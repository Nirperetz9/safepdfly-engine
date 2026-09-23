/**
 * T058 — Worker-side dispatch and host-side client.
 *
 * 1. Unknown inbound messages fail closed (TRANSFORM_FAILED, no transform).
 * 2. Backend throws — including errors embedding document content — cross
 *    the boundary only as stable codes. The raw error never leaks.
 * 3. Success computes the SHA-256 identity of the exact candidate bytes.
 * 4. The host client: single-use worker, terminated after every outcome;
 *    unknown outbound fails closed; the resolved candidate carries bytes +
 *    identity only — never a download URL or a safety verdict.
 */
import { describe, expect, it, vi } from "vitest";
import {
  REDACTION_POLICY_VERSION,
  SAVE_POLICY_VERSION,
  TRANSFORM_ENGINE_VERSION,
  type ApplyRedactionsMessage,
  type TransformRect,
} from "./protocol.js";
import { dispatchTransform, type TransformBackend } from "./handler.js";
import {
  applyRedactionsInWorker,
  TransformWorkerError,
  type TransformRequest,
} from "./client.js";

const RECTS: TransformRect[] = [{ page: 0, x0: 10, y0: 20, x1: 110, y1: 120 }];

function request(payload?: ArrayBuffer): ApplyRedactionsMessage {
  return {
    type: "APPLY_REDACTIONS",
    payload: payload ?? new ArrayBuffer(16),
    rects: RECTS,
    policy: {
      engine: TRANSFORM_ENGINE_VERSION,
      redaction: REDACTION_POLICY_VERSION,
      save: SAVE_POLICY_VERSION,
    },
    sanitize: false,
  };
}

function okBackend(bytes: ArrayBuffer): TransformBackend {
  return {
    apply: async () => ({ bytes, selfCheck: "ok" as const }),
  };
}

describe("dispatchTransform", () => {
  it("fails closed on unknown messages without touching the backend", async () => {
    let called = false;
    const backend: TransformBackend = {
      apply: async () => {
        called = true;
        throw new Error("must not run");
      },
    };
    const out = await dispatchTransform({ type: "HELLO" }, backend);
    expect(out).toEqual({ type: "TRANSFORM_FAILED", reason: "invalid-request" });
    expect(called).toBe(false);
  });

  it("maps backend throws to a stable code without leaking the error", async () => {
    const secret = "acct 1234-5678 owner Jane";
    const backend: TransformBackend = {
      apply: async () => {
        throw new Error(`mupdf choked on ${secret}`);
      },
    };
    const out = await dispatchTransform(request(), backend);
    expect(out.type).toBe("TRANSFORM_FAILED");
    if (out.type !== "TRANSFORM_FAILED") throw new Error("narrow");
    expect(out.reason).toBe("engine-error");
    expect(JSON.stringify(out)).not.toContain("1234");
    expect(JSON.stringify(out)).not.toContain("Jane");
  });

  it("fails a failed self-check without emitting a candidate", async () => {
    const backend: TransformBackend = {
      apply: async () => ({ bytes: new ArrayBuffer(8), selfCheck: "failed" as const }),
    };
    const out = await dispatchTransform(request(), backend);
    expect(out).toEqual({ type: "TRANSFORM_FAILED", reason: "self-check-failed" });
  });

  it("computes the SHA-256 identity of the exact candidate bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const out = await dispatchTransform(request(), okBackend(bytes));
    expect(out.type).toBe("CANDIDATE_READY");
    if (out.type !== "CANDIDATE_READY") throw new Error("narrow");
    const expected = Buffer.from(
      await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3, 4])),
    ).toString("hex");
    expect(out.sha256).toBe(expected);
    expect(out.byteLength).toBe(4);
    expect(out.payload).toBe(bytes);
    expect(out.selfCheck).toBe("ok");
    expect(out.versions.engine).toBe(TRANSFORM_ENGINE_VERSION);
  });
});

/** Minimal fake Worker for client tests. */
interface FakeWorker {
  postMessage(message: unknown, transfer?: unknown[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
  terminated: boolean;
  lastMessage: unknown;
}

function fakeWorker(): FakeWorker {
  return {
    onmessage: null,
    onerror: null,
    terminated: false,
    lastMessage: undefined,
    postMessage(message: unknown) {
      this.lastMessage = message;
    },
    terminate() {
      this.terminated = true;
    },
  };
}

function clientRequest(): TransformRequest {
  return { bytes: new ArrayBuffer(16), rects: RECTS, sanitize: false };
}

describe("applyRedactionsInWorker", () => {
  it("resolves with candidate identity and terminates the worker", async () => {
    const worker = fakeWorker();
    const pending = applyRedactionsInWorker(clientRequest(), {
      createWorker: () => worker as unknown as Worker,
    });
    const payload = new ArrayBuffer(8);
    worker.onmessage?.({
      data: {
        type: "CANDIDATE_READY",
        payload,
        sha256: "b".repeat(64),
        byteLength: 8,
        selfCheck: "ok",
        versions: {
          engine: TRANSFORM_ENGINE_VERSION,
          redaction: REDACTION_POLICY_VERSION,
          save: SAVE_POLICY_VERSION,
        },
      },
    });
    const candidate = await pending;
    expect(candidate.bytes).toBe(payload);
    expect(candidate.sha256).toBe("b".repeat(64));
    expect(candidate.byteLength).toBe(8);
    // No download affordance, no safety verdict on the candidate.
    expect(candidate).not.toHaveProperty("url");
    expect(candidate).not.toHaveProperty("safe");
    expect(candidate).not.toHaveProperty("blobUrl");
    expect(worker.terminated).toBe(true);
  });

  it("carries the exact policy versions in the request", async () => {
    const worker = fakeWorker();
    const pending = applyRedactionsInWorker(clientRequest(), {
      createWorker: () => worker as unknown as Worker,
    });
    const msg = worker.lastMessage as { policy: Record<string, string> };
    expect(msg.policy.engine).toBe(TRANSFORM_ENGINE_VERSION);
    expect(msg.policy.redaction).toBe(REDACTION_POLICY_VERSION);
    expect(msg.policy.save).toBe(SAVE_POLICY_VERSION);
    worker.onmessage?.({ data: { type: "TRANSFORM_FAILED", reason: "engine-error" } });
    await expect(pending).rejects.toBeInstanceOf(TransformWorkerError);
    expect(worker.terminated).toBe(true);
  });

  it("fails closed on unknown outbound messages", async () => {
    const worker = fakeWorker();
    const pending = applyRedactionsInWorker(clientRequest(), {
      createWorker: () => worker as unknown as Worker,
    });
    worker.onmessage?.({ data: { type: "SOMETHING_ELSE" } });
    await expect(pending).rejects.toMatchObject({ reason: "protocol" });
    expect(worker.terminated).toBe(true);
  });

  it("maps TRANSFORM_FAILED to the stable reason and terminates", async () => {
    const worker = fakeWorker();
    const pending = applyRedactionsInWorker(clientRequest(), {
      createWorker: () => worker as unknown as Worker,
    });
    worker.onmessage?.({ data: { type: "TRANSFORM_FAILED", reason: "self-check-failed" } });
    await expect(pending).rejects.toMatchObject({ reason: "self-check-failed" });
    expect(worker.terminated).toBe(true);
  });

  it("terminates a hung worker on timeout", async () => {
    vi.useFakeTimers();
    try {
      const worker = fakeWorker();
      worker.postMessage = () => {
        /* never responds */
      };
      const pending = applyRedactionsInWorker(clientRequest(), {
        createWorker: () => worker as unknown as Worker,
      });
      const assertion = expect(pending).rejects.toMatchObject({ reason: "timeout" });
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
