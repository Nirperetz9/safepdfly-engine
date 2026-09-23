/**
 * T059 — MuPDF.js engine adapter for the approved redaction policy.
 *
 * This module is the ONLY place in the redact path that imports "mupdf"
 * (same facade discipline as the classifier's readonly-facade; enforced by
 * adapter.test.ts). It applies the approved policy for every rectangle:
 *
 * - text: REDACT_TEXT_REMOVE — glyphs destroyed, not overlaid;
 * - images: REDACT_IMAGE_PIXELS — covered pixels replaced with the fill;
 * - line art: REDACT_LINE_ART_REMOVE_IF_TOUCHED — any path touched by a
 *   rectangle is removed entirely (privacy over path preservation);
 * - fill: black_boxes — the redacted area gets an opaque fill.
 *
 * Rectangles arrive as viewport points (origin top-left of the CropBox as
 * displayed, y down): exactly what PDFAnnotation.setRect() consumes
 * (validated empirically in Phase 1, T008).
 *
 * There is no overlay fallback anywhere in this module: any failure throws,
 * and the worker boundary (T058) maps it to TRANSFORM_FAILED. The
 * application never downgrades to a cosmetic rectangle.
 */
import { ColorSpace, Matrix, PDFDocument, PDFPage } from "mupdf";
import type { TransformBackend } from "./handler.js";
import type { SelfCheckStatus, TransformRect } from "./protocol.js";

/** Open a document from raw bytes. Throws on corrupt/encrypted input. */
function openPdfDocument(bytes: ArrayBuffer): PDFDocument {
  // PDFDocument.openDocument is inherited from Document; the cast reflects
  // that a PDF magic buffer opens as a PDF document (throws otherwise).
  return PDFDocument.openDocument(
    new Uint8Array(bytes),
    "application/pdf",
  ) as PDFDocument;
}

/**
 * Apply the approved redaction policy for every rectangle. Groups by page,
 * creates one Redact annotation per rectangle, then applies the destructive
 * policy. Throws without mutating the caller's bytes on any invalid input.
 */
export function applyRedactionPolicy(
  doc: PDFDocument,
  rects: readonly TransformRect[],
): void {
  const pageCount = doc.countPages();
  const byPage = new Map<number, TransformRect[]>();
  for (const r of rects) {
    // Defense in depth: the protocol validated these, but the adapter never
    // trusts the boundary blindly. Messages carry no content, so a bare
    // error is safe.
    if (!Number.isInteger(r.page) || r.page < 0 || r.page >= pageCount) {
      throw new Error("redact: rect page out of range");
    }
    if (!(r.x0 < r.x1 && r.y0 < r.y1)) {
      throw new Error("redact: rect must be non-empty and ordered");
    }
    const list = byPage.get(r.page);
    if (list === undefined) byPage.set(r.page, [r]);
    else list.push(r);
  }

  for (const [pageNo, pageRects] of byPage) {
    const page: PDFPage = doc.loadPage(pageNo);
    for (const rc of pageRects) {
      const annot = page.createAnnotation("Redact");
      annot.setRect([rc.x0, rc.y0, rc.x1, rc.y1]);
      annot.update();
    }
    page.applyRedactions(
      true, // black_boxes: opaque fill over the redacted area
      PDFPage.REDACT_IMAGE_PIXELS, // covered image pixels replaced
      PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED, // touched paths removed entirely
      PDFPage.REDACT_TEXT_REMOVE, // glyphs destroyed
    );
  }
}

/**
 * Internal self-check (T062 will promote this to its own module): the
 * candidate must re-parse, keep its page count, and render its first page.
 * This is a sanity check on the transformation only — never a safety verdict.
 */
function selfCheckRender(bytes: ArrayBuffer, expectedPages: number): SelfCheckStatus {
  let doc: PDFDocument | null = null;
  try {
    doc = openPdfDocument(bytes);
    if (doc.countPages() !== expectedPages) return "failed";
    const pix = doc
      .loadPage(0)
      .toPixmap(Matrix.scale(0.5, 0.5), ColorSpace.DeviceRGB);
    // Touch the pixels so a broken render surface cannot pass silently.
    if (pix.getPixels().length === 0) return "failed";
    pix.destroy();
    return "ok";
  } catch {
    return "failed";
  } finally {
    doc?.destroy();
  }
}

/** Production backend: open, apply policy, full-rewrite save, self-check. */
export function createMuPdfBackend(): TransformBackend {
  return {
    async apply(payload: ArrayBuffer, rects: readonly TransformRect[]) {
      let doc: PDFDocument | null = null;
      try {
        doc = openPdfDocument(payload);
        const expectedPages = doc.countPages();
        applyRedactionPolicy(doc, rects);
        // Full rewrite with garbage collection (T060 promotes this to
        // save.ts). asUint8Array may view WASM memory, so copy before
        // destroying the document.
        const saved = new Uint8Array(
          doc.saveToBuffer("garbage").asUint8Array(),
        ).slice().buffer as ArrayBuffer;
        const selfCheck = selfCheckRender(saved, expectedPages);
        return { bytes: saved, selfCheck };
      } finally {
        doc?.destroy();
      }
    },
  };
}
