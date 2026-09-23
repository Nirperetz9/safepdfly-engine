/**
 * T064 — Verification check composition (worker side).
 *
 * T065 wires in the document checks. T066 (text), T067 (visible content),
 * and T068 (duplicate-occurrence warning) land next; until they do, the
 * unimplemented parts stay honestly indeterminate — never a silent pass —
 * so no candidate can verify through this path yet.
 */
import type { VerifyCheckContext, VerifyCheckRunner } from "./handler.js";
import { runDocumentChecks } from "./checks/document.js";
import { runTextChecks } from "./checks/text.js";
import { runVisualChecks } from "./checks/visual.js";
import { runDuplicateWarnings } from "./checks/duplicates.js";

export const runVerificationChecks: VerifyCheckRunner = async (
  ctx: VerifyCheckContext,
) => {
  const [documentChecks, textChecks, visual, warnings] = await Promise.all([
    runDocumentChecks(ctx),
    runTextChecks(ctx),
    runVisualChecks(ctx),
    runDuplicateWarnings(ctx),
  ]);
  return {
    documentChecks,
    selectionChecks: [...textChecks, ...visual.selectionChecks],
    outsideMaskOutcome: visual.outsideMaskOutcome,
    outsideMaskReasonCode: visual.outsideMaskReasonCode,
    warnings,
  };
};
