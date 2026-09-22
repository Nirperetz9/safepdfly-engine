/**
 * T085 — Isolated read-only MuPDF classifier.
 *
 * Produces per-page evidence (independent boxes, rotation, UserUnit,
 * text/image presence) used by the dual-engine comparison (T036) and the
 * scanned/hybrid policy (T037), plus document-level unsupported-feature
 * evidence (T038). Evidence only — verdicts belong to the support-policy
 * layer.
 *
 * Resource budgets are enforced by the orchestrator (T036/T040) before this
 * classifier runs; the classifier itself only reports what it sees, except
 * for the page-count early guard (T040) that prevents walking a pathological
 * page tree.
 */
import type {
  DocumentFeatures,
  NativeBox,
  PageMarkupEvidence,
  ReadOnlyDocument,
} from "./readonly-facade.js";
import { checkPageCount } from "../support-policy/budgets.js";

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
  /** Annotation / optional-content evidence for the T086 boundary check. */
  markup: PageMarkupEvidence;
  /**
   * T040 — Largest single image XObject on the page, in decoded pixels
   * (/Width × /Height from the image dictionary; no decoding). The
   * support-policy layer adjudicates it against the render-surface budget.
   */
  maxImagePixels: number;
}

export interface ClassifyReport {
  pageCount: number;
  pages: readonly ClassifyPageEvidence[];
  /**
   * Document-level unsupported-feature evidence (T038). The support-policy
   * layer adjudicates these before page-level verdicts; a hostile feature on
   * a zero-page document still rejects it (fail-closed).
   */
  features: DocumentFeatures;
}

/** Stable classifier failure codes (subset of SupportReasonCode semantics). */
export type ClassifyFailureCode =
  | "not-a-pdf"
  | "encrypted"
  | "corrupt"
  | "empty"
  | "over-limit";

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

function hasAnyFeature(features: DocumentFeatures): boolean {
  return (
    features.xfa ||
    features.formWidgets ||
    features.signed ||
    features.embeddedFiles ||
    features.javaScript ||
    features.richMedia
  );
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
  // Unsupported-feature evidence is collected before the page gates: a
  // zero-page document carrying e.g. a JavaScript OpenAction is hostile,
  // not merely empty, and must be rejected with its feature code.
  let features: DocumentFeatures;
  try {
    features = doc.documentFeatures();
  } catch {
    throw new ClassifyError("corrupt");
  }
  if (pageCount === 0) {
    if (hasAnyFeature(features)) {
      return {
        pageCount: 0,
        pages: Object.freeze([]),
        features,
      };
    }
    throw new ClassifyError("empty");
  }
  // T040 — page-count early guard: never walk a pathological page tree.
  // (A verdict on dimensions/images belongs to the support-policy layer,
  // which reads the evidence collected below.)
  if (checkPageCount(pageCount) !== null) {
    throw new ClassifyError("over-limit");
  }

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
        markup: page.markupEvidence(),
        maxImagePixels: page.maxImagePixels(),
      };
    } catch {
      throw new ClassifyError("corrupt");
    }
    pages.push(pageEvidence);
  }
  return { pageCount, pages: deepFreezePages(pages), features };
}
