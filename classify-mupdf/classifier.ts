/**
 * T085 — Isolated read-only MuPDF classifier.
 *
 * Produces per-page evidence (independent boxes, rotation, UserUnit,
 * text/image presence) used by the dual-engine comparison (T036) and the
 * scanned/hybrid policy (T037). Evidence only — verdicts belong to the
 * support-policy layer.
 *
 * Resource budgets are enforced by the orchestrator (T036/T040) before this
 * classifier runs; the classifier itself only reports what it sees.
 */
import type {
  NativeBox,
  ReadOnlyDocument,
} from "./readonly-facade.js";

export interface ClassifyPageEvidence {
  pageIndex: number;
  /** MediaBox in MuPDF native coordinates (y-up). */
  mediaBox: NativeBox;
  /** CropBox in MuPDF native coordinates (y-up). */
  cropBox: NativeBox;
  /** Normalized /Rotate. */
  rotation: number;
  /** /UserUnit, default 1. */
  userUnit: number;
  /** Non-whitespace text characters seen via structured text. */
  textChars: number;
  /** Image blocks seen via structured text. */
  imageBlocks: number;
  /** Fraction of the visible page area covered by raster images (0..1). */
  imageCoverage: number;
}

export interface ClassifyReport {
  pageCount: number;
  pages: readonly ClassifyPageEvidence[];
}

/** Stable classifier failure codes (subset of SupportReasonCode semantics). */
export type ClassifyFailureCode =
  | "not-a-pdf"
  | "encrypted"
  | "corrupt"
  | "empty";

export class ClassifyError extends Error {
  readonly code: ClassifyFailureCode;
  constructor(code: ClassifyFailureCode) {
    super(`classify:${code}`);
    this.name = "ClassifyError";
    this.code = code;
  }
}

export interface ClassifyDeps {
  open: (data: ArrayBuffer) => ReadOnlyDocument;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-

function hasPdfMagic(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  if (view.length < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((b, i) => view[i] === b);
}

function deepFreezePages(
  pages: ClassifyPageEvidence[],
): readonly ClassifyPageEvidence[] {
  for (const p of pages) Object.freeze(p);
  return Object.freeze(pages);
}

/**
 * Classify one document's pages. Throws ClassifyError with a stable code on
 * encrypted, corrupt, empty, or non-PDF input. Never retains document bytes
 * or extracted text beyond the returned evidence counts.
 */
export async function classifySource(
  bytes: ArrayBuffer,
  deps: ClassifyDeps,
): Promise<ClassifyReport> {
  if (!(bytes instanceof ArrayBuffer) || !hasPdfMagic(bytes)) {
    throw new ClassifyError("not-a-pdf");
  }
  let doc: ReadOnlyDocument;
  try {
    doc = deps.open(bytes);
  } catch {
    throw new ClassifyError("corrupt");
  }
  // Encrypted documents must fail closed here: the classifier never attempts
  // password authentication (no user-supplied password exists in MVP).
  let encrypted: boolean;
  try {
    encrypted = doc.isEncrypted();
  } catch {
    throw new ClassifyError("corrupt");
  }
  if (encrypted) throw new ClassifyError("encrypted");
  // A document the engine had to repair is structurally untrustworthy;
  // fail closed as corrupt rather than classifying the repaired view.
  let repaired: boolean;
  try {
    repaired = doc.wasRepaired();
  } catch {
    throw new ClassifyError("corrupt");
  }
  if (repaired) throw new ClassifyError("corrupt");
  let pageCount: number;
  try {
    pageCount = doc.pageCount();
  } catch {
    throw new ClassifyError("corrupt");
  }
  if (pageCount === 0) throw new ClassifyError("empty");

  const pages: ClassifyPageEvidence[] = [];
  for (let i = 0; i < pageCount; i++) {
    let pageEvidence: ClassifyPageEvidence;
    try {
      const page = doc.page(i);
      const { chars, imageBlocks, imageCoverage } = page.contentEvidence();
      pageEvidence = {
        pageIndex: i,
        mediaBox: page.getMediaBox(),
        cropBox: page.getCropBox(),
        rotation: page.rotation(),
        userUnit: page.userUnit(),
        textChars: chars,
        imageBlocks,
        imageCoverage,
      };
    } catch {
      throw new ClassifyError("corrupt");
    }
    pages.push(pageEvidence);
  }
  return { pageCount, pages: deepFreezePages(pages) };
}
