/**
 * T060 — Candidate save path.
 *
 * 1. Mutant tests (fail if incremental saving is attempted):
 *    - static: every saveToBuffer call in non-test redact sources passes
 *      exactly CANDIDATE_SAVE_OPTIONS; the "incremental" option string never
 *      appears in code;
 *    - dynamic (M2 analog): saving the redacted document with the
 *      "incremental" option produces a multi-revision file (%%EOF > 1),
 *      proving the single-%%EOF check catches the mutant.
 * 2. Ported T012: the product path produces exactly one %%EOF (single
 *    revision, no appended update), output bytes differ from the input,
 *    the page count is preserved, garbage collection drops the removed
 *    objects (raw secret bytes are absent from the file), and public
 *    content survives.
 */
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFPage } from "mupdf";
import { createMuPdfBackend } from "./adapter.js";
import { CANDIDATE_SAVE_OPTIONS } from "./save.js";
import {
  eofCount,
  fixtureBytes,
  manifest,
  manifestRects,
  redactDir,
  sourcesIn,
} from "./test-utils.js";

const allSources = sourcesIn(redactDir);

describe("incremental saving is forbidden", () => {
  it("every saveToBuffer call uses exactly CANDIDATE_SAVE_OPTIONS", () => {
    const calls: { file: string; arg: string }[] = [];
    for (const s of allSources) {
      for (const m of s.text.matchAll(/saveToBuffer\(\s*([^)]*?)\)/g)) {
        calls.push({ file: s.name, arg: m[1]!.trim() });
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(
        c.arg === "CANDIDATE_SAVE_OPTIONS" || c.arg === '"garbage"',
        `${c.file}: saveToBuffer(${c.arg})`,
      ).toBe(true);
    }
    expect(CANDIDATE_SAVE_OPTIONS).toBe("garbage");
  });

  it('the "incremental" option never appears in redact code', () => {
    for (const s of allSources) {
      expect(s.text.includes("incremental"), s.name).toBe(false);
    }
  });

  it("dynamic M2: an incremental save of the redacted doc is multi-revision", () => {
    // The mutant: same redaction policy, but the save uses "incremental".
    // The single-%%EOF product check must catch it.
    const doc = PDFDocument.openDocument(
      new Uint8Array(fixtureBytes("text/en-basic.pdf")),
      "application/pdf",
    ) as PDFDocument;
    try {
      const page: PDFPage = doc.loadPage(0);
      const rect = manifestRects("text/en-basic.pdf")[0]!;
      const annot = page.createAnnotation("Redact");
      annot.setRect([rect.x0, rect.y0, rect.x1, rect.y1]);
      annot.update();
      page.applyRedactions(
        true,
        PDFPage.REDACT_IMAGE_PIXELS,
        PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED,
        PDFPage.REDACT_TEXT_REMOVE,
      );
      const mutant = new Uint8Array(
        doc.saveToBuffer("incremental").asUint8Array(),
      ).buffer as ArrayBuffer;
      expect(eofCount(mutant)).toBeGreaterThan(1);
    } finally {
      doc.destroy();
    }
  });
});

describe("ported T012 — full rewrite with garbage collection", () => {
  it("product output is a single-revision file with GC'd dead objects", async () => {
    const name = "text/en-basic.pdf";
    const input = fixtureBytes(name);
    const backend = createMuPdfBackend();
    const { bytes, selfCheck } = await backend.apply(input, manifestRects(name));
    expect(selfCheck).toBe("ok");

    // Single revision: no appended incremental update.
    expect(eofCount(bytes)).toBe(1);
    // Actually rewritten, not the input echoed back.
    expect(Buffer.from(bytes).equals(Buffer.from(input))).toBe(false);
    // Page count preserved.
    const doc = PDFDocument.openDocument(
      new Uint8Array(bytes),
      "application/pdf",
    ) as PDFDocument;
    try {
      expect(doc.countPages()).toBe(1);
    } finally {
      doc.destroy();
    }
    // Garbage collection: the removed secret's raw bytes are gone from the
    // file (no unreferenced original objects left behind), while public
    // content survives.
    const raw = Buffer.from(bytes);
    for (const secret of manifest[name]!.must_remove ?? []) {
      expect(raw.includes(secret), `dead bytes still in file: ${secret}`).toBe(false);
    }
    for (const pub of manifest[name]!.must_keep ?? []) {
      expect(raw.includes(pub), `public content lost: ${pub}`).toBe(true);
    }
  }, 60000);
});
