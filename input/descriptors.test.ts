/**
 * T035 — Page descriptor extraction invariants.
 *
 * Descriptors must be immutable, stable across reopen, and correct across
 * the geometry fixtures (rotation, CropBox, UserUnit, mixed sizes, blank).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createPdfJsEngine, type InputEngine } from "./engine.js";
import {
  fingerprintDescriptor,
  fingerprintDescriptors,
} from "./descriptors.js";
import type { SourceReady } from "./protocol.js";
import { handleOpenSource } from "./handler.js";

const require = createRequire(import.meta.url);

function fixture(name: string): ArrayBuffer {
  const url = new URL(
    `../../src/test/fixtures/${name}`,
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

async function openDescriptors(name: string) {
  const res = (await handleOpenSource(fixture(name), {
    engine: makeEngine(),
  })) as SourceReady;
  expect(res.type).toBe("SOURCE_READY");
  return res.descriptors;
}

describe("descriptor invariants", () => {
  it("descriptors are deeply frozen", async () => {
    const ds = await openDescriptors("text/en-basic.pdf");
    const d = ds[0]!;
    expect(Object.isFrozen(ds)).toBe(true);
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.context)).toBe(true);
    expect(Object.isFrozen(d.renderBudget)).toBe(true);
    expect(() => {
      (d.context as { rotation: number }).rotation = 90;
    }).toThrow(TypeError);
  });

  it("descriptors are stable across reopen", async () => {
    for (const name of [
      "text/en-basic.pdf",
      "text/mixed-bidi.pdf",
      "graphics/cropbox.pdf",
      "graphics/userunit.pdf",
      "graphics/rotated-270.pdf",
      "graphics/mixed-sizes.pdf",
    ]) {
      const a = await openDescriptors(name);
      const b = await openDescriptors(name);
      expect(JSON.stringify(a), name).toBe(JSON.stringify(b));
      expect(fingerprintDescriptors(a), name).toBe(fingerprintDescriptors(b));
    }
  });

  it("fingerprints distinguish different documents", async () => {
    const a = await openDescriptors("text/en-basic.pdf");
    const b = await openDescriptors("graphics/cropbox.pdf");
    expect(fingerprintDescriptor(a[0]!)).not.toBe(
      fingerprintDescriptor(b[0]!),
    );
  });

  it("covers the rotation fixtures", async () => {
    const r180 = await openDescriptors("graphics/rotated-180.pdf");
    const r270 = await openDescriptors("graphics/rotated-270.pdf");
    expect(r180[0]!.context.rotation).toBe(180);
    expect(r270[0]!.context.rotation).toBe(270);
  });

  it("covers mixed page sizes", async () => {
    const ds = await openDescriptors("graphics/mixed-sizes.pdf");
    expect(ds).toHaveLength(2);
    const boxes = ds.map((d) => [...d.context.cropBox]);
    expect(boxes[0]).not.toEqual(boxes[1]);
  });

  it("blank page classifies as blank, not text", async () => {
    const ds = await openDescriptors("graphics/blank.pdf");
    expect(ds).toHaveLength(1);
    expect(ds[0]!.classification).toBe("blank");
  });

  it("descriptors carry no document content", async () => {
    const ds = await openDescriptors("text/en-basic.pdf");
    expect(JSON.stringify(ds)).not.toContain("SafePDFly synthetic fixture");
  });

  it("render budgets come from the published policy", async () => {
    const ds = await openDescriptors("text/en-basic.pdf");
    expect(ds[0]!.renderBudget.maxPixels).toBe(16 * 1024 * 1024);
    expect(ds[0]!.renderBudget.maxOperators).toBeGreaterThan(0);
  });
});
