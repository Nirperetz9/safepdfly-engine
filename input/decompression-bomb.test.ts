/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T040 — Decompression-bomb fixture: fail closed within budget.
 *
 * The fixture is 65 KiB on disk expanding to a 64 MiB content stream of
 * zeros (1029x). It is within every published budget (input size, page
 * count, dimensions, operators), so the correct behavior is safe handling:
 * both engines process it inside their time budgets and produce the honest
 * verdict (one blank page) — no hang, no runaway allocation, no
 * untrustworthy output.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { handleOpenSource } from "./handler.js";
import {
  createPdfJsEngine,
  type InputEngine,
} from "./engine.js";
import { classifySource } from "../classify-mupdf/classifier.js";
import { openDocumentReadOnly } from "../classify-mupdf/readonly-facade.js";
import type { SourceReady } from "./protocol.js";

const require = createRequire(import.meta.url);

function bombBytes(): ArrayBuffer {
  const buf = readFileSync(
    require.resolve(
      "../../src/test/fixtures/negative/decompression-bomb.pdf",
    ),
  );
  expect(buf.byteLength).toBeLessThan(1024 * 1024);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function realEngine(): InputEngine {
  return createPdfJsEngine(pdfjs, {
    workerSrc: require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  });
}

describe("decompression bomb", () => {
  it(
    "input worker: processes within budget, honest blank verdict",
    async () => {
      const started = Date.now();
      const res = await handleOpenSource(bombBytes(), {
        engine: realEngine(),
      });
      const elapsed = Date.now() - started;
      // Well inside the 60 s worker time budget.
      expect(elapsed).toBeLessThan(30_000);
      expect(res.type).toBe("SOURCE_READY");
      const ready = res as SourceReady;
      expect(ready.pageCount).toBe(1);
      expect(ready.descriptors).toHaveLength(1);
      // 64 MiB of zeros: no text, no operators — a blank page, truthfully.
      expect(ready.descriptors[0]!.classification).toBe("blank");
      expect("limitLabel" in res).toBe(false);
    },
    60_000,
  );

  it(
    "classifier: processes within budget, blank evidence",
    async () => {
      const started = Date.now();
      const report = await classifySource(bombBytes(), {
        open: openDocumentReadOnly,
      });
      const elapsed = Date.now() - started;
      // Well inside the 30 s classification time budget.
      expect(elapsed).toBeLessThan(30_000);
      expect(report.pageCount).toBe(1);
      expect(report.pages).toHaveLength(1);
      expect(report.pages[0]!.textChars).toBe(0);
      expect(report.pages[0]!.imageBlocks).toBe(0);
    },
    60_000,
  );
});
