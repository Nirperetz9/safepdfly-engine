/**
 * T040 — Time budget: a hung input worker fails closed as a timeout.
 *
 * The client is single-use per open with a monotonic clock; the worker is
 * terminated once the open settles, even on timeout.
 */
import { describe, expect, it } from "vitest";
import { InputWorkerClient, type MinimalWorker } from "./client.js";

function hangingWorker(): MinimalWorker & { terminated(): boolean } {
  let done = false;
  return {
    terminated: () => done,
    postMessage: () => {
      // Never responds — the engine is hung on pathological input.
    },
    onmessage: null,
    onerror: null,
    terminate: () => {
      done = true;
    },
  };
}

describe("input worker time budget", () => {
  it("rejects a hung worker after the timeout and terminates it", async () => {
    const worker = hangingWorker();
    const client = new InputWorkerClient(() => worker, { timeoutMs: 50 });
    const started = Date.now();
    await expect(
      client.openSource(new ArrayBuffer(8)),
    ).rejects.toThrow("input worker timed out");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(worker.terminated()).toBe(true);
  });

  it("a responding worker resolves before the timeout", async () => {
    const worker = hangingWorker();
    const client = new InputWorkerClient(() => worker, { timeoutMs: 1000 });
    const pending = client.openSource(new ArrayBuffer(8));
    worker.onmessage?.({ data: { type: "SOURCE_REJECTED" } });
    await expect(pending).resolves.toEqual({ type: "SOURCE_REJECTED" });
    expect(worker.terminated()).toBe(true);
  });
});
