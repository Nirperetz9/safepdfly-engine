/**
 * T058 — Transformation worker protocol (contracts/processing-worker.md).
 *
 * APPLY_REDACTIONS carries a caller-owned source copy (transferred, so the
 * host side is neutered), the approved rectangles, and the exact engine /
 * redaction / save policy versions the transformation must apply. The worker
 * refuses any request naming different versions.
 *
 * CANDIDATE_READY carries the full-rewrite candidate (transferred), its
 * SHA-256 identity, and the versions actually used. It is a *candidate*:
 * it is never labeled safe and carries no download affordance.
 *
 * TRANSFORM_FAILED carries only a stable reason code — never document
 * content, filenames, or raw engine errors.
 */
import type { Sha256Digest } from "../geometry/index.js";

/** Exact transformation engine pin (must match docs/governance/engine-pins.md). */
export const TRANSFORM_ENGINE_VERSION = "mupdf/1.28.1" as const;
/** Approved redaction policy (T094): text removed, covered image pixels
 *  replaced, touched vector strokes clipped at the mark boundary (only the
 *  marked portion of the geometry is removed), fills touched by a mark
 *  removed whole, opaque fill. Privacy over path preservation. */
export const REDACTION_POLICY_VERSION = "redaction-policy/2" as const;
/** Save policy: full non-incremental rewrite with garbage collection. */
export const SAVE_POLICY_VERSION = "save/garbage+gc/1" as const;

export const TRANSFORM_MESSAGE_TYPES = [
  "APPLY_REDACTIONS",
  "CANDIDATE_READY",
  "TRANSFORM_FAILED",
] as const;

export type TransformMessageType = (typeof TRANSFORM_MESSAGE_TYPES)[number];

/**
 * One approved rectangle in viewport points: origin top-left of the CropBox
 * as displayed (rotation applied), y down. This is the frame MuPDF.js
 * PDFAnnotation.setRect() consumes (validated in Phase 1, T008).
 */
export interface TransformRect {
  readonly page: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface TransformPolicyVersions {
  readonly engine: typeof TRANSFORM_ENGINE_VERSION;
  readonly redaction: typeof REDACTION_POLICY_VERSION;
  readonly save: typeof SAVE_POLICY_VERSION;
}

export interface ApplyRedactionsMessage {
  type: "APPLY_REDACTIONS";
  /** Caller-owned source copy. Transferred to the worker. */
  payload: ArrayBuffer;
  /** Approved rectangles, viewport points. */
  rects: readonly TransformRect[];
  /** Exact policy versions the transformation must apply. */
  policy: TransformPolicyVersions;
  /**
   * T099 — explicit opt-in: strip document Info, XMP metadata, embedded
   * files, and document-level scripts/actions as part of the transform
   * (before the full-rewrite save). Never defaulted: the host sets it
   * from the user's choice ANDed with the Pro availability seam, and the
   * worker refuses any message that does not carry an explicit boolean.
   */
  sanitize: boolean;
}

/** Internal self-check outcome (T062): the candidate re-parses and renders. */
export type SelfCheckStatus = "ok" | "failed";

export interface CandidateReadyMessage {
  type: "CANDIDATE_READY";
  /** Full-rewrite candidate bytes. Transferred to the host. */
  payload: ArrayBuffer;
  /** Hex SHA-256 of the exact candidate bytes. */
  sha256: Sha256Digest;
  byteLength: number;
  selfCheck: SelfCheckStatus;
  /** Engine/save policy versions actually used. */
  versions: TransformPolicyVersions;
}

/**
 * Stable failure codes. They describe *what* failed, never *what was in the
 * document*: no extracted text, filename, byte offset, or raw engine error
 * may cross the boundary.
 */
export type TransformFailureCode =
  | "precondition"
  | "invalid-request"
  | "engine-error"
  | "save-failed"
  | "self-check-failed"
  | "timeout"
  | "worker-error"
  | "protocol"
  | "internal";

/** The stable set, as a runtime list — the single source of truth. */
const TRANSFORM_FAILURE_CODES = [
  "precondition",
  "invalid-request",
  "engine-error",
  "save-failed",
  "self-check-failed",
  "timeout",
  "worker-error",
  "protocol",
  "internal",
] as const satisfies readonly TransformFailureCode[];

/**
 * T090 — runtime guard for the stable failure-code set. Anything else
 * (a raw engine string, a filename, extracted text) is NOT a code.
 */
export function isTransformFailureCode(value: unknown): value is TransformFailureCode {
  return (
    typeof value === "string" &&
    (TRANSFORM_FAILURE_CODES as readonly string[]).includes(value)
  );
}

export interface TransformFailedMessage {
  type: "TRANSFORM_FAILED";
  reason: TransformFailureCode;
}

export type TransformInbound = ApplyRedactionsMessage;
export type TransformOutbound = CandidateReadyMessage | TransformFailedMessage;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidRect(value: unknown): value is TransformRect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (!Number.isInteger(r.page) || (r.page as number) < 0) return false;
  const { x0, y0, x1, y1 } = r;
  if (!isFiniteNumber(x0) || !isFiniteNumber(y0) || !isFiniteNumber(x1) || !isFiniteNumber(y1)) {
    return false;
  }
  // Non-empty and ordered: a degenerate rect can never redact anything.
  return (x0 as number) < (x1 as number) && (y0 as number) < (y1 as number);
}

function isPolicyVersions(value: unknown): value is TransformPolicyVersions {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    p.engine === TRANSFORM_ENGINE_VERSION &&
    p.redaction === REDACTION_POLICY_VERSION &&
    p.save === SAVE_POLICY_VERSION
  );
}

/** Narrow an unknown worker message to a valid APPLY_REDACTIONS request. */
export function isApplyRedactionsMessage(value: unknown): value is ApplyRedactionsMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.type !== "APPLY_REDACTIONS") return false;
  if (!(m.payload instanceof ArrayBuffer)) return false;
  if (!Array.isArray(m.rects) || m.rects.length === 0) return false;
  if (!m.rects.every(isValidRect)) return false;
  if (!isPolicyVersions(m.policy)) return false;
  // T099: the sanitize opt-in must be an explicit boolean — never absent,
  // never truthy-by-accident.
  return typeof m.sanitize === "boolean";
}

/** Narrow an unknown worker message to a valid outbound message. */
export function isTransformOutbound(value: unknown): value is TransformOutbound {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m.type === "CANDIDATE_READY") {
    return (
      m.payload instanceof ArrayBuffer &&
      typeof m.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(m.sha256 as string) &&
      typeof m.byteLength === "number" &&
      (m.byteLength as number) === (m.payload as ArrayBuffer).byteLength &&
      (m.selfCheck === "ok" || m.selfCheck === "failed") &&
      isPolicyVersions(m.versions)
    );
  }
  if (m.type === "TRANSFORM_FAILED") {
    return typeof m.reason === "string";
  }
  return false;
}
