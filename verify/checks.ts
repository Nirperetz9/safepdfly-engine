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

export const runVerificationChecks: VerifyCheckRunner = async (
  ctx: VerifyCheckContext,
) => {
  const documentChecks = await runDocumentChecks(ctx);
  return {
    documentChecks,
    // T066 — text checks: no non-whitespace/selectable text in marked rects.
    selectionChecks: [],
    // T067 — visible-content checks: uniform fill, no retained pixels,
    // no outside-mask damage.
    outsideMaskOutcome: "indeterminate",
    outsideMaskReasonCode: "verify.visual.not-implemented",
    // T068 — duplicate-occurrence warnings.
    warnings: [],
  };
};
