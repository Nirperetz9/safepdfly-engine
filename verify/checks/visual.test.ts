/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T067 — visual check tests. Fake pages render controlled pixels; the
 * device mapping mimics PDF.js (y-up user space → y-down device).
 */
import { describe, expect, it } from "vitest";
import { runVisualChecks } from "./visual.js";
import type { VerifyCheckContext } from "../handler.js";
import type { VerifyCandidateMessage, VerifyRect } from "../protocol.js";
import type { VerifyDoc, VerifyPage, VerifyPixels, VerifyTextItem } from "../engine.js";
import { VERIFY_ENGINE_VERSION, VERIFY_POLICY_VERSION } from "../protocol.js";
import type { Sha256Digest } from "../../geometry/index.js";

type RGB = readonly [number, number, number];
const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [255, 255, 255];
const RED: RGB = [200, 0, 0];
const GRAY: RGB = [100, 100, 100];

const USER_H = 100; // user-space page height
const W = 120; // device px at scale 2 (60pt wide)
const H = 200;

function paint(painter: (x: number, y: number) => RGB): VerifyPixels {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const [r, g, b] = painter(x, y);
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

interface FakePageOpts {
  painter: (x: number, y: number) => RGB;
  items?: readonly VerifyTextItem[];
  throwOnRender?: boolean;
  throwOnText?: boolean;
}

function fakePage(opts: FakePageOpts): VerifyPage {
  return {
    view: [0, 0, 60, USER_H],
    rotate: 0,
    textItems: async () => {
      if (opts.throwOnText) throw new Error("text failed");
      return opts.items ?? [];
    },
    render: async () => {
      if (opts.throwOnRender) throw new Error("render failed");
      return paint(opts.painter);
    },
    toDevice: (_scale: number, x: number, y: number) =>
      [x * 2, (USER_H - y) * 2] as const,
  };
}

function docs(
    candPage: VerifyPage,
    srcPage: VerifyPage,
  ): { candidate: VerifyDoc; source: VerifyDoc } {
  const doc = (page: VerifyPage): VerifyDoc => ({
    numPages: 1,
    page: async () => page,
    jsActionNames: async () => [],
    attachmentNames: async () => [],
    fieldNames: async () => [],
    close: async () => undefined,
  });
  return { candidate: doc(candPage), source: doc(srcPage) };
}

function ctx(
  candidate: VerifyDoc,
  source: VerifyDoc,
  rects: readonly VerifyRect[],
): VerifyCheckContext {
  const message: VerifyCandidateMessage = {
    type: "VERIFY_CANDIDATE",
    sourceBytes: new ArrayBuffer(4),
    candidateBytes: new ArrayBuffer(8),
    expectedCandidateSha256: "x" as Sha256Digest,
    rects,
    expectedPages: [],
    policy: { engine: VERIFY_ENGINE_VERSION, verify: VERIFY_POLICY_VERSION },
  };
  return { candidate, source, message };
}

const RECT: VerifyRect = {
  page: 0,
  x0: 10,
  y0: 10,
  x1: 30,
  y1: 30,
  selectionId: "s1",
  number: 1,
};
// Device box of RECT: x 20..60, y (100-30)*2=140 .. (100-10)*2=180.
const inMask = (x: number, y: number) => x >= 20 && x < 60 && y >= 140 && y < 180;

function item(
  str: string,
  transform: readonly [number, number, number, number, number, number],
  width: number,
): VerifyTextItem {
  return { str, transform, width, hasEOL: false };
}

describe("runVisualChecks (T067)", () => {
  it("passes a uniform black fill with untouched surroundings", async () => {
    const { candidate, source } = docs(
      fakePage({ painter: (x, y) => (inMask(x, y) ? BLACK : WHITE) }),
      fakePage({ painter: () => WHITE }),
    );
    const out = await runVisualChecks(ctx(candidate, source, [RECT]));
    expect(out.selectionChecks).toHaveLength(1);
    expect(out.selectionChecks[0]).toMatchObject({
      aspect: "visual",
      outcome: "pass",
      reasonCode: "verify.visual.fill-ok",
    });
    expect(out.outsideMaskOutcome).toBe("pass");
    expect(out.outsideMaskReasonCode).toBe("verify.visual.outside-ok");
  });

  it("fails a non-uniform fill inside the mask", async () => {
    const { candidate, source } = docs(
      fakePage({
        painter: (x, y) => (x === 40 && y === 160 ? WHITE : inMask(x, y) ? BLACK : WHITE),
      }),
      fakePage({ painter: () => WHITE }),
    );
    const out = await runVisualChecks(ctx(candidate, source, [RECT]));
    expect(out.selectionChecks[0]!.outcome).toBe("fail");
    expect(out.selectionChecks[0]!.reasonCode).toBe("verify.visual.non-uniform-fill");
  });

  it("fails a uniform but non-black fill", async () => {
    const { candidate, source } = docs(
      fakePage({ painter: (x, y) => (inMask(x, y) ? GRAY : WHITE) }),
      fakePage({ painter: () => WHITE }),
    );
    const out = await runVisualChecks(ctx(candidate, source, [RECT]));
    expect(out.selectionChecks[0]!.outcome).toBe("fail");
    expect(out.selectionChecks[0]!.reasonCode).toBe("verify.visual.unexpected-fill");
  });

  it("fails retained original pixels, but not fill-like source pixels", async () => {
    // Candidate fill is uniform near-black (5,5,5): passes the fill check.
    // The source pixel (9,9,9) still shows through within tolerance and is
    // not itself fill-like → retained original content.
    const gray = (v: number): RGB => [v, v, v];
    const retained = docs(
      fakePage({ painter: (x, y) => (inMask(x, y) ? gray(5) : WHITE) }),
      fakePage({
        painter: (x, y) => (x === 40 && y === 160 ? gray(9) : inMask(x, y) ? gray(5) : WHITE),
      }),
    );
    const out1 = await runVisualChecks(ctx(retained.candidate, retained.source, [RECT]));
    expect(out1.selectionChecks[0]!.outcome).toBe("fail");
    expect(out1.selectionChecks[0]!.reasonCode).toBe("verify.visual.retained-pixels");

    // Fill-like source (already black): not counted as retained.
    const fillLike = docs(
      fakePage({ painter: (x, y) => (inMask(x, y) ? BLACK : WHITE) }),
      fakePage({ painter: (x, y) => (inMask(x, y) ? BLACK : WHITE) }),
    );
    const out2 = await runVisualChecks(ctx(fillLike.candidate, fillLike.source, [RECT]));
    expect(out2.selectionChecks[0]!.outcome).toBe("pass");
  });

  it("ignores antialias-band pixels at the mask edge", async () => {
    // A white pixel 1px inside the mask edge (the AA band) must not fail.
    const { candidate, source } = docs(
      fakePage({
        painter: (x, y) => (x === 20 && y === 150 ? WHITE : inMask(x, y) ? BLACK : WHITE),
      }),
      fakePage({ painter: () => WHITE }),
    );
    const out = await runVisualChecks(ctx(candidate, source, [RECT]));
    expect(out.selectionChecks[0]!.outcome).toBe("pass");
  });

  it("fails outside-mask damage far from any mask", async () => {
    const { candidate, source } = docs(
      fakePage({
        painter: (x, y) => (x === 5 && y === 5 ? RED : inMask(x, y) ? BLACK : WHITE),
      }),
      fakePage({ painter: () => WHITE }),
    );
    const out = await runVisualChecks(ctx(candidate, source, [RECT]));
    expect(out.selectionChecks[0]!.outcome).toBe("pass");
    expect(out.outsideMaskOutcome).toBe("fail");
    expect(out.outsideMaskReasonCode).toBe("verify.visual.outside-damage");
  });

  it("excludes the footprint of legitimately removed glyphs", async () => {
    // Source glyph "X": 10pt at (25,25), advance 8 → user box x 25..33,
    // y 22..35; intersects RECT, so the transform legitimately removed it —
    // including the ascender pixels above the mask edge. At device (62,132)
    // the source shows glyph ink and the candidate shows background: a real
    // difference that must NOT count as outside damage.
    const glyph = item("X", [10, 0, 0, 10, 25, 25], 8);
    const { candidate, source } = docs(
      fakePage({ painter: (x, y) => (inMask(x, y) ? BLACK : WHITE) }),
      fakePage({
        painter: (x, y) => (x === 62 && y === 132 ? BLACK : WHITE),
        items: [glyph],
      }),
    );
    const out = await runVisualChecks(ctx(candidate, source, [RECT]));
    expect(out.outsideMaskOutcome).toBe("pass");

    // Control: without the source glyph, the same pixel is damage.
    const control = docs(
      fakePage({ painter: (x, y) => (inMask(x, y) ? BLACK : WHITE) }),
      fakePage({ painter: (x, y) => (x === 62 && y === 132 ? BLACK : WHITE) }),
    );
    const out2 = await runVisualChecks(ctx(control.candidate, control.source, [RECT]));
    expect(out2.outsideMaskOutcome).toBe("fail");
    expect(out2.outsideMaskReasonCode).toBe("verify.visual.outside-damage");
  });

  it("reports indeterminate when the inner region is smaller than the AA boundary", async () => {
    const tiny: VerifyRect = { page: 0, x0: 10, y0: 10, x1: 11, y1: 11, selectionId: "s2", number: 2 };
    const { candidate, source } = docs(
      fakePage({ painter: () => BLACK }),
      fakePage({ painter: () => WHITE }),
    );
    const out = await runVisualChecks(ctx(candidate, source, [tiny]));
    expect(out.selectionChecks[0]!.outcome).toBe("indeterminate");
    expect(out.selectionChecks[0]!.reasonCode).toBe("verify.visual.inner-region-empty");
  });

  it("reports indeterminate when rendering fails", async () => {
    const { candidate, source } = docs(
      fakePage({ painter: () => BLACK, throwOnRender: true }),
      fakePage({ painter: () => WHITE }),
    );
    const out = await runVisualChecks(ctx(candidate, source, [RECT]));
    expect(out.selectionChecks[0]!.outcome).toBe("indeterminate");
    expect(out.selectionChecks[0]!.reasonCode).toBe("verify.visual.render-unavailable");
    expect(out.outsideMaskOutcome).toBe("indeterminate");
  });

  it("is deterministic: same pixels, same verdict", async () => {
    const { candidate, source } = docs(
      fakePage({ painter: (x, y) => (inMask(x, y) ? BLACK : WHITE) }),
      fakePage({ painter: () => WHITE }),
    );
    const once = await runVisualChecks(ctx(candidate, source, [RECT]));
    const twice = await runVisualChecks(ctx(candidate, source, [RECT]));
    expect(twice).toEqual(once);
  });
});
