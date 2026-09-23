/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T085 — Host-side client for the isolated classify worker.
 *
 * Same single-use semantics as the input worker client (T033): one fresh
 * worker per classification, terminated after the response. The classifier
 * worker can therefore never be reused as the transformation worker.
 */
import {
  isClassifyOutbound,
  type ClassifyReadyMessage,
} from "./protocol.js";
import { createClassificationTimeoutMs } from "./timeouts.js";

export class ClassifyWorkerError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`classify-worker:${reason}`);
    this.name = "ClassifyWorkerError";
    this.reason = reason;
  }
}

export interface ClassifyWorkerClientDeps {
  createWorker: () => Worker;
  now?: () => number;
}

/**
 * Classify one source in a fresh worker. The ArrayBuffer is transferred
 * (neutered host-side). The worker is always terminated afterwards.
 */
export async function classifyInWorker(
  bytes: ArrayBuffer,
  deps: ClassifyWorkerClientDeps,
): Promise<ClassifyReadyMessage["report"]> {
  const worker = deps.createWorker();
  const timeoutMs = createClassificationTimeoutMs(deps.now ?? Date.now);
  try {
    const report = await new Promise<ClassifyReadyMessage["report"]>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new ClassifyWorkerError("timeout"));
        }, timeoutMs);
        worker.onmessage = (event: MessageEvent) => {
          if (!isClassifyOutbound(event.data)) {
            clearTimeout(timer);
            reject(new ClassifyWorkerError("protocol"));
            return;
          }
          clearTimeout(timer);
          if (event.data.type === "CLASSIFY_READY") resolve(event.data.report);
          else reject(new ClassifyWorkerError(event.data.reason));
        };
        worker.onerror = () => {
          clearTimeout(timer);
          reject(new ClassifyWorkerError("worker-error"));
        };
        worker.postMessage({ type: "CLASSIFY_SOURCE", payload: bytes }, [bytes]);
      },
    );
    return report;
  } finally {
    worker.terminate();
  }
}
