/**
 * T093 — Canonical → transform-worker rectangle projection.
 *
 * The transform worker (T058) consumes TransformRects: viewport points at
 * scale 1, y-down, origin at the CropBox top-left as displayed (rotation
 * applied) — exactly what MuPDF.js `PDFAnnotation.setRect()` consumes
 * (validated in Phase 1, T008).
 *
 * Selections are stored canonical (PDF default user space, y-up, MediaBox
 * origin). This module is the single audited place where canonical rects
 * become transform rects, using the approved geometry core (T024) — never
 * an ad-hoc flip. The inverse direction (viewport → canonical) is audited
 * by the property tests in rects.test.ts.
 */
import { pdfToViewport } from "../geometry/transforms.js";
import type { CanonicalRect } from "../geometry/types.js";
import type { TransformRect } from "./protocol.js";

/**
 * Project a canonical selection rect to the transform worker's viewport
 * points (scale 1). The rect must already be round-trip-valid
 * (see isRoundTripValid in preconditions.ts); this function does not
 * re-validate, it only projects.
 */
export function toTransformRect(rect: CanonicalRect): TransformRect {
  const view = pdfToViewport(rect, 1);
  return {
    page: rect.page,
    x0: view.x,
    y0: view.y,
    x1: view.x + view.w,
    y1: view.y + view.h,
  };
}
