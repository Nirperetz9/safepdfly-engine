/**
 * T025 — Transient data model per specs/001-safe-pdf-workflow/data-model.md.
 *
 * Everything here is in-memory only. PDF bytes and extracted content are
 * restricted data and NEVER enter UI state: the model carries opaque handles,
 * digests, and geometry only.
 */
import type { CanonicalRect, PageContext, PageIndex, Sha256Digest } from "./geometry/index.js";
export type { PageIndex };

/** Opaque session id; never derived from filename or content. */
export type DocumentSessionId = string & { readonly __brand: "DocumentSessionId" };
/** Opaque selection id. */
export type SelectionId = string & { readonly __brand: "SelectionId" };
export type { Sha256Digest };

/** Workflow states, exactly per data-model.md. */
export type WorkflowState =
  | "idle"
  | "opening"
  | "rejected"
  | "reviewing"
  | "selecting"
  | "ready_to_redact"
  | "redacting"
  | "verifying"
  | "verified"
  | "verification_failed"
  | "indeterminate"
  | "export_failed"
  | "downloaded"
  | "reset";

export type SupportVerdict = "checking" | "supported" | "rejected" | "indeterminate";
export type PageClassification =
  | "blank"
  | "text_based"
  | "scanned"
  | "hybrid"
  | "unsupported"
  | "indeterminate";
export type SelectionStatus = "draft" | "approved" | "applied" | "verified" | "failed";
export type CandidateStatus =
  | "candidate"
  | "verifying"
  | "verified"
  | "rejected"
  | "indeterminate"
  | "disposed";
export type VerificationOutcome = "pass" | "fail" | "indeterminate";

export interface PageDescriptor {
  readonly pageIndex: PageIndex;
  readonly mediaBox: readonly [number, number, number, number];
  readonly context: PageContext;
  readonly classification: PageClassification;
  readonly renderBudget: { readonly maxPixels: number; readonly maxOperators: number };
}

export interface DocumentSession {
  readonly id: DocumentSessionId;
  /** Opaque worker-owned source handle. Never inspected, serialized, or logged. */
  readonly sourceHandle: unknown;
  readonly displayName: string;
  readonly byteLength: number;
  readonly pageCount: number;
  readonly support: SupportVerdict;
  readonly pageDescriptors: readonly PageDescriptor[];
  readonly lifecycle: WorkflowState;
}

/**
 * A redaction selection: geometry + provenance, never document text.
 * Immutable while a transformation or verification is in flight.
 */
export interface RedactionSelection {
  readonly id: SelectionId;
  readonly rect: CanonicalRect;
  readonly sourceTransformFingerprint: string;
  readonly status: SelectionStatus;
  /** Stable 1-based number shown in the UI. */
  readonly number: number;
}

export interface CandidateExport {
  /** Opaque worker/UI-boundary handle to the exact candidate bytes. */
  readonly bufferHandle: unknown;
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
  readonly createdFromSession: DocumentSessionId;
  readonly status: CandidateStatus;
}

export interface SelectionCheckResult {
  readonly selectionId: SelectionId;
  readonly pageIndex: PageIndex;
  readonly outcome: VerificationOutcome;
  /** Stable bilingual reason-code key; never raw document content. */
  readonly reasonCode: string;
}

export interface VerificationReport {
  readonly candidateSha256: Sha256Digest;
  readonly engineVersion: string;
  readonly policyVersion: string;
  /** Exact PDF.js version that performed verification (T069 evidence). */
  readonly pdfjsVersion: string;
  /** Number of marked rectangles the report covers (T069 evidence). */
  readonly rectCount: number;
  readonly outcome: VerificationOutcome;
  readonly documentChecks: ReadonlyArray<{ readonly check: string; readonly outcome: VerificationOutcome }>;
  readonly selectionChecks: readonly SelectionCheckResult[];
  readonly outsideMaskOutcome: VerificationOutcome;
  readonly warnings: ReadonlyArray<{
    readonly code: string;
    readonly pageIndex: PageIndex;
    /** 1-based mark number whose selected value survived; never content. */
    readonly selectionNumber: number;
  }>;
  /** Stable bilingual reason-code keys, never raw document content. */
  readonly reasonCodes: readonly string[];
}

export interface DownloadGrant {
  readonly candidateSha256: Sha256Digest;
  readonly blobUrl: string;
  /** Grants always expire on reset. */
  readonly expiresOnReset: true;
}
