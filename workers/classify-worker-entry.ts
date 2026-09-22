/**
 * T085 — Classify worker entry. Bundled as a separate worker chunk.
 *
 * Ordering is load-bearing:
 *  1. Importing the facade pulls in "mupdf". That module's top-level await
 *     loads the same-origin WASM binary BEFORE this entry's code runs.
 *  2. Only then is the no-network guard installed.
 *  3. Only then does the entry accept document bytes.
 *
 * The entry handles CLASSIFY_SOURCE exclusively and exits on host command.
 * It is never reused as the transformation worker: it imports nothing from
 * the input or transform paths (enforced by classify.test.ts).
 */
import { installNetworkGuard } from "../../privacy/network-guard.js";
import { classifySource, ClassifyError } from "../../pdf/classify-mupdf/classifier.js";
import { openDocumentReadOnly } from "../../pdf/classify-mupdf/readonly-facade.js";
import { isClassifyOutbound } from "../../pdf/classify-mupdf/protocol.js";
import type { ClassifyFailureCode } from "../../pdf/classify-mupdf/classifier.js";

installNetworkGuard();

function toReason(error: unknown): ClassifyFailureCode | "internal" {
  if (error instanceof ClassifyError) return error.code;
  return "internal";
}

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as { type?: unknown; payload?: unknown };
  if (message?.type !== "CLASSIFY_SOURCE" || !(message.payload instanceof ArrayBuffer)) {
    self.postMessage({ type: "CLASSIFY_REJECTED", reason: "internal" });
    return;
  }
  try {
    const report = await classifySource(message.payload, {
      open: openDocumentReadOnly,
    });
    const out = { type: "CLASSIFY_READY", report };
    if (!isClassifyOutbound(out)) throw new Error("invalid outbound");
    self.postMessage(out);
  } catch (error) {
    self.postMessage({ type: "CLASSIFY_REJECTED", reason: toReason(error) });
  }
};
