/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T086 — Annotation and optional-content (hidden layer) support policy.
 *
 * Synthetic fixtures are built inline (no fixture files): annotation over a
 * selection, annotation clear of it, and optional-content over a selection
 * are each rejected with a stable reason code.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classifySource } from "../classify-mupdf/classifier.js";
import {
  openDocumentReadOnly,
  type PageMarkupEvidence,
} from "../classify-mupdf/readonly-facade.js";
import { checkSelectionMarkup, type SelectionInput } from "./markup.js";

/** Assemble a minimal valid PDF from numbered objects (1-based). */
function buildPdf(objects: string[]): ArrayBuffer {
  const parts = ["%PDF-1.7\n"];
  const offsets = [0];
  let pos = parts[0]!.length;
  objects.forEach((body, i) => {
    const obj = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(pos);
    parts.push(obj);
    pos += obj.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const tail =
    `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${pos}\n%%EOF`;
  const bytes = Buffer.from(parts.join("") + tail, "latin1");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
}

function streamObj(dict: string, data: string): string {
  const len = Buffer.byteLength(data, "latin1");
  return `<< ${dict} /Length ${len} >>\nstream\n${data}\nendstream`;
}

const TEXT_ANNOT = "<< /Type /Annot /Subtype /Text /Rect [10 140 60 190] /Contents (note) >>";
const OCG = "<< /Type /OCG /Name (Layer1) >>";
const OC_PROPS = "<< /OCGs [5 0 R] /D << /Order [5 0 R] >> >>";

function pageWithAnnots(annots: string, extra = ""): string[] {
  return [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [${annots}]${extra} >>`,
  ];
}

function markupOf(objects: string[]): PageMarkupEvidence {
  return openDocumentReadOnly(buildPdf(objects)).page(0).markupEvidence();
}

const OVERLAP: SelectionInput = { pageIndex: 0, rect: [0, 130, 70, 200] };
const CLEAR_OF: SelectionInput = { pageIndex: 0, rect: [100, 100, 150, 150] };

describe("annotation overlap", () => {
  it("rejects a selection under a text annotation", () => {
    const markup = markupOf([...pageWithAnnots("4 0 R"), TEXT_ANNOT]);
    expect(markup.annotations.map((a) => a.type)).toEqual(["Text"]);
    expect(checkSelectionMarkup(markup, OVERLAP)).toEqual({
      clear: false,
      reason: "annotation-overlap",
    });
  });

  it("clears a selection far from any annotation", () => {
    const markup = markupOf([...pageWithAnnots("4 0 R"), TEXT_ANNOT]);
    expect(checkSelectionMarkup(markup, CLEAR_OF)).toEqual({ clear: true });
  });

  it("rejects a selection under a highlight annotation", () => {
    // Highlight.getRect() throws in MuPDF; the raw /Rect path must work.
    const annot =
      "<< /Type /Annot /Subtype /Highlight /Rect [10 140 60 190] " +
      "/QuadPoints [10 190 60 190 10 140 60 140] /C [1 1 0] >>";
    const markup = markupOf([...pageWithAnnots("4 0 R"), annot]);
    expect(markup.annotations.map((a) => a.type)).toEqual(["Highlight"]);
    expect(markup.annotationsIndeterminate).toBe(false);
    expect(checkSelectionMarkup(markup, OVERLAP)).toEqual({
      clear: false,
      reason: "annotation-overlap",
    });
  });

  it("compares in the canonical (unrotated) frame on rotated pages", () => {
    const markup = markupOf([
      ...pageWithAnnots("4 0 R", " /Rotate 90"),
      TEXT_ANNOT,
    ]);
    // Raw /Rect [10 140 60 190] is unrotated; the selection is expressed in
    // the same canonical frame, so they overlap despite /Rotate 90.
    expect(checkSelectionMarkup(markup, OVERLAP)).toEqual({
      clear: false,
      reason: "annotation-overlap",
    });
    expect(checkSelectionMarkup(markup, CLEAR_OF)).toEqual({ clear: true });
  });

  it("edge-touching without positive area does not count", () => {
    const markup = markupOf([...pageWithAnnots("4 0 R"), TEXT_ANNOT]);
    const touching: SelectionInput = { pageIndex: 0, rect: [60, 140, 100, 190] };
    expect(checkSelectionMarkup(markup, touching)).toEqual({ clear: true });
  });
});

describe("optional content", () => {
  it("rejects any selection on a page with a page-level /OC entry", () => {
    const markup = markupOf([
      "<< /Type /Catalog /Pages 2 0 R /OCProperties " + OC_PROPS + " >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /OC 5 0 R >>",
      streamObj("", ""),
      OCG,
    ]);
    expect(markup.optionalContent).toBe(true);
    expect(checkSelectionMarkup(markup, CLEAR_OF)).toEqual({
      clear: false,
      reason: "hidden-layer",
    });
  });

  it("rejects any selection when content uses OCG marked content", () => {
    const content = "/OC /oc0 BDC\nBT (hi) Tj ET\nEMC";
    const markup = markupOf([
      "<< /Type /Catalog /Pages 2 0 R /OCProperties " + OC_PROPS + " >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] " +
        "/Contents 4 0 R /Resources << /Properties << /oc0 5 0 R >> >> >>",
      streamObj("", content),
      OCG,
    ]);
    expect(markup.optionalContent).toBe(true);
    expect(checkSelectionMarkup(markup, CLEAR_OF)).toEqual({
      clear: false,
      reason: "hidden-layer",
    });
  });

  it("rejects any selection when an XObject is OCG-gated", () => {
    const markup = markupOf([
      "<< /Type /Catalog /Pages 2 0 R /OCProperties " + OC_PROPS + " >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] " +
        "/Resources << /XObject << /Fm1 6 0 R >> >> >>",
      streamObj("", ""),
      OCG,
      streamObj("/Type /XObject /Subtype /Form /BBox [0 0 50 50] /OC 5 0 R", ""),
    ]);
    expect(markup.optionalContent).toBe(true);
    expect(checkSelectionMarkup(markup, CLEAR_OF)).toEqual({
      clear: false,
      reason: "hidden-layer",
    });
  });
});

describe("evidence plumbing", () => {
  it("flows through the classifier report", async () => {
    const bytes = buildPdf([...pageWithAnnots("4 0 R"), TEXT_ANNOT]);
    const report = await classifySource(bytes, { open: openDocumentReadOnly });
    const markup = report.pages[0]!.markup;
    expect(markup.annotations).toHaveLength(1);
    expect(markup.annotations[0]).toMatchObject({ type: "Text" });
    expect([...markup.annotations[0]!.rect]).toEqual([10, 140, 60, 190]);
    expect(markup.annotationsIndeterminate).toBe(false);
    expect(markup.optionalContent).toBe(false);
  });

  it("ordinary documents are clear", async () => {
    const url = new URL(
      "../../src/test/fixtures/text/en-basic.pdf",
      import.meta.url,
    );
    const buf = readFileSync(url);
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const report = await classifySource(bytes, { open: openDocumentReadOnly });
    const markup = report.pages[0]!.markup;
    expect(markup.annotations).toEqual([]);
    expect(markup.annotationsIndeterminate).toBe(false);
    expect(markup.optionalContent).toBe(false);
    expect(checkSelectionMarkup(markup, OVERLAP)).toEqual({ clear: true });
  });
});

describe("fail-closed on uncertainty", () => {
  const blank: PageMarkupEvidence = {
    annotations: [],
    annotationsIndeterminate: false,
    optionalContent: false,
  };

  it("uninspectable annotations reject as annotation-overlap", () => {
    const markup: PageMarkupEvidence = {
      ...blank,
      annotationsIndeterminate: true,
    };
    expect(checkSelectionMarkup(markup, CLEAR_OF)).toEqual({
      clear: false,
      reason: "annotation-overlap",
    });
  });

  it("null evidence rejects", () => {
    expect(checkSelectionMarkup(null, CLEAR_OF)).toEqual({
      clear: false,
      reason: "annotation-overlap",
    });
  });

  it("a degenerate selection rect rejects", () => {
    const bad: SelectionInput = {
      pageIndex: 0,
      rect: [0, 0, 1, Number.NaN],
    };
    expect(checkSelectionMarkup(blank, bad)).toEqual({
      clear: false,
      reason: "annotation-overlap",
    });
  });

  it("verdicts name exactly one stable reason", () => {
    const v = checkSelectionMarkup(blank, OVERLAP);
    expect(v).toEqual({ clear: true });
    const json = JSON.stringify([
      checkSelectionMarkup(
        { ...blank, annotationsIndeterminate: true },
        OVERLAP,
      ),
      checkSelectionMarkup({ ...blank, optionalContent: true }, OVERLAP),
    ]);
    expect(json).not.toMatch(/Error|Exception|stack/);
  });
});
