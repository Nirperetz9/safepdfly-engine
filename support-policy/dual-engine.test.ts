/**
 * T036 — Dual-engine comparison.
 *
 * Agreement is verified with both real engines on every geometry fixture;
 * every tamper case must fail closed with reason "disagreement".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { handleOpenSource } from "../input/handler.js";
import { createPdfJsEngine, type InputEngine } from "../input/engine.js";
import type { SourceReady } from "../input/protocol.js";
import {
  classifySource,
  type ClassifyReport,
} from "../classify-mupdf/classifier.js";
import {
  openDocumentReadOnly,
  NO_FEATURES,
} from "../classify-mupdf/readonly-facade.js";
import { compareEngines, GEOMETRY_EPSILON_PT } from "./dual-engine.js";

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

async function dualEvidence(name: string) {
  const bytes = fixture(name);
  const ready = (await handleOpenSource(bytes.slice(0), {
    engine: makeEngine(),
  })) as SourceReady;
  expect(ready.type).toBe("SOURCE_READY");
  const report = await classifySource(bytes.slice(0), {
    open: openDocumentReadOnly,
  });
  return { descriptors: ready.descriptors, report };
}

describe("dual-engine agreement (real engines)", () => {
  const names = [
    "text/en-basic.pdf",
    "text/mixed-bidi.pdf",
    "graphics/cropbox.pdf",
    "graphics/userunit.pdf",
    "graphics/rotated-90.pdf",
    "graphics/rotated-180.pdf",
    "graphics/rotated-270.pdf",
    "graphics/mixed-sizes.pdf",
    "graphics/blank.pdf",
  ];
  for (const name of names) {
    it(`agrees on ${name}`, async () => {
      const { descriptors, report } = await dualEvidence(name);
      const cmp = compareEngines(descriptors, report);
      expect(cmp.ok).toBe(true);
      if (cmp.ok) {
        expect(cmp.pageCount).toBe(descriptors.length);
        expect(cmp.pages).toHaveLength(descriptors.length);
        expect(Object.isFrozen(cmp.pages)).toBe(true);
      }
    });
  }
});

describe("fail-closed disagreement", () => {
  async function baseline() {
    return dualEvidence("graphics/cropbox.pdf");
  }

  function tamper(
    report: ClassifyReport,
    pageIndex: number,
    patch: Record<string, unknown>,
  ): ClassifyReport {
    const pages = report.pages.map((p, i) =>
      i === pageIndex ? { ...p, ...patch } : p,
    );
    return { ...report, pages };
  }

  it("rotation mismatch", async () => {
    const { descriptors, report } = await baseline();
    const cmp = compareEngines(
      descriptors,
      tamper(report, 0, { rotation: 90 }),
    );
    expect(cmp).toEqual({ ok: false, reason: "disagreement" });
  });

  it("userUnit mismatch", async () => {
    const { descriptors, report } = await baseline();
    const cmp = compareEngines(descriptors, tamper(report, 0, { userUnit: 3 }));
    expect(cmp).toEqual({ ok: false, reason: "disagreement" });
  });

  it("visible dimension mismatch", async () => {
    const { descriptors, report } = await baseline();
    const p = report.pages[0]!;
    const cmp = compareEngines(
      descriptors,
      tamper(report, 0, {
        cropBox: [p.cropBox[0], p.cropBox[1], p.cropBox[2] * 2, p.cropBox[3]],
      }),
    );
    expect(cmp).toEqual({ ok: false, reason: "disagreement" });
  });

  it("page count mismatch", async () => {
    const { descriptors, report } = await baseline();
    const cmp = compareEngines(descriptors, {
      pageCount: report.pageCount + 1,
      pages: report.pages,
      features: report.features,
    });
    expect(cmp).toEqual({ ok: false, reason: "disagreement" });
  });

  it("text-presence mismatch", async () => {
    const { descriptors, report } = await dualEvidence("text/en-basic.pdf");
    const cmp = compareEngines(descriptors, tamper(report, 0, { textChars: 0 }));
    expect(cmp).toEqual({ ok: false, reason: "disagreement" });
  });

  it("crop larger than media (engine-internal insanity)", async () => {
    const { descriptors, report } = await baseline();
    const p = report.pages[0]!;
    const cmp = compareEngines(
      descriptors,
      tamper(report, 0, { mediaBox: [0, 0, 10, 10], cropBox: p.cropBox }),
    );
    expect(cmp).toEqual({ ok: false, reason: "disagreement" });
  });

  it("sub-epsilon float noise still agrees", async () => {
    const { descriptors, report } = await baseline();
    const p = report.pages[0]!;
    const n = GEOMETRY_EPSILON_PT / 2;
    const cmp = compareEngines(
      descriptors,
      tamper(report, 0, {
        cropBox: [
          p.cropBox[0] + n,
          p.cropBox[1] - n,
          p.cropBox[2] + n,
          p.cropBox[3] - n,
        ],
        mediaBox: [...p.mediaBox],
      }),
    );
    expect(cmp.ok).toBe(true);
  });

  it("never throws on malformed input", async () => {
    const { descriptors } = await baseline();
    expect(
      compareEngines(descriptors, null as unknown as ClassifyReport),
    ).toEqual({ ok: false, reason: "disagreement" });
    expect(
      compareEngines(descriptors, {
        pageCount: 1,
        pages: [],
        features: NO_FEATURES,
      }),
    ).toEqual({ ok: false, reason: "disagreement" });
  });
});
