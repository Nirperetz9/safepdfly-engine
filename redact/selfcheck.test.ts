/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T062 — Candidate identity and internal self-check.
 *
 * 1. runSelfCheck: "ok" on a real candidate; "failed" (never throws) on
 *    truncated, corrupt, or empty bytes and on a page-count mismatch.
 * 2. Identity: the SHA-256 and byte length describe the exact candidate
 *    bytes that crossed the worker boundary.
 * 3. The candidate is never labeled safe and carries no download URL:
 *    exact message/candidate shapes, plus a source scan proving no safe
 *    verdict and no URL minting exists in the redact path. Export success
 *    (selfCheck "ok") alone never implies safety (FR-012, PR-006) —
 *    independent verification (Phase 7) decides what the user may download.
 */
import { describe, expect, it } from "vitest";
import { createMuPdfBackend } from "./adapter.js";
import { dispatchTransform } from "./handler.js";
import {
  REDACTION_POLICY_VERSION,
  SAVE_POLICY_VERSION,
  TRANSFORM_ENGINE_VERSION,
} from "./protocol.js";
import { runSelfCheck } from "./selfcheck.js";
import {
  fixtureBytes,
  manifestRects,
  redactDir,
  sourcesIn,
  workersDir,
} from "./test-utils.js";

const FIXTURE = "text/en-basic.pdf";

function policyMessage(payload: ArrayBuffer) {
  return {
    type: "APPLY_REDACTIONS" as const,
    payload,
    rects: manifestRects(FIXTURE),
    policy: {
      engine: TRANSFORM_ENGINE_VERSION,
      redaction: REDACTION_POLICY_VERSION,
      save: SAVE_POLICY_VERSION,
    },
    sanitize: false,
  };
}

async function realCandidate(): Promise<ArrayBuffer> {
  const backend = createMuPdfBackend();
  const { bytes, selfCheck } = await backend.apply(
    fixtureBytes(FIXTURE),
    manifestRects(FIXTURE),
    false,
  );
  expect(selfCheck).toBe("ok");
  return bytes;
}

describe("runSelfCheck", () => {
  it('returns "ok" for a genuine candidate', async () => {
    const bytes = await realCandidate();
    expect(runSelfCheck(bytes, 1)).toBe("ok");
  }, 60000);

  it('returns "failed" for severely truncated bytes without throwing', async () => {
    // MuPDF repairs some truncations leniently, so the self-check only
    // promises to catch unparseable output — documented in selfcheck.ts.
    const bytes = await realCandidate();
    expect(runSelfCheck(bytes.slice(0, 128), 1)).toBe("failed");
  }, 60000);

  it('returns "failed" for corrupt bytes without throwing', () => {
    const junk = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x99, 0x88]).buffer;
    expect(runSelfCheck(junk, 1)).toBe("failed");
  });

  it('returns "failed" for empty bytes', () => {
    expect(runSelfCheck(new ArrayBuffer(0), 1)).toBe("failed");
  });

  it('returns "failed" when the page count changed', async () => {
    const bytes = await realCandidate();
    expect(runSelfCheck(bytes, 2)).toBe("failed");
  }, 60000);
});

describe("candidate identity", () => {
  it("SHA-256 and byte length describe the exact candidate bytes", async () => {
    const backend = createMuPdfBackend();
    const out = await dispatchTransform(
      policyMessage(fixtureBytes(FIXTURE)),
      backend,
    );
    expect(out.type).toBe("CANDIDATE_READY");
    if (out.type !== "CANDIDATE_READY") throw new Error("narrow");
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", out.payload),
    ).toString("hex");
    expect(out.sha256).toBe(digest);
    expect(out.byteLength).toBe(out.payload.byteLength);
  }, 60000);
});

describe("the candidate is never labeled safe and has no download URL", () => {
  it("CANDIDATE_READY carries identity only — no URL, no verdict", async () => {
    const backend = createMuPdfBackend();
    const out = await dispatchTransform(
      policyMessage(fixtureBytes(FIXTURE)),
      backend,
    );
    expect(out.type).toBe("CANDIDATE_READY");
    if (out.type !== "CANDIDATE_READY") throw new Error("narrow");
    expect(Object.keys(out).sort()).toEqual([
      "byteLength",
      "payload",
      "selfCheck",
      "sha256",
      "type",
      "versions",
    ]);
    // Even with selfCheck "ok", nothing here authorizes a download.
    expect(out.selfCheck).toBe("ok");
    expect(JSON.stringify(out).includes("safe")).toBe(false);
  }, 60000);

  it("no safe verdict and no URL minting exist in the redact path", () => {
    const sources = [
      ...sourcesIn(redactDir),
      ...sourcesIn(workersDir, "redact-"),
    ];
    for (const s of sources) {
      expect(s.text.includes('"safe"'), `${s.name}: "safe" literal`).toBe(false);
      expect(/(^|[^a-zA-Z])safe\s*:/.test(s.text), `${s.name}: safe: property`).toBe(
        false,
      );
      expect(s.text.includes("createObjectURL"), s.name).toBe(false);
    }
  });
});
