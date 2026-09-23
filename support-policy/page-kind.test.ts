/**
 * T037 — Scanned/hybrid policy.
 *
 * Unit rules plus end-to-end runs through both real engines:
 * descriptors (PDF.js) -> compareEngines (dual-engine) -> adjudicate.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { handleOpenSource } from "../input/handler.js";
import { createPdfJsEngine, type InputEngine } from "../input/engine.js";
import type { SourceReady } from "../input/protocol.js";
import { classifySource } from "../classify-mupdf/classifier.js";
import { openDocumentReadOnly } from "../classify-mupdf/readonly-facade.js";
import { compareEngines, type AgreedPage } from "./dual-engine.js";
import {
  adjudicateDocumentKind,
  classifyPageKind,
  HYBRID_IMAGE_COVERAGE,
} from "./page-kind.js";

const require = createRequire(import.meta.url);

function fixture(name: string): ArrayBuffer {
  const url = new URL(
    `../../test/fixtures/${name}`,
    import.meta.url,
  );
  const buf = readFileSync(url);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function makeEngine(): InputEngine {
  return createPdfJsEngine(pdfjs, {
    workerSrc: require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  });
}

/** Full pipeline to agreed pages: PDF.js descriptors + MuPDF evidence. */
async function agreedPages(name: string): Promise<AgreedPage[]> {
  const bytes = fixture(name);
  const ready = (await handleOpenSource(bytes.slice(0), {
    engine: makeEngine(),
  })) as SourceReady;
  if (ready.type !== "SOURCE_READY") throw new Error(`not ready: ${name}`);
  const report = await classifySource(bytes.slice(0), {
    open: openDocumentReadOnly,
  });
  const cmp = compareEngines(ready.descriptors, report);
  if (!cmp.ok) throw new Error(`engines disagree: ${name}`);
  return [...cmp.pages];
}

describe("classifyPageKind rules", () => {
  it("blank: no text, no images", () => {
    expect(
      classifyPageKind({ pageIndex: 0, hasText: false, imageBlocks: 0, imageCoverage: 0 }),
    ).toBe("blank");
  });

  it("scanned: images but no text", () => {
    expect(
      classifyPageKind({ pageIndex: 0, hasText: false, imageBlocks: 1, imageCoverage: 1 }),
    ).toBe("scanned");
  });

  it("text_based: text with incidental raster", () => {
    expect(
      classifyPageKind({ pageIndex: 0, hasText: true, imageBlocks: 1, imageCoverage: 0.0625 }),
    ).toBe("text_based");
  });

  it("hybrid: text over page-dominating raster", () => {
    expect(
      classifyPageKind({ pageIndex: 0, hasText: true, imageBlocks: 1, imageCoverage: 1 }),
    ).toBe("hybrid");
  });

  it(`threshold is exactly ${HYBRID_IMAGE_COVERAGE}`, () => {
    const base = { pageIndex: 0, hasText: true, imageBlocks: 1 };
    expect(classifyPageKind({ ...base, imageCoverage: HYBRID_IMAGE_COVERAGE })).toBe("hybrid");
    expect(
      classifyPageKind({ ...base, imageCoverage: HYBRID_IMAGE_COVERAGE - 0.001 }),
    ).toBe("text_based");
  });

  it("clamps insane coverage instead of misclassifying", () => {
    expect(
      classifyPageKind({ pageIndex: 0, hasText: true, imageBlocks: 1, imageCoverage: NaN }),
    ).toBe("text_based");
  });
});

describe("document adjudication", () => {
  it("rejects the scanned fixture with reason scanned", async () => {
    const pages = await agreedPages("policy/scanned-page.pdf");
    expect(pages[0]).toMatchObject({ hasText: false, imageBlocks: 1 });
    expect(pages[0]!.imageCoverage).toBeCloseTo(1, 3);
    const verdict = adjudicateDocumentKind(pages);
    expect(verdict).toMatchObject({
      supported: false,
      reason: "scanned",
      pageNumbers: [1],
    });
  });

  it("rejects the hybrid fixture with reason hybrid", async () => {
    const pages = await agreedPages("policy/hybrid-page.pdf");
    expect(pages[0]).toMatchObject({ hasText: true, imageBlocks: 1 });
    expect(pages[0]!.imageCoverage).toBeCloseTo(1, 3);
    const verdict = adjudicateDocumentKind(pages);
    expect(verdict).toMatchObject({
      supported: false,
      reason: "hybrid",
      pageNumbers: [1],
    });
  });

  it("supports text with an incidental figure", async () => {
    const pages = await agreedPages("policy/text-with-figure.pdf");
    expect(pages[0]!.imageCoverage).toBeLessThan(HYBRID_IMAGE_COVERAGE);
    const verdict = adjudicateDocumentKind(pages);
    expect(verdict.supported).toBe(true);
    if (verdict.supported) expect(verdict.kinds[0]!.kind).toBe("text_based");
  });

  it("supports ordinary text and blank pages", async () => {
    for (const name of ["text/en-basic.pdf", "graphics/blank.pdf"]) {
      const verdict = adjudicateDocumentKind(await agreedPages(name));
      expect(verdict.supported, name).toBe(true);
    }
  });

  it("reports 1-based offending page numbers", () => {
    const pages: AgreedPage[] = [
      {
        pageIndex: 0,
        visibleBox: [0, 0, 100, 100],
        rotation: 0,
        userUnit: 1,
        hasText: true,
        imageBlocks: 0,
        imageCoverage: 0,
      },
      {
        pageIndex: 1,
        visibleBox: [0, 0, 100, 100],
        rotation: 0,
        userUnit: 1,
        hasText: false,
        imageBlocks: 1,
        imageCoverage: 1,
      },
    ];
    const verdict = adjudicateDocumentKind(pages);
    expect(verdict).toMatchObject({ supported: false, reason: "scanned", pageNumbers: [2] });
  });
});
