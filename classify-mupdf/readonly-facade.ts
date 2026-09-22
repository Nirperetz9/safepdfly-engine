/**
 * T085 — Read-only facade over MuPDF.js for the isolated classifier worker.
 *
 * This module is the ONLY place in the classifier path that imports "mupdf".
 * It exposes a minimal, frozen, read-only surface: open a document, count
 * pages, and read per-page geometry plus text/image evidence. No mutation,
 * save, redaction, annotation, or embedding API is reachable through the
 * returned objects — they are plain wrappers, not MuPDF instances.
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
  /** Text/image evidence from structured text (walker, no content kept). */
  textEvidence(): { chars: number; imageBlocks: number };
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
}

function toNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
    page(index: number): ReadOnlyPage {
      // openDocument on a PDF yields a PDFDocument; loadPage a PDFPage.
      // Cast through unknown so the facade never leaks MuPDF instance types.
      const raw = doc.loadPage(index) as unknown as {
        getBounds(box?: "MediaBox" | "CropBox"): [number, number, number, number];
        getObject(): { getInheritable(key: string): { valueOf(): unknown } };
        toStructuredText(options: string): {
          walk(walker: {
            onChar?: () => void;
            onImageBlock?: () => void;
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
        textEvidence(): { chars: number; imageBlocks: number } {
          let chars = 0;
          let imageBlocks = 0;
          raw.toStructuredText("").walk({
            onChar: () => {
              chars++;
            },
            onImageBlock: () => {
              imageBlocks++;
            },
          });
          return { chars, imageBlocks };
        },
      };
    },
  };
}
