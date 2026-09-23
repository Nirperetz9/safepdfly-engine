/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T033 — Resource budget policy (values), T040 — enforcement.
 *
 * Published limits from the approved Plan ("Limits and Browser Support").
 * Lowering below the approved 25 MiB / 100 pages requires founder review;
 * raising is a planned refinement. These constants are the single source of
 * truth for both enforcement and the `{limitLabel}` UX placeholder — no
 * numeric limit may be hard-coded into UX copy (T040 validation).
 */
export const BUDGET_POLICY_VERSION = "budget-policy/1" as const;

export interface BudgetPolicy {
  readonly version: typeof BUDGET_POLICY_VERSION;
  /** Maximum accepted input file size. */
  readonly maxInputBytes: number;
  /** Maximum accepted page count. */
  readonly maxPages: number;
  /** Maximum render surface per page/tile. */
  readonly maxRenderPixels: number;
  /** Maximum physical page dimension in points, after UserUnit. */
  readonly maxPageDimensionPt: number;
  /** Engineering operator budget per page (fail-closed guard). */
  readonly maxOperatorsPerPage: number;
  /** Peak-memory engineering target (MiB). Not a hard cap; a design budget. */
  readonly peakMemoryTargetMiB: number;
}

export const BUDGET_POLICY: BudgetPolicy = {
  version: BUDGET_POLICY_VERSION,
  maxInputBytes: 25 * 1024 * 1024,
  maxPages: 100,
  maxRenderPixels: 16 * 1024 * 1024,
  maxPageDimensionPt: 14400,
  maxOperatorsPerPage: 2_000_000,
  peakMemoryTargetMiB: 512,
} as const;

export type BudgetKind =
  | "input-size"
  | "page-count"
  | "render-surface"
  | "page-dimension"
  | "operators";

/**
 * Human label for the `{limitLabel}` UX placeholder, derived from the policy —
 * never hard-coded into copy. Direction isolation is applied by the i18n
 * `format` helper at render time.
 */
export function limitLabel(kind: BudgetKind): string {
  switch (kind) {
    case "input-size":
      return "25 MiB";
    case "page-count":
      return "100 pages";
    case "render-surface":
      return "16 megapixels";
    case "page-dimension":
      return "14,400 points";
    case "operators":
      return "2,000,000 operators";
  }
}

/**
 * T040 — Pure budget checks. Each returns the breached {@link BudgetKind},
 * or `null` when the value is within budget. Boundary values are accepted
 * (a value exactly at the limit is within budget); anything above breaches.
 *
 * Provenance of the numbers (see the header comment): `input-size`,
 * `page-count`, `render-surface`, and `page-dimension` are published Plan
 * limits. `operators` is the T033 engineering fail-closed guard (2,000,000
 * per page) — not a Plan-published limit; it is enforced as a worker-level
 * safety guard and reported through the same `over-limit` channel with the
 * policy-derived label, never as a product promise in UX copy.
 */
export function checkInputSize(byteLength: number): BudgetKind | null {
  return byteLength > BUDGET_POLICY.maxInputBytes ? "input-size" : null;
}

export function checkPageCount(pageCount: number): BudgetKind | null {
  return pageCount > BUDGET_POLICY.maxPages ? "page-count" : null;
}

/**
 * Physical page dimensions in points, already multiplied by UserUnit.
 * Either dimension above the limit breaches.
 */
export function checkPhysicalDimensions(
  widthPt: number,
  heightPt: number,
): BudgetKind | null {
  return widthPt > BUDGET_POLICY.maxPageDimensionPt ||
    heightPt > BUDGET_POLICY.maxPageDimensionPt
    ? "page-dimension"
    : null;
}

/** Decoded pixels of a single image XObject (the atomic decode unit). */
export function checkDecodedImagePixels(pixels: number): BudgetKind | null {
  return pixels > BUDGET_POLICY.maxRenderPixels ? "render-surface" : null;
}

/** Content-stream operator count of a single page. */
export function checkOperatorCount(operators: number): BudgetKind | null {
  return operators > BUDGET_POLICY.maxOperatorsPerPage ? "operators" : null;
}

/** Physical page evidence used by the policy-level budget check. */
export interface ClassifiedPageBudgets {
  /** 1-based page number, for safe numeric context. */
  readonly pageNumber: number;
  /** MediaBox width × UserUnit, in points (authoritative physical size). */
  readonly mediaWidthPt: number;
  /** MediaBox height × UserUnit, in points. */
  readonly mediaHeightPt: number;
  /** Largest single image XObject on the page, in decoded pixels. */
  readonly maxImagePixels: number;
}

/**
 * Policy-level budget verdict for one classified page. Dimension is checked
 * first (cheap, most likely to fire on pathological input), then decoded
 * image pixels. Returns the breached kind and page number, or `null` when
 * the page is within budget. Verdicts belong here — the classifier only
 * collects the evidence.
 */
export function checkClassifiedPageBudgets(
  page: ClassifiedPageBudgets,
): { readonly kind: BudgetKind; readonly pageNumber: number } | null {
  const dimKind = checkPhysicalDimensions(
    page.mediaWidthPt,
    page.mediaHeightPt,
  );
  if (dimKind !== null) return { kind: dimKind, pageNumber: page.pageNumber };
  const imgKind = checkDecodedImagePixels(page.maxImagePixels);
  if (imgKind !== null) return { kind: imgKind, pageNumber: page.pageNumber };
  return null;
}

/**
 * T040 — Thrown inside the input worker when a budget check fires on a
 * page. Carries only the breached kind and the 1-based page number — no
 * document content. The handler maps it to `SOURCE_REJECTED` with
 * reason `over-limit` and the policy-derived `{limitLabel}`.
 */
export class BudgetExceededError extends Error {
  readonly kind: BudgetKind;
  readonly pageNumber?: number;

  constructor(kind: BudgetKind, pageNumber?: number) {
    super(`budget exceeded: ${kind}`);
    this.name = "BudgetExceededError";
    this.kind = kind;
    if (pageNumber !== undefined) this.pageNumber = pageNumber;
  }
}

/**
 * T040 — Time and memory enforcement notes.
 *
 * Time: enforced by the single-use worker clients with monotonic clocks —
 * `InputWorkerClient` (default 60 s per open) and the classifier client
 * (`CLASSIFICATION_TIMEOUT_MS`, 30 s). A hung or pathological engine run
 * rejects as a timeout; the worker is terminated and never reused.
 *
 * Memory: the 512 MiB peak is an engineering design target, not a
 * browser-enforceable hard cap. It is held structurally: the 25 MiB input
 * gate bounds the largest single allocation the pipeline accepts, the two
 * engines run sequentially (never two document contexts alive), each worker
 * is single-use and terminated after its operation, and the render surface
 * is capped at 16 MP per page/tile (enforced at render time, Phase 4).
 */
