/**
 * T064 — protocol tests: strict message validation, stable failure codes,
 * checkpoint routing, and the failure→outcome mapping.
 */
import { describe, expect, it } from "vitest";
import {
  VERIFY_ENGINE_VERSION,
  VERIFY_POLICY_VERSION,
  VERIFY_FAILURE_OUTCOME,
  isVerifyCandidateMessage,
  isVerifyCheckpointMessage,
  isVerifyFailureCode,
  isVerifyOutbound,
} from "./protocol.js";

function candidateMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "VERIFY_CANDIDATE",
    sourceBytes: new ArrayBuffer(8),
    candidateBytes: new ArrayBuffer(8),
    expectedCandidateSha256: "aa",
    rects: [],
    expectedPages: [],
    policy: { engine: VERIFY_ENGINE_VERSION, verify: VERIFY_POLICY_VERSION },
    ...overrides,
  };
}

describe("verify protocol", () => {
  it("accepts a well-formed VERIFY_CANDIDATE message", () => {
    expect(
      isVerifyCandidateMessage(
        candidateMessage({
          rects: [
            {
              page: 0,
              x0: 1,
              y0: 2,
              x1: 3,
              y1: 4,
              selectionId: "s1",
              number: 1,
            },
          ],
          expectedPages: [{ page: 0, view: [0, 0, 100, 100], rotation: 0 }],
        }),
      ),
    ).toBe(true);
  });

  it("rejects non-ArrayBuffer payloads (fail closed on protocol)", () => {
    expect(
      isVerifyCandidateMessage(candidateMessage({ candidateBytes: "nope" })),
    ).toBe(false);
    expect(
      isVerifyCandidateMessage(candidateMessage({ sourceBytes: null })),
    ).toBe(false);
  });

  it("rejects malformed rects and pages", () => {
    expect(
      isVerifyCandidateMessage(candidateMessage({ rects: [{ page: 0 }] })),
    ).toBe(false);
    expect(
      isVerifyCandidateMessage(
        candidateMessage({
          expectedPages: [{ page: 0, view: [0, 0], rotation: 0 }],
        }),
      ),
    ).toBe(false);
    expect(
      isVerifyCandidateMessage(
        candidateMessage({
          expectedPages: [{ page: 0, view: [0, 0, 1, 1], rotation: 45 }],
        }),
      ),
    ).toBe(false);
  });

  it("rejects wrong policy versions (engine pin mismatch)", () => {
    expect(
      isVerifyCandidateMessage(
        candidateMessage({
          policy: { engine: "pdfjs/9.9.9", verify: VERIFY_POLICY_VERSION },
        }),
      ),
    ).toBe(false);
  });

  it("rejects unknown message types", () => {
    expect(isVerifyCandidateMessage({ type: "APPLY_REDACTIONS" })).toBe(false);
    expect(isVerifyCandidateMessage(null)).toBe(false);
  });

  it("guards the stable failure-code set; raw strings fail closed", () => {
    expect(isVerifyFailureCode("digest-mismatch")).toBe(true);
    expect(isVerifyFailureCode("timeout")).toBe(true);
    expect(isVerifyFailureCode("boom")).toBe(false);
    expect(isVerifyFailureCode("Error: xref")).toBe(false);
    expect(isVerifyFailureCode(undefined)).toBe(false);
  });

  it("routes checkpoint messages separately from terminal messages", () => {
    expect(
      isVerifyCheckpointMessage({
        type: "VERIFY_CHECKPOINT",
        checkpoint: "reopened",
      }),
    ).toBe(true);
    expect(
      isVerifyCheckpointMessage({
        type: "VERIFY_CHECKPOINT",
        checkpoint: "checks-done",
      }),
    ).toBe(true);
    expect(
      isVerifyCheckpointMessage({
        type: "VERIFY_CHECKPOINT",
        checkpoint: "nope",
      }),
    ).toBe(false);
    expect(
      isVerifyCheckpointMessage({ type: "VERIFY_RESULT", result: {} }),
    ).toBe(false);
  });

  it("accepts VERIFY_RESULT and VERIFY_FAILED outbound shapes", () => {
    expect(isVerifyOutbound({ type: "VERIFY_RESULT", result: {} })).toBe(true);
    expect(
      isVerifyOutbound({ type: "VERIFY_FAILED", reason: "parse-error" }),
    ).toBe(true);
    expect(
      isVerifyOutbound({ type: "VERIFY_FAILED", reason: "raw engine text" }),
    ).toBe(false);
    expect(
      isVerifyOutbound({ type: "VERIFY_CHECKPOINT", checkpoint: "reopened" }),
    ).toBe(false);
  });

  it("maps integrity failures to fail and ambiguity to indeterminate", () => {
    expect(VERIFY_FAILURE_OUTCOME["digest-mismatch"]).toBe("fail");
    expect(VERIFY_FAILURE_OUTCOME["parse-error"]).toBe("fail");
    for (const code of [
      "source-unavailable",
      "budget-exhausted",
      "timeout",
      "worker-error",
      "protocol",
      "internal",
    ] as const) {
      expect(VERIFY_FAILURE_OUTCOME[code]).toBe("indeterminate");
    }
  });
});
