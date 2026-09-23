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
  type PiiFailureCode,
  type PiiKind,
  type PiiWorkerCandidate,
  type RenderWorkerRequest,
  type RenderWorkerResponse,
} from "./render.js";

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
 * T097 — the worker refused or failed the PII scan. The `code` is the
 * stable worker failure code (`no_text_layer`, `extraction_failed`, …);
 * callers surface a plain-language message, never the code alone.
 */
export class PiiScanError extends Error {
  readonly code: PiiFailureCode;
  constructor(code: PiiFailureCode) {
    super(`pii scan failed: ${code}`);
    this.name = "PiiScanError";
    this.code = code;
  }
}

export class PiiScanSupersededError extends Error {
  constructor() {
    super("pii scan superseded by a newer scan");
    this.name = "PiiScanSupersededError";
  }
}

interface PendingRender {
  readonly resolve: (page: RenderedPage) => void;
  readonly reject: (error: Error) => void;
}

interface PendingPiiScan {
  readonly resolve: (candidates: readonly PiiWorkerCandidate[]) => void;
  readonly reject: (error: Error) => void;
}

/** Per-page PII scan timeout: extraction + matching must not hang the UI. */
const PII_SCAN_TIMEOUT_MS = 30_000;

export class RenderWorkerClient {
  private worker: MinimalRenderWorker | null = null;
  private nextRequestId = 1;
  private pending: { requestId: number; pending: PendingRender } | null = null;
  private piiPending: { requestId: number; pending: PendingPiiScan } | null = null;
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
    this.failPiiPending(new Error("render client closed"));
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

  private failPiiPending(error: Error): void {
    const current = this.piiPending;
    this.piiPending = null;
    current?.pending.reject(error);
  }

  /**
   * T097 — scan one page's text layer for the given PII kinds.
   * `pageIndex` is 0-based (UI convention); the worker uses 1-based page
   * numbers. Resolves with candidate geometry only — matched text values
   * never cross the worker boundary. Only the latest scan's promise
   * settles; an earlier one rejects with PiiScanSupersededError. Rejects
   * with PiiScanError carrying the worker's stable failure code
   * (`no_text_layer`, `extraction_failed`, …) on a failed scan.
   */
  findPiiPage(
    pageIndex: number,
    kinds: readonly PiiKind[],
  ): Promise<readonly PiiWorkerCandidate[]> {
    if (!this.opened || this.closed || this.worker === null) {
      return Promise.reject(new Error("render client is not open"));
    }
    // Supersede any in-flight scan.
    this.failPiiPending(new PiiScanSupersededError());
    const requestId = this.nextRequestId++;
    const promise = new Promise<readonly PiiWorkerCandidate[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPiiPending(new Error("pii scan timed out"));
      }, PII_SCAN_TIMEOUT_MS);
      this.piiPending = {
        requestId,
        pending: {
          resolve: (candidates) => {
            clearTimeout(timer);
            resolve(candidates);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        },
      };
    });
    this.worker.postMessage({
      type: "FIND_PII_PAGE",
      requestId,
      pageIndex: pageIndex + 1,
      kinds,
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
      case "PII_PAGE_FOUND": {
        const current = this.piiPending;
        if (current === null || current.requestId !== response.requestId) {
          // Stale scan: drop it; candidates belong to a superseded scan.
          return;
        }
        this.piiPending = null;
        current.pending.resolve(response.candidates);
        return;
      }
      case "PII_PAGE_FAILED": {
        const current = this.piiPending;
        if (current === null || current.requestId !== response.requestId) return;
        this.piiPending = null;
        current.pending.reject(new PiiScanError(response.code));
        return;
      }
    }
  }
}
