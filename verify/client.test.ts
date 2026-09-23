/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T064 — client tests: fresh worker per run, checkpoint forwarding,
 * transfer of both buffers, and guaranteed termination (the T063 handoff
 * contract's other half: the transform worker is already dead before this
 * client creates the verification worker).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  verifyCandidateInWorker,
  VerifyWorkerError,
  type VerifyRequest,
} from "./client.js";
import type { Sha256Digest } from "../geometry/index.js";

interface FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  postMessage: (message: unknown, transfer?: unknown) => void;
  terminate: () => void;
  posted: unknown[];
  transfers: unknown[];
  terminated: boolean;
}

function fakeWorker(): FakeWorker {
  const w: FakeWorker = {
    onmessage: null,
    onerror: null,
    posted: [],
    transfers: [],
    terminated: false,
    postMessage(message: unknown, transfer?: unknown) {
      w.posted.push(message);
      w.transfers.push(transfer);
    },
    terminate() {
      w.terminated = true;
    },
  };
  return w;
}

function request(): VerifyRequest {
  return {
    sourceBytes: new ArrayBuffer(4),
    candidateBytes: new ArrayBuffer(8),
    expectedCandidateSha256: "digest" as Sha256Digest,
    rects: [],
    expectedPages: [],
  };
}

const RESULT = {
  candidateSha256: "digest",
  documentChecks: [],
  selectionChecks: [],
  outsideMaskOutcome: "pass",
  outsideMaskReasonCode: "verify.ok",
  warnings: [],
  versions: { engine: "pdfjs/6.3.289", verify: "verify-policy/1" },
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("verifyCandidateInWorker (T064)", () => {
  it("posts VERIFY_CANDIDATE transferring both buffers, then resolves", async () => {
    const w = fakeWorker();
    const pending = verifyCandidateInWorker(request(), {
      createWorker: () => w as unknown as Worker,
    });
    const posted = w.posted[0] as Record<string, unknown>;
    expect(posted.type).toBe("VERIFY_CANDIDATE");
    expect(posted.expectedCandidateSha256).toBe("digest");
    // Both buffers transferred (neutered host-side).
    expect(w.transfers[0]).toEqual([posted.sourceBytes, posted.candidateBytes]);
    w.onmessage!({ data: { type: "VERIFY_RESULT", result: RESULT } });
    await expect(pending).resolves.toEqual(RESULT);
    expect(w.terminated).toBe(true);
  });

  it("forwards checkpoints without settling the promise", async () => {
    const w = fakeWorker();
    const seen: string[] = [];
    const pending = verifyCandidateInWorker(request(), {
      createWorker: () => w as unknown as Worker,
      onCheckpoint: (c) => seen.push(c),
    });
    w.onmessage!({
      data: { type: "VERIFY_CHECKPOINT", checkpoint: "reopened" },
    });
    w.onmessage!({
      data: { type: "VERIFY_CHECKPOINT", checkpoint: "checks-done" },
    });
    expect(seen).toEqual(["reopened", "checks-done"]);
    w.onmessage!({ data: { type: "VERIFY_RESULT", result: RESULT } });
    await expect(pending).resolves.toEqual(RESULT);
  });

  it("rejects with the worker's stable failure code", async () => {
    const w = fakeWorker();
    const pending = verifyCandidateInWorker(request(), {
      createWorker: () => w as unknown as Worker,
    });
    w.onmessage!({
      data: { type: "VERIFY_FAILED", reason: "digest-mismatch" },
    });
    await expect(pending).rejects.toMatchObject({ reason: "digest-mismatch" });
    expect(w.terminated).toBe(true);
  });

  it("fails closed on a non-protocol message and still terminates", async () => {
    const w = fakeWorker();
    const pending = verifyCandidateInWorker(request(), {
      createWorker: () => w as unknown as Worker,
    });
    w.onmessage!({ data: { type: "CANDIDATE_READY" } });
    const err = await pending.catch((e) => e);
    expect(err).toBeInstanceOf(VerifyWorkerError);
    expect(err.reason).toBe("protocol");
    expect(w.terminated).toBe(true);
  });

  it("fails closed on a malformed VERIFY_FAILED as a protocol violation", async () => {
    const w = fakeWorker();
    const pending = verifyCandidateInWorker(request(), {
      createWorker: () => w as unknown as Worker,
    });
    // A VERIFY_FAILED carrying a raw engine string is not a valid outbound
    // message at all: the worker broke the protocol. Fail closed as such.
    w.onmessage!({ data: { type: "VERIFY_FAILED", reason: "Error: xref" } });
    const err = await pending.catch((e) => e);
    expect(err.reason).toBe("protocol");
    expect(w.terminated).toBe(true);
  });

  it("times out a hung worker and terminates it", async () => {
    const w = fakeWorker();
    const pending = verifyCandidateInWorker(request(), {
      createWorker: () => w as unknown as Worker,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
    expect(w.terminated).toBe(true);
  });

  it("maps worker onerror to worker-error", async () => {
    const w = fakeWorker();
    const pending = verifyCandidateInWorker(request(), {
      createWorker: () => w as unknown as Worker,
    });
    w.onerror!();
    await expect(pending).rejects.toMatchObject({ reason: "worker-error" });
    expect(w.terminated).toBe(true);
  });

  it("creates a NEW worker per call (never reuses)", async () => {
    const workers: FakeWorker[] = [];
    const deps = {
      createWorker: () => {
        const w = fakeWorker();
        workers.push(w);
        return w as unknown as Worker;
      },
    };
    const p1 = verifyCandidateInWorker(request(), deps);
    workers[0]!.onmessage!({ data: { type: "VERIFY_RESULT", result: RESULT } });
    await p1;
    const p2 = verifyCandidateInWorker(request(), deps);
    workers[1]!.onmessage!({ data: { type: "VERIFY_RESULT", result: RESULT } });
    await p2;
    expect(workers).toHaveLength(2);
    expect(workers[0]).not.toBe(workers[1]);
    expect(workers.every((w) => w.terminated)).toBe(true);
  });
});
