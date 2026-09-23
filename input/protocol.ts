/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T033 — Input worker message protocol per contracts/processing-worker.md.
 *
 * The worker accepts a transferred ArrayBuffer only — never a URL. Unknown
 * messages fail closed. Errors cross the boundary only as allowlisted reason
 * codes with safe numeric context; document content (bytes, text, filename,
 * parser dumps) never crosses.
 */
import type { PageDescriptor, SupportVerdict } from "../model.js";
import type { SupportReasonCode } from "../support-policy/reasons.js";

/** Stable input-policy version carried in every request/response. */
export const INPUT_POLICY_VERSION = "input-policy/1" as const;

/**
 * Allowlisted reason codes for SOURCE_REJECTED. These are the only failure
 * identities that may cross the worker boundary; raw engine errors never do.
 * The features layer maps each code to bilingual UX copy.
 * (Vocabulary owned by pdf/support-policy/reasons.ts; re-exported here.)
 */
export {
  SUPPORT_REASON_CODES,
  isSupportReasonCode,
  type SupportReasonCode,
} from "../support-policy/reasons.js";

/** Request: open a transferred source buffer. Bytes travel out-of-band. */
export interface OpenSourceRequest {
  readonly type: "OPEN_SOURCE";
  readonly policyVersion: typeof INPUT_POLICY_VERSION;
}

/** Success: source parsed; descriptors are immutable and frozen. */
export interface SourceReady {
  readonly type: "SOURCE_READY";
  /** Opaque session id held by the worker; never derived from content. */
  readonly sessionId: string;
  readonly pageCount: number;
  readonly descriptors: readonly PageDescriptor[];
  readonly engineVersion: string;
  readonly policyVersion: typeof INPUT_POLICY_VERSION;
  readonly support: Extract<SupportVerdict, "supported">;
}

/** Failure: rejected or indeterminate. Indeterminate is treated as failure. */
export interface SourceRejected {
  readonly type: "SOURCE_REJECTED";
  readonly outcome: "rejected" | "indeterminate";
  readonly reasonCode: SupportReasonCode;
  /** 1-based page numbers where the problem was found; empty when global. */
  readonly pageNumbers: readonly number[];
  /**
   * UX `{limitLabel}` value derived from the budget policy (T040), e.g.
   * "25 MiB". Present only for `over-limit`.
   */
  readonly limitLabel?: string;
}

export type InputWorkerResponse = SourceReady | SourceRejected;

export function isOpenSourceRequest(value: unknown): value is OpenSourceRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "OPEN_SOURCE"
  );
}

/**
 * T104 — one text item in default user space (y-up), as produced by PDF.js
 * getTextContent. The render worker exposes these through EXTRACT_TEXT_PAGE
 * (see input/render.ts); the proprietary PII worker consumes them. The shape
 * is identical to the proprietary `PiiTextItem` so the host can relay items
 * structurally without conversion.
 */
export interface TextItem {
  readonly str: string;
  /** PDF.js text transform [a, b, c, d, e, f]. */
  readonly transform: readonly [number, number, number, number, number, number];
  /** Advance in default user space along the text direction. */
  readonly width: number;
  readonly hasEOL: boolean;
}
