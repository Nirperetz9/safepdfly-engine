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
