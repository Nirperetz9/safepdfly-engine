/**
 * T062 — Internal self-check for a redaction candidate.
 *
 * After the save, the candidate must re-parse under a fresh document, keep
 * its page count, and render its first page. This is a sanity check on the
 * transformation only: it catches a save that produced an unparseable file.
 * MuPDF repairs some damaged inputs leniently, so this check does not
 * promise to catch every truncation — the exact-bytes SHA-256 identity
 * (T058) and independent verification (Phase 7) cover that. It is NEVER a
 * safety verdict — a candidate that passes the self-check is still only a
 * candidate (FR-012, PR-006). Independent verification (Phase 7) decides
 * what the user may download.
 */
import { ColorSpace, Matrix, PDFDocument } from "mupdf";
import type { SelfCheckStatus } from "./protocol.js";

/**
 * Run the internal self-check render. Returns "ok" only when the exact
 * candidate bytes re-open, report the expected page count, and render.
 * Any exception or mismatch returns "failed" — never throws.
 */
export function runSelfCheck(
  bytes: ArrayBuffer,
  expectedPages: number,
): SelfCheckStatus {
  if (bytes.byteLength === 0) return "failed";
  let doc: PDFDocument | null = null;
  try {
    doc = PDFDocument.openDocument(
      new Uint8Array(bytes),
      "application/pdf",
    ) as PDFDocument;
    if (doc.countPages() !== expectedPages) return "failed";
    const pix = doc
      .loadPage(0)
      .toPixmap(Matrix.scale(0.5, 0.5), ColorSpace.DeviceRGB);
    try {
      // Touch the pixels so a broken render surface cannot pass silently.
      if (pix.getPixels().length === 0) return "failed";
    } finally {
      pix.destroy();
    }
    return "ok";
  } catch {
    return "failed";
  } finally {
    doc?.destroy();
  }
}
