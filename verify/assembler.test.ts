/**
 * T069 — report assembler tests (host side).
 */
import { describe, expect, it } from "vitest";
import {
  assembleVerificationReport,
  REPORT_ASPECT_MISSING,
  REPORT_SELECTION_MISSING,
  type AssemblerSelection,
} from "./assembler.js";
import {
  VERIFY_ENGINE_VERSION,
  VERIFY_POLICY_VERSION,
  type VerifySelectionCheck,
  type VerifyWorkerResult,
} from "./protocol.js";
import type { Sha256Digest } from "../geometry/index.js";
import type { PageIndex } from "../geometry/index.js";
import type { SelectionId } from "../model.js";

const SEL: AssemblerSelection = {
  selectionId: "s1" as SelectionId,
  number: 1,
  page: 0 as PageIndex,
};

function check(
  selectionId: string,
  aspect: "text" | "visual",
  outcome: "pass" | "fail" | "indeterminate",
  reasonCode: string,
): VerifySelectionCheck {
  return { selectionId, page: 0, number: 1, aspect, outcome, reasonCode };
}

function result(
  selectionChecks: readonly VerifySelectionCheck[],
  overrides?: Partial<VerifyWorkerResult>,
): VerifyWorkerResult {
  return {
    candidateSha256: "ab".repeat(32) as Sha256Digest,
    documentChecks: [
      { check: "page-count", outcome: "pass", reasonCode: "verify.document.page-count-ok" },
    ],
    selectionChecks,
    outsideMaskOutcome: "pass",
    outsideMaskReasonCode: "verify.visual.outside-ok",
    warnings: [],
    versions: { engine: VERIFY_ENGINE_VERSION, verify: VERIFY_POLICY_VERSION },
    ...overrides,
  };
}

const BOTH_PASS = [
  check("s1", "text", "pass", "verify.text.clear"),
  check("s1", "visual", "pass", "verify.visual.fill-ok"),
];

describe("assembleVerificationReport (T069)", () => {
  it("reports pass with exact evidence when everything clears", () => {
    const report = assembleVerificationReport(result(BOTH_PASS), [SEL]);
    expect(report.outcome).toBe("pass");
    expect(report.selectionChecks).toEqual([
      { selectionId: "s1", pageIndex: 0, outcome: "pass", reasonCode: "verify.text.clear" },
    ]);
    expect(report.candidateSha256).toBe("ab".repeat(32));
    expect(report.engineVersion).toBe("mupdf/1.28.1");
    expect(report.pdfjsVersion).toBe("6.3.289");
    expect(report.policyVersion).toBe(VERIFY_POLICY_VERSION);
    expect(report.rectCount).toBe(1);
    expect(report.reasonCodes).toEqual([
      "verify.document.page-count-ok",
      "verify.text.clear",
      "verify.visual.fill-ok",
      "verify.visual.outside-ok",
    ]);
    expect(report.warnings).toEqual([]);
  });

  it("fails when any aspect of any selection fails", () => {
    const checks = [
      check("s1", "text", "fail", "verify.text.remaining"),
      check("s1", "visual", "pass", "verify.visual.fill-ok"),
    ];
    const report = assembleVerificationReport(result(checks), [SEL]);
    expect(report.outcome).toBe("fail");
    expect(report.selectionChecks[0]).toMatchObject({
      outcome: "fail",
      reasonCode: "verify.text.remaining",
    });
  });

  it("fails when a document check or the outside-mask check fails", () => {
    const docFail = result(BOTH_PASS, {
      documentChecks: [
        { check: "javascript-actions", outcome: "fail", reasonCode: "verify.document.js-actions" },
      ],
    });
    expect(assembleVerificationReport(docFail, [SEL]).outcome).toBe("fail");

    const outsideFail = result(BOTH_PASS, {
      outsideMaskOutcome: "fail",
      outsideMaskReasonCode: "verify.visual.outside-damage",
    });
    const report = assembleVerificationReport(outsideFail, [SEL]);
    expect(report.outcome).toBe("fail");
    expect(report.outsideMaskOutcome).toBe("fail");
    expect(report.reasonCodes).toContain("verify.visual.outside-damage");
  });

  it("reports indeterminate when any check is indeterminate", () => {
    const checks = [
      check("s1", "text", "pass", "verify.text.clear"),
      check("s1", "visual", "indeterminate", "verify.visual.render-unavailable"),
    ];
    const report = assembleVerificationReport(result(checks), [SEL]);
    expect(report.outcome).toBe("indeterminate");
    expect(report.selectionChecks[0]).toMatchObject({
      outcome: "indeterminate",
      reasonCode: "verify.visual.render-unavailable",
    });
  });

  it("fails closed when a selection has no checks at all", () => {
    const report = assembleVerificationReport(result([]), [SEL]);
    expect(report.outcome).toBe("indeterminate");
    expect(report.selectionChecks[0]).toMatchObject({
      outcome: "indeterminate",
      reasonCode: REPORT_SELECTION_MISSING,
    });
    expect(report.reasonCodes).toContain(REPORT_SELECTION_MISSING);
  });

  it("fails closed when an aspect is missing", () => {
    const checks = [check("s1", "text", "pass", "verify.text.clear")];
    const report = assembleVerificationReport(result(checks), [SEL]);
    expect(report.outcome).toBe("indeterminate");
    expect(report.selectionChecks[0]).toMatchObject({
      outcome: "indeterminate",
      reasonCode: REPORT_ASPECT_MISSING,
    });
  });

  it("keeps pass when all is clear and only a warning was raised", () => {
    const warned = result(BOTH_PASS, {
      warnings: [{ code: "duplicate-occurrence", pageIndex: 2, selectionNumber: 1 }],
    });
    const report = assembleVerificationReport(warned, [SEL]);
    expect(report.outcome).toBe("pass");
    expect(report.warnings).toEqual([
      { code: "duplicate-occurrence", pageIndex: 2, selectionNumber: 1 },
    ]);
  });

  it("is deterministic", () => {
    const input = result(BOTH_PASS);
    const once = assembleVerificationReport(input, [SEL]);
    const twice = assembleVerificationReport(input, [SEL]);
    expect(twice).toEqual(once);
  });
});
