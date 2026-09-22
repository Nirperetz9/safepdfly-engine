/**
 * T036 — Dual-engine comparison (PDF.js descriptors vs MuPDF classify report).
 *
 * Any disagreement fails closed with reason "disagreement". The two engines
 * report geometry in different frames, so the comparison is done on
 * frame-independent invariants:
 *
 * - PDF.js `page.view`  = raw intersect(CropBox, MediaBox), y-up, unrotated,
 *   UserUnit NOT applied (verified against pdfjs-dist 6.3.289 source).
 * - MuPDF `getBounds()` = raw box transformed by the page transform:
 *   /Rotate applied, y flipped to y-down, translated so the crop box's
 *   top-left is the origin, UserUnit applied (verified empirically).
 *
 * Compared per page: page count, normalized rotation, UserUnit, visible-box
 * dimensions (rotation-aware, UserUnit-normalized, within epsilon), and
 * text-presence agreement. Each engine must also be internally sane
 * (positive, finite, crop-within-media dimensions on the MuPDF side).
 */
import type { PageDescriptor } from "../model.js";
import type { ClassifyReport } from "../classify-mupdf/classifier.js";
import type { SupportReasonCode } from "./reasons.js";

/**
 * Geometry both engines agreed on. visibleBox is in the PDF.js canonical
 * frame (y-up, unrotated, unscaled) — the frame the render pipeline uses.
 */
export interface AgreedPageGeometry {
  readonly pageIndex: number;
  readonly visibleBox: readonly [number, number, number, number];
  readonly rotation: number;
  readonly userUnit: number;
}

export type EngineComparison =
  | {
      readonly ok: true;
      readonly pageCount: number;
      readonly pages: readonly AgreedPageGeometry[];
    }
  | { readonly ok: false; readonly reason: Extract<SupportReasonCode, "disagreement"> };

/**
 * float32 (MuPDF WASM) vs float64 (PDF.js) rounding is ~1e-4 pt at page
 * sizes; a genuine box disagreement differs by whole points. 0.02 pt keeps
 * false rejections out while catching every real divergence seen in probes.
 */
export const GEOMETRY_EPSILON_PT = 0.02;

function dims(box: readonly [number, number, number, number]): [number, number] {
  return [box[2] - box[0], box[3] - box[1]];
}

function saneDims(w: number, h: number): boolean {
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
}

function closeEnough(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= GEOMETRY_EPSILON_PT;
}

function freezeAgreed(p: AgreedPageGeometry): AgreedPageGeometry {
  return Object.freeze({
    ...p,
    visibleBox: Object.freeze([...p.visibleBox]) as readonly [number, number, number, number],
  });
}

/**
 * Compare one source's dual-engine evidence. Pure function; never throws —
 * every mismatch (or malformed input) yields { ok: false }.
 */
export function compareEngines(
  descriptors: readonly PageDescriptor[],
  report: ClassifyReport,
): EngineComparison {
  const disagree = (): EngineComparison => ({ ok: false, reason: "disagreement" });
  try {
    if (!Array.isArray(descriptors) || report == null) return disagree();
    if (descriptors.length !== report.pageCount) return disagree();
    if (!Array.isArray(report.pages) || report.pages.length !== report.pageCount) {
      return disagree();
    }
    const pages: AgreedPageGeometry[] = [];
    for (let i = 0; i < descriptors.length; i++) {
      const d = descriptors[i]!;
      const e = report.pages[i]!;
      if (!d || !e) return disagree();
      if (d.pageIndex !== i || e.pageIndex !== i) return disagree();

      // Normalized rotation and UserUnit must match exactly.
      if (d.context.rotation !== e.rotation) return disagree();
      if (d.context.userUnit !== e.userUnit) return disagree();
      if (!(e.userUnit > 0)) return disagree();

      // Visible dimensions: MuPDF frame is rotated + UserUnit-scaled.
      const [vw, vh] = dims(d.context.cropBox);
      if (!saneDims(vw, vh)) return disagree();
      const [mw, mh] = dims(e.cropBox);
      const uw = mw / e.userUnit;
      const uh = mh / e.userUnit;
      if (!saneDims(uw, uh)) return disagree();
      const rotated = e.rotation === 90 || e.rotation === 270;
      const [ew, eh] = rotated ? [vh, vw] : [vw, vh];
      if (!closeEnough(uw, ew) || !closeEnough(uh, eh)) return disagree();

      // MuPDF-side sanity: crop must fit inside media (same frame).
      const [medW, medH] = dims(e.mediaBox);
      if (!saneDims(medW, medH)) return disagree();
      if (mw - medW > GEOMETRY_EPSILON_PT || mh - medH > GEOMETRY_EPSILON_PT) {
        return disagree();
      }

      // Text-presence agreement (feeds the scanned/hybrid policy, T037).
      const jsHasText = d.classification === "text_based";
      const muHasText = e.textChars > 0;
      if (jsHasText !== muHasText) return disagree();

      pages.push(
        freezeAgreed({
          pageIndex: i,
          visibleBox: d.context.cropBox,
          rotation: d.context.rotation,
          userUnit: d.context.userUnit,
        }),
      );
    }
    return { ok: true, pageCount: descriptors.length, pages: Object.freeze(pages) };
  } catch {
    return disagree();
  }
}
