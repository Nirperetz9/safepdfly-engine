/**
 * T038 — Unsupported-feature and malformed-input rejection policy.
 *
 * Intake order (the orchestrator, T034, composes these; each stage is
 * fail-closed and later stages never run after a rejection):
 *
 *   1. precheckSource(bytes) — byte-level gates: wrong-type, xfa.
 *      (The 25 MiB source-size gate is T040's; it runs here too but is
 *      defined and validated there.)
 *   2. Engine open failures — the input worker (T033) and the classifier
 *      (T085) each reject encrypted/corrupt/empty/non-PDF input with stable
 *      codes; mapClassifyFailure translates classifier codes into the
 *      shared SupportReasonCode vocabulary. Passwords are never attempted.
 *   3. adjudicateFeatures(report.features) — XFA, signatures, form widgets,
 *      embedded files, JavaScript/actions, rich media.
 *   4. T037 scanned/hybrid adjudication on dual-engine-agreed pages (T036).
 *
 * Annotation and optional-content handling is T086's, scoped to selections;
 * general annotation sanitization remains an explicit non-goal.
 */
import type { ClassifyFailureCode } from "../classify-mupdf/classifier.js";
import type { DocumentFeatures } from "../classify-mupdf/readonly-facade.js";
import type { SupportReasonCode } from "./reasons.js";

/**
 * Translate a classifier failure code into the shared vocabulary.
 * Total: unknown codes map to "unexpected", never throw, never leak.
 */
export function mapClassifyFailure(
  code: ClassifyFailureCode | (string & {}),
): SupportReasonCode {
  switch (code) {
    case "not-a-pdf":
      return "wrong-type";
    case "encrypted":
      return "locked";
    case "corrupt":
      return "damaged";
    case "empty":
      return "empty";
    default:
      return "unexpected";
  }
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-

/**
 * The /XFA dictionary key. Scanned at the byte level because a malformed
 * XFA file may not survive either engine's parser (corpus xfa.pdf), while a
 * well-formed one is also caught via the catalog (facade documentFeatures).
 * A false positive (e.g. the literal text "/XFA" inside page content)
 * fails closed toward the "xfa" rejection.
 */
const XFA_DICT_KEY_RE = /\/XFA(?=[\s<>\[\]\(\)/])/;

/**
 * Byte-level intake gates, runnable before any engine work. Returns the
 * rejection reason, or null when the bytes pass to the engines.
 */
export function precheckSource(bytes: unknown): SupportReasonCode | null {
  if (!(bytes instanceof ArrayBuffer)) return "wrong-type";
  const view = new Uint8Array(bytes);
  if (
    view.length < PDF_MAGIC.length ||
    !PDF_MAGIC.every((b, i) => view[i] === b)
  ) {
    return "wrong-type";
  }
  // Decode as latin1 (1:1 byte mapping) in chunks to avoid argument-list
  // limits; no Node Buffer — this module ships to the browser.
  const bytes8 = new Uint8Array(bytes);
  let text = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes8.length; i += CHUNK) {
    text += String.fromCharCode(...bytes8.subarray(i, i + CHUNK));
  }
  if (XFA_DICT_KEY_RE.test(text)) return "xfa";
  return null;
}

export type FeatureVerdict =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: SupportReasonCode };

/**
 * Reject documents carrying unsupported features. Precedence is fixed and
 * documented: xfa, signed, form-widget, embedded-file, js-actions,
 * rich-media. The first hit wins; the verdict names exactly one reason.
 * Signed outranks form-widget because a lone signature field would
 * otherwise masquerade as an interactive form; the signature is the
 * salient unsupported feature.
 */
export function adjudicateFeatures(
  features: DocumentFeatures | null | undefined,
): FeatureVerdict {
  if (!features) return { supported: true };
  if (features.xfa) return { supported: false, reason: "xfa" };
  if (features.signed) return { supported: false, reason: "signed" };
  if (features.formWidgets)
    return { supported: false, reason: "form-widget" };
  if (features.embeddedFiles)
    return { supported: false, reason: "embedded-file" };
  if (features.javaScript)
    return { supported: false, reason: "js-actions" };
  if (features.richMedia)
    return { supported: false, reason: "rich-media" };
  return { supported: true };
}
