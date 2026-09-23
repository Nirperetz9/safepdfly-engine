/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T037 — Scanned/hybrid page policy (MVP support boundary).
 *
 * Per spec.md, the MVP does not OCR: any PDF containing a scanned or hybrid
 * page is unsupported, and the whole document is rejected (fail-closed).
 *
 * Page kinds, from dual-engine-agreed evidence (T036):
 * - blank:      no text, no raster images.
 * - text_based: text with at most incidental raster images.
 * - scanned:    raster image(s) but no text layer — the page is pictures.
 * - hybrid:     a text layer over a page-dominating raster (the OCR'd-scan
 *               signature). Text positions on such pages do not reliably
 *               correspond to visible glyphs, so text redaction is unsafe.
 *
 * The hybrid threshold is a documented heuristic: at >= 90% raster coverage
 * the page is dominated by a single image (verified: synthetic scanned and
 * hybrid fixtures report exactly 1.0; a 50x50 figure on a 200x200 page
 * reports 0.0625). Pages below the threshold with text are treated as
 * ordinary text pages with figures. False rejections fail closed toward
 * the UX "Scanned PDF" message.
 */
import type { AgreedPage } from "./dual-engine.js";
import type { SupportReasonCode } from "./reasons.js";

export type PageKind = "blank" | "text_based" | "scanned" | "hybrid";

/**
 * Raster coverage at or above which a text-bearing page is treated as a
 * hybrid (OCR'd scan) rather than a text page with figures.
 * Approved value: plan.md — "approximately 80% or more of the visible page".
 */
export const HYBRID_IMAGE_COVERAGE = 0.8;

export interface PageKindInput {
  readonly pageIndex: number;
  readonly hasText: boolean;
  readonly imageBlocks: number;
  readonly imageCoverage: number;
}

export function classifyPageKind(input: PageKindInput): PageKind {
  const coverage = Number.isFinite(input.imageCoverage)
    ? Math.min(1, Math.max(0, input.imageCoverage))
    : 0;
  const images = Number.isInteger(input.imageBlocks) && input.imageBlocks > 0
    ? input.imageBlocks
    : 0;
  if (!input.hasText && images === 0) return "blank";
  if (!input.hasText) return "scanned";
  if (coverage >= HYBRID_IMAGE_COVERAGE) return "hybrid";
  return "text_based";
}

export interface PageKindVerdict {
  readonly pageIndex: number;
  readonly kind: PageKind;
}

export type DocumentKindVerdict =
  | { readonly supported: true; readonly kinds: readonly PageKindVerdict[] }
  | {
      readonly supported: false;
      readonly reason: Extract<SupportReasonCode, "scanned" | "hybrid">;
      /** 1-based page numbers, for UX copy and progress reporting. */
      readonly pageNumbers: readonly number[];
      readonly kinds: readonly PageKindVerdict[];
    };

/** Classify every agreed page, then adjudicate the document. */
export function adjudicateDocumentKind(
  pages: readonly AgreedPage[],
): DocumentKindVerdict {
  const kinds: PageKindVerdict[] = (pages ?? []).map((p) => ({
    pageIndex: p.pageIndex,
    kind: classifyPageKind(p),
  }));
  const scanned = kinds.filter((k) => k.kind === "scanned");
  const hybrid = kinds.filter((k) => k.kind === "hybrid");
  const toNumbers = (ks: PageKindVerdict[]) =>
    Object.freeze(ks.map((k) => k.pageIndex + 1));
  if (scanned.length > 0) {
    return {
      supported: false,
      reason: "scanned",
      pageNumbers: toNumbers(scanned),
      kinds: Object.freeze(kinds),
    };
  }
  if (hybrid.length > 0) {
    return {
      supported: false,
      reason: "hybrid",
      pageNumbers: toNumbers(hybrid),
      kinds: Object.freeze(kinds),
    };
  }
  return { supported: true, kinds: Object.freeze(kinds) };
}
