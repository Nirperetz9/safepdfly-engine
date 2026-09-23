/**
 * T058 — Transformation worker protocol.
 *
 * 1. APPLY_REDACTIONS validation: unknown/malformed messages fail closed.
 * 2. Version pinning: requests naming other engine/policy versions are rejected.
 * 3. Outbound validation: CANDIDATE_READY shape (identity matches bytes);
 *    TRANSFORM_FAILED carries only a code.
 */
import { describe, expect, it } from "vitest";
import {
  REDACTION_POLICY_VERSION,
  SAVE_POLICY_VERSION,
  TRANSFORM_ENGINE_VERSION,
  isApplyRedactionsMessage,
  isTransformOutbound,
  type ApplyRedactionsMessage,
} from "./protocol.js";

function validRequest(): ApplyRedactionsMessage {
  return {
    type: "APPLY_REDACTIONS",
    payload: new ArrayBuffer(16),
    rects: [{ page: 0, x0: 10, y0: 20, x1: 110, y1: 120 }],
    policy: {
      engine: TRANSFORM_ENGINE_VERSION,
      redaction: REDACTION_POLICY_VERSION,
      save: SAVE_POLICY_VERSION,
    },
  };
}

describe("APPLY_REDACTIONS validation", () => {
  it("accepts a well-formed request", () => {
    expect(isApplyRedactionsMessage(validRequest())).toBe(true);
  });

  it("fails closed on unknown message types", () => {
    expect(isApplyRedactionsMessage({ type: "REDACT_PLEASE" })).toBe(false);
    expect(isApplyRedactionsMessage({ type: "CANDIDATE_READY" })).toBe(false);
    expect(isApplyRedactionsMessage(null)).toBe(false);
    expect(isApplyRedactionsMessage(undefined)).toBe(false);
    expect(isApplyRedactionsMessage("APPLY_REDACTIONS")).toBe(false);
  });

  it("rejects a non-transferred payload", () => {
    const m = { ...validRequest(), payload: [1, 2, 3] };
    expect(isApplyRedactionsMessage(m)).toBe(false);
  });

  it("rejects empty or degenerate rectangles", () => {
    expect(
      isApplyRedactionsMessage({ ...validRequest(), rects: [] }),
    ).toBe(false);
    // Zero-area rect.
    const zero = { ...validRequest() };
    zero.rects = [{ page: 0, x0: 10, y0: 20, x1: 10, y1: 120 }];
    expect(isApplyRedactionsMessage(zero)).toBe(false);
    // Unordered rect.
    const unordered = { ...validRequest() };
    unordered.rects = [{ page: 0, x0: 110, y0: 20, x1: 10, y1: 120 }];
    expect(isApplyRedactionsMessage(unordered)).toBe(false);
    // Non-finite coordinate.
    const nan = { ...validRequest() };
    nan.rects = [{ page: 0, x0: NaN, y0: 20, x1: 110, y1: 120 }];
    expect(isApplyRedactionsMessage(nan)).toBe(false);
    // Negative page.
    const neg = { ...validRequest() };
    neg.rects = [{ page: -1, x0: 10, y0: 20, x1: 110, y1: 120 }];
    expect(isApplyRedactionsMessage(neg)).toBe(false);
  });

  it("rejects requests naming different policy versions", () => {
    const m = { ...validRequest() };
    m.policy = { ...m.policy, engine: "mupdf/9.9.9" as typeof TRANSFORM_ENGINE_VERSION };
    expect(isApplyRedactionsMessage(m)).toBe(false);
    const m2 = { ...validRequest() };
    m2.policy = { ...m2.policy, save: "save/incremental/1" as typeof SAVE_POLICY_VERSION };
    expect(isApplyRedactionsMessage(m2)).toBe(false);
  });
});

describe("outbound validation", () => {
  const versions = {
    engine: TRANSFORM_ENGINE_VERSION,
    redaction: REDACTION_POLICY_VERSION,
    save: SAVE_POLICY_VERSION,
  };

  it("accepts a well-formed CANDIDATE_READY", () => {
    const payload = new ArrayBuffer(32);
    expect(
      isTransformOutbound({
        type: "CANDIDATE_READY",
        payload,
        sha256: "a".repeat(64),
        byteLength: 32,
        selfCheck: "ok",
        versions,
      }),
    ).toBe(true);
  });

  it("rejects CANDIDATE_READY when identity does not match the bytes", () => {
    const payload = new ArrayBuffer(32);
    expect(
      isTransformOutbound({
        type: "CANDIDATE_READY",
        payload,
        sha256: "a".repeat(64),
        byteLength: 31,
        selfCheck: "ok",
        versions,
      }),
    ).toBe(false);
  });

  it("rejects CANDIDATE_READY with a malformed digest", () => {
    const payload = new ArrayBuffer(8);
    expect(
      isTransformOutbound({
        type: "CANDIDATE_READY",
        payload,
        sha256: "not-a-digest",
        byteLength: 8,
        selfCheck: "ok",
        versions,
      }),
    ).toBe(false);
  });

  it("accepts TRANSFORM_FAILED with a code only", () => {
    expect(
      isTransformOutbound({ type: "TRANSFORM_FAILED", reason: "engine-error" }),
    ).toBe(true);
  });

  it("rejects unknown outbound messages", () => {
    expect(isTransformOutbound({ type: "DOWNLOAD_READY", url: "blob:x" })).toBe(false);
    expect(isTransformOutbound(null)).toBe(false);
  });
});
