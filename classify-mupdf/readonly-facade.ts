/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T085 — Read-only facade over MuPDF.js for the isolated classifier worker.
 *
 * This module is the ONLY place in the classifier path that imports "mupdf".
 * It exposes a minimal, frozen, read-only surface: open a document, count
 * pages, and read per-page geometry, text/image evidence, and annotation /
 * optional-content evidence. No mutation, save, redaction, annotation, or
 * embedding API is reachable through the returned objects — they are plain
 * wrappers, not MuPDF instances.
 *
 * A static test (classify.test.ts) enforces this boundary:
 *  - no other module in the classify path imports "mupdf";
 *  - forbidden mutation identifiers never appear in classifier sources.
 */
import { Document } from "mupdf";

/** Page rectangle in MuPDF native coordinates: y-up, [x0, y0, x1, y1]. */
export type NativeBox = readonly [number, number, number, number];

export interface ReadOnlyPage {
  /** Independent MediaBox, y-up. */
  getMediaBox(): NativeBox;
  /** Independent CropBox, y-up. */
  getCropBox(): NativeBox;
  /** Normalized /Rotate (0, 90, 180, 270). */
  rotation(): number;
  /** /UserUnit, defaulting to 1. */
  userUnit(): number;
  /**
   * Content evidence from structured text (walker, no content kept).
   * imageCoverage is the fraction of the visible page area covered by
   * raster image blocks (0..1) — the scanned/hybrid signal (T037).
   */
  contentEvidence(): { chars: number; imageBlocks: number; imageCoverage: number };
  /**
   * Annotation and optional-content evidence (T086), read-only.
   * Annotation rects are raw /Rect values in default user space
   * (unrotated, y-up) — the canonical frame selections use.
   */
  markupEvidence(): PageMarkupEvidence;
  /**
   * T040 — Largest single image XObject on the page, in decoded pixels
   * (/Width × /Height from the image dictionary; nothing is decoded).
   * 0 when the page has no image XObjects.
   */
  maxImagePixels(): number;
}

/**
 * T086 — Per-page markup evidence for the annotation/optional-content
 * support boundary. Evidence only; verdicts belong to support-policy.
 */
export interface PageMarkupEvidence {
  /** Annotations with their raw /Rect in default user space (canonical frame). */
  readonly annotations: readonly MarkupAnnotation[];
  /**
   * True when the annotation enumeration failed: an overlapping annotation
   * cannot be ruled out (fail-closed upstream as annotation-overlap).
   */
  readonly annotationsIndeterminate: boolean;
  /**
   * True when optional-content constructs affect the page (page /OC, OCG
   * marked-content properties, or OCG-gated XObjects), or when that could
   * not be ruled out (fail-closed upstream as hidden-layer).
   */
  readonly optionalContent: boolean;
}

export interface MarkupAnnotation {
  readonly type: string;
  readonly rect: NativeBox;
}

export interface ReadOnlyDocument {
  pageCount(): number;
  page(index: number): ReadOnlyPage;
  /** True when the document requires a password (checked before any page read). */
  isEncrypted(): boolean;
  /**
   * True when MuPDF had to repair the document structure during open.
   * A repaired document is not a trustworthy source for a safety verdict.
   */
  wasRepaired(): boolean;
  /**
   * Document-level unsupported-feature evidence (T038), read from the
   * trailer/catalog and page dictionaries. Read-only; never throws for
   * malformed structures — unreadable state yields all-false.
   */
  documentFeatures(): DocumentFeatures;
}

/**
 * T038 — Unsupported-feature evidence. Each flag maps to a stable
 * SupportReasonCode via adjudicateFeatures (support-policy/unsupported.ts).
 */
export interface DocumentFeatures {
  /** XFA form (AcroForm /XFA). */
  readonly xfa: boolean;
  /** Interactive form widgets (AcroForm fields or page widgets). */
  readonly formWidgets: boolean;
  /** Digital signature present (AcroForm /SigFlags bit 1). */
  readonly signed: boolean;
  /** Embedded files (/EmbeddedFiles name tree). */
  readonly embeddedFiles: boolean;
  /**
   * JavaScript or action-bearing constructs (OpenAction, /AA, name tree).
   * T103: split by source so intake can route exactly what T099 removes.
   */
  readonly javaScript: boolean;
  /**
   * T103 — JavaScript carried by document-level constructs (OpenAction,
   * catalog /AA, the /JavaScript name tree): fully removed by the T099
   * sanitize step.
   */
  readonly javaScriptDocument: boolean;
  /**
   * T103 — JavaScript carried by page-level /AA entries: NOT removed by
   * the T099 sanitize step, so it still hard-rejects as js-actions.
   */
  readonly javaScriptPage: boolean;
  /** Rich-media annotations (RichMedia/Sound/Movie/Screen/3D). */
  readonly richMedia: boolean;
}

export const NO_FEATURES: DocumentFeatures = Object.freeze({
  xfa: false,
  formWidgets: false,
  signed: false,
  embeddedFiles: false,
  javaScript: false,
  javaScriptDocument: false,
  javaScriptPage: false,
  richMedia: false,
});

function toNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Minimal structural type for trailer/catalog/page-dictionary reads.
 * Note: calling .get() on a null PDFObject throws, so every chain is
 * isNull-guarded. All operations are reads.
 */
type StructObj = {
  isNull(): boolean;
  get(key: string): StructObj;
  getInheritable(key: string): StructObj;
  valueOf(): unknown;
  asJS(): unknown;
  forEach(fn: (val: StructObj, key: number | string) => void): void;
  readonly length: number;
};

function normalizeBox(values: unknown): NativeBox | null {  if (!Array.isArray(values) || values.length !== 4) return null;
  const nums: number[] = [];
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    nums.push(v);
  }
  const [a, b, c, d] = nums as [number, number, number, number];
  return Object.freeze([
    Math.min(a, c),
    Math.min(b, d),
    Math.max(a, c),
    Math.max(b, d),
  ]) as NativeBox;
}

/**
 * True when an XObject name tree (or nested XObject resources, depth ≤ 2)
 * carries OCG gating: a direct /OC entry, or OCG marked-content
 * properties. Throws on walk errors so the caller can fail closed.
 */
function xobjectUsesOC(xobjects: StructObj, depth: number): boolean {
  if (depth > 2) return false;
  let found = false;
  xobjects.forEach((val) => {
    if (found) return;
    if (!val.get("OC").isNull()) {
      found = true;
      return;
    }
    const resources = val.get("Resources");
    if (!resources.isNull()) {
      const properties = resources.get("Properties");
      if (!properties.isNull()) {
        let count = 0;
        properties.forEach(() => {
          count++;
        });
        if (count > 0) {
          found = true;
          return;
        }
      }
      const nested = resources.get("XObject");
      if (!nested.isNull() && xobjectUsesOC(nested, depth + 1)) {
        found = true;
      }
    }
  });
  return found;
}

/**
 * T040 — Largest single image XObject in an XObject name tree (or nested
 * Form XObject resources, depth ≤ 2), in decoded pixels (/Width × /Height
 * from the image dictionary). Dictionary reads only — nothing is decoded.
 * Throws on walk errors so the caller can fail closed.
 */
function maxImagePixelsIn(xobjects: StructObj, depth: number): number {
  if (depth > 2) return 0;
  let max = 0;
  xobjects.forEach((val) => {
    const subtypeObj = val.get("Subtype");
    const subtype = subtypeObj.isNull() ? "" : String(subtypeObj.valueOf());
    if (subtype === "Image") {
      const w = toNumberOr(val.get("Width").valueOf(), 0);
      const h = toNumberOr(val.get("Height").valueOf(), 0);
      if (w > 0 && h > 0) max = Math.max(max, w * h);
    } else if (subtype === "Form") {
      const resources = val.get("Resources");
      if (!resources.isNull()) {
        const nested = resources.get("XObject");
        if (!nested.isNull()) {
          max = Math.max(max, maxImagePixelsIn(nested, depth + 1));
        }
      }
    }
  });
  return max;
}

export function openDocumentReadOnly(data: ArrayBuffer): ReadOnlyDocument {
  const doc = Document.openDocument(data);
  return {
    pageCount(): number {
      return doc.countPages();
    },
    isEncrypted(): boolean {
      return doc.needsPassword();
    },
    wasRepaired(): boolean {
      const pdfDoc = doc as unknown as { wasRepaired?: () => boolean };
      return typeof pdfDoc.wasRepaired === "function"
        ? pdfDoc.wasRepaired()
        : false;
    },
    documentFeatures(): DocumentFeatures {
      // Minimal structural type for the trailer/catalog reads. Note: calling
      // .get() on a null PDFObject throws, so every chain is isNull-guarded.
      type PdfObj = {
        isNull(): boolean;
        get(key: string): PdfObj;
        valueOf(): unknown;
        asJS(): unknown;
        readonly length: number;
      };
      // True when a converted action dictionary carries JavaScript.
      const mentionsJs = (value: unknown, depth: number): boolean => {
        if (depth > 4 || value === null || typeof value !== "object")
          return false;
        if (Array.isArray(value))
          return value.some((v) => mentionsJs(v, depth + 1));
        const obj = value as Record<string, unknown>;
        if (obj["S"] === "JavaScript" || "JS" in obj) return true;
        return Object.values(obj).some((v) => mentionsJs(v, depth + 1));
      };
      try {
        const pdf = doc as unknown as {
          getTrailer(): PdfObj;
          getEmbeddedFiles(): Record<string, unknown>;
        };
        const root = pdf.getTrailer().get("Root");
        const acro = root.get("AcroForm");
        const hasAcro = !acro.isNull();

        const xfa = hasAcro && !acro.get("XFA").isNull();

        const sigFlags = hasAcro ? acro.get("SigFlags").valueOf() : 0;
        const signed =
          typeof sigFlags === "number" && (sigFlags & 1) !== 0;

        const embeddedFiles =
          Object.keys(pdf.getEmbeddedFiles()).length > 0;

        const openAction = root.get("OpenAction");
        const docAA = root.get("AA");
        const names = root.get("Names");
        // T103 — split JavaScript by source: document-level constructs are
        // fully removed by the T099 sanitize step (soft route), page-level
        // /AA entries are not (hard reject).
        const javaScriptDocument =
          (!openAction.isNull() && mentionsJs(openAction.asJS(), 0)) ||
          (!docAA.isNull() && mentionsJs(docAA.asJS(), 0)) ||
          (!names.isNull() && !names.get("JavaScript").isNull());
        let javaScriptPage = false;

        let formWidgets = hasAcro && acro.get("Fields").length > 0;
        let richMedia = false;
        const RICH_MEDIA = new Set([
          "RichMedia",
          "Sound",
          "Movie",
          "Screen",
          "3D",
        ]);
        const pageCount = doc.countPages();
        for (let i = 0; i < pageCount; i++) {
          const rawPage = doc.loadPage(i) as unknown as {
            getWidgets(): unknown[];
            getAnnotations(): { getType(): string }[];
            getObject(): PdfObj;
          };
          if (!formWidgets && rawPage.getWidgets().length > 0)
            formWidgets = true;
          if (!richMedia) {
            for (const annot of rawPage.getAnnotations()) {
              if (RICH_MEDIA.has(annot.getType())) {
                richMedia = true;
                break;
              }
            }
          }
          if (!javaScriptPage) {
            const pageAA = rawPage.getObject().get("AA");
            if (!pageAA.isNull() && mentionsJs(pageAA.asJS(), 0))
              javaScriptPage = true;
          }
          if (formWidgets && richMedia && javaScriptDocument && javaScriptPage)
            break;
        }

        return Object.freeze({
          xfa,
          formWidgets,
          signed,
          embeddedFiles,
          javaScript: javaScriptDocument || javaScriptPage,
          javaScriptDocument,
          javaScriptPage,
          richMedia,
        });
      } catch {
        // T103 — unreadable feature structure fails closed: the caller
        // (classifier) maps the throw to a "corrupt" classify failure, so
        // intake rejects with "damaged". Silently claiming NO_FEATURES
        // here would let a corrupt EmbeddedFiles tree masquerade as
        // "no embedded files" and bypass the review notice + sanitization.
        throw new Error("unreadable-document-features");
      }
    },
    page(index: number): ReadOnlyPage {
      // openDocument on a PDF yields a PDFDocument; loadPage a PDFPage.
      // Cast through unknown so the facade never leaks MuPDF instance types.
      const raw = doc.loadPage(index) as unknown as {
        getBounds(box?: "MediaBox" | "CropBox"): [number, number, number, number];
        getObject(): StructObj;
        getAnnotations(): { getType(): string; getObject(): StructObj }[];
        toStructuredText(options: string): {
          walk(walker: {
            onChar?: () => void;
            onImageBlock?: (bbox: [number, number, number, number]) => void;
          }): void;
        };
      };
      const freezeBox = (r: [number, number, number, number]): NativeBox =>
        Object.freeze([r[0], r[1], r[2], r[3]]) as NativeBox;
      return {
        getMediaBox(): NativeBox {
          return freezeBox(raw.getBounds("MediaBox"));
        },
        getCropBox(): NativeBox {
          return freezeBox(raw.getBounds("CropBox"));
        },
        rotation(): number {
          const v = raw.getObject().getInheritable("Rotate").valueOf();
          const n = toNumberOr(v, 0);
          return ((Math.round(n) % 360) + 360) % 360;
        },
        userUnit(): number {
          const v = raw.getObject().getInheritable("UserUnit").valueOf();
          const n = toNumberOr(v, 1);
          return n > 0 ? n : 1;
        },
        contentEvidence(): { chars: number; imageBlocks: number; imageCoverage: number } {
          let chars = 0;
          let imageBlocks = 0;
          let imageArea = 0;
          // "preserve-images" is required for the stext device to emit
          // image blocks (verified against the mupdf-wasm option strings).
          raw.toStructuredText("preserve-images").walk({
            onChar: () => {
              chars++;
            },
            onImageBlock: (bbox: [number, number, number, number]) => {
              imageBlocks++;
              imageArea += Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
            },
          });
          const crop = raw.getBounds("CropBox");
          const pageArea =
            Math.max(0, crop[2] - crop[0]) * Math.max(0, crop[3] - crop[1]);
          const imageCoverage =
            pageArea > 0 ? Math.min(1, imageArea / pageArea) : 0;
          return { chars, imageBlocks, imageCoverage };
        },
        markupEvidence(): PageMarkupEvidence {
          const annotations: MarkupAnnotation[] = [];
          let annotationsIndeterminate = false;
          let optionalContent = false;
          // Annotation enumeration. Raw /Rect is read from the dictionary:
          // annot.getRect() is frame-transformed per subtype and throws for
          // some subtypes (verified: Highlight), so it is not used.
          try {
            for (const annot of raw.getAnnotations()) {
              let type = "unknown";
              try {
                type = String(annot.getType());
              } catch {
                annotationsIndeterminate = true;
                continue;
              }
              const rectObj = annot.getObject().get("Rect");
              if (rectObj.isNull()) {
                annotationsIndeterminate = true;
                continue;
              }
              const rect = normalizeBox(rectObj.asJS());
              if (rect === null) {
                annotationsIndeterminate = true;
                continue;
              }
              annotations.push(Object.freeze({ type, rect }));
            }
          } catch {
            annotationsIndeterminate = true;
          }
          // Optional-content constructs: page /OC, OCG marked-content
          // properties in Resources, or OCG-gated (nested) XObjects.
          // Any walk failure fails closed toward optionalContent = true.
          try {
            const pageObj = raw.getObject();
            if (!pageObj.get("OC").isNull()) {
              optionalContent = true;
            } else {
              const resources = pageObj.getInheritable("Resources");
              if (!resources.isNull()) {
                const properties = resources.get("Properties");
                if (!properties.isNull()) {
                  let count = 0;
                  properties.forEach(() => {
                    count++;
                  });
                  if (count > 0) optionalContent = true;
                }
                if (!optionalContent) {
                  const xobjects = resources.get("XObject");
                  if (!xobjects.isNull()) {
                    optionalContent = xobjectUsesOC(xobjects, 0);
                  }
                }
              }
            }
          } catch {
            optionalContent = true;
          }
          return Object.freeze({
            annotations: Object.freeze(annotations),
            annotationsIndeterminate,
            optionalContent,
          });
        },
        maxImagePixels(): number {
          // Dictionary reads only — the image stream is never decoded.
          // Any walk failure throws so the classifier fails closed.
          const pageObj = raw.getObject();
          const resources = pageObj.getInheritable("Resources");
          if (resources.isNull()) return 0;
          const xobjects = resources.get("XObject");
          if (xobjects.isNull()) return 0;
          return maxImagePixelsIn(xobjects, 0);
        },
      };
    },
  };
}
