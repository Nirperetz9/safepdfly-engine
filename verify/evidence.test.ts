/**
 * T070 — deterministic evidence/versioning tests.
 */
import { describe, expect, it } from "vitest";
import {
  assembleVerificationReport,
  type AssemblerSelection,
} from "./assembler.js";
import {
  canonicalJson,
  canonicalReportBytes,
  EVIDENCE_VERSIONS,
  VERIFY_VISUAL_THRESHOLDS,
} from "./evidence.js";
import {
  VERIFY_ENGINE_VERSION,
  VERIFY_POLICY_VERSION,
  type VerifySelectionCheck,
  type VerifyWorkerResult,
} from "./protocol.js";
import type { Sha256Digest } from "../geometry/index.js";
import type { PageIndex } from "../geometry/index.js";
import type { SelectionId } from "../model.js";

describe("canonicalJson (T070)", () => {
  it("sorts keys at every depth and preserves array order", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [3, 2], c: 1 }, z: [{ b: 1, a: 2 }] }),
    ).toBe('{"a":{"c":1,"d":[3,2]},"b":1,"z":[{"a":2,"b":1}]}');
  });

  it("drops undefined values like JSON does", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("round-trips through JSON unchanged", () => {
    const value = { b: [1, { y: 2, x: 1 }], a: "s" };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });
});

describe("canonicalReportBytes (T070)", () => {
  function workerResult(): VerifyWorkerResult {
    const check = (
      aspect: "text" | "visual",
    ): VerifySelectionCheck => ({
      selectionId: "s1",
      page: 0,
      number: 1,
      aspect,
      outcome: "pass",
      reasonCode: aspect === "text" ? "verify.text.clear" : "verify.visual.fill-ok",
    });
    return {
      candidateSha256: "ab".repeat(32) as Sha256Digest,
      documentChecks: [
        { check: "page-count", outcome: "pass", reasonCode: "verify.document.page-count-ok" },
      ],
      selectionChecks: [check("text"), check("visual")],
      outsideMaskOutcome: "pass",
      outsideMaskReasonCode: "verify.visual.outside-ok",
      warnings: [],
      versions: { engine: VERIFY_ENGINE_VERSION, verify: VERIFY_POLICY_VERSION },
    };
  }

  const selections: AssemblerSelection[] = [
    { selectionId: "s1" as SelectionId, number: 1, page: 0 as PageIndex },
  ];

  it("produces identical bytes for the same PDF and marks", () => {
    const once = canonicalReportBytes(assembleVerificationReport(workerResult(), selections));
    const twice = canonicalReportBytes(assembleVerificationReport(workerResult(), selections));
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
    expect(once.length).toBeGreaterThan(0);
  });
});

describe("frozen versions and thresholds (T070)", () => {
  it("pins the exact engine/policy version strings — changing them requires a spec amendment", () => {
    expect(EVIDENCE_VERSIONS).toEqual({
      transformEngine: "mupdf/1.28.1",
      verifyEngine: "pdfjs/6.3.289",
      verifyPolicy: "verify-policy/1",
      redactionPolicy: "redaction-policy/1",
      savePolicy: "save/garbage+gc/1",
    });
  });

  it("pins the exact deterministic thresholds — changing them requires a spec amendment", () => {
    expect(VERIFY_VISUAL_THRESHOLDS).toEqual({
      visualScale: 2,
      aaBoundaryPx: 2,
      fillUniformityTolerance: 4,
      fillBlackTolerance: 8,
      retainedTolerance: 4,
      outsideTolerance: 2,
      glyphExclusionMarginPx: 3,
    });
  });
});
