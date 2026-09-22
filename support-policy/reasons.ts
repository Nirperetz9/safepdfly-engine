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
