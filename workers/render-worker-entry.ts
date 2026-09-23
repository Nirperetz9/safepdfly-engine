/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T041 — Render worker entry point (browser Web Worker).
 *
 * Lives in `app/` (not `pdf/`) because it composes the engine layer with the
 * privacy layer: the network guard is installed before any document bytes are
 * handled (T027). The worker persists for one review session: OPEN_RENDERER
 * opens the document once, RENDER_PAGE rasterizes on demand, CLOSE_RENDERER
 * destroys it. The host terminates the worker on session close regardless.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { createPdfJsEngine } from "../input/engine.js";
import { createRenderHandler, type RenderWorkerRequest } from "../input/render.js";
import { installNetworkGuard } from "../network-guard.js";

const engine = createPdfJsEngine(pdfjs, { workerSrc: pdfWorkerUrl });

// After local assets initialize, document processing cannot reach the
// network — even if a future code path tried (T027, defense in depth).
installNetworkGuard(globalThis as unknown as Record<string, unknown>);

const handler = createRenderHandler({ engine });

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent): void => {
  const data = event.data as { bytes?: unknown; type?: unknown } | null;
  const bytes = data?.bytes as ArrayBuffer | undefined;
  void handler.dispatch(data as RenderWorkerRequest, bytes).then((response) => {
    const transfer: Transferable[] =
      response.type === "PAGE_RENDERED" ? [response.bitmap] : [];
    scope.postMessage(response, transfer);
  });
};
