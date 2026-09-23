/**
 * T058 — Host-side client for the transformation worker.
 *
 * Same single-use semantics as the input/classify clients: one fresh worker
 * per transformation, terminated afterwards. The worker is therefore never
 * reused — in particular it can never become the verification worker (T063).
 *
 * The source ArrayBuffer is transferred (neutered host-side): the worker
 * operates on a separate copied buffer per the processing-worker contract.
 * The client resolves only with the candidate identity + bytes; it never
 * creates a Blob URL and never labels anything safe.
 */
import {
  isTransformOutbound,
  type CandidateReadyMessage,
  type SelfCheckStatus,
  type TransformFailureCode,
  type TransformRect,
} from "./protocol.js";
import { TRANSFORM_POLICY_VERSIONS } from "./handler.js";
import { createTransformTimeoutMs } from "./timeouts.js";
import type { Sha256Digest } from "../geometry/index.js";

export class TransformWorkerError extends Error {
  readonly reason: TransformFailureCode;
  constructor(reason: TransformFailureCode) {
    super(`transform-worker:${reason}`);
    this.name = "TransformWorkerError";
    this.reason = reason;
  }
}

export interface TransformWorkerClientDeps {
  createWorker: () => Worker;
  now?: () => number;
}

export interface TransformRequest {
  /** Caller-owned source copy; transferred to the worker. */
  bytes: ArrayBuffer;
  rects: readonly TransformRect[];
}

/** The candidate as the host receives it: bytes + identity, no URL, no verdict. */
export interface TransformCandidate {
  readonly bytes: ArrayBuffer;
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
  readonly selfCheck: SelfCheckStatus;
  readonly versions: CandidateReadyMessage["versions"];
}

/**
 * Run one transformation in a fresh worker. The worker is always terminated
 * afterwards — before any verification worker may be created (T063).
 */
export async function applyRedactionsInWorker(
  request: TransformRequest,
  deps: TransformWorkerClientDeps,
): Promise<TransformCandidate> {
  const worker = deps.createWorker();
  const timeoutMs = createTransformTimeoutMs(deps.now ?? Date.now);
  try {
    const candidate = await new Promise<TransformCandidate>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TransformWorkerError("timeout"));
      }, timeoutMs);
      worker.onmessage = (event: MessageEvent) => {
        if (!isTransformOutbound(event.data)) {
          clearTimeout(timer);
          reject(new TransformWorkerError("protocol"));
          return;
        }
        clearTimeout(timer);
        const data = event.data;
        if (data.type === "CANDIDATE_READY") {
          resolve({
            bytes: data.payload,
            sha256: data.sha256,
            byteLength: data.byteLength,
            selfCheck: data.selfCheck,
            versions: data.versions,
          });
        } else {
          reject(new TransformWorkerError(data.reason));
        }
      };
      worker.onerror = () => {
        clearTimeout(timer);
        reject(new TransformWorkerError("worker-error"));
      };
      worker.postMessage(
        {
          type: "APPLY_REDACTIONS",
          payload: request.bytes,
          rects: request.rects,
          policy: { ...TRANSFORM_POLICY_VERSIONS },
        },
        [request.bytes],
      );
    });
    return candidate;
  } finally {
    worker.terminate();
  }
}
