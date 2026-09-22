/**
 * T024 — Canonical rectangle geometry, ported from the validated T008 prototype
 * (`prototypes/engine-validation/src/geometry/rect.js`) and hardened with branded
 * types. The rotation mappings (especially 180/270) were verified empirically
 * against MuPDF.js `setRedaction` quads in Phase 1; do not "simplify" them.
 *
 * Conventions:
 * - Canonical space: PDF default user space, points, y-up, origin at MediaBox origin.
 * - Viewport space: CSS pixels, top-left origin, at a recorded devicePixelRatio/scale.
 */
import {
  Brand,
  type CanonicalRect,
  type PageContext,
  type PageIndex,
  type PageRotation,
  type PdfPoint,
  type PdfRect,
  type ViewportPixel,
  type ViewportRect,
} from "./types.js";

/** Tolerance for viewport<->PDF round trips (viewport pixels). */
export const ROUND_TRIP_TOLERANCE_PX = 0.01;

export function normRotate(r: number): PageRotation {
  const n = ((r % 360) + 360) % 360;
  if (n === 0 || n === 90 || n === 180 || n === 270) return n;
  throw new RangeError(`unsupported rotation: ${r}`);
}

export function makePageContext(
  cropBox: readonly [number, number, number, number],
  rotation: number,
  userUnit: number,
): PageContext {
  const [x0, y0, x1, y1] = cropBox;
  if (!(x0 < x1 && y0 < y1)) throw new RangeError("cropBox must be non-empty and ordered");
  if (!(userUnit > 0) || !Number.isFinite(userUnit)) throw new RangeError(`invalid userUnit: ${userUnit}`);
  return {
    cropBox: [Brand.pdfPoint(x0), Brand.pdfPoint(y0), Brand.pdfPoint(x1), Brand.pdfPoint(y1)],
    rotation: normRotate(rotation),
    userUnit,
  };
}

/** Build a canonical rect. Throws unless non-empty, ordered, and inside the CropBox. */
export function makeCanonicalRect(
  page: PageIndex,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  context: PageContext,
): CanonicalRect {
  if (!(x0 < x1 && y0 < y1)) throw new RangeError("rect must be non-empty and ordered");
  const [cx0, cy0, cx1, cy1] = context.cropBox;
  if (x0 < cx0 || y0 < cy0 || x1 > cx1 || y1 > cy1) {
    throw new RangeError("rect must be contained in the visible CropBox");
  }
  return {
    page,
    rect: {
      x0: Brand.pdfPoint(x0),
      y0: Brand.pdfPoint(y0),
      x1: Brand.pdfPoint(x1),
      y1: Brand.pdfPoint(y1),
    },
    context,
  };
}

/**
 * Clamp a PDF rect to the visible CropBox. Returns null when nothing visible remains.
 * Used by the editor for drags that leave the page; never silently expands a rect.
 */
export function clipToCropBox(rect: PdfRect, context: PageContext): PdfRect | null {
  const [cx0, cy0, cx1, cy1] = context.cropBox;
  const x0 = Math.max(rect.x0, cx0);
  const y0 = Math.max(rect.y0, cy0);
  const x1 = Math.min(rect.x1, cx1);
  const y1 = Math.min(rect.y1, cy1);
  if (!(x0 < x1 && y0 < y1)) return null;
  return { x0: Brand.pdfPoint(x0), y0: Brand.pdfPoint(y0), x1: Brand.pdfPoint(x1), y1: Brand.pdfPoint(y1) };
}

type Pt = readonly [number, number];

/** PDF user space -> viewport pixels (top-left origin) at the given scale. */
export function pdfToViewport(rect: CanonicalRect, scale: number): ViewportRect {
  const k = rect.context.userUnit * scale;
  const [cx0, cy0, cx1, cy1] = rect.context.cropBox;
  const map = (x: number, y: number): Pt => {
    switch (rect.context.rotation) {
      case 0:
        return [(x - cx0) * k, (cy1 - y) * k];
      case 90:
        return [(y - cy0) * k, (x - cx0) * k];
      // 180/270 verified empirically against MuPDF.js search quads (T008):
      // device space = unrotated top-origin coords rotated CW by rotation.
      case 180:
        return [(cx1 - x) * k, (y - cy0) * k];
      case 270:
        return [(cy1 - y) * k, (cx1 - x) * k];
    }
  };
  const [ax, ay] = map(rect.rect.x0, rect.rect.y0);
  const [bx, by] = map(rect.rect.x1, rect.rect.y1);
  return {
    x: Brand.viewportPixel(Math.min(ax, bx)),
    y: Brand.viewportPixel(Math.min(ay, by)),
    w: Brand.viewportPixel(Math.abs(bx - ax)),
    h: Brand.viewportPixel(Math.abs(by - ay)),
  };
}

/** Viewport pixels (top-left origin) -> canonical PDF rect. Inverse of pdfToViewport. */
export function viewportToPdf(
  page: PageIndex,
  view: { x: number; y: number; w: number; h: number },
  scale: number,
  context: PageContext,
): CanonicalRect {
  const k = context.userUnit * scale;
  const [cx0, cy0, cx1, cy1] = context.cropBox;
  const unmap = (X: number, Y: number): Pt => {
    switch (context.rotation) {
      case 0:
        return [cx0 + X / k, cy1 - Y / k];
      case 90:
        return [cx0 + Y / k, cy0 + X / k];
      case 180:
        return [cx1 - X / k, cy0 + Y / k];
      case 270:
        return [cx1 - Y / k, cy1 - X / k];
    }
  };
  const [x0, y0] = unmap(view.x, view.y);
  const [x1, y1] = unmap(view.x + view.w, view.y + view.h);
  const clipped = clipToCropBox(
    {
      x0: Brand.pdfPoint(Math.min(x0, x1)),
      y0: Brand.pdfPoint(Math.min(y0, y1)),
      x1: Brand.pdfPoint(Math.max(x0, x1)),
      y1: Brand.pdfPoint(Math.max(y0, y1)),
    },
    context,
  );
  if (clipped === null) throw new RangeError("viewport rect maps outside the visible page");
  return { page, rect: clipped, context };
}

/** Visible display size of the crop region in viewport pixels at the given scale. */
export function displaySize(context: PageContext, scale: number): { w: number; h: number } {
  const k = context.userUnit * scale;
  const w = (context.cropBox[2] - context.cropBox[0]) * k;
  const h = (context.cropBox[3] - context.cropBox[1]) * k;
  return context.rotation % 180 === 0 ? { w, h } : { w: h, h: w };
}

/** Fingerprint identifying the transform a rect was converted under (T025 uses it). */
export function transformFingerprint(context: PageContext): string {
  const [x0, y0, x1, y1] = context.cropBox;
  return `crop=${x0},${y0},${x1},${y1};rot=${context.rotation};uu=${context.userUnit}`;
}
