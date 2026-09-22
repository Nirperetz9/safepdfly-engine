/**
 * T033 — Page descriptor extraction from the PDF.js input engine.
 *
 * Descriptors are immutable (frozen) and stable across reopen: they carry
 * only geometry and safe numeric context, never document content.
 *
 * Known engine limitation (recorded, not hidden): PDF.js exposes only the
 * effective visible box (CropBox ∩ MediaBox) from the main thread, not the
 * MediaBox and CropBox separately. Both `mediaBox` and `cropBox` therefore
 * carry the visible box for PDF.js-derived descriptors. The independent
 * read-only MuPDF.js classifier (T085) derives the authoritative boxes, and
 * T036 compares the *visible* boxes between engines — material disagreement
 * makes the document unsupported.
 */
import { Brand } from "../geometry/index.js";
import type { PageDescriptor, PageClassification } from "../model.js";
import { BUDGET_POLICY } from "../support-policy/budgets.js";
import type { InputEngineDoc } from "./engine.js";

/** Internal only. Never crosses the worker boundary. */
export class DescriptorError extends Error {
  constructor(
    message: string,
    readonly pageNumber?: number,
  ) {
    super(message);
    this.name = "DescriptorError";
  }
}

function normalizeRotation(degrees: number, pageNumber: number): 0 | 90 | 180 | 270 {
  const n = ((Math.round(degrees) % 360) + 360) % 360;
  if (n === 0 || n === 90 || n === 180 || n === 270) return n;
  throw new DescriptorError(`non-normalizable rotation: ${degrees}`, pageNumber);
}

function probeClassification(
  hasText: boolean,
): Extract<PageClassification, "text_based" | "blank"> {
  // T036/T037 refine this with the dual-engine verdict (scanned/hybrid).
  return hasText ? "text_based" : "blank";
}

/**
 * Extract one frozen descriptor per page. Throws DescriptorError on
 * degenerate geometry; the caller maps it to a stable reason code.
 */
export async function extractDescriptors(
  doc: InputEngineDoc,
): Promise<readonly PageDescriptor[]> {
  const out: PageDescriptor[] = [];
  const count = doc.numPages;
  for (let n = 1; n <= count; n++) {
    const page = await doc.page(n);
    const rotation = normalizeRotation(page.rotate, n);
    const userUnit = page.userUnit;
    if (!Number.isFinite(userUnit) || userUnit <= 0) {
      throw new DescriptorError(`invalid userUnit: ${userUnit}`, n);
    }
    const [x0, y0, x1, y1] = page.view;
    const box = [x0, y0, x1, y1] as const;
    if (
      ![x0, y0, x1, y1].every(Number.isFinite) ||
      x1 <= x0 ||
      y1 <= y0
    ) {
      throw new DescriptorError("degenerate page box", n);
    }
    const hasText = await page.hasNonWhitespaceText();
    out.push(
      Object.freeze({
        pageIndex: Brand.pageIndex(n - 1),
        mediaBox: box,
        context: Object.freeze({
          cropBox: [Brand.pdfPoint(x0), Brand.pdfPoint(y0), Brand.pdfPoint(x1), Brand.pdfPoint(y1)] as const,
          rotation,
          userUnit,
        }),
        classification: probeClassification(hasText),
        renderBudget: Object.freeze({
          maxPixels: BUDGET_POLICY.maxRenderPixels,
          maxOperators: BUDGET_POLICY.maxOperatorsPerPage,
        }),
      }) satisfies PageDescriptor,
    );
  }
  return Object.freeze(out);
}
