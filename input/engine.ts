/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T033 — PDF.js engine adapter for the input worker.
 *
 * The adapter is dependency-injected so the message handler is testable
 * without a browser worker. Production passes the real `pdfjs-dist` module;
 * the worker entry sets `GlobalWorkerOptions.workerSrc` to the self-hosted
 * worker asset and `standardFontDataUrl` to the self-hosted fonts — same
 * origin only, never a CDN.
 */
import type * as pdfjsTypes from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "./protocol.js";

export type PdfJsModule = typeof pdfjsTypes;

export interface InputEnginePage {
  /** Normalized rotation, 0 | 90 | 180 | 270. */
  readonly rotate: number;
  readonly userUnit: number;
  /** Effective visible box (CropBox ∩ MediaBox), y-up, MediaBox origin. */
  readonly view: readonly [number, number, number, number];
  /** True when any non-whitespace text item exists on the page. */
  hasNonWhitespaceText(): Promise<boolean>;
  /**
   * T104 — raw text items in default user space (y-up) for the proprietary
   * PII worker (see src/pdf/pii). Runs in the render worker; the host
   * relays the items to the PII worker, which returns candidate geometry
   * only — matched values never leave the PII worker.
   */
  textItems(): Promise<readonly TextItem[]>;
  /**
   * T040 — Number of content-stream operators on the page, for the
   * per-page operator budget guard. A full parse; the worker time budget
   * bounds pathological streams.
   */
  countOperators(): Promise<number>;
}

/** A rendered page bitmap produced inside the render worker. */
export interface PageRender {
  /** Transferred bitmap; the receiver owns it and must close it. */
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
}

export interface InputEngineDoc {
  readonly numPages: number;
  page(n: number): Promise<InputEnginePage>;
  /**
   * T041 — Render page `n` (1-based) at the given scale (device px per
   * point) into an OffscreenCanvas and transfer the bitmap. Runs in the
   * render worker; `scale` is validated by the render protocol handler.
   */
  renderPage(n: number, scale: number): Promise<PageRender>;
  destroy(): Promise<void>;
}

export interface InputEngine {
  readonly name: "pdfjs";
  readonly version: string;
  open(data: Uint8Array): Promise<InputEngineDoc>;
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

class PdfJsEnginePage implements InputEnginePage {
  constructor(private readonly page: pdfjsTypes.PDFPageProxy) {}

  get rotate(): number {
    return this.page.rotate;
  }

  get userUnit(): number {
    return this.page.userUnit;
  }

  get view(): readonly [number, number, number, number] {
    const [x0, y0, x1, y1] = this.page.view;
    return [x0 ?? 0, y0 ?? 0, x1 ?? 0, y1 ?? 0];
  }

  async hasNonWhitespaceText(): Promise<boolean> {
    const content = await this.page.getTextContent();
    return content.items.some(
      (item) =>
        typeof (item as { str?: unknown }).str === "string" &&
        ((item as { str: string }).str.trim().length > 0 ||
          (item as { hasEOL?: boolean }).hasEOL === true),
    );
  }

  async countOperators(): Promise<number> {
    const ops = await this.page.getOperatorList();
    return ops.fnArray.length;
  }

  async textItems(): Promise<readonly TextItem[]> {
    const content = await this.page.getTextContent();
    const items: TextItem[] = [];
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
}

class PdfJsEngineDoc implements InputEngineDoc {
  constructor(
    private readonly task: pdfjsTypes.PDFDocumentLoadingTask,
    private readonly doc: pdfjsTypes.PDFDocumentProxy,
  ) {}

  get numPages(): number {
    return this.doc.numPages;
  }

  async page(n: number): Promise<InputEnginePage> {
    return new PdfJsEnginePage(await this.doc.getPage(n));
  }

  async renderPage(n: number, scale: number): Promise<PageRender> {
    const page = await this.doc.getPage(n);
    try {
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { alpha: false });
      if (ctx === null) throw new Error("2d context unavailable");
      // pdf.js accepts an OffscreenCanvas 2d context at runtime; the DOM
      // lib types only know the on-screen context, hence the cast. When the
      // context is supplied, `canvas` must be null (backwards-compat path).
      await page.render({
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      return { bitmap: canvas.transferToImageBitmap(), width, height };
    } finally {
      // Release page resources promptly: one active page render at a time.
      page.cleanup();
    }
  }

  async destroy(): Promise<void> {
    await this.task.destroy();
  }
}

export interface PdfJsEngineOptions {
  /**
   * Same-origin URL of the PDF.js worker asset. The engine never fetches a
   * remote worker.
   */
  workerSrc: string;
  /** Same-origin base URL of the standard 14 fonts (optional but preferred). */
  standardFontDataUrl?: string;
}

/**
 * Create the PDF.js input engine. The engine is hardened for untrusted
 * input: XFA processing is disabled, and evaluation needs no disabling —
 * the pinned PDF.js 6.3.289 worker bundle contains no `new Function(`/`eval`
 * path over document content (PostScript functions run through a
 * WASM/interpreter path), so the legacy `isEvalSupported` option no longer
 * exists and there is no eval path to turn off. The caller supplies only
 * same-origin asset URLs; no remote asset URL is ever used.
 */
export function createPdfJsEngine(
  pdfjs: PdfJsModule,
  options: PdfJsEngineOptions,
): InputEngine {
  pdfjs.GlobalWorkerOptions.workerSrc = options.workerSrc;
  return {
    name: "pdfjs",
    version: pdfjs.version,
    async open(data: Uint8Array): Promise<InputEngineDoc> {
      const task = pdfjs.getDocument({
        data,
        enableXfa: false,
        useSystemFonts: true,
        ...(options.standardFontDataUrl !== undefined
          ? { standardFontDataUrl: options.standardFontDataUrl }
          : {}),
      });
      try {
        const doc = await task.promise;
        return new PdfJsEngineDoc(task, doc);
      } catch (error) {
        await task.destroy().catch(() => undefined);
        throw error;
      }
    },
  };
}
