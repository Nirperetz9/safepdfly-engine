/**
 * T033 — Input worker entry point (browser Web Worker).
 *
 * Lives in `app/` (not `pdf/`) because it composes the engine layer with the
 * privacy layer: the network guard is installed before any document bytes are
 * handled, and it cannot be bypassed by processing code (T027).
 *
 * The worker is single-use per open: it parses the transferred buffer,
 * responds, destroys the document, and the host terminates it. Source bytes
 * stay with the host, which sends a copy.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { createPdfJsEngine } from "../../pdf/input/engine.js";
import { dispatchMessage } from "../../pdf/input/handler.js";
import { installNetworkGuard } from "../../privacy/network-guard.js";

const engine = createPdfJsEngine(pdfjs, { workerSrc: pdfWorkerUrl });

// After local assets initialize, document processing cannot reach the
// network — even if a future code path tried (T027, defense in depth).
installNetworkGuard(globalThis as unknown as Record<string, unknown>);

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent): void => {
  const data = event.data as { bytes?: unknown } | null;
  void dispatchMessage(data, data?.bytes, { engine }).then((response) => {
    scope.postMessage(response);
  });
};
