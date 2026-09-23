/**
 * T064 — Verification worker protocol (VERIFY_CANDIDATE).
 *
 * The verification worker is a FRESH PDF.js worker: it never sees the
 * transformation worker, its WASM state, or its in-memory verdict. It
 * reopens the exact candidate bytes, recomputes SHA-256 over the received
 * bytes, and matches the digest BEFORE running any check (FR-012). A
 * mismatch is a deterministic integrity failure, never an ambiguity.
 *
 * Reason codes are stable and bilingual-mappable; raw engine errors,
 * filenames, and document content never cross this boundary (PR-003).
 */
import type { Sha256Digest } from "../geometry/index.js";
import type { VerificationOutcome } from "../model.js";

/** Pinned verification engine, matching the product engine pins (T084). */
export const VERIFY_ENGINE_VERSION = "pdfjs/6.3.289" as const;
/** Version of the verification policy + tolerances (recorded in evidence, T070). */
export const VERIFY_POLICY_VERSION = "verify-policy/1" as const;

export const VERIFY_MESSAGE_TYPES = [
  "VERIFY_CANDIDATE",
  "VERIFY_RESULT",
  "VERIFY_CHECKPOINT",
  "VERIFY_FAILED",
] as const;
export type VerifyMessageType = (typeof VERIFY_MESSAGE_TYPES)[number];

/**
 * Plain-data redaction rectangle in canonical PDF space: default user
 * space, y-up, origin at MediaBox origin — the same space the transform
 * worker applied redactions in, and the same space PDF.js text coordinates
 * use. Plain numbers (brands do not survive the worker boundary).
 */
export interface VerifyRect {
  readonly page: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Opaque selection id (for joining results, never document content). */
  readonly selectionId: string;
  /** Stable 1-based number shown in the UI (warnings reference this). */
  readonly number: number;
}

/**
 * Expected page geometry from the transformation contract (the session's
 * page descriptors, captured at classification time).
 */
export interface ExpectedPage {
  readonly page: number;
  /** Effective visible box (CropBox ∩ MediaBox), y-up, MediaBox origin. */
  readonly view: readonly [number, number, number, number];
  readonly rotation: 0 | 90 | 180 | 270;
}

export interface VerifyPolicyVersions {
  readonly engine: typeof VERIFY_ENGINE_VERSION;
  readonly verify: typeof VERIFY_POLICY_VERSION;
}

export interface VerifyCandidateMessage {
  readonly type: "VERIFY_CANDIDATE";
  /** Caller-owned source copy; transferred to the worker. */
  readonly sourceBytes: ArrayBuffer;
  /** Caller-owned candidate copy; transferred to the worker. */
  readonly candidateBytes: ArrayBuffer;
  /** Digest the transformation produced; the worker recomputes and matches. */
  readonly expectedCandidateSha256: Sha256Digest;
  readonly rects: readonly VerifyRect[];
  readonly expectedPages: readonly ExpectedPage[];
  readonly policy: VerifyPolicyVersions;
}

/** Truthful progress checkpoints (T091): emitted only when actually reached. */
export type VerifyCheckpoint = "reopened" | "checks-done";

export interface VerifyCheckpointMessage {
  readonly type: "VERIFY_CHECKPOINT";
  readonly checkpoint: VerifyCheckpoint;
}

export interface VerifyDocumentCheck {
  readonly check: string;
  /** 0-based page index for per-page checks; omitted for document-wide ones. */
  readonly page?: number;
  readonly outcome: VerificationOutcome;
  readonly reasonCode: string;
}

export interface VerifySelectionCheck {
  readonly selectionId: string;
  readonly page: number;
  readonly number: number;
  readonly outcome: VerificationOutcome;
  readonly reasonCode: string;
}

export interface VerifyWarning {
  readonly code: "duplicate-occurrence";
  readonly page: number;
  readonly selectionNumber: number;
}

/** Raw check results from the worker. The host assembles the report (T069). */
export interface VerifyWorkerResult {
  /** Digest the worker computed over the bytes it actually checked. */
  readonly candidateSha256: Sha256Digest;
  readonly documentChecks: readonly VerifyDocumentCheck[];
  readonly selectionChecks: readonly VerifySelectionCheck[];
  readonly outsideMaskOutcome: VerificationOutcome;
  readonly outsideMaskReasonCode: string;
  readonly warnings: readonly VerifyWarning[];
  readonly versions: VerifyPolicyVersions;
}

export interface VerifyResultMessage {
  readonly type: "VERIFY_RESULT";
  readonly result: VerifyWorkerResult;
}

export const VERIFY_FAILURE_CODES = [
  "digest-mismatch",
  "parse-error",
  "source-unavailable",
  "budget-exhausted",
  "timeout",
  "worker-error",
  "protocol",
  "internal",
] as const;
export type VerifyFailureCode = (typeof VERIFY_FAILURE_CODES)[number];

const VERIFY_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
  VERIFY_FAILURE_CODES,
);

/**
 * Runtime guard for the stable failure-code set. Anything else (a raw
 * engine string, extracted text) is NOT a code — fail closed to "internal".
 */
export function isVerifyFailureCode(
  value: unknown,
): value is VerifyFailureCode {
  return typeof value === "string" && VERIFY_FAILURE_CODE_SET.has(value);
}

export interface VerifyFailedMessage {
  readonly type: "VERIFY_FAILED";
  readonly reason: VerifyFailureCode;
}

export type VerifyInbound = VerifyCandidateMessage;
export type VerifyOutbound = VerifyResultMessage | VerifyFailedMessage;

/**
 * T069 — how a worker-level failure maps to a report outcome.
 * Integrity failures (digest mismatch, unparseable candidate) are
 * deterministic failures. Everything else is ambiguity → indeterminate,
 * which is equivalent to failure at the download boundary (FR-014).
 */
export const VERIFY_FAILURE_OUTCOME: Readonly<
  Record<VerifyFailureCode, VerificationOutcome>
> = {
  "digest-mismatch": "fail",
  "parse-error": "fail",
  "source-unavailable": "indeterminate",
  "budget-exhausted": "indeterminate",
  timeout: "indeterminate",
  "worker-error": "indeterminate",
  protocol: "indeterminate",
  internal: "indeterminate",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVerifyRect(value: unknown): value is VerifyRect {
  if (!isObject(value)) return false;
  const { page, x0, y0, x1, y1, selectionId, number } = value;
  return (
    typeof page === "number" &&
    typeof x0 === "number" &&
    typeof y0 === "number" &&
    typeof x1 === "number" &&
    typeof y1 === "number" &&
    typeof selectionId === "string" &&
    typeof number === "number"
  );
}

function isExpectedPage(value: unknown): value is ExpectedPage {
  if (!isObject(value)) return false;
  const { page, view, rotation } = value;
  return (
    typeof page === "number" &&
    Array.isArray(view) &&
    view.length === 4 &&
    view.every((n) => typeof n === "number") &&
    (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270)
  );
}

export function isVerifyCandidateMessage(
  value: unknown,
): value is VerifyCandidateMessage {
  if (!isObject(value) || value.type !== "VERIFY_CANDIDATE") return false;
  const v = value as Record<string, unknown>;
  return (
    v.sourceBytes instanceof ArrayBuffer &&
    v.candidateBytes instanceof ArrayBuffer &&
    typeof v.expectedCandidateSha256 === "string" &&
    Array.isArray(v.rects) &&
    (v.rects as unknown[]).every(isVerifyRect) &&
    Array.isArray(v.expectedPages) &&
    (v.expectedPages as unknown[]).every(isExpectedPage) &&
    isObject(v.policy) &&
    (v.policy as Record<string, unknown>).engine === VERIFY_ENGINE_VERSION &&
    (v.policy as Record<string, unknown>).verify === VERIFY_POLICY_VERSION
  );
}

export function isVerifyCheckpointMessage(
  value: unknown,
): value is VerifyCheckpointMessage {
  return (
    isObject(value) &&
    value.type === "VERIFY_CHECKPOINT" &&
    (value.checkpoint === "reopened" || value.checkpoint === "checks-done")
  );
}

export function isVerifyOutbound(value: unknown): value is VerifyOutbound {
  if (!isObject(value)) return false;
  if (value.type === "VERIFY_RESULT") return isObject(value.result);
  if (value.type === "VERIFY_FAILED")
    return isVerifyFailureCode((value as Record<string, unknown>).reason);
  return false;
}
