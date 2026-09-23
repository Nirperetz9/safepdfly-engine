/**
 * T064 — Verification message handler (worker side).
 *
 * Pipeline, in order:
 *  1. Validate the inbound message (anything else → VERIFY_FAILED/protocol).
 *  2. Budget-gate the candidate bytes.
 *  3. Reopen the exact candidate bytes as a fresh PDF.js document.
 *  4. The FR-012 digest gate runs BEFORE the open: the expected digest is
 *     recomputed over the received bytes and matched first. This ordering
 *     is load-bearing — PDF.js transfers (detaches) the message's
 *     candidate buffer to its internal worker on open, so a digest
 *     computed after the open would always run over zeroed bytes and
 *     every real verification would fail closed as "digest-mismatch".
 *  5. Emit the "reopened" checkpoint, open the source, run the injected
 *     check runner (the real checks land in T065–T068), emit "checks-done".
 *  6. Return VERIFY_RESULT carrying the worker-computed digest and versions.
 *
 * Both documents are always closed; every unexpected failure maps to a
 * stable VERIFY_FAILED code — raw engine errors never cross the boundary.
 */
import {
  VERIFY_ENGINE_VERSION,
  VERIFY_POLICY_VERSION,
  isVerifyCandidateMessage,
  type VerifyCandidateMessage,
  type VerifyCheckpoint,
  type VerifyFailureCode,
  type VerifyOutbound,
  type VerifyWorkerResult,
} from "./protocol.js";
import type { VerifyDoc, VerifyEngine } from "./engine.js";
import type { Sha256Digest } from "../geometry/index.js";

/** Hard cap on candidate bytes: 2× the 25 MiB input budget plus headroom. */
export const VERIFY_MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;

export interface VerifyCheckContext {
  readonly candidate: VerifyDoc;
  readonly source: VerifyDoc;
  readonly message: VerifyCandidateMessage;
}

/**
 * Runs the document/text/visual/duplicate checks (T065–T068). Injected so
 * the digest gate and lifecycle are testable without the full check suite;
 * production wires the real `runVerificationChecks`.
 */
export type VerifyCheckRunner = (
  ctx: VerifyCheckContext,
) => Promise<Omit<VerifyWorkerResult, "candidateSha256" | "versions">>;

export interface VerifyHandlerDeps {
  createEngine: () => VerifyEngine;
  runChecks: VerifyCheckRunner;
  /** Test seam; production uses SubtleCrypto. */
  sha256?: (bytes: ArrayBuffer) => Promise<Sha256Digest>;
  /** The worker entry forwards checkpoints to the host. */
  onCheckpoint?: (checkpoint: VerifyCheckpoint) => void;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<Sha256Digest> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex as Sha256Digest;
}

function failed(reason: VerifyFailureCode): VerifyOutbound {
  return { type: "VERIFY_FAILED", reason };
}

export async function dispatchVerify(
  data: unknown,
  deps: VerifyHandlerDeps,
): Promise<VerifyOutbound> {
  if (!isVerifyCandidateMessage(data)) return failed("protocol");
  if (data.candidateBytes.byteLength > VERIFY_MAX_CANDIDATE_BYTES) {
    return failed("budget-exhausted");
  }
  const sha256 = deps.sha256 ?? sha256Hex;
  const emit = (checkpoint: VerifyCheckpoint): void => {
    deps.onCheckpoint?.(checkpoint);
  };

  const engine = deps.createEngine();
  let candidate: VerifyDoc | null = null;
  let source: VerifyDoc | null = null;
  try {
    // FR-012 — the digest gate runs BEFORE the candidate is opened.
    // engine.open hands the message's candidate buffer to PDF.js, which
    // transfers (detaches) it to its internal worker; computing the
    // digest after the open would hash zeroed bytes and fail every real
    // verification as "digest-mismatch". Mismatch is a deterministic
    // integrity failure → "digest-mismatch" (fail), never an ambiguity.
    const actual = await sha256(data.candidateBytes);
    if (actual !== data.expectedCandidateSha256) {
      return failed("digest-mismatch");
    }
    try {
      candidate = await engine.open(new Uint8Array(data.candidateBytes));
    } catch {
      return failed("parse-error");
    }
    emit("reopened");
    try {
      source = await engine.open(new Uint8Array(data.sourceBytes));
    } catch {
      return failed("source-unavailable");
    }
    let partial: Omit<VerifyWorkerResult, "candidateSha256" | "versions">;
    try {
      partial = await deps.runChecks({ candidate, source, message: data });
    } catch {
      return failed("internal");
    }
    emit("checks-done");
    const result: VerifyWorkerResult = {
      ...partial,
      candidateSha256: actual,
      versions: {
        engine: VERIFY_ENGINE_VERSION,
        verify: VERIFY_POLICY_VERSION,
      },
    };
    return { type: "VERIFY_RESULT", result };
  } finally {
    await candidate?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
}
