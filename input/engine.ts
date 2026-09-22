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

export type PdfJsModule = typeof pdfjsTypes;

export interface InputEnginePage {
  /** Normalized rotation, 0 | 90 | 180 | 270. */
  readonly rotate: number;
  readonly userUnit: number;
  /** Effective visible box (CropBox ∩ MediaBox), y-up, MediaBox origin. */
  readonly view: readonly [number, number, number, number];
  /** True when any non-whitespace text item exists on the page. */
  hasNonWhitespaceText(): Promise<boolean>;
}

export interface InputEngineDoc {
  readonly numPages: number;
  page(n: number): Promise<InputEnginePage>;
  destroy(): Promise<void>;
}

export interface InputEngine {
  readonly name: "pdfjs";
  readonly version: string;
  open(data: Uint8Array): Promise<InputEngineDoc>;
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
