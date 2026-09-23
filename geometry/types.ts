/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T024 — Branded coordinate primitives.
 *
 * These brands exist so a PDF-space value can never be silently mixed with a
 * viewport-space value. Construction goes through the narrow `Brand` helpers;
 * arithmetic on branded values returns `number`, never a brand.
 */
export type PageIndex = number & { readonly __brand: "PageIndex" };
export type PdfPoint = number & { readonly __brand: "PdfPoint" };
export type ViewportPixel = number & { readonly __brand: "ViewportPixel" };
/** Hex SHA-256 digest of exact candidate bytes. */
export type Sha256Digest = string & { readonly __brand: "Sha256Digest" };

/** Normalized page rotation in degrees: 0 | 90 | 180 | 270. */
export type PageRotation = 0 | 90 | 180 | 270;

/** PDF default-user-space rectangle, y-up, origin at MediaBox origin (points). */
export interface PdfRect {
  readonly x0: PdfPoint;
  readonly y0: PdfPoint;
  readonly x1: PdfPoint;
  readonly y1: PdfPoint;
}

/** Viewport rectangle in CSS pixels, top-left origin. */
export interface ViewportRect {
  readonly x: ViewportPixel;
  readonly y: ViewportPixel;
  readonly w: ViewportPixel;
  readonly h: ViewportPixel;
}

/**
 * The page context a canonical rectangle ALWAYS carries. A rect without its
 * CropBox/rotation/UserUnit identity is meaningless and cannot be constructed.
 */
export interface PageContext {
  readonly cropBox: readonly [PdfPoint, PdfPoint, PdfPoint, PdfPoint];
  readonly rotation: PageRotation;
  readonly userUnit: number;
}

/** A canonical rectangle: geometry plus the context that interprets it. */
export interface CanonicalRect {
  readonly page: PageIndex;
  readonly rect: PdfRect;
  readonly context: PageContext;
}

/** Narrow constructors — the only way to obtain a branded value. */
export const Brand = {
  pageIndex(n: number): PageIndex {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`invalid PageIndex: ${n}`);
    return n as PageIndex;
  },
  pdfPoint(n: number): PdfPoint {
    if (!Number.isFinite(n)) throw new RangeError(`invalid PdfPoint: ${n}`);
    return n as PdfPoint;
  },
  viewportPixel(n: number): ViewportPixel {
    if (!Number.isFinite(n)) throw new RangeError(`invalid ViewportPixel: ${n}`);
    return n as ViewportPixel;
  },
} as const;
