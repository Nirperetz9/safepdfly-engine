/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T064 — Host-side client for the verification worker.
 *
 * Same single-use semantics as the input/classify/transform clients: one
 * fresh worker per verification, terminated afterwards. The worker is
 * therefore never reused — in particular a transform worker can never
 * become the verification worker, because the transform client (T063)
 * terminates its worker before its promise settles, and this client only
 * ever creates workers through its own factory (FR-012 independence).
 *
 * Both byte buffers are transferred (neutered host-side). Checkpoint
 * messages ("reopened", "checks-done") are forwarded to `onCheckpoint`
 * and never touch the result timer. The client resolves only with the
 * worker's check results; it never labels anything safe (T069 owns that).
 */
import {
  VERIFY_ENGINE_VERSION,
  VERIFY_POLICY_VERSION,
  isVerifyCheckpointMessage,
  isVerifyOutbound,
  type ExpectedPage,
  type VerifyCheckpoint,
  type VerifyFailureCode,
  type VerifyRect,
  type VerifyWorkerResult,
} from "./protocol.js";
import { createVerifyTimeoutMs } from "./timeouts.js";
import type { Sha256Digest } from "../geometry/index.js";

/**
 * T104 — open-core blessed surface: the host assembles the user-facing
 * verification report from the worker's raw check results (T069). Exported
 * from the client module so proprietary orchestration never imports engine
 * internals directly.
 */
export { assembleVerificationReport } from "./assembler.js";

export class VerifyWorkerError extends Error {
  readonly reason: VerifyFailureCode;
  constructor(reason: VerifyFailureCode) {
    super(`verify-worker:${reason}`);
    this.name = "VerifyWorkerError";
    this.reason = reason;
  }
}

export interface VerifyWorkerClientDeps {
  createWorker: () => Worker;
  now?: () => number;
  /** Truthful progress: invoked only when the worker actually checkpoints. */
  onCheckpoint?: (checkpoint: VerifyCheckpoint) => void;
}

export interface VerifyRequest {
  /** Caller-owned source copy; transferred to the worker. */
  sourceBytes: ArrayBuffer;
  /** Caller-owned candidate copy; transferred to the worker. */
  candidateBytes: ArrayBuffer;
  expectedCandidateSha256: Sha256Digest;
  rects: readonly VerifyRect[];
  expectedPages: readonly ExpectedPage[];
}

/**
 * Run one verification in a fresh worker. The worker is ALWAYS terminated
 * in `finally`, before this promise settles — on success, on worker
 * failure, on protocol violation, and on timeout (mid-flight interruption).
 */
export async function verifyCandidateInWorker(
  request: VerifyRequest,
  deps: VerifyWorkerClientDeps,
): Promise<VerifyWorkerResult> {
  const worker = deps.createWorker();
  const timeoutMs = createVerifyTimeoutMs(deps.now ?? Date.now);
  try {
    return await new Promise<VerifyWorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new VerifyWorkerError("timeout"));
      }, timeoutMs);
      worker.onmessage = (event: MessageEvent) => {
        const data: unknown = event.data;
        if (isVerifyCheckpointMessage(data)) {
          deps.onCheckpoint?.(data.checkpoint);
          return;
        }
        if (!isVerifyOutbound(data)) {
          clearTimeout(timer);
          reject(new VerifyWorkerError("protocol"));
          return;
        }
        clearTimeout(timer);
        if (data.type === "VERIFY_RESULT") {
          resolve(data.result);
        } else {
          // isVerifyOutbound already validated the reason against the
          // stable code set; anything else cannot reach this branch.
          reject(new VerifyWorkerError(data.reason));
        }
      };
      worker.onerror = () => {
        clearTimeout(timer);
        reject(new VerifyWorkerError("worker-error"));
      };
      worker.postMessage(
        {
          type: "VERIFY_CANDIDATE",
          sourceBytes: request.sourceBytes,
          candidateBytes: request.candidateBytes,
          expectedCandidateSha256: request.expectedCandidateSha256,
          rects: request.rects,
          expectedPages: request.expectedPages,
          policy: {
            engine: VERIFY_ENGINE_VERSION,
            verify: VERIFY_POLICY_VERSION,
          },
        },
        [request.sourceBytes, request.candidateBytes],
      );
    });
  } finally {
    worker.terminate();
  }
}
