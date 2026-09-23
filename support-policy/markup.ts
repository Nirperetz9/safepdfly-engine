/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T086 — Annotation and optional-content (hidden layer) support policy.
 *
 * Scope guard (per tasks.md): this is a support-BOUNDARY check only. It
 * rejects selections that an annotation or optional-content construct may
 * affect. It does not sanitize, remove, or inspect metadata, attachments,
 * or hidden data in general — those remain explicit spec non-goals — and
 * result copy must never claim they were.
 *
 * Contract:
 * - The selection rect is in the canonical frame: default user space,
 *   y-up, unrotated — the same frame as AgreedPage.visibleBox (T036).
 *   Annotation rects are collected as raw /Rect values in that frame.
 * - Overlap means positive intersecting area (edge-touching does not count).
 * - Any optional-content construct on the page (page /OC, OCG
 *   marked-content properties, OCG-gated XObjects) rejects every selection
 *   on that page: without resolving layer states, deterministic
 *   verification of a selection is impossible.
 * - Fail closed on uncertainty: uninspectable annotations or markup
 *   evidence reject the selection.
 */
import type { PageMarkupEvidence } from "../classify-mupdf/readonly-facade.js";
import type { SupportReasonCode } from "./reasons.js";

export interface SelectionInput {
  readonly pageIndex: number;
  /** Canonical frame rect: [x0, y0, x1, y1], y-up, unrotated. */
  readonly rect: readonly [number, number, number, number];
}

export type MarkupVerdict =
  | { readonly clear: true }
  | {
      readonly clear: false;
      readonly reason: Extract<
        SupportReasonCode,
        "annotation-overlap" | "hidden-layer"
      >;
    };

function normalized(
  rect: readonly [number, number, number, number],
): [number, number, number, number] | null {
  const [a, b, c, d] = rect;
  if (![a, b, c, d].every((v) => typeof v === "number" && Number.isFinite(v))) {
    return null;
  }
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** Positive-area intersection, or false for degenerate input. */
function overlaps(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): boolean {
  const na = normalized(a);
  const nb = normalized(b);
  if (na === null || nb === null) return false;
  return (
    Math.min(na[2], nb[2]) - Math.max(na[0], nb[0]) > 0 &&
    Math.min(na[3], nb[3]) - Math.max(na[1], nb[1]) > 0
  );
}

/**
 * Check one marked selection against a page's markup evidence. Pure;
 * never throws — uninspectable input fails closed.
 */
export function checkSelectionMarkup(
  markup: PageMarkupEvidence | null | undefined,
  selection: SelectionInput,
): MarkupVerdict {
  try {
    if (!markup || markup.annotationsIndeterminate) {
      return { clear: false, reason: "annotation-overlap" };
    }
    if (normalized(selection.rect) === null) {
      return { clear: false, reason: "annotation-overlap" };
    }
    for (const annotation of markup.annotations ?? []) {
      if (overlaps(annotation.rect, selection.rect)) {
        return { clear: false, reason: "annotation-overlap" };
      }
    }
    if (markup.optionalContent) {
      return { clear: false, reason: "hidden-layer" };
    }
    return { clear: true };
  } catch {
    return { clear: false, reason: "annotation-overlap" };
  }
}
