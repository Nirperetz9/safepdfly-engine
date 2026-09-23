/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T059 — Redact worker entry. Bundled as a separate worker chunk.
 *
 * Ordering is load-bearing (same as the classify worker, T085):
 *  1. Importing the adapter pulls in "mupdf". That module's top-level await
 *     loads the same-origin WASM binary BEFORE this entry's code runs.
 *  2. Only then is the no-network guard installed.
 *  3. Only then does the entry accept document bytes.
 *
 * The entry handles APPLY_REDACTIONS exclusively. Unknown messages fail
 * closed via the handler (TRANSFORM_FAILED). The worker is single-use: the
 * host terminates it after the response, so it can never be reused as the
 * verification worker (T063).
 */
import { installNetworkGuard } from "../network-guard.js";
import { createMuPdfBackend } from "../redact/adapter.js";
import { dispatchTransform } from "../redact/handler.js";
import { isTransformOutbound } from "../redact/protocol.js";

installNetworkGuard();

const backend = createMuPdfBackend();

self.onmessage = async (event: MessageEvent) => {
  const out = await dispatchTransform(event.data, backend);
  // The handler guarantees a valid outbound message; assert it anyway —
  // an invalid message must never cross to the host silently.
  if (!isTransformOutbound(out)) {
    self.postMessage({ type: "TRANSFORM_FAILED", reason: "internal" });
    return;
  }
  const transfer = out.type === "CANDIDATE_READY" ? [out.payload] : [];
  self.postMessage(out, { transfer });
};
