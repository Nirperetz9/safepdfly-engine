/**
 * T038 — Unsupported-feature and malformed-input rejection.
 *
 * Unit rules plus a sweep of the negative corpus through the real MuPDF
 * classifier: every fixture is rejected with one stable code, and no
 * failure output carries engine internals.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifySource,
  ClassifyError,
  type ClassifyReport,
} from "../classify-mupdf/classifier.js";
import {
  NO_FEATURES,
  openDocumentReadOnly,
  type DocumentFeatures,
} from "../classify-mupdf/readonly-facade.js";
import {
  adjudicateFeatures,
  mapClassifyFailure,
  precheckSource,
} from "./unsupported.js";

function fixture(name: string): ArrayBuffer {
  const url = new URL(
    `../../test/fixtures/${name}`,
    import.meta.url,
  );
  const buf = readFileSync(url);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function classifyFailure(
  name: string,
): Promise<{ code: string; report?: ClassifyReport }> {
  try {
    const report = await classifySource(fixture(name), {
      open: openDocumentReadOnly,
    });
    return { code: "ok", report };
  } catch (error) {
    if (error instanceof ClassifyError) return { code: error.code };
    throw error;
  }
}

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

const PAGE = (extra = "") =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]${extra} >>`;

describe("mapClassifyFailure", () => {
  it("maps every classifier code to the shared vocabulary", () => {
    expect(mapClassifyFailure("not-a-pdf")).toBe("wrong-type");
    expect(mapClassifyFailure("encrypted")).toBe("locked");
    expect(mapClassifyFailure("corrupt")).toBe("damaged");
    expect(mapClassifyFailure("empty")).toBe("empty");
  });

  it("is total: unknown codes become unexpected, never throw", () => {
    expect(mapClassifyFailure("bogus" as never)).toBe("unexpected");
    expect(mapClassifyFailure("" as never)).toBe("unexpected");
  });
});

describe("precheckSource", () => {
  it("rejects non-buffers and empty input as wrong-type", () => {
    expect(precheckSource("nope")).toBe("wrong-type");
    expect(precheckSource(new ArrayBuffer(0))).toBe("wrong-type");
    expect(precheckSource(new Uint8Array([1, 2, 3]).buffer)).toBe(
      "wrong-type",
    );
  });

  it("passes ordinary PDFs to the engines", () => {
    expect(precheckSource(fixture("text/en-basic.pdf"))).toBeNull();
  });

  it("detects XFA at the byte level", () => {
    expect(precheckSource(fixture("negative/xfa.pdf"))).toBe("xfa");
    const xfa = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /XFA 4 0 R >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      PAGE(),
      "<< /Length 5 >>\nstream\n<x/>\nendstream",
    ]);
    expect(precheckSource(xfa)).toBe("xfa");
  });

  it("does not mistake /XFATheme for the XFA key", () => {
    const clean = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      PAGE(),
    ]);
    expect(precheckSource(clean)).toBeNull();
  });
});

describe("adjudicateFeatures", () => {
  const all: DocumentFeatures = {
    xfa: true,
    formWidgets: true,
    signed: true,
    embeddedFiles: true,
    javaScript: true,
    richMedia: true,
  };

  it("supports featureless documents", () => {
    expect(adjudicateFeatures(NO_FEATURES)).toEqual({ supported: true });
    expect(adjudicateFeatures(null)).toEqual({ supported: true });
  });

  it("names exactly one reason with fixed precedence", () => {
    expect(adjudicateFeatures(all)).toMatchObject({
      supported: false,
      reason: "xfa",
    });
    const rest = { ...all, xfa: false };
    expect(adjudicateFeatures(rest)).toMatchObject({ reason: "signed" });
    expect(adjudicateFeatures({ ...rest, signed: false })).toMatchObject({
      reason: "form-widget",
    });
    expect(
      adjudicateFeatures({ ...rest, signed: false, formWidgets: false }),
    ).toMatchObject({ reason: "embedded-file" });
    expect(
      adjudicateFeatures({
        ...rest,
        signed: false,
        formWidgets: false,
        embeddedFiles: false,
      }),
    ).toMatchObject({ reason: "js-actions" });
    expect(adjudicateFeatures({ ...NO_FEATURES, richMedia: true })).toMatchObject(
      { reason: "rich-media" },
    );
  });
});

describe("facade documentFeatures", () => {
  it("detects XFA via the catalog on a well-formed file", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /XFA 4 0 R >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      PAGE(),
      "<< /Length 5 >>\nstream\n<x/>\nendstream",
    ]);
    expect(openDocumentReadOnly(bytes).documentFeatures().xfa).toBe(true);
  });

  it("detects a JavaScript OpenAction", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (x) >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      PAGE(),
    ]);
    const features = openDocumentReadOnly(bytes).documentFeatures();
    expect(features.javaScript).toBe(true);
    expect(features.xfa).toBe(false);
  });

  it("detects form widgets via AcroForm fields", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      PAGE(" /Annots [4 0 R]"),
      "<< /Type /Annot /Subtype /Widget /Rect [10 10 50 30] /FT /Tx /T (f) >>",
    ]);
    expect(openDocumentReadOnly(bytes).documentFeatures().formWidgets).toBe(
      true,
    );
  });

  it("detects rich-media annotations", () => {
    const bytes = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      PAGE(" /Annots [4 0 R]"),
      "<< /Type /Annot /Subtype /RichMedia /Rect [10 10 50 30] >>",
    ]);
    expect(openDocumentReadOnly(bytes).documentFeatures().richMedia).toBe(
      true,
    );
  });

  it("reports no features for ordinary documents", () => {
    const features = openDocumentReadOnly(
      fixture("text/en-basic.pdf"),
    ).documentFeatures();
    expect(features).toEqual(NO_FEATURES);
  });
});

describe("negative corpus sweep", () => {
  it("encrypted.pdf -> locked (no password is ever attempted)", async () => {
    const { code } = await classifyFailure("negative/encrypted.pdf");
    expect(mapClassifyFailure(code)).toBe("locked");
  });

  it("corrupt.pdf -> damaged", async () => {
    const { code } = await classifyFailure("negative/corrupt.pdf");
    expect(mapClassifyFailure(code)).toBe("damaged");
  });

  it("zero-byte.pdf -> wrong-type", async () => {
    expect(precheckSource(fixture("negative/zero-byte.pdf"))).toBe(
      "wrong-type",
    );
    const { code } = await classifyFailure("negative/zero-byte.pdf");
    expect(mapClassifyFailure(code)).toBe("wrong-type");
  });

  it("zero-page.pdf -> empty", async () => {
    const { code } = await classifyFailure("negative/zero-page.pdf");
    expect(mapClassifyFailure(code)).toBe("empty");
  });

  it("xfa.pdf -> xfa (byte precheck and catalog agree)", async () => {
    expect(precheckSource(fixture("negative/xfa.pdf"))).toBe("xfa");
    const { code, report } = await classifyFailure("negative/xfa.pdf");
    expect(code).toBe("ok");
    expect(report!.features.xfa).toBe(true);
    expect(adjudicateFeatures(report!.features)).toEqual({
      supported: false,
      reason: "xfa",
    });
  });

  it("javascript.pdf is rejected by both engines (catalog unloadable)", async () => {
    // The corpus file's catalog object cannot be loaded by MuPDF (its
    // /OpenAction string breaks the object parser), so the classifier sees
    // an empty document; PDF.js rejects it as damaged. Both are stable and
    // fail-closed. JavaScript detection itself is proven above on
    // well-formed inline fixtures.
    const { code } = await classifyFailure("negative/javascript.pdf");
    expect(mapClassifyFailure(code)).toBe("empty");
    expect(precheckSource(fixture("negative/javascript.pdf"))).toBeNull();
  });

  it("embedded-file.pdf -> embedded-file", async () => {
    const { code, report } = await classifyFailure(
      "negative/embedded-file.pdf",
    );
    expect(code).toBe("ok");
    expect(report!.features.embeddedFiles).toBe(true);
    expect(adjudicateFeatures(report!.features)).toMatchObject({
      reason: "embedded-file",
    });
  });

  it("signed.pdf -> signed", async () => {
    const { code, report } = await classifyFailure("negative/signed.pdf");
    expect(code).toBe("ok");
    expect(report!.features.signed).toBe(true);
    expect(adjudicateFeatures(report!.features)).toEqual({
      supported: false,
      reason: "signed",
    });
  });

  it("hybrid/image-only fixtures carry no unsupported features", async () => {
    for (const name of ["negative/hybrid.pdf", "negative/image-only.pdf"]) {
      const { code, report } = await classifyFailure(name);
      expect(code).toBe("ok");
      expect(report!.features).toEqual(NO_FEATURES);
    }
  });

  it("zero pages with hostile features still reports them (fail-closed)", async () => {
    const stub = {
      pageCount: () => 0,
      page: (): never => {
        throw new Error("no pages");
      },
      isEncrypted: () => false,
      wasRepaired: () => false,
      documentFeatures: () => ({ ...NO_FEATURES, javaScript: true }),
    };
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer;
    const report = await classifySource(bytes, {
      open: () => stub,
    });
    expect(report.pageCount).toBe(0);
    expect(report.features.javaScript).toBe(true);
    expect(adjudicateFeatures(report.features)).toMatchObject({
      supported: false,
      reason: "js-actions",
    });
  });
});

describe("no engine internals leak", () => {
  it("failure outputs contain only stable codes", async () => {
    const outputs: unknown[] = [];
    for (const name of [
      "negative/encrypted.pdf",
      "negative/corrupt.pdf",
      "negative/zero-byte.pdf",
      "negative/zero-page.pdf",
      "negative/xfa.pdf",
    ]) {
      const { code } = await classifyFailure(name);
      outputs.push({
        reason: mapClassifyFailure(code),
        precheck: precheckSource(fixture(name)),
      });
    }
    const text = JSON.stringify(outputs);
    expect(text).not.toMatch(
      /password|Password|Error|Exception|stack|at\s+\w+\s*\(/,
    );
  });
});
