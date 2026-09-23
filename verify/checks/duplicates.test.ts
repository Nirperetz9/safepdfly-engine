/**
 * T068 — duplicate-occurrence warning tests.
 */
import { describe, expect, it } from "vitest";
import {
  runDuplicateWarnings,
  selectedValueForRect,
  unmarkedPageText,
} from "./duplicates.js";
import type { VerifyCheckContext } from "../handler.js";
import type { VerifyCandidateMessage, VerifyRect, VerifyWarning } from "../protocol.js";
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

// 10pt text at (x,y): y-up box y-3..y+10.
const at = (str: string, x: number, y: number) =>
  item(str, [10, 0, 0, 10, x, y], str.length * 6);

const RECT: VerifyRect = {
  page: 0,
  x0: 10,
  y0: 10,
  x1: 60,
  y1: 40,
  selectionId: "s1",
  number: 1,
};

function page(items: readonly VerifyTextItem[], fail = false): VerifyPage {
  return {
    view: [0, 0, 200, 100],
    rotate: 0,
    textItems: async () => {
      if (fail) throw new Error("text failed");
      return items;
    },
    render: async () => {
      throw new Error("not used");
    },
    toDevice: (_s: number, x: number, y: number) => [x * 2, (100 - y) * 2] as const,
  };
}

function doc(pages: readonly VerifyPage[]): VerifyDoc {
  return {
    numPages: pages.length,
    page: async (n: number) => pages[n - 1]!,
    jsActionNames: async () => [],
    attachmentNames: async () => [],
    fieldNames: async () => [],
    close: async () => undefined,
  };
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

describe("selectedValueForRect (T068)", () => {
  it("joins intersecting source items and normalizes", () => {
    const items = [
      at("Keep this", 10, 80), // outside (y 77..90 vs rect y 10..40)
      at("John", 12, 20), // inside
      item(" ", [10, 0, 0, 10, 40, 20], 3), // inside
      at("Doe", 46, 20), // inside
    ];
    expect(selectedValueForRect(items, RECT)).toBe("John Doe");
  });

  it("returns empty when the mark covers no readable text", () => {
    expect(selectedValueForRect([at("  \u200b ", 12, 20)], RECT)).toBe("");
    expect(selectedValueForRect([], RECT)).toBe("");
  });
});

describe("unmarkedPageText (T068)", () => {
  it("excludes text inside marked rectangles", () => {
    const items = [at("John Doe", 12, 20), at("Jane Roe", 12, 70)];
    expect(unmarkedPageText(items, [RECT])).toBe("Jane Roe");
    expect(unmarkedPageText(items, [])).toBe("John Doe Jane Roe");
  });
});

describe("runDuplicateWarnings (T068)", () => {
  it("warns when the selected value survives on another page", async () => {
    const source = doc([page([at("John Doe", 12, 20), at("intro", 12, 70)])]);
    const candidate = doc([
      page([at("intro", 12, 70)]), // marked occurrence removed
      page([at("John Doe", 12, 70)]), // duplicate survives on page 2
    ]);
    const warnings = await runDuplicateWarnings(ctx(candidate, source, [RECT]));
    expect(warnings).toEqual<VerifyWarning[]>([
      { code: "duplicate-occurrence", pageIndex: 1, selectionNumber: 1 },
    ]);
  });

  it("stays silent when every occurrence was marked", async () => {
    const source = doc([page([at("John Doe", 12, 20)])]);
    const candidate = doc([page([])]);
    expect(await runDuplicateWarnings(ctx(candidate, source, [RECT]))).toEqual([]);
  });

  it("does not warn for a value that only remains inside another mark", async () => {
    // Candidate still shows "John Doe" on page 0 — but inside a second mark
    // (that mark's own removal check would fail independently).
    const rect2: VerifyRect = { ...RECT, x0: 10, y0: 60, x1: 60, y1: 90, selectionId: "s2", number: 2 };
    const source = doc([page([at("John Doe", 12, 20), at("John Doe", 12, 70)])]);
    const candidate = doc([page([at("John Doe", 12, 70)])]);
    expect(
      await runDuplicateWarnings(ctx(candidate, source, [RECT, rect2])),
    ).toEqual([]);
  });

  it("points at the first surviving page and never includes content", async () => {
    const source = doc([page([at("John Doe", 12, 20)])]);
    const candidate = doc([
      page([]),
      page([at("John Doe", 12, 70)]),
      page([at("John Doe", 12, 70)]),
    ]);
    const warnings = await runDuplicateWarnings(ctx(candidate, source, [RECT]));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.pageIndex).toBe(1);
    expect(JSON.stringify(warnings)).not.toContain("John");
  });

  it("orders warnings by mark number and skips unreadable pages", async () => {
    const rectA: VerifyRect = { ...RECT, page: 1, selectionId: "s1", number: 1 };
    const rectB: VerifyRect = { ...RECT, selectionId: "s2", number: 2 };
    const rectC: VerifyRect = { ...RECT, page: 2, selectionId: "s3", number: 3 };
    const source = doc([
      page([at("John Doe", 12, 20)]),
      page([at("Jane Roe", 12, 20)]),
      page([at("Mystery", 12, 20)], true), // unreadable → skipped, no warning
    ]);
    const candidate = doc([
      page([at("John Doe", 12, 70)]), // unmarked duplicate of mark 2
      page([at("Jane Roe", 12, 70)]), // unmarked duplicate of mark 1
      page([]),
    ]);
    const warnings = await runDuplicateWarnings(
      ctx(candidate, source, [rectB, rectA, rectC]),
    );
    expect(warnings).toEqual<VerifyWarning[]>([
      { code: "duplicate-occurrence", pageIndex: 1, selectionNumber: 1 },
      { code: "duplicate-occurrence", pageIndex: 0, selectionNumber: 2 },
    ]);
  });
});
