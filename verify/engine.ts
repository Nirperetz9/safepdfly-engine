/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T064 — PDF.js engine adapter for the verification worker.
 *
 * Hardening mirrors the input engine (T033): XFA disabled, strict parsing
 * (`stopAtErrors`), and evaluation needs no disabling — the pinned PDF.js
 * 6.3.289 bundle contains no `new Function`/`eval` path over document
 * content (PostScript functions run through a WASM/interpreter path), so
 * the legacy `isEvalSupported` option no longer exists. Same-origin engine
 * assets only, installed before any document bytes are handled.
 *
 * The adapter is dependency-injected so the handler is testable without a
 * browser worker. Production passes the real `pdfjs-dist` module; the
 * worker entry sets `GlobalWorkerOptions.workerSrc` to the self-hosted
 * worker asset — same origin only, never a CDN.
 */
import type * as pdfjsTypes from "pdfjs-dist/legacy/build/pdf.mjs";

export type PdfJsModule = typeof pdfjsTypes;

export interface VerifyTextItem {
  readonly str: string;
  /**
   * Text rendering matrix [a,b,c,d,e,f] mapping glyph space to default
   * user space (y-up, MediaBox origin) — the same space VerifyRects use.
   */
  readonly transform: readonly [number, number, number, number, number, number];
  readonly width: number;
  readonly hasEOL: boolean;
}

export interface VerifyPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface VerifyPage {
  /** Effective visible box (CropBox ∩ MediaBox), y-up, MediaBox origin. */
  readonly view: readonly [number, number, number, number];
  readonly rotate: number;
  textItems(): Promise<readonly VerifyTextItem[]>;
  /**
   * Deterministic render at `scale` device px per point, with page rotation
   * applied. Device pixels, y-down, top-left origin.
   */
  render(scale: number): Promise<VerifyPixels>;
  /**
   * Map a default-user-space point (y-up) to device pixels of render(scale).
   * Uses the same viewport the render uses, so rects and pixels agree even
   * for rotated pages and non-default CropBoxes.
   */
  toDevice(scale: number, x: number, y: number): readonly [number, number];
}

export interface VerifyDoc {
  readonly numPages: number;
  /** 1-based page numbers, like PDF.js. */
  page(n: number): Promise<VerifyPage>;
  /** Names of document-level JavaScript actions (must be empty). */
  jsActionNames(): Promise<readonly string[]>;
  /** Names of embedded file attachments (must be empty). */
  attachmentNames(): Promise<readonly string[]>;
  /**
   * Fully-qualified names of every AcroForm field, flattened recursively
   * (a nested field introduced under an existing parent still counts).
   */
  fieldNames(): Promise<readonly string[]>;
  close(): Promise<void>;
}

export interface VerifyEngine {
  open(data: Uint8Array): Promise<VerifyDoc>;
  readonly name: "pdfjs";
  readonly version: string;
}

function toMatrix6(
  value: unknown,
): [number, number, number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 6) return null;
  const [a, b, c, d, e, f] = value;
  return typeof a === "number" &&
    typeof b === "number" &&
    typeof c === "number" &&
    typeof d === "number" &&
    typeof e === "number" &&
    typeof f === "number"
    ? [a, b, c, d, e, f]
    : null;
}

class PdfJsVerifyPage implements VerifyPage {
  constructor(private readonly page: pdfjsTypes.PDFPageProxy) {}

  get view(): readonly [number, number, number, number] {
    const [x0, y0, x1, y1] = this.page.view;
    return [x0 ?? 0, y0 ?? 0, x1 ?? 0, y1 ?? 0];
  }

  get rotate(): number {
    return this.page.rotate;
  }

  async textItems(): Promise<readonly VerifyTextItem[]> {
    const content = await this.page.getTextContent();
    const items: VerifyTextItem[] = [];
    for (const raw of content.items) {
      if (!("str" in raw) || typeof raw.str !== "string") continue;
      const matrix = toMatrix6((raw as { transform?: unknown }).transform);
      if (matrix === null) continue;
      items.push({
        str: raw.str,
        transform: matrix,
        width: typeof raw.width === "number" ? raw.width : 0,
        hasEOL: (raw as { hasEOL?: unknown }).hasEOL === true,
      });
    }
    return items;
  }

  async render(scale: number): Promise<VerifyPixels> {
    const viewport = this.page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("verify: 2d context unavailable");
    try {
      await this.page.render({
        // When the context is supplied, `canvas` must be null
        // (backwards-compat path, same as the T033 input engine).
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const image = ctx.getImageData(0, 0, width, height);
      return { width, height, data: image.data };
    } finally {
      ctx.clearRect(0, 0, width, height);
    }
  }

  toDevice(scale: number, x: number, y: number): readonly [number, number] {
    const viewport = this.page.getViewport({ scale });
    const [px, py] = viewport.convertToViewportPoint(x, y);
    return [px, py];
  }
}

class PdfJsVerifyDoc implements VerifyDoc {
  constructor(
    private readonly task: pdfjsTypes.PDFDocumentLoadingTask,
    private readonly doc: pdfjsTypes.PDFDocumentProxy,
  ) {}

  get numPages(): number {
    return this.doc.numPages;
  }

  async page(n: number): Promise<VerifyPage> {
    return new PdfJsVerifyPage(await this.doc.getPage(n));
  }

  async jsActionNames(): Promise<readonly string[]> {
    const actions = await this.doc.getJSActions();
    return actions === null ? [] : [...actions.keys()].map(String);
  }

  async attachmentNames(): Promise<readonly string[]> {
    const attachments = await this.doc.getAttachments();
    return attachments === null ? [] : [...attachments.keys()];
  }

  async fieldNames(): Promise<readonly string[]> {
    const fields = await this.doc.getFieldObjects();
    if (fields === null) return [];
    const names: string[] = [];
    const walk = (node: unknown, prefix: string): void => {
      if (!(node instanceof Map)) return;
      for (const [key, value] of node) {
        const name = prefix === "" ? String(key) : `${prefix}.${String(key)}`;
        names.push(name);
        const kids = (value as { kids?: unknown } | null)?.kids;
        walk(kids, name);
      }
    };
    walk(fields, "");
    return names;
  }

  async close(): Promise<void> {
    await this.task.destroy().catch(() => undefined);
  }
}

export interface PdfJsVerifyEngineOptions {
  readonly workerSrc: string;
}

export function createPdfJsVerifyEngine(
  pdfjs: PdfJsModule,
  options: PdfJsVerifyEngineOptions,
): VerifyEngine {
  pdfjs.GlobalWorkerOptions.workerSrc = options.workerSrc;
  return {
    name: "pdfjs",
    version: pdfjs.version,
    async open(data: Uint8Array): Promise<VerifyDoc> {
      const task = pdfjs.getDocument({
        data,
        enableXfa: false,
        useSystemFonts: true,
        // Strict parsing: malformed structures reject instead of being
        // silently repaired where PDF.js can detect them.
        stopAtErrors: true,
      });
      try {
        const doc = await task.promise;
        return new PdfJsVerifyDoc(task, doc);
      } catch (error) {
        await task.destroy().catch(() => undefined);
        throw error;
      }
    },
  };
}
