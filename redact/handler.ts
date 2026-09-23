/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T058 — Worker-side dispatch for the transformation protocol.
 *
 * The engine backend is injected so the protocol logic (validation,
 * fail-closed mapping, identity computation) is testable without the MuPDF
 * WASM module. Production wires the MuPDF adapter (T059); the worker entry
 * never sees raw engine errors — every backend throw becomes a stable
 * TRANSFORM_FAILED code with no document content attached.
 */
import {
  REDACTION_POLICY_VERSION,
  SAVE_POLICY_VERSION,
  TRANSFORM_ENGINE_VERSION,
  isApplyRedactionsMessage,
  type ApplyRedactionsMessage,
  type CandidateReadyMessage,
  type SelfCheckStatus,
  type TransformFailedMessage,
  type TransformOutbound,
  type TransformRect,
} from "./protocol.js";
import type { Sha256Digest } from "../geometry/index.js";

/** What the engine backend must do with a validated request. */
export interface TransformBackend {
  /**
   * Apply the approved redaction policy to the source bytes and return the
   * full-rewrite candidate plus the internal self-check outcome.
   * Must never resolve with an overlay-only or incremental result.
   * @param sanitize T099: when true, strip document Info, XMP metadata,
   * embedded files, and document-level scripts/actions after the
   * redaction policy and before the save. The caller (host) is the only
   * authority for this flag; the worker never enables it on its own.
   */
  apply(
    payload: ArrayBuffer,
    rects: readonly TransformRect[],
    sanitize: boolean,
  ): Promise<{ bytes: ArrayBuffer; selfCheck: SelfCheckStatus }>;
}

export const TRANSFORM_POLICY_VERSIONS = {
  engine: TRANSFORM_ENGINE_VERSION,
  redaction: REDACTION_POLICY_VERSION,
  save: SAVE_POLICY_VERSION,
} as const;

function failed(reason: TransformFailedMessage["reason"]): TransformFailedMessage {
  return { type: "TRANSFORM_FAILED", reason };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<Sha256Digest> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex as Sha256Digest;
}

/**
 * Handle one inbound worker message. Unknown or malformed messages fail
 * closed: the worker never starts a transformation and reports
 * `invalid-request` so the host can run export-error recovery (T090).
 * Backend failures — including engine throws that may embed document
 * content — are mapped to stable codes; the raw error never crosses.
 */
export async function dispatchTransform(
  message: unknown,
  backend: TransformBackend,
): Promise<TransformOutbound> {
  if (!isApplyRedactionsMessage(message)) {
    return failed("invalid-request");
  }
  const request = message as ApplyRedactionsMessage;
  let result: { bytes: ArrayBuffer; selfCheck: SelfCheckStatus };
  try {
    result = await backend.apply(request.payload, request.rects, request.sanitize);
  } catch {
    // The raw error is swallowed deliberately: it may contain document
    // content (PR-003). The host learns only that the engine failed.
    return failed("engine-error");
  }
  if (result.selfCheck !== "ok") {
    return failed("self-check-failed");
  }
  const bytes = result.bytes;
  let sha256: Sha256Digest;
  try {
    sha256 = await sha256Hex(bytes);
  } catch {
    return failed("internal");
  }
  const out: CandidateReadyMessage = {
    type: "CANDIDATE_READY",
    payload: bytes,
    sha256,
    byteLength: bytes.byteLength,
    selfCheck: "ok",
    versions: { ...TRANSFORM_POLICY_VERSIONS },
  };
  return out;
}
