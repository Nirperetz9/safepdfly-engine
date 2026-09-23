/**
 * T064 placeholder — the real verification checks land in T065–T068
 * (document, text, visible-content, and duplicate-occurrence checks).
 *
 * Until then this runner fails closed: it throws, and the handler maps a
 * throwing runner to VERIFY_FAILED/internal (ambiguity → indeterminate at
 * the report level), so no candidate can ever verify through this path.
 * T065–T068 will replace the body, not the interface.
 */
import type { VerifyCheckRunner } from "./handler.js";

export const runVerificationChecks: VerifyCheckRunner = async () => {
  throw new Error("verify: checks T065-T068 not yet implemented");
};
