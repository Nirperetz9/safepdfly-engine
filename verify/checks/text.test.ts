/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T066 — text check tests. Item geometry is grounded in the pinned PDF.js
 * 6.3.289 output observed empirically (see checks/text.ts header).
 */
import { describe, expect, it } from "vitest";
import {
  boxesOverlap,
  hasVisibleText,
  runTextChecks,
  textItemBox,
} from "./text.js";
import type { VerifyCheckContext } from "../handler.js";
import type { VerifyCandidateMessage, VerifyRect } from "../protocol.js";
import type { VerifyDoc, VerifyPage, VerifyTextItem } from "../engine.js";
import { VERIFY_ENGINE_VERSION, VERIFY_POLICY_VERSION } from "../protocol.js";
import type { Sha256Digest } from "../../geometry/index.js";

function item(
  str: string,
  transform: readonly [number, number, number, number, number, number],
  width: number,
): VerifyTextItem {
  return { str, transform, width, hasEOL: false };
}

function pageWith(items: readonly VerifyTextItem[] | "throw"): VerifyPage {
  return {
    view: [0, 0, 612, 792],
    rotate: 0,
    textItems: async () => {
      if (items === "throw") throw new Error("extraction failed");
      return items;
    },
    render: async () => {
      throw new Error("not needed");
    },
    toDevice: () => [0, 0] as const,
  };
}

function ctx(
  pages: Map<number, VerifyPage>,
  rects: readonly VerifyRect[],
  numPages = 2,
): VerifyCheckContext {
  const candidate: VerifyDoc = {
    numPages,
    page: async (n: number) => {
      const page = pages.get(n);
      if (!page) throw new Error("no such page");
      return page;
    },
    jsActionNames: async () => [],
    attachmentNames: async () => [],
    fieldNames: async () => [],
    close: async () => undefined,
  };
  const message: VerifyCandidateMessage = {
    type: "VERIFY_CANDIDATE",
    sourceBytes: new ArrayBuffer(4),
    candidateBytes: new ArrayBuffer(8),
    expectedCandidateSha256: "x" as Sha256Digest,
    rects,
    expectedPages: [],
    policy: { engine: VERIFY_ENGINE_VERSION, verify: VERIFY_POLICY_VERSION },
  };
  return { candidate, source: candidate, message };
}

function rect(
  page: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  number = 1,
): VerifyRect {
  return { page, x0, y0, x1, y1, selectionId: `s${page}-${number}`, number };
}

// "Hello" at 24pt, origin (100,700): the exact item PDF.js produced.
const HELLO = item("Hello", [24, 0, 0, 24, 100, 700], 54.672);

describe("textItemBox", () => {
  it("computes the horizontal box from the empirical fixture", () => {
    expect(textItemBox(HELLO)).toEqual({
      x0: 100,
      y0: 700 - 0.3 * 24,
      x1: 154.672,
      y1: 700 + 24,
    });
  });

  it("handles 90-degree rotated text (empirical fixture)", () => {
    const box = textItemBox(item("Hello", [0, 24, -24, 0, 100, 700], 54.672))!;
    expect(box.x0).toBeCloseTo(100 - 24, 9);
    expect(box.x1).toBeCloseTo(100 + 0.3 * 24, 9);
    expect(box.y0).toBeCloseTo(700, 9);
    expect(box.y1).toBeCloseTo(700 + 54.672, 9);
  });

  it("returns null for degenerate items with no extent", () => {
    expect(textItemBox(item("x", [0, 0, 0, 24, 100, 700], 10))).toBeNull();
    expect(textItemBox(item("x", [24, 0, 0, 0, 100, 700], 10))).toBeNull();
  });
});

describe("hasVisibleText", () => {
  it("accepts visible text in any script", () => {
    expect(hasVisibleText("Hello")).toBe(true);
    expect(hasVisibleText("שלום")).toBe(true);
    expect(hasVisibleText("a b")).toBe(true);
  });

  it("rejects whitespace, format characters, and directional marks", () => {
    expect(hasVisibleText("   ")).toBe(false);
    expect(hasVisibleText("")).toBe(false);
    expect(hasVisibleText("\u200B")).toBe(false); // zero-width space (U+200B)
    expect(hasVisibleText(" \u200E ")).toBe(false); // LTR mark
    expect(hasVisibleText(" ")).toBe(false); // nbsp alone (U+00A0)
  });
});

describe("boxesOverlap", () => {
  it("treats touching edges as intersecting (conservative)", () => {
    expect(boxesOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 10, y0: 10, x1: 20, y1: 20 })).toBe(
      true,
    );
    expect(boxesOverlap({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 11, y0: 0, x1: 20, y1: 10 })).toBe(
      false,
    );
  });
});

describe("runTextChecks (T066)", () => {
  it("fails a rect that still contains text, keeping selection identity", async () => {
    const pages = new Map([[1, pageWith([HELLO])]]);
    const results = await runTextChecks(ctx(pages, [rect(0, 90, 690, 160, 730, 3)]));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      selectionId: "s0-3",
      page: 0,
      number: 3,
      outcome: "fail",
      reasonCode: "verify.text.remaining-text",
    });
  });

  it("passes a rect far from any text", async () => {
    const pages = new Map([[1, pageWith([HELLO])]]);
    const results = await runTextChecks(ctx(pages, [rect(0, 400, 400, 500, 450)]));
    expect(results[0]!.outcome).toBe("pass");
    expect(results[0]!.reasonCode).toBe("verify.text.clear");
  });

  it("ignores whitespace-only items inside the rect", async () => {
    const pages = new Map([[1, pageWith([item("   ", [24, 0, 0, 24, 100, 700], 20)])]]);
    const results = await runTextChecks(ctx(pages, [rect(0, 90, 690, 160, 730)]));
    expect(results[0]!.outcome).toBe("pass");
  });

  it("fails on Hebrew text inside the rect (bilingual case)", async () => {
    const hebrew = item("שלום", [24, 0, 0, 24, 100, 700], 60);
    const pages = new Map([[1, pageWith([hebrew])]]);
    const results = await runTextChecks(ctx(pages, [rect(0, 90, 690, 170, 730)]));
    expect(results[0]!.outcome).toBe("fail");
  });

  it("checks each rect on its own page", async () => {
    const pages = new Map([
      [1, pageWith([HELLO])],
      [2, pageWith([])],
    ]);
    const results = await runTextChecks(
      ctx(pages, [rect(0, 90, 690, 160, 730, 1), rect(1, 90, 690, 160, 730, 2)]),
    );
    expect(results.map((r) => r.outcome)).toEqual(["fail", "pass"]);
  });

  it("marks rects indeterminate when the page cannot be opened", async () => {
    const results = await runTextChecks(ctx(new Map(), [rect(5, 0, 0, 10, 10)]));
    expect(results[0]!.outcome).toBe("indeterminate");
    expect(results[0]!.reasonCode).toBe("verify.text.page-unavailable");
  });

  it("marks rects indeterminate when extraction fails", async () => {
    const pages = new Map([[1, pageWith("throw")]]);
    const results = await runTextChecks(ctx(pages, [rect(0, 0, 0, 10, 10)]));
    expect(results[0]!.outcome).toBe("indeterminate");
    expect(results[0]!.reasonCode).toBe("verify.text.extraction-unavailable");
  });
});
