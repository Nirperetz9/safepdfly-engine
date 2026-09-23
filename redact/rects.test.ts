/**
 * T093 — property tests for the canonical → transform-worker projection.
 *
 * The projection must be the exact inverse of the approved viewport→PDF
 * conversion for every supported page geometry: rotated pages (90/180/270),
 * offset CropBoxes, non-default UserUnit. A TransformRect fed back through
 * `viewportToPdf` at scale 1 must recover the original canonical rect
 * within ROUND_TRIP_TOLERANCE_PX — otherwise the rect the engine redacts
 * and the rect verification checks would silently diverge.
 */
import { describe, expect, it } from "vitest";
import {
  Brand,
  ROUND_TRIP_TOLERANCE_PX,
  displaySize,
  makeCanonicalRect,
  makePageContext,
  pdfToViewport,
  viewportToPdf,
  type PageContext,
} from "../geometry/index.js";
import { toTransformRect } from "./rects.js";

const CONTEXTS: Array<{ name: string; ctx: PageContext }> = [
  { name: "letter-0", ctx: makePageContext([0, 0, 612, 792], 0, 1) },
  { name: "rotated-90", ctx: makePageContext([0, 0, 612, 792], 90, 1) },
  { name: "rotated-180", ctx: makePageContext([0, 0, 612, 792], 180, 1) },
  { name: "rotated-270", ctx: makePageContext([0, 0, 612, 792], 270, 1) },
  { name: "cropbox-offset", ctx: makePageContext([36, 48, 576, 744], 0, 1) },
  { name: "cropbox-rotated-90", ctx: makePageContext([36, 48, 576, 744], 90, 1) },
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
  return makeCanonicalRect(Brand.pageIndex(0), x0, y0, x0 + rw, y0 + rh, ctx);
}

describe("toTransformRect", () => {
  for (const { name, ctx } of CONTEXTS) {
    it(`round-trips through viewportToPdf within tolerance (${name})`, () => {
      const rand = mulberry32(name.length * 331 + 7);
      for (let i = 0; i < 120; i++) {
        const canon = randomCanonicalRect(ctx, rand);
        const t = toTransformRect(canon);
        // Ordered, y-down viewport points.
        expect(t.x0).toBeLessThan(t.x1);
        expect(t.y0).toBeLessThan(t.y1);
        const back = viewportToPdf(
          canon.page,
          { x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0 },
          1,
          ctx,
        );
        const again = pdfToViewport(back, 1);
        const first = pdfToViewport(canon, 1);
        for (const [a, b] of [
          [again.x, first.x],
          [again.y, first.y],
          [again.w, first.w],
          [again.h, first.h],
        ] as const) {
          expect(Math.abs(a - b)).toBeLessThanOrEqual(ROUND_TRIP_TOLERANCE_PX);
        }
      }
    });

    it(`stays inside the displayed viewport extents (${name})`, () => {
      const rand = mulberry32(name.length * 577 + 41);
      const disp = displaySize(ctx, 1);
      for (let i = 0; i < 60; i++) {
        const t = toTransformRect(randomCanonicalRect(ctx, rand));
        expect(t.x0).toBeGreaterThanOrEqual(-ROUND_TRIP_TOLERANCE_PX);
        expect(t.y0).toBeGreaterThanOrEqual(-ROUND_TRIP_TOLERANCE_PX);
        expect(t.x1).toBeLessThanOrEqual(disp.w + ROUND_TRIP_TOLERANCE_PX);
        expect(t.y1).toBeLessThanOrEqual(disp.h + ROUND_TRIP_TOLERANCE_PX);
      }
    });
  }
});
