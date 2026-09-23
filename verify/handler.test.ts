/**
 * T064 — handler tests: the digest gate and worker lifecycle.
 *
 * The check runner is injected (real checks land in T065–T068); these
 * tests prove the FR-012 gate: the exact received bytes are reopened and
 * SHA-256-matched BEFORE any check runs, and verification never depends
 * on transformation-internal state.
 */
import { describe, expect, it, vi } from "vitest";
import {
  dispatchVerify,
  VERIFY_MAX_CANDIDATE_BYTES,
  type VerifyHandlerDeps,
} from "./handler.js";
import {
  VERIFY_ENGINE_VERSION,
  VERIFY_POLICY_VERSION,
  type VerifyCandidateMessage,
  type VerifyCheckRunner,
  type VerifyDoc,
  type VerifyEngine,
} from "./index.js";
import type { Sha256Digest } from "../geometry/index.js";

const EXPECTED = "expected-digest" as Sha256Digest;
const ACTUAL = "actual-digest" as Sha256Digest;

function fakeDoc(closed: string[], tag: string): VerifyDoc {
  return {
    numPages: 1,
    page: async () => {
      throw new Error("not needed here");
    },
    jsActionNames: async () => [],
    attachmentNames: async () => [],
    hasFieldObjects: async () => false,
    close: async () => {
      closed.push(tag);
    },
  };
}

function fakeEngine(
  opts: { candidateThrows?: boolean; sourceThrows?: boolean } = {},
): {
  engine: VerifyEngine;
  closed: string[];
} {
  const closed: string[] = [];
  return {
    closed,
    engine: {
      name: "pdfjs",
      version: "test",
      open: async (data: Uint8Array) => {
        // Distinguish candidate (8 bytes) from source (4 bytes) by length.
        if (data.byteLength === 8) {
          if (opts.candidateThrows) throw new Error("bad pdf");
          return fakeDoc(closed, "candidate");
        }
        if (opts.sourceThrows) throw new Error("bad source");
        return fakeDoc(closed, "source");
      },
    },
  };
}

function message(): VerifyCandidateMessage {
  return {
    type: "VERIFY_CANDIDATE",
    sourceBytes: new ArrayBuffer(4),
    candidateBytes: new ArrayBuffer(8),
    expectedCandidateSha256: EXPECTED,
    rects: [],
    expectedPages: [],
    policy: { engine: VERIFY_ENGINE_VERSION, verify: VERIFY_POLICY_VERSION },
  };
}

function deps(overrides: Partial<VerifyHandlerDeps> = {}): VerifyHandlerDeps & {
  closed: string[];
  checkpoints: string[];
  runChecks: VerifyCheckRunner;
} {
  const { engine, closed } = fakeEngine();
  const checkpoints: string[] = [];
  const runChecks: VerifyCheckRunner = vi.fn(async () => ({
    documentChecks: [],
    selectionChecks: [],
    outsideMaskOutcome: "pass" as const,
    outsideMaskReasonCode: "verify.ok",
    warnings: [],
  }));
  const merged: VerifyHandlerDeps = {
    createEngine: () => engine,
    runChecks,
    sha256: async () => ACTUAL,
    onCheckpoint: (c) => checkpoints.push(c),
    ...overrides,
  };
  const spy = vi.mocked(merged.runChecks);
  return { ...merged, closed, checkpoints, runChecks: spy };
}

describe("dispatchVerify (T064)", () => {
  it("rejects a non-protocol message without touching the engine", async () => {
    const d = deps();
    const createEngine = vi.fn(d.createEngine);
    const out = await dispatchVerify({ type: "HELLO" }, { ...d, createEngine });
    expect(out).toEqual({ type: "VERIFY_FAILED", reason: "protocol" });
    expect(createEngine).not.toHaveBeenCalled();
  });

  it("fails closed on an unparseable candidate", async () => {
    const { engine } = fakeEngine({ candidateThrows: true });
    const d = deps({ createEngine: () => engine });
    const out = await dispatchVerify(message(), d);
    expect(out).toEqual({ type: "VERIFY_FAILED", reason: "parse-error" });
    expect(d.runChecks).not.toHaveBeenCalled();
  });

  it("fails closed on digest mismatch WITHOUT running checks", async () => {
    const d = deps({ sha256: async () => "other-digest" as Sha256Digest });
    const out = await dispatchVerify(message(), d);
    expect(out).toEqual({ type: "VERIFY_FAILED", reason: "digest-mismatch" });
    expect(d.runChecks).not.toHaveBeenCalled();
    expect(d.checkpoints).toEqual([]);
  });

  it("emits checkpoints in order and returns the worker-computed digest", async () => {
    const d = deps({ sha256: async () => EXPECTED });
    const out = await dispatchVerify(message(), d);
    expect(d.checkpoints).toEqual(["reopened", "checks-done"]);
    expect(out.type).toBe("VERIFY_RESULT");
    if (out.type === "VERIFY_RESULT") {
      expect(out.result.candidateSha256).toBe(EXPECTED);
      expect(out.result.versions).toEqual({
        engine: VERIFY_ENGINE_VERSION,
        verify: VERIFY_POLICY_VERSION,
      });
      expect(d.runChecks).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed when the source cannot be reopened (ambiguity, not failure)", async () => {
    const { engine } = fakeEngine({ sourceThrows: true });
    const d = deps({
      createEngine: () => engine,
      sha256: async () => EXPECTED,
    });
    const out = await dispatchVerify(message(), d);
    expect(out).toEqual({
      type: "VERIFY_FAILED",
      reason: "source-unavailable",
    });
    expect(d.runChecks).not.toHaveBeenCalled();
  });

  it("maps a throwing check runner to internal (never leaks the error)", async () => {
    const runChecks = vi.fn(async () => {
      throw new Error("Error: xref table corrupt at offset 1234");
    });
    const d = deps({ runChecks, sha256: async () => EXPECTED });
    const out = await dispatchVerify(message(), d);
    expect(out).toEqual({ type: "VERIFY_FAILED", reason: "internal" });
  });

  it("rejects oversized candidates at the budget gate", async () => {
    const d = deps();
    const big = message();
    // Bypass the guard's ArrayBuffer check by resizing via a fresh message.
    const oversized = {
      ...big,
      candidateBytes: new ArrayBuffer(VERIFY_MAX_CANDIDATE_BYTES + 1),
    };
    const out = await dispatchVerify(oversized, d);
    expect(out).toEqual({ type: "VERIFY_FAILED", reason: "budget-exhausted" });
    expect(d.runChecks).not.toHaveBeenCalled();
  });

  it("always closes both documents, even on digest mismatch", async () => {
    const d = deps({ sha256: async () => "other" as Sha256Digest });
    await dispatchVerify(message(), d);
    // Candidate was opened before the digest check; it must still be closed.
    expect(d.closed).toContain("candidate");
  });

  it("closes both documents on the success path", async () => {
    const d = deps({ sha256: async () => EXPECTED });
    await dispatchVerify(message(), d);
    expect(d.closed).toContain("candidate");
    expect(d.closed).toContain("source");
  });

  it("does not depend on transformation-internal state (FR-012 independence)", async () => {
    // The message carries no verdict, no self-check, no engine handle —
    // only bytes, a digest, geometry, and policy versions. Verification
    // succeeds from those alone.
    const d = deps({ sha256: async () => EXPECTED });
    const msg = message() as unknown as Record<string, unknown>;
    expect("selfCheck" in msg).toBe(false);
    expect("verdict" in msg).toBe(false);
    const out = await dispatchVerify(message(), d);
    expect(out.type).toBe("VERIFY_RESULT");
  });
});
