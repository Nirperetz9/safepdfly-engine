/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T069 — verification report assembler (host side).
 *
 * The worker returns raw check results (VerifyWorkerResult); the host
 * assembles the user-facing VerificationReport. Combining rules:
 *
 * - Each requested selection gets exactly one SelectionCheckResult. The
 *   worker reports one check per aspect ("text", "visual"); the combined
 *   verdict is fail if any aspect fails, else indeterminate if any aspect
 *   is indeterminate or missing, else pass. The text aspect's reason code
 *   takes precedence on ties — it is the privacy-critical claim — and every
 *   aspect code is preserved in the report-level reasonCodes.
 * - A selection with no checks at all is missing: fail closed to
 *   indeterminate ("verify.report.selection-missing"). A selection with
 *   only one aspect is indeterminate ("verify.report.aspect-missing").
 * - Overall outcome: any fail anywhere (document check, selection, or
 *   outside-mask) → fail. Otherwise any indeterminate anywhere → 
 *   indeterminate. Otherwise pass. Warnings never change the outcome:
 *   all-clear plus a duplicate warning is still pass.
 * - Evidence pins the exact redaction engine, the exact PDF.js version
 *   that verified, the policy version, the rect count, and the SHA-256 of
 *   the exact candidate bytes the worker checked.
 */

import type {
  SelectionCheckResult,
  SelectionId,
  VerificationOutcome,
  VerificationReport,
} from "../model.js";
import type { PageIndex } from "../geometry/index.js";
import { TRANSFORM_ENGINE_VERSION } from "../redact/protocol.js";
import type {
  SelectionCheckAspect,
  VerifySelectionCheck,
  VerifyWorkerResult,
} from "./protocol.js";

/** A requested mark the report must cover. */
export interface AssemblerSelection {
  readonly selectionId: SelectionId;
  /** 1-based mark number shown in the UI. */
  readonly number: number;
  /** 0-based page index of the mark. */
  readonly page: PageIndex;
}

/** Reason codes the assembler itself emits (fail-closed gaps). */
export const REPORT_SELECTION_MISSING = "verify.report.selection-missing";
export const REPORT_ASPECT_MISSING = "verify.report.aspect-missing";

/** Aspect precedence: text is the privacy-critical claim. */
const ASPECT_PRECEDENCE: readonly SelectionCheckAspect[] = ["text", "visual"];

function combineAspects(
  checks: readonly VerifySelectionCheck[],
): { outcome: VerificationOutcome; reasonCode: string } {
  const ordered = [...checks].sort(
    (a, b) => ASPECT_PRECEDENCE.indexOf(a.aspect) - ASPECT_PRECEDENCE.indexOf(b.aspect),
  );
  const byAspect = new Map(ordered.map((c) => [c.aspect, c] as const));
  if (!byAspect.has("text") || !byAspect.has("visual")) {
    return { outcome: "indeterminate", reasonCode: REPORT_ASPECT_MISSING };
  }
  if (ordered.some((c) => c.outcome === "fail")) {
    const failed = ordered.find((c) => c.outcome === "fail")!;
    return { outcome: "fail", reasonCode: failed.reasonCode };
  }
  if (ordered.some((c) => c.outcome === "indeterminate")) {
    const unknown = ordered.find((c) => c.outcome === "indeterminate")!;
    return { outcome: "indeterminate", reasonCode: unknown.reasonCode };
  }
  return { outcome: "pass", reasonCode: ordered[0]!.reasonCode };
}

function combineOverall(outcomes: readonly VerificationOutcome[]): VerificationOutcome {
  if (outcomes.includes("fail")) return "fail";
  if (outcomes.includes("indeterminate")) return "indeterminate";
  return "pass";
}

export function assembleVerificationReport(
  result: VerifyWorkerResult,
  selections: readonly AssemblerSelection[],
): VerificationReport {
  const reasonCodes: string[] = [];
  const pushCode = (code: string): void => {
    if (!reasonCodes.includes(code)) reasonCodes.push(code);
  };

  const checksBySelection = new Map<string, VerifySelectionCheck[]>();
  for (const check of result.selectionChecks) {
    const list = checksBySelection.get(check.selectionId) ?? [];
    list.push(check);
    checksBySelection.set(check.selectionId, list);
  }

  const selectionChecks: SelectionCheckResult[] = [];
  const selectionAspectCodes: string[][] = [];
  for (const selection of selections) {
    const checks = checksBySelection.get(selection.selectionId) ?? [];
    let outcome: VerificationOutcome;
    let reasonCode: string;
    if (checks.length === 0) {
      // Fail closed: the worker produced nothing for a requested mark.
      outcome = "indeterminate";
      reasonCode = REPORT_SELECTION_MISSING;
    } else {
      ({ outcome, reasonCode } = combineAspects(checks));
    }
    selectionChecks.push({
      selectionId: selection.selectionId,
      pageIndex: selection.page,
      outcome,
      reasonCode,
    });
    selectionAspectCodes.push(
      ASPECT_PRECEDENCE.map(
        (aspect) => checks.find((c) => c.aspect === aspect)?.reasonCode,
      ).filter((code): code is string => code !== undefined),
    );
  }

  // Report-level codes, model field order: document, selections, outside.
  for (const check of result.documentChecks) pushCode(check.reasonCode);
  selectionChecks.forEach((selection, i) => {
    for (const code of selectionAspectCodes[i]!) pushCode(code);
    if (selectionAspectCodes[i]!.length < ASPECT_PRECEDENCE.length) {
      pushCode(selection.reasonCode);
    }
  });
  pushCode(result.outsideMaskReasonCode);

  const outcome = combineOverall([
    ...result.documentChecks.map((c) => c.outcome),
    result.outsideMaskOutcome,
    ...selectionChecks.map((c) => c.outcome),
  ]);

  return {
    candidateSha256: result.candidateSha256,
    engineVersion: TRANSFORM_ENGINE_VERSION,
    policyVersion: result.versions.verify,
    pdfjsVersion: result.versions.engine.replace(/^pdfjs\//, ""),
    rectCount: selections.length,
    outcome,
    documentChecks: result.documentChecks.map((c) => ({
      check: c.check,
      outcome: c.outcome,
    })),
    selectionChecks,
    outsideMaskOutcome: result.outsideMaskOutcome,
    warnings: result.warnings.map((w) => ({
      code: w.code,
      pageIndex: w.pageIndex as PageIndex,
      selectionNumber: w.selectionNumber,
    })),
    reasonCodes,
  };
}
