/**
 * T064 — Verify worker entry. Bundled as a separate worker chunk.
 *
 * Ordering is load-bearing (same as the input/redact workers):
 *  1. Same-origin PDF.js + worker assets initialize.
 *  2. The no-network guard is installed BEFORE any document bytes arrive.
 *  3. Only then does the entry accept candidate bytes.
 *
 * The entry handles VERIFY_CANDIDATE exclusively and is single-use: the
 * host terminates it after the response, so it can never be reused — and
 * a transform worker can never become the verification worker (T063
 * terminates the transform worker before its promise settles, and this
 * entry is a different chunk entirely).
 *
 * Checkpoint messages ("reopened", "checks-done") are forwarded as they
 * happen; terminal messages are validated before crossing to the host.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { createPdfJsVerifyEngine } from "../../pdf/verify/engine.js";
import { dispatchVerify } from "../../pdf/verify/handler.js";
import { isVerifyOutbound } from "../../pdf/verify/protocol.js";
import { runVerificationChecks } from "../../pdf/verify/checks.js";
import { installNetworkGuard } from "../../privacy/network-guard.js";

// After local assets initialize, document processing cannot reach the
// network — even if a future code path tried (T027, defense in depth).
installNetworkGuard(globalThis as unknown as Record<string, unknown>);

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, options?: { transfer?: Transferable[] }): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent): void => {
  const engine = createPdfJsVerifyEngine(pdfjs, { workerSrc: pdfWorkerUrl });
  void dispatchVerify(event.data, {
    createEngine: () => engine,
    runChecks: runVerificationChecks,
    onCheckpoint: (checkpoint) => {
      scope.postMessage({ type: "VERIFY_CHECKPOINT", checkpoint });
    },
  }).then((out) => {
    // The handler guarantees a valid outbound message; assert it anyway —
    // an invalid message must never cross to the host silently.
    if (!isVerifyOutbound(out)) {
      scope.postMessage({ type: "VERIFY_FAILED", reason: "internal" });
      return;
    }
    scope.postMessage(out);
  });
};
