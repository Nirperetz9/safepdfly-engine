/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

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
import {
  BUDGET_POLICY,
  BudgetExceededError,
  checkOperatorCount,
  checkPhysicalDimensions,
} from "../support-policy/budgets.js";
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
 * Stable identity fingerprint of one descriptor's geometry. Used to detect
 * source drift between open and transformation (T061). FNV-1a 64-bit over a
 * canonical serialization — an identity tag, not a security digest.
 */
export function fingerprintDescriptor(d: PageDescriptor): string {
  const canonical = JSON.stringify([
    d.pageIndex,
    [...d.mediaBox],
    [...d.context.cropBox],
    d.context.rotation,
    d.context.userUnit,
    d.classification,
  ]);
  let h1 = 0xcbf29ce4;
  let h2 = 0x84222325;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193);
  }
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** Stable fingerprint of a whole descriptor set (page order matters). */
export function fingerprintDescriptors(
  descriptors: readonly PageDescriptor[],
): string {
  return descriptors.map(fingerprintDescriptor).join(":");
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
    // T040 — budget gates, fail-fast inside the worker. Dimensions use the
    // visible box (the only box PDF.js exposes on the main thread); the
    // classifier derives the authoritative MediaBox and the policy layer
    // re-checks physical dimensions on that evidence.
    const dimKind = checkPhysicalDimensions(
      (x1 - x0) * userUnit,
      (y1 - y0) * userUnit,
    );
    if (dimKind !== null) throw new BudgetExceededError(dimKind, n);
    const opKind = checkOperatorCount(await page.countOperators());
    if (opKind !== null) throw new BudgetExceededError(opKind, n);
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
