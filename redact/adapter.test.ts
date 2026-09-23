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
 * 4. Ported T011: vector fixture — touched paths removed entirely, an
 *    untouched path survives.
 * 5. Never-overlay: any adapter failure surfaces as TRANSFORM_FAILED with
 *    no candidate — the application cannot downgrade to a cosmetic
 *    rectangle under any failure condition.
 *
 * Fixture note: like the T085 classifier tests, these read the Phase 1
 * fixture PDFs under prototypes/engine-validation/fixtures/ (read-only;
 * fixture ownership is still to be fixed deliberately).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ColorSpace, Matrix, PDFDocument } from "mupdf";
import { createMuPdfBackend } from "./adapter.js";
import { dispatchTransform } from "./handler.js";
import type { TransformRect } from "./protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "..", "prototypes", "engine-validation", "fixtures");
const workersDir = join(here, "..", "..", "app", "workers");

interface ManifestEntry {
  rects?: { page: number; rect: [number, number, number, number] }[];
  must_remove?: string[];
  must_keep?: string[];
}
const manifest = JSON.parse(
  readFileSync(join(fixturesDir, "manifest.json"), "utf8"),
) as Record<string, ManifestEntry>;

function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(fixturesDir, name));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return ab as ArrayBuffer;
}

function manifestRects(name: string): TransformRect[] {
  const entry = manifest[name];
  if (!entry?.rects) throw new Error(`no rects for ${name}`);
  return entry.rects.map((r) => ({
    page: r.page,
    x0: r.rect[0],
    y0: r.rect[1],
    x1: r.rect[2],
    y1: r.rect[3],
  }));
}

function sourcesIn(dir: string, prefix?: string): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && (!prefix || n.startsWith(prefix)))
    .map((n) => ({
      name: n,
      // Strip comments: prose may discuss a forbidden concept, but code
      // must never contain it.
      text: readFileSync(join(dir, n), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1"),
    }));
}

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

describe("mutation boundary", () => {
  const redactSources = sourcesIn(here);
  const entrySources = sourcesIn(workersDir, "redact-");
  const all = [...redactSources, ...entrySources];

  it("only the adapter imports the mupdf module", () => {
    const importers = all
      .filter((s) => /from\s+["']mupdf["']/.test(s.text))
      .map((s) => s.name);
    expect(importers).toEqual(["adapter.ts"]);
  });

  it("no overlay or downgrade identifier appears in the redact path", () => {
    const forbidden = [
      "REDACT_TEXT_NONE",
      "REDACT_IMAGE_NONE",
      "REDACT_IMAGE_REMOVE",
      "REDACT_LINE_ART_NONE",
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
      const { bytes, selfCheck } = await backend.apply(fixtureBytes(name), manifestRects(name));
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
    const { bytes } = await backend.apply(input, [rect]);

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

describe("ported T011 — vector redaction", () => {
  it("removes touched paths entirely and keeps an untouched path", async () => {
    const name = "graphics/vector-crossing.pdf";
    const backend = createMuPdfBackend();
    const input = fixtureBytes(name);
    const { bytes } = await backend.apply(input, manifestRects(name));

    const scale = 2;
    const before = renderInput(input, scale);
    const after = renderInput(bytes, scale);

    // Viewport probes from Phase 1 (y-down points; device = x2).
    const probes = [
      { x: 100, y: 241.89, before: true, after: false, label: "h-line (touched: whole path gone)" },
      { x: 300, y: 100, before: true, after: false, label: "v-line (touched: whole path gone)" },
      { x: 480, y: 481.89, before: true, after: true, label: "isolated square (untouched: survives)" },
    ];
    for (const p of probes) {
      expect(sampleDark(before, p.x * scale, p.y * scale), `${p.label} input`).toBe(p.before);
      expect(sampleDark(after, p.x * scale, p.y * scale), `${p.label} output`).toBe(p.after);
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
          redaction: "redaction-policy/1",
          save: "save/garbage+gc/1",
        },
      },
      backend,
    );
    expect(out).toEqual({ type: "TRANSFORM_FAILED", reason: "engine-error" });
  });
});
