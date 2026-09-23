/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T061 — Pre-transformation preconditions.
 *
 * Contract (contracts/redaction-verification.md, "Transformation
 * preconditions"): before any transformation begins, all of the following
 * must hold —
 *  1. both engines classified the input as supported;
 *  2. at least one approved, round-trip-valid canonical rectangle exists;
 *  3. page descriptor fingerprints still match the source;
 *  4. no unsupported active/hidden feature was discovered;
 *  5. T103: no un-sanitized finding stands (embedded files / document-level
 *     JavaScript block the run unless sanitization was actually applied);
 *  6. resource budgets permit a full rewrite plus fresh verification.
 *
 * Any unmet precondition fails closed HERE, before the transform worker is
 * created. The result carries a stable code (no document content); the
 * orchestration layer (T089) maps codes to user-facing copy.
 */
import { pdfToViewport, viewportToPdf } from "../geometry/transforms.js";
import type { CanonicalRect } from "../geometry/types.js";
import type { SupportVerdict } from "../model.js";
import type { SanitizableFinding } from "../support-policy/reasons.js";
import { checkInputSize, checkPageCount } from "../support-policy/budgets.js";
import { GEOMETRY_EPSILON_PT } from "../support-policy/dual-engine.js";

export const PRECONDITION_FAILURE_CODES = [
  "not-supported",
  "no-valid-rectangle",
  "fingerprint-mismatch",
  "unsupported-feature",
  "over-limit",
] as const;
export type PreconditionFailureCode =
  (typeof PRECONDITION_FAILURE_CODES)[number];

export type PreconditionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PreconditionFailureCode };

/** Geometric identity of one page descriptor (classification evidence). */
export interface PageGeometryFingerprintInput {
  readonly mediaBox: readonly [number, number, number, number];
  readonly cropBox: readonly [number, number, number, number];
  readonly rotation: number;
  readonly userUnit: number;
}

/**
 * Canonical fingerprint string for a page descriptor. Deterministic and
 * exact: any change in the box geometry, rotation, or UserUnit changes the
 * string. This is a change detector for equality comparison, not a security
 * digest (the candidate identity hash remains SHA-256, T058/T062).
 */
export function fingerprintPageGeometry(
  input: PageGeometryFingerprintInput,
): string {
  const parts = [
    ...input.mediaBox,
    ...input.cropBox,
    input.rotation,
    input.userUnit,
  ];
  return parts.map((n) => String(n)).join(",");
}

/**
 * A canonical rectangle is round-trip-valid when converting it to viewport
 * coordinates (scale 1) and back yields the same rectangle within the
 * established geometry epsilon. Hand-crafted, corrupted, or context-shifted
 * rects fail: viewportToPdf throws outside the visible page, and drift shows
 * up in the comparison.
 */
export function isRoundTripValid(rect: CanonicalRect): boolean {
  try {
    const view = pdfToViewport(rect, 1);
    if (!(view.w > 0 && view.h > 0)) return false;
    const back = viewportToPdf(
      rect.page,
      { x: view.x, y: view.y, w: view.w, h: view.h },
      1,
      rect.context,
    );
    const a = rect.rect;
    const b = back.rect;
    return (
      Math.abs(a.x0 - b.x0) <= GEOMETRY_EPSILON_PT &&
      Math.abs(a.y0 - b.y0) <= GEOMETRY_EPSILON_PT &&
      Math.abs(a.x1 - b.x1) <= GEOMETRY_EPSILON_PT &&
      Math.abs(a.y1 - b.y1) <= GEOMETRY_EPSILON_PT
    );
  } catch {
    return false;
  }
}

/**
 * Re-verify the published resource limits immediately before the rewrite.
 * The full rewrite holds the input and the candidate co-resident, and the
 * fresh verification re-opens the candidate and renders pages; both fit
 * structurally because the input-size gate bounds the largest single
 * allocation the pipeline accepts (2 x 25 MiB is far below the 512 MiB peak
 * target). That headroom is asserted as an invariant by the budget math
 * test — raising maxInputBytes requires revisiting it. Returns
 * "over-limit" on any breach, null when the rewrite plus verification fits
 * the budget.
 */
export function checkTransformBudgets(
  byteLength: number,
  pageCount: number,
): "over-limit" | null {
  if (checkInputSize(byteLength) !== null) return "over-limit";
  if (checkPageCount(pageCount) !== null) return "over-limit";
  return null;
}

export interface TransformPreconditionInput {
  /** Per-engine support verdicts from the dual-engine comparison (T036). */
  readonly engineVerdicts: {
    readonly mupdf: SupportVerdict;
    readonly pdfjs: SupportVerdict;
  };
  /** Approved canonical rectangles. */
  readonly rects: readonly CanonicalRect[];
  /** Per-page descriptor fingerprints captured at classification time. */
  readonly expectedFingerprints: readonly string[];
  /** Per-page descriptor fingerprints recomputed immediately pre-transform. */
  readonly actualFingerprints: readonly string[];
  /** An unsupported active/hidden feature was discovered (T038). */
  readonly unsupportedFeatureFound: boolean;
  /**
   * T103 — findings the document carried into review (embedded files,
   * document-level JavaScript). The run is blocked while any finding
   * stands unless sanitization was actually applied (T099 removes exactly
   * these layers; nothing else may clear the block).
   */
  readonly sanitizableFindings: readonly SanitizableFinding[];
  /**
   * T103 — the user's sanitize opt-in ANDed with Pro availability (the
   * same AND the run uses before telling the worker to strip). True only
   * when the transform will actually remove the sanitizable layers.
   */
  readonly sanitizeApplied: boolean;
  /** Source byte length. */
  readonly byteLength: number;
  /** Source page count. */
  readonly pageCount: number;
}

/**
 * Enforce the transformation preconditions in fail-fast order (cheapest
 * checks first). Pure: no engine access, no I/O, no document content in the
 * result.
 */
export function checkTransformPreconditions(
  input: TransformPreconditionInput,
): PreconditionResult {
  if (
    input.engineVerdicts.mupdf !== "supported" ||
    input.engineVerdicts.pdfjs !== "supported"
  ) {
    return { ok: false, code: "not-supported" };
  }
  if (input.unsupportedFeatureFound) {
    return { ok: false, code: "unsupported-feature" };
  }
  // T103 — a sanitizable finding blocks the run unless sanitization was
  // actually applied. The check runs before the transform worker exists,
  // so no candidate can ever be created with un-sanitized findings.
  if (input.sanitizableFindings.length > 0 && !input.sanitizeApplied) {
    return { ok: false, code: "unsupported-feature" };
  }
  if (
    input.rects.length === 0 ||
    !input.rects.every(isRoundTripValid)
  ) {
    return { ok: false, code: "no-valid-rectangle" };
  }
  if (
    input.expectedFingerprints.length !== input.actualFingerprints.length ||
    !input.expectedFingerprints.every((f, i) => f === input.actualFingerprints[i])
  ) {
    return { ok: false, code: "fingerprint-mismatch" };
  }
  if (checkTransformBudgets(input.byteLength, input.pageCount) !== null) {
    return { ok: false, code: "over-limit" };
  }
  return { ok: true };
}
