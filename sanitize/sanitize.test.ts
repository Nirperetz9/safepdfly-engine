/**
 * T099 — sanitizeDocument unit battery.
 *
 * Fail-closed behavior is pinned with tiny structural fakes (the module is
 * structurally typed, so malformed metadata shapes need no real PDFs);
 * the positive strip is pinned against the real metadata-rich fixture
 * through the real MuPDF engine and the real garbage-collecting save.
 */
import { describe, expect, it } from "vitest";
import { PDFDocument } from "mupdf";
import {
  sanitizeDocument,
  SanitizeError,
  type SanitizeDocument,
  type SanitizeObject,
} from "./sanitize.js";
import { fixtureBytes } from "../redact/test-utils.js";

interface FakeSpec {
  isNull?: boolean;
  isIndirect?: boolean;
  isDictionary?: boolean;
  isStream?: boolean;
  resolveTo?: FakeObj;
  entries?: Record<string, FakeObj>;
}

/** Minimal structural fake of a MuPDF PDFObject. */
class FakeObj implements SanitizeObject {
  readonly deleted: string[] = [];
  constructor(private readonly spec: FakeSpec = {}) {}
  isNull(): boolean {
    return this.spec.isNull ?? false;
  }
  isIndirect(): boolean {
    return this.spec.isIndirect ?? false;
  }
  isDictionary(): boolean {
    return this.spec.isDictionary ?? false;
  }
  isStream(): boolean {
    return this.spec.isStream ?? false;
  }
  resolve(): SanitizeObject {
    if (!this.spec.resolveTo) throw new Error("fake: nothing to resolve to");
    return this.spec.resolveTo;
  }
  get(key: string): SanitizeObject {
    return this.spec.entries?.[key] ?? new FakeObj({ isNull: true });
  }
  delete(key: string): void {
    this.deleted.push(key);
  }
}

const NULL = new FakeObj({ isNull: true });

function docWith(rootEntries: Record<string, FakeObj>, info?: FakeObj): {
  doc: SanitizeDocument;
  trailer: FakeObj;
  root: FakeObj;
} {
  const root = new FakeObj({ isDictionary: true, entries: rootEntries });
  const trailer = new FakeObj({
    isDictionary: true,
    entries: { Root: root, ...(info ? { Info: info } : {}) },
  });
  return { doc: { getTrailer: () => trailer }, trailer, root };
}

function fullLayers(): {
  doc: SanitizeDocument;
  trailer: FakeObj;
  root: FakeObj;
  names: FakeObj;
} {
  const names = new FakeObj({
    isDictionary: true,
    entries: {
      EmbeddedFiles: new FakeObj({ isDictionary: true }),
      JavaScript: new FakeObj({ isDictionary: true }),
      Dests: new FakeObj({ isDictionary: true }),
    },
  });
  const { doc, trailer, root } = docWith(
    {
      Metadata: new FakeObj({ isStream: true }),
      Names: names,
      OpenAction: new FakeObj({ isDictionary: true }),
      AA: new FakeObj({ isDictionary: true }),
    },
    new FakeObj({ isDictionary: true }),
  );
  return { doc, trailer, root, names };
}

describe("sanitizeDocument", () => {
  it("strips every hidden layer and keeps the rest", () => {
    const { doc, trailer, root, names } = fullLayers();
    sanitizeDocument(doc);
    expect(trailer.deleted).toEqual(["Info"]);
    expect(root.deleted).toEqual(
      expect.arrayContaining(["Metadata", "OpenAction", "AA"]),
    );
    expect(names.deleted).toEqual(
      expect.arrayContaining(["EmbeddedFiles", "JavaScript"]),
    );
    // Dests (navigation, not hidden data) is kept.
    expect(names.deleted).not.toContain("Dests");
  });

  it("resolves an indirect Info dictionary before dropping it", () => {
    const infoDict = new FakeObj({ isDictionary: true });
    const { doc, trailer } = docWith(
      {},
      new FakeObj({ isIndirect: true, resolveTo: infoDict }),
    );
    sanitizeDocument(doc);
    expect(trailer.deleted).toEqual(["Info"]);
  });

  it("is a no-op on a document with no hidden layers", () => {
    const { doc, trailer, root } = docWith({});
    expect(() => sanitizeDocument(doc)).not.toThrow();
    expect(trailer.deleted).toEqual([]);
    expect(root.deleted).toEqual([]);
  });

  it("fails closed: Info present but not a dictionary", () => {
    const { doc } = docWith({}, new FakeObj({ isStream: true }));
    expect(() => sanitizeDocument(doc)).toThrow(SanitizeError);
  });

  it("fails closed: /Metadata present but not a stream", () => {
    const { doc } = docWith({ Metadata: new FakeObj({ isDictionary: true }) });
    expect(() => sanitizeDocument(doc)).toThrow(SanitizeError);
  });

  it("fails closed: /Names present but not a dictionary", () => {
    const { doc } = docWith({ Names: new FakeObj() });
    expect(() => sanitizeDocument(doc)).toThrow(SanitizeError);
  });

  it("fails closed: EmbeddedFiles entry present but not a dictionary", () => {
    const names = new FakeObj({
      isDictionary: true,
      entries: { EmbeddedFiles: new FakeObj({ isStream: true }) },
    });
    const { doc } = docWith({ Names: names });
    expect(() => sanitizeDocument(doc)).toThrow(SanitizeError);
  });

  it("fails closed: JavaScript entry present but not a dictionary", () => {
    const names = new FakeObj({
      isDictionary: true,
      entries: { JavaScript: new FakeObj() },
    });
    const { doc } = docWith({ Names: names });
    expect(() => sanitizeDocument(doc)).toThrow(SanitizeError);
  });

  it("fails closed: catalog /AA present but not a dictionary", () => {
    const { doc } = docWith({ AA: new FakeObj({ isStream: true }) });
    expect(() => sanitizeDocument(doc)).toThrow(SanitizeError);
  });

  it("fails closed: missing catalog root", () => {
    const trailer = new FakeObj({
      isDictionary: true,
      entries: { Root: NULL },
    });
    const doc: SanitizeDocument = { getTrailer: () => trailer };
    expect(() => sanitizeDocument(doc)).toThrow(SanitizeError);
  });

  it("positive: real fixture — hidden layers gone after save, content intact", () => {
    const bytes = fixtureBytes("sanitize/metadata-rich.pdf");
    const doc = PDFDocument.openDocument(
      new Uint8Array(bytes),
      "application/pdf",
    ) as PDFDocument;
    try {
      sanitizeDocument(doc);
      const saved = new Uint8Array(
        doc.saveToBuffer("garbage").asUint8Array(),
      ).slice().buffer as ArrayBuffer;
      const raw = Buffer.from(saved).toString("latin1");
      for (const marker of [
        "Test Author",
        "Sanitize Fixture Title",
        "Fixture Subject",
        "x:xmpmeta",
        "secret.txt",
        "Nothing real here",
        "sanitize-fixture",
        "/OpenAction",
        "/AA",
        "/EmbeddedFiles",
        "/Metadata",
      ]) {
        expect(raw.includes(marker), `marker survived: ${marker}`).toBe(false);
      }
      // Content survives: same page count, same text.
      const reopened = PDFDocument.openDocument(
        new Uint8Array(saved),
        "application/pdf",
      ) as PDFDocument;
      try {
        expect(reopened.countPages()).toBe(1);
        const text = reopened.loadPage(0).toStructuredText({}).asText();
        expect(text).toContain("SafePDFly-SANITIZE-FIXTURE remove-me");
        expect(text).toContain("SafePDFly-SANITIZE-FIXTURE keep-me");
      } finally {
        reopened.destroy();
      }
    } finally {
      doc.destroy();
    }
  });
});
