/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T033 — Host-side client for the PDF.js input worker.
 *
 * The client spawns a fresh worker per open, transfers a *copy* of the source
 * buffer (the host retains the original for classification, transformation,
 * and verification), awaits exactly one typed response, then terminates the
 * worker. The worker never outlives the open operation.
 */
import {
  INPUT_POLICY_VERSION,
  type InputWorkerResponse,
} from "./protocol.js";

export interface MinimalWorker {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

export interface InputWorkerClientOptions {
  /** Per-open timeout in ms. Defaults to 60_000. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class InputWorkerClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly spawnWorker: () => MinimalWorker,
    options: InputWorkerClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Open a source document. `bytes` is transferred — pass a copy if the
   * caller needs to retain the original.
   */
  openSource(bytes: ArrayBuffer): Promise<InputWorkerResponse> {
    const worker = this.spawnWorker();
    const done = new Promise<InputWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("input worker timed out"));
      }, this.timeoutMs);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data as InputWorkerResponse);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`input worker error: ${event.message ?? "unknown"}`));
      };
      worker.postMessage(
        { type: "OPEN_SOURCE", policyVersion: INPUT_POLICY_VERSION, bytes },
        [bytes],
      );
    });
    // The worker is single-use: terminate once the open settles.
    return done.finally(() => worker.terminate());
  }
}
