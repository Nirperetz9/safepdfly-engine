/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T067 — Visible-content checks: deterministic 2× rendering of source and
 * candidate, compared pixel by pixel.
 *
 * Per marked rectangle (aspect "visual"):
 *  - FILL: inside the mask, excluding a versioned antialias boundary, the
 *    pixels must be uniform AND near-black (the pinned redaction policy
 *    paints opaque black boxes). Non-uniform → "non-uniform-fill";
 *    uniform but not black → "unexpected-fill".
 *  - RETAINED: no inner-mask pixel may still match the source pixel unless
 *    the source pixel was itself fill-like (e.g. the region was already
 *    black) — a retained original pixel fails.
 *
 * Document-wide:
 *  - OUTSIDE: every pixel outside the masks must match the source within a
 *    strict versioned tolerance. Two legitimate difference sources are
 *    excluded: the antialias band around each mask edge, and the footprint
 *    of source glyphs the transform legitimately removed — REDACT_TEXT_REMOVE
 *    destroys whole glyphs intersecting the redaction quad, including the
 *    parts sticking out past the mask edge (verified empirically: ascender
 *    tips up to ~8pt above the mask are erased). Those footprints come from
 *    the SOURCE's text items intersecting the mask (the T066 predicate), so
 *    over-redaction elsewhere is still caught.
 *
 * Mutant coverage: an overlay-only "redaction" (paint over content without
 * removing it) fails the T066 text check; a retained-pixel mutant fails the
 * retained test; an outside-damage mutant fails the outside test.
 *
 * All tolerances are versioned policy (recorded in the report evidence,
 * T070). Rendering is deterministic: same bytes + same policy → same
 * verdict. Anything that cannot be evaluated is indeterminate, never a
 * silent pass.
 */
import type { VerifyCheckContext } from "../handler.js";
import type { VerificationOutcome } from "../../model.js";
import type { VerifyRect, VerifySelectionCheck } from "../protocol.js";
import type { VerifyPage, VerifyPixels, VerifyTextItem } from "../engine.js";
import { boxesOverlap, hasVisibleText, textItemBox, type TextBox } from "./text.js";

/** Deterministic render scale: 2 device px per PDF point. */
export const VISUAL_SCALE = 2;
/** Antialias exclusion band around mask edges, in device px (versioned). */
export const AA_BOUNDARY_PX = 2;
/** Max per-channel deviation from the fill median (uniformity). */
export const FILL_UNIFORMITY_TOLERANCE = 4;
/** The fill median must be within this of black, per channel. */
export const FILL_BLACK_TOLERANCE = 8;
/** Candidate≈source per-channel match treated as "same pixel". */
export const RETAINED_TOLERANCE = 4;
/** Strict per-channel tolerance for pixels outside masks. */
export const OUTSIDE_TOLERANCE = 2;
/** Removed-glyph footprint expansion in the outside exclusion, device px. */
export const GLYPH_EXCLUSION_MARGIN_PX = 3;

const CODES = {
  fillOk: "verify.visual.fill-ok",
  nonUniform: "verify.visual.non-uniform-fill",
  unexpectedFill: "verify.visual.unexpected-fill",
  retained: "verify.visual.retained-pixels",
  innerEmpty: "verify.visual.inner-region-empty",
  pageUnavailable: "verify.visual.page-unavailable",
  renderUnavailable: "verify.visual.render-unavailable",
  sourceTextUnavailable: "verify.visual.source-text-unavailable",
  outsideOk: "verify.visual.outside-ok",
  outsideDamage: "verify.visual.outside-damage",
} as const;

interface DeviceBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface VisualCheckOutput {
  readonly selectionChecks: readonly VerifySelectionCheck[];
  readonly outsideMaskOutcome: VerificationOutcome;
  readonly outsideMaskReasonCode: string;
}

/** Map a y-up user-space rect to integer device pixels (y-down), clamped. */
export function toDeviceBox(
  page: VerifyPage,
  rect: TextBox,
  pixels: VerifyPixels,
): DeviceBox | null {
  const [ax, ay] = page.toDevice(VISUAL_SCALE, rect.x0, rect.y0);
  const [bx, by] = page.toDevice(VISUAL_SCALE, rect.x1, rect.y1);
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by)));
  const x1 = Math.min(pixels.width, Math.ceil(Math.max(ax, bx)));
  const y1 = Math.min(pixels.height, Math.ceil(Math.max(ay, by)));
  if (x0 >= x1 || y0 >= y1) return null;
  return { x0, y0, x1, y1 };
}

function shrink(box: DeviceBox, by: number): DeviceBox | null {
  const x0 = box.x0 + by;
  const y0 = box.y0 + by;
  const x1 = box.x1 - by;
  const y1 = box.y1 - by;
  if (x0 >= x1 || y0 >= y1) return null;
  return { x0, y0, x1, y1 };
}

function expand(box: DeviceBox, by: number, pixels: VerifyPixels): DeviceBox {
  return {
    x0: Math.max(0, box.x0 - by),
    y0: Math.max(0, box.y0 - by),
    x1: Math.min(pixels.width, box.x1 + by),
    y1: Math.min(pixels.height, box.y1 + by),
  };
}

type RGB = readonly [number, number, number];

function pixelAt(pixels: VerifyPixels, x: number, y: number): RGB {
  const i = (y * pixels.width + x) * 4;
  const d = pixels.data;
  return [d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0];
}

function within(a: RGB, b: RGB, tolerance: number): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance
  );
}

function isFillLike(px: RGB): boolean {
  return px[0] <= FILL_BLACK_TOLERANCE && px[1] <= FILL_BLACK_TOLERANCE && px[2] <= FILL_BLACK_TOLERANCE;
}

function forEachPixel(box: DeviceBox, fn: (x: number, y: number) => boolean): boolean {
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      if (!fn(x, y)) return false;
    }
  }
  return true;
}

function checkFill(cand: VerifyPixels, box: DeviceBox): { outcome: VerificationOutcome; reasonCode: string } {
  const inner = shrink(box, AA_BOUNDARY_PX);
  if (inner === null) return { outcome: "indeterminate", reasonCode: CODES.innerEmpty };
  let rMin = 255;
  let gMin = 255;
  let bMin = 255;
  let rMax = 0;
  let gMax = 0;
  let bMax = 0;
  forEachPixel(inner, (x, y) => {
    const [r, g, b] = pixelAt(cand, x, y);
    if (r < rMin) rMin = r;
    if (g < gMin) gMin = g;
    if (b < bMin) bMin = b;
    if (r > rMax) rMax = r;
    if (g > gMax) gMax = g;
    if (b > bMax) bMax = b;
    return true;
  });
  const uniform =
    rMax - rMin <= FILL_UNIFORMITY_TOLERANCE &&
    gMax - gMin <= FILL_UNIFORMITY_TOLERANCE &&
    bMax - bMin <= FILL_UNIFORMITY_TOLERANCE;
  if (!uniform) return { outcome: "fail", reasonCode: CODES.nonUniform };
  const mid: RGB = [(rMin + rMax) / 2, (gMin + gMax) / 2, (bMin + bMax) / 2];
  if (!isFillLike(mid)) return { outcome: "fail", reasonCode: CODES.unexpectedFill };
  return { outcome: "pass", reasonCode: CODES.fillOk };
}

/**
 * True when any inner-mask pixel still shows the source's original content:
 * it matches the source pixel and the source pixel was not itself fill-like.
 */
function hasRetainedPixels(cand: VerifyPixels, src: VerifyPixels, box: DeviceBox): boolean {
  const inner = shrink(box, AA_BOUNDARY_PX);
  if (inner === null) return false;
  let retained = false;
  forEachPixel(inner, (x, y) => {
    const c = pixelAt(cand, x, y);
    const s = pixelAt(src, x, y);
    if (within(c, s, RETAINED_TOLERANCE) && !isFillLike(s)) {
      retained = true;
      return false;
    }
    return true;
  });
  return retained;
}

/**
 * Device-space exclusion zones for the outside check: each mask expanded
 * by the antialias band, plus the footprint of every source glyph the
 * transform legitimately removed (source text items intersecting a mask),
 * expanded by a small margin.
 */
function buildExclusion(
  page: VerifyPage,
  rects: readonly VerifyRect[],
  sourceItems: readonly VerifyTextItem[],
  candPixels: VerifyPixels,
): DeviceBox[] {
  const zones: DeviceBox[] = [];
  const masks: TextBox[] = rects.map((r) => ({
    x0: Math.min(r.x0, r.x1),
    y0: Math.min(r.y0, r.y1),
    x1: Math.max(r.x0, r.x1),
    y1: Math.max(r.y0, r.y1),
  }));
  for (const mask of masks) {
    const device = toDeviceBox(page, mask, candPixels);
    if (device !== null) zones.push(expand(device, AA_BOUNDARY_PX, candPixels));
  }
  for (const item of sourceItems) {
    if (!hasVisibleText(item.str)) continue;
    const box = textItemBox(item);
    if (box === null) continue;
    if (!masks.some((mask) => boxesOverlap(box, mask))) continue;
    const device = toDeviceBox(page, box, candPixels);
    if (device !== null) zones.push(expand(device, GLYPH_EXCLUSION_MARGIN_PX, candPixels));
  }
  return zones;
}

function insideAny(zones: readonly DeviceBox[], x: number, y: number): boolean {
  return zones.some((z) => x >= z.x0 && x < z.x1 && y >= z.y0 && y < z.y1);
}

function visualResult(
  rect: VerifyRect,
  outcome: VerificationOutcome,
  reasonCode: string,
): VerifySelectionCheck {
  return {
    selectionId: rect.selectionId,
    page: rect.page,
    number: rect.number,
    aspect: "visual",
    outcome,
    reasonCode,
  };
}

export async function runVisualChecks(ctx: VerifyCheckContext): Promise<VisualCheckOutput> {
  const { candidate, source, message } = ctx;
  const selectionChecks: VerifySelectionCheck[] = [];
  let outsideMaskOutcome: VerificationOutcome = "pass";
  let outsideMaskReasonCode: string = CODES.outsideOk;

  const byPage = new Map<number, VerifyRect[]>();
  for (const rect of message.rects) {
    const list = byPage.get(rect.page) ?? [];
    list.push(rect);
    byPage.set(rect.page, list);
  }

  if (byPage.size === 0) {
    return { selectionChecks, outsideMaskOutcome, outsideMaskReasonCode };
  }

  const poisonOutside = (outcome: VerificationOutcome, reasonCode: string): void => {
    if (outsideMaskOutcome === "pass") {
      outsideMaskOutcome = outcome;
      outsideMaskReasonCode = reasonCode;
    } else if (outsideMaskOutcome === "indeterminate" && outcome === "fail") {
      outsideMaskOutcome = outcome;
      outsideMaskReasonCode = reasonCode;
    }
    // fail sticks; indeterminate never overwrites fail.
  };

  for (const [pageIndex, rects] of byPage) {
    const failPage = (reasonCode: string): void => {
      for (const rect of rects) selectionChecks.push(visualResult(rect, "indeterminate", reasonCode));
      poisonOutside("indeterminate", reasonCode);
    };
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= candidate.numPages) {
      failPage(CODES.pageUnavailable);
      continue;
    }
    let candPage: VerifyPage;
    let srcPage: VerifyPage;
    try {
      [candPage, srcPage] = await Promise.all([
        candidate.page(pageIndex + 1),
        source.page(pageIndex + 1),
      ]);
    } catch {
      failPage(CODES.pageUnavailable);
      continue;
    }
    let candPixels: VerifyPixels;
    let srcPixels: VerifyPixels;
    try {
      [candPixels, srcPixels] = await Promise.all([
        candPage.render(VISUAL_SCALE),
        srcPage.render(VISUAL_SCALE),
      ]);
    } catch {
      failPage(CODES.renderUnavailable);
      continue;
    }
    let sourceItems: readonly VerifyTextItem[];
    try {
      sourceItems = await srcPage.textItems();
    } catch {
      failPage(CODES.sourceTextUnavailable);
      continue;
    }

    for (const rect of rects) {
      const box = toDeviceBox(candPage, rect, candPixels);
      if (box === null) {
        selectionChecks.push(visualResult(rect, "indeterminate", CODES.innerEmpty));
        continue;
      }
      const fill = checkFill(candPixels, box);
      if (fill.outcome !== "pass") {
        selectionChecks.push(visualResult(rect, fill.outcome, fill.reasonCode));
        continue;
      }
      if (hasRetainedPixels(candPixels, srcPixels, box)) {
        selectionChecks.push(visualResult(rect, "fail", CODES.retained));
        continue;
      }
      selectionChecks.push(visualResult(rect, "pass", CODES.fillOk));
    }

    // Outside-mask damage for this page.
    const exclusion = buildExclusion(candPage, rects, sourceItems, candPixels);
    let damaged = false;
    forEachPixel(
      { x0: 0, y0: 0, x1: candPixels.width, y1: candPixels.height },
      (x, y) => {
        if (insideAny(exclusion, x, y)) return true;
        const c = pixelAt(candPixels, x, y);
        const s = pixelAt(srcPixels, Math.min(x, srcPixels.width - 1), Math.min(y, srcPixels.height - 1));
        if (!within(c, s, OUTSIDE_TOLERANCE)) {
          damaged = true;
          return false;
        }
        return true;
      },
    );
    if (damaged) poisonOutside("fail", CODES.outsideDamage);
  }

  return { selectionChecks, outsideMaskOutcome, outsideMaskReasonCode };
}
