/**
 * T093 — property tests for the transform → verification projection.
 *
 * The critical audit: a VerifyRect derived from an applied TransformRect
 * (via the approved viewport→PDF conversion) must recover the original
 * canonical rect within tolerance for every supported page geometry —
 * rotated pages (90/180/270), offset CropBoxes, non-default UserUnit. If
 * this diverges, verification would check a different area than the
 * engine redacted: a passing report would be meaningless.
 *
 * Also covered: selection identity passthrough, and fail-closed behavior
 * when a transform rect maps outside the visible page.
 */
import { describe, expect, it } from "vitest";
import {
  Brand,
  ROUND_TRIP_TOLERANCE_PX,
  makeCanonicalRect,
  makePageContext,
  type PageContext,
} from "../geometry/index.js";
import type { SelectionId } from "../model.js";
import { toTransformRect } from "../redact/index.js";
import { toVerifyRectFromTransform } from "./rects.js";

const CONTEXTS: Array<{ name: string; ctx: PageContext }> = [
  { name: "letter-0", ctx: makePageContext([0, 0, 612, 792], 0, 1) },
  { name: "rotated-90", ctx: makePageContext([0, 0, 612, 792], 90, 1) },
  { name: "rotated-180", ctx: makePageContext([0, 0, 612, 792], 180, 1) },
  { name: "rotated-270", ctx: makePageContext([0, 0, 612, 792], 270, 1) },
  { name: "cropbox-offset", ctx: makePageContext([36, 48, 576, 744], 0, 1) },
  { name: "cropbox-rotated-90", ctx: makePageContext([36, 48, 576, 744], 90, 1) },
  { name: "cropbox-rotated-180", ctx: makePageContext([36, 48, 576, 744], 180, 1) },
  { name: "cropbox-rotated-270", ctx: makePageContext([36, 48, 576, 744], 270, 1) },
  { name: "userunit-2", ctx: makePageContext([0, 0, 306, 396], 0, 2) },
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

function randomCanonicalRect(ctx: PageContext, rand: () => number) {
  const [cx0, cy0, cx1, cy1] = ctx.cropBox;
  const w = cx1 - cx0;
  const h = cy1 - cy0;
  const rw = Math.max(1, rand() * w * 0.4);
  const rh = Math.max(1, rand() * h * 0.4);
  const x0 = cx0 + rand() * (w - rw);
  const y0 = cy0 + rand() * (h - rh);
  return makeCanonicalRect(Brand.pageIndex(2), x0, y0, x0 + rw, y0 + rh, ctx);
}

const SEL = { id: "sel-1" as SelectionId, number: 3 };

describe("toVerifyRectFromTransform", () => {
  for (const { name, ctx } of CONTEXTS) {
    it(`recovers the canonical rect within tolerance (${name})`, () => {
      const rand = mulberry32(name.length * 1013 + 5);
      for (let i = 0; i < 120; i++) {
        const canon = randomCanonicalRect(ctx, rand);
        const transform = toTransformRect(canon);
        const v = toVerifyRectFromTransform(transform, SEL, ctx, canon.page);
        // Canonical space is y-up: tolerance scaled back to points.
        const tolPt = ROUND_TRIP_TOLERANCE_PX / ctx.userUnit;
        expect(Math.abs(v.x0 - canon.rect.x0)).toBeLessThanOrEqual(tolPt);
        expect(Math.abs(v.y0 - canon.rect.y0)).toBeLessThanOrEqual(tolPt);
        expect(Math.abs(v.x1 - canon.rect.x1)).toBeLessThanOrEqual(tolPt);
        expect(Math.abs(v.y1 - canon.rect.y1)).toBeLessThanOrEqual(tolPt);
        // Identity passthrough: page, selection id, mark number.
        expect(v.page).toBe(canon.page);
        expect(v.selectionId).toBe(SEL.id);
        expect(v.number).toBe(SEL.number);
      }
    });
  }

  it("is y-up in default user space, not a copy of the y-down transform rect", () => {
    const ctx = makePageContext([0, 0, 612, 792], 0, 1);
    const canon = makeCanonicalRect(Brand.pageIndex(0), 100, 100, 200, 150, ctx);
    const t = toTransformRect(canon);
    // Viewport points are y-down from the top of the page…
    expect(t.y0).toBeCloseTo(792 - 150, 9);
    const v = toVerifyRectFromTransform(t, SEL, ctx, canon.page);
    // …while the verify rect is y-up from the MediaBox origin.
    expect(v.y0).toBeCloseTo(100, 9);
    expect(v.y1).toBeCloseTo(150, 9);
  });

  it("throws fail-closed when the transform rect maps outside the visible page", () => {
    const ctx = makePageContext([0, 0, 612, 792], 0, 1);
    expect(() =>
      toVerifyRectFromTransform(
        { page: 0, x0: -500, y0: -500, x1: -400, y1: -400 },
        SEL,
        ctx,
        Brand.pageIndex(0),
      ),
    ).toThrow(RangeError);
  });
});
