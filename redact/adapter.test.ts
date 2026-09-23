/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T059 — Engine adapter for the approved redaction policy.
 *
 * 1. Mutation boundary: only adapter.ts imports "mupdf" in the redact path;
 *    no overlay/downgrade identifier appears in redact sources.
 * 2. Ported T009: text fixtures (en/he/bidi) — marked text destroyed,
 *    public text preserved, page count kept. Runs on the validated
 *    mupdf 1.28.1 pin (T084).
 * 3. Ported T010: image fixture — covered pixels replaced with the opaque
 *    fill; image content outside the rectangle is not destroyed.
 * 4. Ported T011: vector fixture — strokes touched by a rectangle are
 *    clipped at the mark boundary (T094): the marked portion is destroyed,
 *    the outside portions survive pixel-identical; an untouched path
 *    survives byte-verbatim.
 * 5. Never-overlay: any adapter failure surfaces as TRANSFORM_FAILED with
 *    no candidate — the application cannot downgrade to a cosmetic
 *    rectangle under any failure condition.
 *
 * Fixture note (T074): the corpus lives at src/test/fixtures/ (committed,
 * synthetic only); prototypes/ is never read anymore.
 */
import { describe, expect, it } from "vitest";
import { ColorSpace, Matrix, PDFDocument } from "mupdf";
import { createMuPdfBackend } from "./adapter.js";
import { dispatchTransform } from "./handler.js";
import {
  fixtureBytes,
  manifest,
  manifestRects,
  redactDir,
  sourcesIn,
  workersDir,
} from "./test-utils.js";

/** Render page 0 to an RGB pixmap at the given scale; y-down device space. */
function renderInput(bytes: ArrayBuffer, scale: number): Pixmap {
  const doc = PDFDocument.openDocument(new Uint8Array(bytes), "application/pdf") as PDFDocument;
  const pix = doc
    .loadPage(0)
    .toPixmap(Matrix.scale(scale, scale), ColorSpace.DeviceRGB);
  const out: Pixmap = {
    pixels: new Uint8Array(pix.getPixels()).slice(),
    width: pix.getWidth(),
    height: pix.getHeight(),
  };
  pix.destroy();
  doc.destroy();
  return out;
}

interface Pixmap {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/** Any dark pixel in the 3x3 neighborhood (thin anti-aliased strokes). */
function sampleDark(pm: Pixmap, x: number, y: number): boolean {
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ix = Math.max(0, Math.min(pm.width - 1, cx + dx));
      const iy = Math.max(0, Math.min(pm.height - 1, cy + dy));
      const o = (iy * pm.width + ix) * 3;
      if (pm.pixels[o]! < 100 && pm.pixels[o + 1]! < 100 && pm.pixels[o + 2]! < 100) {
        return true;
      }
    }
  }
  return false;
}

function extractText(bytes: ArrayBuffer): string {
  const doc = PDFDocument.openDocument(new Uint8Array(bytes), "application/pdf") as PDFDocument;
  try {
    return doc.loadPage(0).toStructuredText({}).asText();
  } finally {
    doc.destroy();
  }
}

/** Decoded page-0 content stream of a candidate (single stream). */
function readContentStream(bytes: ArrayBuffer): string {
  const doc = PDFDocument.openDocument(new Uint8Array(bytes), "application/pdf") as PDFDocument;
  try {
    const page = doc.loadPage(0);
    const contents = page.getObject().get("Contents");
    const ref = contents.isArray() ? contents.get(0)! : contents;
    return new Uint8Array(ref.readStream().asUint8Array()).reduce(
      (s, b) => s + String.fromCharCode(b),
      "",
    );
  } finally {
    doc.destroy();
  }
}

describe("mutation boundary", () => {
  const redactSources = sourcesIn(redactDir);
  const entrySources = sourcesIn(workersDir, "redact-");
  const all = [...redactSources, ...entrySources];

  it("only the mutation facade imports the mupdf module", () => {
    const importers = all
      .filter((s) => /from\s+["']mupdf["']/.test(s.text))
      .map((s) => s.name)
      .sort();
    // T059/T060/T062: the mutation facade is exactly the adapter (policy),
    // the save path (serialization), and the self-check (re-parse + render).
    // Everything else stays engine-free.
    expect(importers).toEqual(["adapter.ts", "save.ts", "selfcheck.ts"]);
  });

  it("no overlay or downgrade identifier appears in the redact path", () => {
    const forbidden = [
      "REDACT_TEXT_NONE",
      "REDACT_IMAGE_NONE",
      "REDACT_IMAGE_REMOVE",
      // T094: the old whole-path removal mode must not appear; the clip
      // pre-pass replaces it and MuPDF runs with REDACT_LINE_ART_NONE.
      "REDACT_LINE_ART_REMOVE_IF_TOUCHED",
      "REDACT_LINE_ART_REMOVE_IF_COVERED",
      "incremental",
      "overlay",
    ];
    for (const s of all) {
      for (const id of forbidden) {
        expect(s.text.includes(id), `${s.name} contains ${id}`).toBe(false);
      }
    }
  });

  it("only Redact annotations are ever created", () => {
    for (const s of all) {
      const creates = [...s.text.matchAll(/createAnnotation\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const kind of creates) {
        expect(kind, s.name).toBe("Redact");
      }
    }
  });
});

describe("ported T009 — text redaction", () => {
  for (const name of ["text/en-basic.pdf", "text/he-basic.pdf", "text/mixed-bidi.pdf"]) {
    it(`destroys marked text and keeps public text: ${name}`, async () => {
      const entry = manifest[name]!;
      const backend = createMuPdfBackend();
      const { bytes, selfCheck } = await backend.apply(fixtureBytes(name), manifestRects(name), false);
      expect(selfCheck).toBe("ok");
      const text = extractText(bytes);
      for (const secret of entry.must_remove ?? []) {
        expect(text.includes(secret), `secret still extractable: ${secret}`).toBe(false);
      }
      for (const pub of entry.must_keep ?? []) {
        expect(text.includes(pub), `public text lost: ${pub}`).toBe(true);
      }
      // Page count preserved.
      const doc = PDFDocument.openDocument(new Uint8Array(bytes), "application/pdf") as PDFDocument;
      try {
        expect(doc.countPages()).toBe(1);
      } finally {
        doc.destroy();
      }
    }, 60000);
  }
});

describe("ported T010 — image redaction", () => {
  it("replaces covered pixels with the fill and spares the rest of the image", async () => {
    const name = "graphics/image-partial.pdf";
    // Viewport rect from the manifest: [72, 141.89, 272, 371.89].
    const rect = manifestRects(name)[0]!;
    const backend = createMuPdfBackend();
    const input = fixtureBytes(name);
    const { bytes } = await backend.apply(input, [rect], false);

    const scale = 2;
    const after = renderInput(bytes, scale);

    // Inside the rectangle (inset): uniformly the opaque fill.
    let dark = 0;
    let total = 0;
    for (let y = rect.y0 + 10; y < rect.y1 - 10; y += 6) {
      for (let x = rect.x0 + 10; x < rect.x1 - 10; x += 6) {
        total++;
        if (sampleDark(after, x * scale, y * scale)) dark++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(dark / total).toBeGreaterThan(0.9);

    // Image area outside the rectangle (Phase 1 probe region): not destroyed.
    let nonBlack = 0;
    let outside = 0;
    for (let y = 160; y < 400; y += 4) {
      for (let x = 300; x < 460; x += 4) {
        outside++;
        if (!sampleDark(after, x * scale, y * scale)) nonBlack++;
      }
    }
    expect(nonBlack / outside).toBeGreaterThan(0.5);
  }, 60000);
});

describe("T094 fail-closed — unclippable vector content", () => {
  /** Minimal one-page PDF whose content stream is `streamBody`. */
  function buildPdf(streamBody: string, pageExtra = ""): ArrayBuffer {
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /CropBox [0 0 612 792]${pageExtra} /Contents 4 0 R >>`,
      `<< /Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream`,
    ];
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
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  it("an unclippable touched path fails the transform with no candidate", async () => {
    // A stroke under an external graphics state cannot be assessed exactly:
    // the clip throws, the backend throws (no candidate bytes), and the
    // dispatcher reports TRANSFORM_FAILED — never an overlay or downgrade.
    // Viewport mark [0,770,200,792] covers the PDF-space line at y=10.
    const pdf = buildPdf("/GS1 gs\n10 10 m 100 10 l S\n");
    const rects = [{ page: 0, x0: 0, y0: 770, x1: 200, y1: 792 }];
    const backend = createMuPdfBackend();
    await expect(backend.apply(pdf, rects, false)).rejects.toThrow();
    const out = await dispatchTransform(
      {
        type: "APPLY_REDACTIONS",
        payload: pdf,
        rects,
        policy: {
          engine: "mupdf/1.28.1",
          redaction: "redaction-policy/2",
          save: "save/garbage+gc/1",
        },
        sanitize: false,
      },
      backend,
    );
    expect(out).toEqual({ type: "TRANSFORM_FAILED", reason: "engine-error" });
  });

  it("maps the mark through the unrotated page box on a rotated page", async () => {
    // /Rotate 90 with MediaBox [0 0 612 792]: the content stream lives in
    // unrotated space. Viewport rect [340,50,360,150] must map to canonical
    // x[50,150] y[340,360] (rotation 90: unmap(X,Y) = (Y,X)), clipping the
    // line at PDF y=350. Using the rotation-applied bounds here would map
    // the mark outside the page and throw (or clip the wrong region).
    const pdf = buildPdf("0 0 0 RG\n10 350 m 190 350 l S\n", " /Rotate 90");
    const backend = createMuPdfBackend();
    const candidate = await backend.apply(
      pdf,
      [{ page: 0, x0: 340, y0: 50, x1: 360, y1: 150 }],
      false,
    );
    const text = readContentStream(candidate.bytes);
    expect(text).toContain("10 350 m 50 350 l S");
    expect(text).toContain("150 350 m 190 350 l S");
    expect(text).not.toContain("50 350 m 150 350 l");
  });
});

describe("ported T011 — vector redaction (T094 clip-instead-of-remove)", () => {
  it("clips touched strokes at the mark boundary; outside portions survive pixel-identical", async () => {
    const name = "graphics/vector-crossing.pdf";
    const backend = createMuPdfBackend();
    const input = fixtureBytes(name);
    const { bytes } = await backend.apply(input, manifestRects(name), false);

    const scale = 2;
    const before = renderInput(input, scale);
    const after = renderInput(bytes, scale);

    // Viewport probes (y-down points; device = x2). Manifest mark:
    // [140, 161.89, 360, 281.89].
    const probes = [
      { x: 100, y: 241.89, label: "h-line left of mark: survives" },
      { x: 400, y: 241.89, label: "h-line right of mark: survives" },
      { x: 300, y: 100, label: "v-line above mark: survives" },
      { x: 300, y: 350, label: "v-line below mark: survives" },
      { x: 250, y: 241.89, label: "h-line inside mark: opaque fill covers" },
      { x: 200, y: 161.89, label: "small rect top edge on mark boundary: survives" },
      { x: 200, y: 201.89, label: "small rect bottom edge inside mark: opaque fill covers" },
      { x: 480, y: 481.89, label: "isolated square (untouched: survives)" },
    ];
    for (const p of probes) {
      expect(sampleDark(before, p.x * scale, p.y * scale), `${p.label} (input)`).toBe(true);
      expect(sampleDark(after, p.x * scale, p.y * scale), `${p.label} (output)`).toBe(true);
    }

    // Outside the mark (plus an antialias margin), every pixel must be
    // identical: the clip may only destroy the marked portion.
    const margin = 4; // device px at scale 2
    const mx0 = 140 * scale - margin;
    const my0 = 161.89 * scale - margin;
    const mx1 = 360 * scale + margin;
    const my1 = 281.89 * scale + margin;
    expect(before.width).toBe(after.width);
    expect(before.height).toBe(after.height);
    let compared = 0;
    let mismatched = 0;
    let firstMismatch = "";
    for (let y = 0; y < before.height; y++) {
      for (let x = 0; x < before.width; x++) {
        if (x >= mx0 && x <= mx1 && y >= my0 && y <= my1) continue;
        const o = (y * before.width + x) * 3;
        compared++;
        if (
          before.pixels[o] !== after.pixels[o] ||
          before.pixels[o + 1] !== after.pixels[o + 1] ||
          before.pixels[o + 2] !== after.pixels[o + 2]
        ) {
          mismatched++;
          if (firstMismatch === "") firstMismatch = `${x},${y}`;
        }
      }
    }
    expect(compared).toBeGreaterThan(100000);
    expect(mismatched, `outside-mark pixels differ (first at ${firstMismatch})`).toBe(0);

    // Stream level: the removed geometry must be genuinely gone from the
    // content stream, not merely covered — and the kept pieces must be the
    // exact clipped runs. (MuPDF normalizes the stream on save, so the
    // assertions match its space-separated re-emission.)
    const stream = readContentStream(bytes);
    for (const kept of [
      "50 600 m 140 600 l S",
      "360 600 m 545 600 l S",
      "300 450 m 300 560 l S",
      "300 680 m 300 750 l S",
      "270 680 m 150 680 l S",
      "450 300 60 60 re S", // untouched rect passes through verbatim
    ]) {
      expect(stream.includes(kept), `kept run missing: ${JSON.stringify(kept)}`).toBe(true);
    }
    for (const gone of [
      "50 600 m 545 600 l", // original uncut h-line
      "140 600 m 360 600 l", // removed middle piece of h-line
      "300 450 m 300 750 l", // original uncut v-line
      "300 560 m 300 680 l", // removed middle piece of v-line
      "150 640 m 270 640 l", // removed rect bottom edge
    ]) {
      expect(stream.includes(gone), `removed geometry still present: ${JSON.stringify(gone)}`).toBe(false);
    }
  }, 60000);
});

describe("never downgrades to an overlay", () => {
  it("an adapter failure becomes TRANSFORM_FAILED with no candidate", async () => {
    const backend = createMuPdfBackend();
    // Page 99 does not exist: the adapter must throw, never overlay.
    const out = await dispatchTransform(
      {
        type: "APPLY_REDACTIONS",
        payload: fixtureBytes("text/en-basic.pdf"),
        rects: [{ page: 99, x0: 10, y0: 10, x1: 50, y1: 50 }],
        policy: {
          engine: "mupdf/1.28.1",
          redaction: "redaction-policy/2",
          save: "save/garbage+gc/1",
        },
        sanitize: false,
      },
      backend,
    );
    expect(out).toEqual({ type: "TRANSFORM_FAILED", reason: "engine-error" });
  });
});
