/**
 * T041 — Render worker protocol (PDF.js page rasterization for the page
 * stage). The render worker is separate from the single-use input worker:
 * it opens the document ONCE per review session and serves page renders on
 * demand, one active page render at a time. Bytes stay in the worker; the
 * host receives only transferred ImageBitmaps — no document content ever
 * enters UI state.
 *
 * Fail-closed: unknown messages, invalid scales, and engine errors produce
 * RENDER_FAILED with an allowlisted code. Raw engine errors, filenames, and
 * extracted text never cross the boundary.
 */
import type { InputEngine, InputEngineDoc, PageRender } from "./engine.js";

/** Bump when the render wire format changes. */
export const RENDER_POLICY_VERSION = 1;

export type RenderWorkerRequest =
  | { readonly type: "OPEN_RENDERER"; readonly policyVersion: number }
  | {
      readonly type: "RENDER_PAGE";
      readonly requestId: number;
      /** 1-based page number. */
      readonly pageIndex: number;
      /** Device pixels per PDF point. Validated by the handler. */
      readonly scale: number;
      /** Upper bound on rendered pixels (from the page descriptor budget). */
      readonly maxPixels: number;
    }
  | { readonly type: "CLOSE_RENDERER" };

export type RenderFailureCode = "invalid_request" | "render_failed" | "closed" | "not_open";

export type RenderWorkerResponse =
  | { readonly type: "RENDERER_OPENED" }
  | {
      readonly type: "PAGE_RENDERED";
      readonly requestId: number;
      readonly width: number;
      readonly height: number;
      readonly scale: number;
      /** Transferred to the host; the host owns and must close it. */
      readonly bitmap: ImageBitmap;
    }
  | { readonly type: "RENDER_FAILED"; readonly requestId?: number; readonly code: RenderFailureCode }
  | { readonly type: "RENDERER_CLOSED" };

export interface RenderHandlerDeps {
  readonly engine: InputEngine;
}

/** Hard bounds on a single render: scale is device px per point. */
export const MIN_RENDER_SCALE = 0.05;
export const MAX_RENDER_SCALE = 16;

/**
 * Stateful render message handler. Pure logic shared by the browser worker
 * entry and the tests: bytes arrive with the dispatch call (transferred by
 * the client on OPEN_RENDERER).
 */
export function createRenderHandler(deps: RenderHandlerDeps) {
  let doc: InputEngineDoc | null = null;
  let closed = false;

  function failed(requestId: number | undefined, code: RenderFailureCode): RenderWorkerResponse {
    return requestId === undefined
      ? { type: "RENDER_FAILED", code }
      : { type: "RENDER_FAILED", requestId, code };
  }

  return {
    async dispatch(
      message: RenderWorkerRequest,
      bytes: ArrayBuffer | undefined,
    ): Promise<RenderWorkerResponse> {
      if (message === null || typeof message !== "object" || typeof message.type !== "string") {
        return failed(undefined, "invalid_request");
      }
      switch (message.type) {
        case "OPEN_RENDERER": {
          if (message.policyVersion !== RENDER_POLICY_VERSION) {
            return failed(undefined, "invalid_request");
          }
          if (closed || doc !== null) return failed(undefined, "invalid_request");
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) {
            return failed(undefined, "invalid_request");
          }
          try {
            doc = await deps.engine.open(new Uint8Array(bytes));
          } catch {
            doc = null;
            return failed(undefined, "render_failed");
          }
          return { type: "RENDERER_OPENED" };
        }
        case "RENDER_PAGE": {
          const { requestId, pageIndex, scale, maxPixels } = message;
          if (doc === null || closed) return failed(requestId, closed ? "closed" : "not_open");
          if (
            !Number.isInteger(requestId) ||
            !Number.isInteger(pageIndex) ||
            pageIndex < 1 ||
            pageIndex > doc.numPages ||
            !Number.isFinite(scale) ||
            scale < MIN_RENDER_SCALE ||
            scale > MAX_RENDER_SCALE ||
            !Number.isFinite(maxPixels) ||
            maxPixels <= 0
          ) {
            return failed(requestId, "invalid_request");
          }
          let rendered: PageRender;
          try {
            rendered = await doc.renderPage(pageIndex, scale);
          } catch {
            return failed(requestId, "render_failed");
          }
          if (rendered.width * rendered.height > maxPixels) {
            rendered.bitmap.close();
            return failed(requestId, "invalid_request");
          }
          return {
            type: "PAGE_RENDERED",
            requestId,
            width: rendered.width,
            height: rendered.height,
            scale,
            bitmap: rendered.bitmap,
          };
        }
        case "CLOSE_RENDERER": {
          closed = true;
          const d = doc;
          doc = null;
          if (d !== null) {
            try {
              await d.destroy();
            } catch {
              // Best effort: the host terminates the worker regardless.
            }
          }
          return { type: "RENDERER_CLOSED" };
        }
        default:
          return failed(
            (message as { requestId?: number }).requestId,
            "invalid_request",
          );
      }
    },
  };
}
