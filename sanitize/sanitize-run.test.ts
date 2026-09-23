/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T099 — end-to-end sanitize run: the metadata-rich fixture goes through
 * the real transform worker path (dispatchTransform + production MuPDF
 * backend) with sanitize on/off, then the sanitized candidate goes through
 * the normal independent verification path (real PDF.js 6.3.289 engine +
 * real checks, like the corpus full-path harness).
 *
 * Required validation: author/XMP/embedded files/document JS all gone
 * after the run, content intact, verification passes. Fail closed: a
 * malformed metadata structure yields TRANSFORM_FAILED (engine-error) —
 * no candidate, no grant.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "mupdf";
import { installNodeCanvas } from "../../tests/helpers/node-canvas.js";
import { createMuPdfBackend } from "../redact/adapter.js";
import { dispatchTransform } from "../redact/handler.js";
import {
  TRANSFORM_ENGINE_VERSION,
  REDACTION_POLICY_VERSION,
  SAVE_POLICY_VERSION,
  type TransformRect,
} from "../redact/index.js";
import { fixtureBytes, manifestRects } from "../redact/test-utils.js";
import { dispatchVerify } from "../verify/handler.js";
import {
  VERIFY_ENGINE_VERSION,
  VERIFY_POLICY_VERSION,
  type VerifyCandidateMessage,
  type VerifyRect,
} from "../verify/index.js";
import { createPdfJsVerifyEngine } from "../verify/engine.js";
import { runVerificationChecks } from "../verify/checks.js";
import { toVerifyRectFromTransform } from "../verify/rects.js";
import { assembleVerificationReport } from "../verify/assembler.js";
import { makePageContext } from "../geometry/index.js";
import type { Sha256Digest } from "../geometry/index.js";
import type { PageIndex, SelectionId } from "../model.js";

installNodeCanvas();

const require = createRequire(import.meta.url);
const PDF_WORKER_SRC = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");

const FIXTURE = "sanitize/metadata-rich.pdf";
const CTX = makePageContext([0, 0, 612, 792], 0, 1);

async function sha256Hex(bytes: ArrayBuffer): Promise<Sha256Digest> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("") as Sha256Digest;
}

function extractText(bytes: ArrayBuffer): string {
  const doc = PDFDocument.openDocument(
    new Uint8Array(bytes),
    "application/pdf",
  ) as PDFDocument;
  try {
    return doc.loadPage(0).toStructuredText({}).asText();
  } finally {
    doc.destroy();
  }
}

/** All hidden-layer markers the fixture carries. None may survive. */
const HIDDEN_MARKERS = [
  "Test Author",
  "Sanitize Fixture Title",
  "Fixture Subject",
  "x:xmpmeta",
  "secret.txt",
  "Nothing real here",
  "sanitize-fixture",
  "/OpenAction",
  "/EmbeddedFiles",
];

function expectNoHiddenLayers(bytes: ArrayBuffer): void {
  const raw = Buffer.from(bytes).toString("latin1");
  for (const marker of HIDDEN_MARKERS) {
    expect(raw.includes(marker), `hidden layer survived: ${marker}`).toBe(false);
  }
}

/** Run the transform worker path with the given sanitize flag. */
async function runTransform(sanitize: boolean): Promise<ArrayBuffer> {
  const backend = createMuPdfBackend();
  const out = await dispatchTransform(
    {
      type: "APPLY_REDACTIONS",
      payload: fixtureBytes(FIXTURE),
      rects: manifestRects(FIXTURE),
      policy: {
        engine: TRANSFORM_ENGINE_VERSION,
        redaction: REDACTION_POLICY_VERSION,
        save: SAVE_POLICY_VERSION,
      },
      sanitize,
    },
    backend,
  );
  if (out.type !== "CANDIDATE_READY") {
    throw new Error(
      `transform failed: ${(out as { reason: string }).reason}`,
    );
  }
  expect(out.selfCheck).toBe("ok");
  return out.payload;
}

/** Run the independent verification path over a candidate. */
async function runVerify(
  sourceBytes: ArrayBuffer,
  candidateBytes: ArrayBuffer,
  rects: readonly TransformRect[],
): Promise<{ outcome: string; documentChecksPass: boolean }> {
  const candidateSha256 = await sha256Hex(candidateBytes);
  const verifyRects: VerifyRect[] = rects.map((t, i) =>
    toVerifyRectFromTransform(
      t,
      { id: `sanitize-${i + 1}` as SelectionId, number: i + 1 },
      CTX,
      t.page as PageIndex,
    ),
  );
  const message: VerifyCandidateMessage = {
    type: "VERIFY_CANDIDATE",
    sourceBytes: sourceBytes.slice(0),
    candidateBytes: candidateBytes.slice(0),
    expectedCandidateSha256: candidateSha256,
    rects: verifyRects,
    expectedPages: [
      {
        page: 0 as PageIndex,
        view: [0, 0, 612, 792] as unknown as readonly [
          number,
          number,
          number,
          number,
        ],
        rotation: 0,
      },
    ],
    policy: { engine: VERIFY_ENGINE_VERSION, verify: VERIFY_POLICY_VERSION },
  };
  const out = await dispatchVerify(message, {
    createEngine: () => createPdfJsVerifyEngine(pdfjs, { workerSrc: PDF_WORKER_SRC }),
    runChecks: runVerificationChecks,
  });
  expect(out.type).toBe("VERIFY_RESULT");
  if (out.type !== "VERIFY_RESULT") {
    throw new Error(`verify failed: ${(out as { reason: string }).reason}`);
  }
  const report = assembleVerificationReport(
    out.result,
    verifyRects.map((r) => ({
      selectionId: r.selectionId as SelectionId,
      number: r.number,
      page: r.page as PageIndex,
    })),
  );
  return {
    outcome: report.outcome,
    documentChecksPass: report.documentChecks.every((c) => c.outcome === "pass"),
  };
}

describe("T099 sanitize run", () => {
  it(
    "sanitize:true — hidden layers gone, content intact, verification passes",
    async () => {
      const sourceBytes = fixtureBytes(FIXTURE);
      const rects = manifestRects(FIXTURE);
      const candidate = await runTransform(true);

      // All hidden layers gone (byte level: nothing recoverable).
      expectNoHiddenLayers(candidate);

      // Content intact: marked line destroyed, public line survives.
      const text = extractText(candidate);
      expect(text.includes("remove-me")).toBe(false);
      expect(text.includes("SafePDFly-SANITIZE-FIXTURE keep-me")).toBe(true);

      // The sanitized candidate passes the normal independent verify path.
      const { outcome, documentChecksPass } = await runVerify(
        sourceBytes,
        candidate,
        rects,
      );
      expect(outcome).toBe("pass");
      expect(documentChecksPass).toBe(true);
    },
    120000,
  );

  it("sanitize:false — hidden layers survive the transform untouched (opt-in is what strips)", async () => {
    const candidate = await runTransform(false);
    const raw = Buffer.from(candidate).toString("latin1");
    expect(raw.includes("Test Author")).toBe(true);
    expect(raw.includes("x:xmpmeta")).toBe(true);
    expect(raw.includes("secret.txt")).toBe(true);
  });

  it("malformed Info dictionary fails closed: TRANSFORM_FAILED, no candidate", async () => {
    // Trailer-only byte surgery: replacing the /Info reference with a
    // string literal keeps every xref offset valid.
    const raw = Buffer.from(fixtureBytes(FIXTURE)).toString("latin1");
    expect(raw.includes("/Info 16 0 R")).toBe(true);
    const broken = Buffer.from(
      raw.replace("/Info 16 0 R", "/Info (bogus) "),
      "latin1",
    );
    const backend = createMuPdfBackend();
    const out = await dispatchTransform(
      {
        type: "APPLY_REDACTIONS",
        payload: broken.buffer.slice(
          broken.byteOffset,
          broken.byteOffset + broken.byteLength,
        ) as ArrayBuffer,
        rects: manifestRects(FIXTURE),
        policy: {
          engine: TRANSFORM_ENGINE_VERSION,
          redaction: REDACTION_POLICY_VERSION,
          save: SAVE_POLICY_VERSION,
        },
        sanitize: true,
      },
      backend,
    );
    expect(out).toEqual({ type: "TRANSFORM_FAILED", reason: "engine-error" });
  });
});
