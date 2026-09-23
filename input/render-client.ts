/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T041 — Host-side client for the render worker.
 *
 * One client per review session: `open` transfers a COPY of the source
 * bytes, `renderPage` serves one active page render at a time, and `close`
 * sends CLOSE_RENDERER and terminates the worker (Tier 2 cleanup).
 *
 * Supersede: only the latest renderPage request is honored. An older
 * response arriving late has its bitmap closed immediately and its promise
 * rejects with a `superseded` error, so the stage can never paint a stale
 * page.
 */
import {
  RENDER_POLICY_VERSION,
  type RenderWorkerRequest,
  type RenderWorkerResponse,
  type TextExtractFailureCode,
} from "./render.js";
import type { TextItem } from "./protocol.js";

export interface MinimalRenderWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

export interface RenderedPage {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export class RenderSupersededError extends Error {
  constructor() {
    super("render superseded by a newer request");
    this.name = "RenderSupersededError";
  }
}

/**
 * T104 — the worker refused or failed text extraction. The `code` is the
 * stable worker failure code (`extraction_failed`, …); callers surface a
 * plain-language message, never the code alone.
 */
export class TextExtractError extends Error {
  readonly code: TextExtractFailureCode;
  constructor(code: TextExtractFailureCode) {
    super(`text extraction failed: ${code}`);
    this.name = "TextExtractError";
    this.code = code;
  }
}

export class TextExtractSupersededError extends Error {
  constructor() {
    super("text extraction superseded by a newer request");
    this.name = "TextExtractSupersededError";
  }
}

interface PendingRender {
  readonly resolve: (page: RenderedPage) => void;
  readonly reject: (error: Error) => void;
}

interface PendingTextExtract {
  readonly resolve: (items: readonly TextItem[]) => void;
  readonly reject: (error: Error) => void;
}

/** Per-page text-extraction timeout: extraction must not hang the UI. */
const TEXT_EXTRACT_TIMEOUT_MS = 30_000;

export class RenderWorkerClient {
  private worker: MinimalRenderWorker | null = null;
  private nextRequestId = 1;
  private pending: { requestId: number; pending: PendingRender } | null = null;
  private textPending: { requestId: number; pending: PendingTextExtract } | null = null;
  private opened = false;
  private closed = false;

  constructor(private readonly spawnWorker: () => MinimalRenderWorker) {}

  /** Transfer a copy of the source bytes; the host retains its own. */
  async open(bytes: ArrayBuffer): Promise<void> {
    if (this.worker !== null) throw new Error("render client already opened");
    const copy = bytes.slice(0);
    const worker = this.spawnWorker();
    this.worker = worker;
    worker.onmessage = (event) => this.onMessage(event.data as RenderWorkerResponse);
    worker.onerror = (event) => {
      this.failPending(new Error(`render worker error: ${event.message ?? "unknown"}`));
    };
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("render worker open timed out")), 30_000);
      this.openResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.openReject = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    // The bytes ride inside the message so they transfer with it.
    worker.postMessage(
      { type: "OPEN_RENDERER", policyVersion: RENDER_POLICY_VERSION, bytes: copy },
      [copy],
    );
    try {
      await opened;
      this.opened = true;
    } finally {
      this.openResolve = null;
      this.openReject = null;
    }
  }

  private openResolve: (() => void) | null = null;
  private openReject: ((error: Error) => void) | null = null;

  /**
   * Render a page. `pageIndex` is 0-based (UI convention); the worker uses
   * 1-based page numbers. Only the latest call's promise settles with a
   * page — earlier ones reject with RenderSupersededError.
   */
  renderPage(pageIndex: number, scale: number, maxPixels: number): Promise<RenderedPage> {
    if (!this.opened || this.closed || this.worker === null) {
      return Promise.reject(new Error("render client is not open"));
    }
    // Supersede any in-flight render.
    this.failPending(new RenderSupersededError());
    const requestId = this.nextRequestId++;
    const promise = new Promise<RenderedPage>((resolve, reject) => {
      this.pending = { requestId, pending: { resolve, reject } };
    });
    this.worker.postMessage({
      type: "RENDER_PAGE",
      requestId,
      pageIndex: pageIndex + 1,
      scale,
      maxPixels,
    } satisfies RenderWorkerRequest);
    return promise;
  }

  /** Idempotent: close the renderer and terminate the worker. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new Error("render client closed"));
    this.failTextPending(new Error("render client closed"));
    const worker = this.worker;
    this.worker = null;
    this.pending = null;
    if (worker !== null) {
      try {
        worker.postMessage({ type: "CLOSE_RENDERER" } satisfies RenderWorkerRequest);
      } catch {
        // Best effort; terminate is authoritative.
      }
      worker.terminate();
    }
  }

  private failPending(error: Error): void {
    const current = this.pending;
    this.pending = null;
    current?.pending.reject(error);
  }

  private failTextPending(error: Error): void {
    const current = this.textPending;
    this.textPending = null;
    current?.pending.reject(error);
  }

  /**
   * T104 — extract one page's raw text items (text + geometry) for the
   * proprietary PII worker. `pageIndex` is 0-based (UI convention); the
   * worker uses 1-based page numbers. Only the latest extraction's promise
   * settles; an earlier one rejects with TextExtractSupersededError.
   * Rejects with TextExtractError carrying the worker's stable failure
   * code (`extraction_failed`, …) on a failed extraction. The host relays
   * the items to the PII worker; no PII matching happens here.
   */
  extractTextPage(pageIndex: number): Promise<readonly TextItem[]> {
    if (!this.opened || this.closed || this.worker === null) {
      return Promise.reject(new Error("render client is not open"));
    }
    // Supersede any in-flight extraction.
    this.failTextPending(new TextExtractSupersededError());
    const requestId = this.nextRequestId++;
    const promise = new Promise<readonly TextItem[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failTextPending(new Error("text extraction timed out"));
      }, TEXT_EXTRACT_TIMEOUT_MS);
      this.textPending = {
        requestId,
        pending: {
          resolve: (items) => {
            clearTimeout(timer);
            resolve(items);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        },
      };
    });
    this.worker.postMessage({
      type: "EXTRACT_TEXT_PAGE",
      requestId,
      pageIndex: pageIndex + 1,
    } satisfies RenderWorkerRequest);
    return promise;
  }

  private onMessage(response: RenderWorkerResponse): void {
    if (response === null || typeof response !== "object") return;
    switch (response.type) {
      case "RENDERER_OPENED":
        this.openResolve?.();
        return;
      case "RENDERER_CLOSED":
        return;
      case "RENDER_FAILED": {
        const code = response.code;
        if (this.openResolve !== null && code !== undefined && response.requestId === undefined) {
          this.openReject?.(new Error(`render worker failed to open: ${code}`));
          return;
        }
        this.failPending(new Error(`render failed: ${code}`));
        return;
      }
      case "PAGE_RENDERED": {
        const current = this.pending;
        if (current === null || current.requestId !== response.requestId) {
          // Stale: never paint it; release the bitmap immediately.
          response.bitmap.close();
          return;
        }
        this.pending = null;
        current.pending.resolve({
          bitmap: response.bitmap,
          width: response.width,
          height: response.height,
          scale: response.scale,
        });
        return;
      }
      case "TEXT_PAGE_EXTRACTED": {
        const current = this.textPending;
        if (current === null || current.requestId !== response.requestId) {
          // Stale extraction: drop it; items belong to a superseded request.
          return;
        }
        this.textPending = null;
        current.pending.resolve(response.items);
        return;
      }
      case "TEXT_PAGE_FAILED": {
        const current = this.textPending;
        if (current === null || current.requestId !== response.requestId) return;
        this.textPending = null;
        current.pending.reject(new TextExtractError(response.code));
        return;
      }
    }
  }
}
