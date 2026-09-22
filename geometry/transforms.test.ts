/**
 * T024 validation — property tests for the canonical geometry core.
 *
 * Contexts cover every geometry fixture class from the Phase 1 corpus (T006):
 * rotated pages (90/180/270), non-default CropBox, non-default UserUnit,
 * mixed page sizes, and a small-crop page. Round trips must hold within
 * ROUND_TRIP_TOLERANCE_PX (sub-pixel).
 */
import { describe, expect, it } from "vitest";
import {
  Brand,
  ROUND_TRIP_TOLERANCE_PX,
  clipToCropBox,
  displaySize,
  makeCanonicalRect,
  makePageContext,
  normRotate,
  pdfToViewport,
  transformFingerprint,
  viewportToPdf,
  type CanonicalRect,
  type PageContext,
} from "./index.js";

const CONTEXTS: Array<{ name: string; ctx: PageContext }> = [
  { name: "letter-0", ctx: makePageContext([0, 0, 612, 792], 0, 1) },
  { name: "rotated-90", ctx: makePageContext([0, 0, 612, 792], 90, 1) },
  { name: "rotated-180", ctx: makePageContext([0, 0, 612, 792], 180, 1) },
  { name: "rotated-270", ctx: makePageContext([0, 0, 612, 792], 270, 1) },
  { name: "cropbox-offset", ctx: makePageContext([36, 48, 576, 744], 0, 1) },
  { name: "cropbox-rotated-90", ctx: makePageContext([36, 48, 576, 744], 90, 1) },
  { name: "userunit-2", ctx: makePageContext([0, 0, 306, 396], 0, 2) },
  { name: "a4-mixed", ctx: makePageContext([0, 0, 595.28, 841.89], 0, 1) },
  { name: "small-crop-180", ctx: makePageContext([100, 200, 400, 500], 180, 1) },
];

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("geometry round trips", () => {
  for (const { name, ctx } of CONTEXTS) {
    it(`viewport -> PDF -> viewport is stable (${name})`, () => {
      const rand = mulberry32(name.length * 7919 + 13);
      const disp = displaySize(ctx, 1);
      for (let i = 0; i < 120; i++) {
        const x = rand() * disp.w * 0.9;
        const y = rand() * disp.h * 0.9;
        const w = 4 + rand() * (disp.w - x) * 0.5;
        const h = 4 + rand() * (disp.h - y) * 0.5;
        const canon = viewportToPdf(Brand.pageIndex(0), { x, y, w, h }, 1, ctx);
        const back = pdfToViewport(canon, 1);
        expect(Math.abs(back.x - x)).toBeLessThanOrEqual(ROUND_TRIP_TOLERANCE_PX);
        expect(Math.abs(back.y - y)).toBeLessThanOrEqual(ROUND_TRIP_TOLERANCE_PX);
        expect(Math.abs(back.w - w)).toBeLessThanOrEqual(ROUND_TRIP_TOLERANCE_PX);
        expect(Math.abs(back.h - h)).toBeLessThanOrEqual(ROUND_TRIP_TOLERANCE_PX);
      }
    });

    it(`PDF -> viewport -> PDF is stable (${name})`, () => {
      const rand = mulberry32(name.length * 104729 + 7);
      const [cx0, cy0, cx1, cy1] = ctx.cropBox;
      const pw = cx1 - cx0;
      const ph = cy1 - cy0;
      for (let i = 0; i < 120; i++) {
        const x0 = cx0 + rand() * pw * 0.8;
        const y0 = cy0 + rand() * ph * 0.8;
        const x1 = Math.min(cx1, x0 + 1 + rand() * pw * 0.4);
        const y1 = Math.min(cy1, y0 + 1 + rand() * ph * 0.4);
        const canon = makeCanonicalRect(Brand.pageIndex(0), x0, y0, x1, y1, ctx);
        const view = pdfToViewport(canon, 1.5);
        const back = viewportToPdf(Brand.pageIndex(0), view, 1.5, ctx);
        const tol = ROUND_TRIP_TOLERANCE_PX / 1.5;
        expect(Math.abs(back.rect.x0 - x0)).toBeLessThanOrEqual(tol);
        expect(Math.abs(back.rect.y0 - y0)).toBeLessThanOrEqual(tol);
        expect(Math.abs(back.rect.x1 - x1)).toBeLessThanOrEqual(tol);
        expect(Math.abs(back.rect.y1 - y1)).toBeLessThanOrEqual(tol);
      }
    });

    it(`display size matches rotated crop extents (${name})`, () => {
      const d = displaySize(ctx, 2);
      const [cx0, cy0, cx1, cy1] = ctx.cropBox;
      const kw = (cx1 - cx0) * ctx.userUnit * 2;
      const kh = (cy1 - cy0) * ctx.userUnit * 2;
      if (ctx.rotation % 180 === 0) {
        expect(d.w).toBeCloseTo(kw, 9);
        expect(d.h).toBeCloseTo(kh, 9);
      } else {
        expect(d.w).toBeCloseTo(kh, 9);
        expect(d.h).toBeCloseTo(kw, 9);
      }
    });
  }
});

describe("invariants", () => {
  const ctx = makePageContext([0, 0, 612, 792], 0, 1);

  it("rejects empty, inverted, and out-of-bounds rects", () => {
    expect(() => makeCanonicalRect(Brand.pageIndex(0), 10, 10, 10, 20, ctx)).toThrow(RangeError);
    expect(() => makeCanonicalRect(Brand.pageIndex(0), 20, 10, 10, 20, ctx)).toThrow(RangeError);
    expect(() => makeCanonicalRect(Brand.pageIndex(0), -5, 10, 20, 20, ctx)).toThrow(RangeError);
    expect(() => makeCanonicalRect(Brand.pageIndex(0), 600, 10, 620, 20, ctx)).toThrow(RangeError);
  });

  it("rejects unsupported rotations and bad contexts", () => {
    expect(() => normRotate(45)).toThrow(RangeError);
    expect(() => normRotate(360 + 45)).toThrow(RangeError);
    expect(() => makePageContext([0, 0, 0, 10], 0, 1)).toThrow(RangeError);
    expect(() => makePageContext([0, 0, 10, 10], 0, 0)).toThrow(RangeError);
  });

  it("clips partially-outside rects and drops fully-outside ones", () => {
    const partial = clipToCropBox(
      { x0: Brand.pdfPoint(600), y0: Brand.pdfPoint(700), x1: Brand.pdfPoint(700), y1: Brand.pdfPoint(800) },
      ctx,
    );
    expect(partial).not.toBeNull();
    expect(partial!.x1).toBe(612);
    expect(partial!.y1).toBe(792);
    const outside = clipToCropBox(
      { x0: Brand.pdfPoint(700), y0: Brand.pdfPoint(800), x1: Brand.pdfPoint(800), y1: Brand.pdfPoint(900) },
      ctx,
    );
    expect(outside).toBeNull();
  });

  it("brands cannot be implicitly mixed", () => {
    const px = Brand.pdfPoint(5);
    const vp = Brand.viewportPixel(5);
    // @ts-expect-error PdfPoint is not assignable to ViewportPixel
    const bad: typeof vp = px;
    void bad;
    // @ts-expect-error ViewportPixel is not assignable to PdfPoint
    const worse: typeof px = vp;
    void worse;
  });

  it("transform fingerprints distinguish contexts", () => {
    const a = makePageContext([0, 0, 612, 792], 0, 1);
    const b = makePageContext([0, 0, 612, 792], 90, 1);
    const c = makePageContext([0, 0, 612, 792], 0, 2);
    expect(transformFingerprint(a)).not.toBe(transformFingerprint(b));
    expect(transformFingerprint(a)).not.toBe(transformFingerprint(c));
    expect(transformFingerprint(a)).toBe(transformFingerprint(makePageContext([0, 0, 612, 792], 0, 1)));
  });

  it("keeps its page context through conversion", () => {
    const r: CanonicalRect = makeCanonicalRect(Brand.pageIndex(2), 10, 10, 60, 60, ctx);
    expect(r.page).toBe(2);
    expect(r.context).toBe(ctx);
  });
});
