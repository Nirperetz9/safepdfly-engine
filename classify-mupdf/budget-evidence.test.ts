/**
 * T040 — Classifier budget evidence and guards.
 *
 * The classifier collects budget evidence (never verdicts): the page-count
 * early guard prevents walking a pathological page tree, and per-page
 * maxImagePixels feeds the policy-level decoded-pixel check. Verdicts
 * belong to the support-policy layer (checkClassifiedPageBudgets).
 */
import { describe, expect, it } from "vitest";
import {
  classifySource,
  ClassifyError,
  type ClassifyDeps,
} from "./classifier.js";
import type {
  DocumentFeatures,
  ReadOnlyDocument,
  ReadOnlyPage,
} from "./readonly-facade.js";
import { openDocumentReadOnly } from "./readonly-facade.js";
import { mapClassifyFailure } from "../support-policy/unsupported.js";
import {
  checkClassifiedPageBudgets,
  limitLabel,
} from "../support-policy/budgets.js";

const NO_FEATURES: DocumentFeatures = {
  xfa: false,
  formWidgets: false,
  signed: false,
  embeddedFiles: false,
  javaScript: false,
  richMedia: false,
};

function stubDeps(pageCount: number): ClassifyDeps & {
  pagesWalked(): number;
} {
  let pagesWalked = 0;
  const page = (): ReadOnlyPage => {
    pagesWalked++;
    throw new Error("page tree must not be walked past the budget guard");
  };
  const doc: ReadOnlyDocument = {
    pageCount: () => pageCount,
    page,
    isEncrypted: () => false,
    wasRepaired: () => false,
    documentFeatures: () => NO_FEATURES,
  };
  return { open: () => doc, pagesWalked: () => pagesWalked };
}

function pdfBytes(): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  new Uint8Array(buf).set([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  return buf;
}

/**
 * Minimal synthetic PDF with valid xref: one page, one image XObject with
 * the given /Width × /Height (the stream is a 4-byte stub — the facade
 * never decodes it).
 */
function syntheticImagePdf(
  imgWidth: number,
  imgHeight: number,
  mediaW = 595,
  mediaH = 842,
): ArrayBuffer {
  const parts: string[] = [];
  const offsets: number[] = [];
  const push = (s: string) => {
    parts.push(s);
  };
  const beginObj = (n: number) => {
    offsets[n] = parts.join("").length;
    push(`${n} 0 obj\n`);
  };
  push("%PDF-1.7\n");
  beginObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  beginObj(2);
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  beginObj(3);
  push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaW} ${mediaH}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> >>\nendobj\n`,
  );
  beginObj(4);
  push(
    `<< /Type /XObject /Subtype /Image /Width ${imgWidth} /Height ${imgHeight} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n` +
      "\x00\x01\x02\x03\nendstream\nendobj\n",
  );
  const xrefOffset = parts.join("").length;
  const count = 5;
  push(`xref\n0 ${count}\n`);
  push("0000000000 65535 f \n");
  for (let n = 1; n < count; n++) {
    push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  const bytes = new TextEncoder().encode(parts.join(""));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("classifier page-count guard", () => {
  it("throws over-limit on 101 pages without walking the page tree", async () => {
    const deps = stubDeps(101);
    await expect(classifySource(pdfBytes(), deps)).rejects.toMatchObject({
      name: "ClassifyError",
    });
    let code = "";
    try {
      await classifySource(pdfBytes(), deps);
    } catch (e) {
      code = (e as ClassifyError).code;
    }
    expect(code).toBe("over-limit");
    expect(deps.pagesWalked()).toBe(0);
    expect(mapClassifyFailure(code)).toBe("over-limit");
    expect(limitLabel("page-count")).toBe("100 pages");
  });

  it("does not fire the guard at exactly 100 pages", async () => {
    // A stub doc with 100 pages whose page() throws would surface as
    // corrupt — proving the guard (not the walk) is what fires at 101.
    const deps = stubDeps(100);
    await expect(classifySource(pdfBytes(), deps)).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});

describe("classifier image-pixel evidence", () => {
  it("reports the largest image XObject in decoded pixels", async () => {
    const report = await classifySource(
      syntheticImagePdf(5000, 5000),
      { open: openDocumentReadOnly },
    );
    expect(report.pageCount).toBe(1);
    expect(report.pages[0]!.maxImagePixels).toBe(25_000_000);
  });

  it("policy flags the 25 MP image against the render-surface budget", async () => {
    const report = await classifySource(
      syntheticImagePdf(5000, 5000),
      { open: openDocumentReadOnly },
    );
    const page = report.pages[0]!;
    const [x0, y0, x1, y1] = page.mediaBox;
    const verdict = checkClassifiedPageBudgets({
      pageNumber: 1,
      mediaWidthPt: (x1 - x0) * page.userUnit,
      mediaHeightPt: (y1 - y0) * page.userUnit,
      maxImagePixels: page.maxImagePixels,
    });
    expect(verdict).toEqual({ kind: "render-surface", pageNumber: 1 });
    expect(limitLabel(verdict!.kind)).toBe("16 megapixels");
  });

  it("a small image stays within budget", async () => {
    const report = await classifySource(
      syntheticImagePdf(100, 100),
      { open: openDocumentReadOnly },
    );
    expect(report.pages[0]!.maxImagePixels).toBe(10_000);
    expect(
      checkClassifiedPageBudgets({
        pageNumber: 1,
        mediaWidthPt: 595,
        mediaHeightPt: 842,
        maxImagePixels: report.pages[0]!.maxImagePixels,
      }),
    ).toBeNull();
  });

  it("policy flags an oversized physical page from classifier evidence", async () => {
    const report = await classifySource(
      syntheticImagePdf(100, 100, 20000, 20000),
      { open: openDocumentReadOnly },
    );
    const page = report.pages[0]!;
    const [x0, y0, x1, y1] = page.mediaBox;
    const verdict = checkClassifiedPageBudgets({
      pageNumber: 1,
      mediaWidthPt: (x1 - x0) * page.userUnit,
      mediaHeightPt: (y1 - y0) * page.userUnit,
      maxImagePixels: page.maxImagePixels,
    });
    expect(verdict).toEqual({ kind: "page-dimension", pageNumber: 1 });
  });
});
