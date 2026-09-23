/**
 * T036 — Shared support-reason vocabulary.
 *
 * These are the only failure identities that may cross worker boundaries or
 * appear in verdicts; raw engine errors never do. The features layer maps
 * each code to bilingual UX copy (docs/ux/content.md).
 *
 * (Relocated from pdf/input/protocol.ts, which re-exports for compatibility.)
 */
export const SUPPORT_REASON_CODES = [
  "wrong-type",
  "empty",
  "damaged",
  "locked",
  "signed",
  "xfa",
  "form-widget",
  "embedded-file",
  "js-actions",
  "rich-media",
  "scanned",
  "hybrid",
  "annotation-overlap",
  "hidden-layer",
  "over-limit",
  "disagreement",
  "unexpected",
] as const;

export type SupportReasonCode = (typeof SUPPORT_REASON_CODES)[number];

export function isSupportReasonCode(value: unknown): value is SupportReasonCode {
  return (
    typeof value === "string" &&
    (SUPPORT_REASON_CODES as readonly string[]).includes(value)
  );
}

/**
 * T103 — findings a document can carry into review without being rejected:
 * layers the T099 sanitize step fully removes. These are never failure
 * identities; they are advice attached to a *successful* intake, consumed by
 * the review notice and the T061 precondition (which blocks the run until
 * the user opts into sanitization).
 */
export const SANITIZABLE_FINDINGS = ["embedded-files", "java-script"] as const;

export type SanitizableFinding = (typeof SANITIZABLE_FINDINGS)[number];

export function isSanitizableFinding(
  value: unknown,
): value is SanitizableFinding {
  return (
    typeof value === "string" &&
    (SANITIZABLE_FINDINGS as readonly string[]).includes(value)
  );
}
