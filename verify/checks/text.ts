/**
 * T066 — Text checks: fresh extraction from the candidate must find no
 * non-whitespace text intersecting any marked rectangle.
 *
 * This is the select/copy layer (PDF.js getTextContent) — the same layer
 * a user would copy from — so "no selectable text in the region" is the
 * same test, not a second one. Each item's string is normalized (NFC,
 * format characters stripped, whitespace collapsed) before the emptiness
 * test, so the check is script-agnostic: Hebrew, Latin, digits, and
 * mixed-direction runs are all just "visible text" or "not".
 *
 * Item geometry (grounded empirically against the pinned PDF.js 6.3.289):
 *  - `width` is the advance in DEFAULT USER SPACE along the text direction
 *    normalize(a, b) — verified with scaled (2x) and 90°-rotated text.
 *  - font height is hypot(c, d) (the text layer uses the same quantity).
 *  - The ink box is the baseline segment (origin → origin + width·û),
 *    expanded DESCENT_RATIO·h below and ASCENT_RATIO·h above the baseline
 *    along the ascender side v̂ = rotate90(û). Mirrored text (negative
 *    determinant) swaps the two sides.
 *  - The axis-aligned bounding box of that parallelogram is tested against
 *    the mark rect with inclusive overlap: touching counts as intersecting.
 *
 * The box deliberately OVER-approximates (it is not the exact ink): a glyph
 * at the rect's edge fails rather than slipping through. The margins are
 * part of the versioned verification policy (VERIFY_POLICY_VERSION).
 */
import type { VerifyCheckContext } from "../handler.js";
import type { VerifyRect, VerifySelectionCheck } from "../protocol.js";
import type { VerifyPage, VerifyTextItem } from "../engine.js";

/** Below-baseline margin, in font heights. Covers descenders + slack. */
const DESCENT_RATIO = 0.3;
/** Above-baseline margin, in font heights. Covers ascenders + slack. */
const ASCENT_RATIO = 1.0;

export interface TextBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * Conservative user-space box for one text item. Returns null when the
 * item has no extent at all (zero advance or zero font height): such text
 * occupies no space and cannot intersect anything.
 */
export function textItemBox(item: VerifyTextItem): TextBox | null {
  const [a, b, c, d, e, f] = item.transform;
  const advanceLen = Math.hypot(a, b);
  const fontHeight = Math.hypot(c, d);
  if (!(advanceLen > 0) || !(fontHeight > 0)) return null;

  // Text direction and ascender side (both unit vectors, y-up space).
  const ux = a / advanceLen;
  const uy = b / advanceLen;
  const vx = -uy;
  const vy = ux;

  // Mirrored text renders its ascenders on the other side.
  const mirrored = a * d - b * c < 0;
  const below = (mirrored ? ASCENT_RATIO : DESCENT_RATIO) * fontHeight;
  const above = (mirrored ? DESCENT_RATIO : ASCENT_RATIO) * fontHeight;

  const w = item.width;
  const corners: Array<readonly [number, number]> = [
    [e - vx * below, f - vy * below],
    [e + ux * w - vx * below, f + uy * w - vy * below],
    [e + vx * above, f + vy * above],
    [e + ux * w + vx * above, f + uy * w + vy * above],
  ];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of corners) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Normalized emptiness test: NFC, strip format characters (zero-width
 * spaces, directional marks, BOM), then whitespace. Anything left is
 * visible, selectable text — in any script.
 */
export function hasVisibleText(str: string): boolean {
  const stripped = str.normalize("NFC").replace(/\p{Cf}/gu, "");
  return stripped.trim() !== "";
}

function normalizeRect(rect: VerifyRect): TextBox {
  return {
    x0: Math.min(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1),
    x1: Math.max(rect.x0, rect.x1),
    y1: Math.max(rect.y0, rect.y1),
  };
}

/** Inclusive overlap: sharing even an edge counts as intersecting. */
export function boxesOverlap(a: TextBox, b: TextBox): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

const CODES = {
  clear: "verify.text.clear",
  remaining: "verify.text.remaining-text",
  pageUnavailable: "verify.text.page-unavailable",
  extractionUnavailable: "verify.text.extraction-unavailable",
} as const;

function indeterminateFor(
  rects: readonly VerifyRect[],
  reasonCode: string,
): VerifySelectionCheck[] {
  return rects.map((rect) => ({
    selectionId: rect.selectionId,
    page: rect.page,
    number: rect.number,
    aspect: "text" as const,
    outcome: "indeterminate" as const,
    reasonCode,
  }));
}

export async function runTextChecks(ctx: VerifyCheckContext): Promise<VerifySelectionCheck[]> {
  const { candidate, message } = ctx;
  const results: VerifySelectionCheck[] = [];

  const byPage = new Map<number, VerifyRect[]>();
  for (const rect of message.rects) {
    const list = byPage.get(rect.page) ?? [];
    list.push(rect);
    byPage.set(rect.page, list);
  }

  for (const [pageIndex, rects] of byPage) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= candidate.numPages) {
      results.push(...indeterminateFor(rects, CODES.pageUnavailable));
      continue;
    }
    let page: VerifyPage;
    try {
      page = await candidate.page(pageIndex + 1);
    } catch {
      results.push(...indeterminateFor(rects, CODES.pageUnavailable));
      continue;
    }
    let items: readonly VerifyTextItem[];
    try {
      items = await page.textItems();
    } catch {
      results.push(...indeterminateFor(rects, CODES.extractionUnavailable));
      continue;
    }
    const visible = items.filter((item) => hasVisibleText(item.str));
    for (const rect of rects) {
      const region = normalizeRect(rect);
      const hit = visible.some((item) => {
        const box = textItemBox(item);
        return box !== null && boxesOverlap(box, region);
      });
      results.push({
        selectionId: rect.selectionId,
        page: rect.page,
        number: rect.number,
        aspect: "text",
        outcome: hit ? "fail" : "pass",
        reasonCode: hit ? CODES.remaining : CODES.clear,
      });
    }
  }

  return results;
}
