/**
 * T085 — Isolated read-only MuPDF classifier.
 *
 * 1. Read-only boundary: only the facade imports "mupdf"; no mutation API
 *    identifier appears anywhere in the classify path; the classify worker
 *    entry never touches the input/transform paths.
 * 2. Evidence correctness against fixtures (independent boxes, rotation,
 *    UserUnit, text evidence).
 * 3. Fail-closed codes for encrypted/corrupt/empty/non-PDF.
 * 4. Single-use worker client semantics (fresh worker per call, terminated).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifySource, ClassifyError } from "./classifier.js";
import { openDocumentReadOnly } from "./readonly-facade.js";
import { classifyInWorker } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
const workersDir = join(here, "..", "..", "app", "workers");

function fixture(name: string): ArrayBuffer {
  const url = new URL(
    `../../test/fixtures/${name}`,
    import.meta.url,
  );
  const buf = readFileSync(url);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function sourcesIn(dir: string): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .map((n) => ({ name: n, text: readFileSync(join(dir, n), "utf8") }));
}

describe("read-only boundary", () => {
  const classifySources = sourcesIn(here);
  const entrySources = sourcesIn(workersDir).filter((s) =>
    s.name.startsWith("classify-"),
  );
  const all = [...classifySources, ...entrySources];

  it("only the facade imports the mupdf module", () => {
    const importers = all
      .filter((s) => /from\s+["']mupdf["']/.test(s.text))
      .map((s) => s.name);
    expect(importers).toEqual(["readonly-facade.ts"]);
  });

  it("no mutation API identifier appears in the classify path", () => {
    const forbidden = [
      "applyRedact",
      "saveToBuffer",
      "saveDocument",
      "DocumentWriter",
      "setPageBox",
      "createAnnotation",
      "deleteAnnotation",
      "insertEmbeddedFile",
      "deleteEmbeddedFile",
      "graftPage",
      "graftObject",
      "bakeDocument",
      "subsetFonts",
      "rearrangePages",
      "authenticatePassword",
      "toggleWidget",
      "setMetadata",
      "enableJournal",
      "beginOperation",
    ];
    for (const s of all) {
      for (const id of forbidden) {
        expect(s.text, `${s.name} contains ${id}`).not.toContain(id);
      }
    }
  });

  it("classify worker entry never touches input/transform paths", () => {
    for (const s of entrySources) {
      expect(s.text, s.name).not.toMatch(/pdf\/(input|transform)/);
    }
  });
});

describe("classify evidence", () => {
  const deps = { open: openDocumentReadOnly };

  it("reports independent MediaBox and CropBox (cropbox fixture)", async () => {
    const report = await classifySource(fixture("graphics/cropbox.pdf"), deps);
    expect(report.pageCount).toBe(1);
    const p = report.pages[0]!;
    // MuPDF native y-up: crop [0,0,495,320], media [-50,-21.89,545.28,820].
    expect([...p.cropBox]).toEqual([0, 0, 495, 320]);
    expect(p.mediaBox[0]).toBeCloseTo(-50, 0);
    expect(p.mediaBox[2]).toBeCloseTo(545.28, 0);
    expect(p.mediaBox).not.toEqual(p.cropBox);
  });

  it("reports normalized rotation (rotated-90 fixture)", async () => {
    const report = await classifySource(
      fixture("graphics/rotated-90.pdf"),
      deps,
    );
    expect(report.pages[0]!.rotation).toBe(90);
  });

  it("reports UserUnit (userunit fixture)", async () => {
    const report = await classifySource(fixture("graphics/userunit.pdf"), deps);
    expect(report.pages[0]!.userUnit).toBe(2);
  });

  it("sees text evidence on a text page", async () => {
    const report = await classifySource(fixture("text/en-basic.pdf"), deps);
    expect(report.pageCount).toBe(1);
    expect(report.pages[0]!.textChars).toBeGreaterThan(0);
  });

  it("returns frozen evidence", async () => {
    const report = await classifySource(fixture("text/en-basic.pdf"), deps);
    expect(Object.isFrozen(report.pages)).toBe(true);
    expect(Object.isFrozen(report.pages[0])).toBe(true);
    expect(() => {
      (report.pages[0] as { textChars: number }).textChars = 0;
    }).toThrow(TypeError);
  });
});

describe("fail-closed classification", () => {
  const deps = { open: openDocumentReadOnly };

  it.each([
    ["negative/encrypted.pdf", "encrypted"],
    ["negative/corrupt.pdf", "corrupt"],
    ["negative/zero-page.pdf", "empty"],
  ])("%s -> %s", async (name, code) => {
    await expect(classifySource(fixture(name), deps)).rejects.toMatchObject({
      name: "ClassifyError",
      code,
    });
  });

  it("rejects non-PDF bytes as not-a-pdf", async () => {
    const bytes = new TextEncoder().encode("hello").buffer as ArrayBuffer;
    const err = await classifySource(bytes, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ClassifyError);
    expect(err.code).toBe("not-a-pdf");
  });

  it("T103: unreadable feature structure fails closed as corrupt (never claims no features)", async () => {
    const doc = {
      pageCount: () => 1,
      page: (): never => {
        throw new Error("no pages");
      },
      isEncrypted: () => false,
      wasRepaired: () => false,
      documentFeatures: (): never => {
        throw new Error("unreadable-document-features");
      },
    };
    const err = await classifySource(fixture("text/en-basic.pdf"), {
      open: (() => doc) as never,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ClassifyError);
    expect(err.code).toBe("corrupt");
  });
});

describe("classify worker client (single-use)", () => {
  interface FakeWorker {
    onmessage: ((e: MessageEvent) => void) | null;
    onerror: (() => void) | null;
    postMessage: (msg: unknown, transfer: unknown[]) => void;
    terminate: () => void;
    terminated: boolean;
    respond: (data: unknown) => void;
  }

  function makeHarness() {
    const workers: FakeWorker[] = [];
    const createWorker = () => {
      const w: FakeWorker = {
        onmessage: null,
        onerror: null,
        terminated: false,
        postMessage(_msg: unknown, _transfer: unknown[]) {
          // Transfer neutering happens on the real postMessage; the harness
          // only needs the call to succeed.
        },
        terminate() {
          w.terminated = true;
        },
        respond(data: unknown) {
          w.onmessage?.({ data } as MessageEvent);
        },
      };
      workers.push(w);
      return w as unknown as Worker;
    };
    return { workers, createWorker };
  }

  it("uses a fresh worker per call and terminates it", async () => {
    const h = makeHarness();
    const bytes = fixture("text/en-basic.pdf");
    const pending = classifyInWorker(bytes, h);
    h.workers[0]!.respond({
      type: "CLASSIFY_READY",
      report: { pageCount: 1, pages: [] },
    });
    const report = await pending;
    expect(report.pageCount).toBe(1);
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0]!.terminated).toBe(true);

    const pending2 = classifyInWorker(bytes, h);
    h.workers[1]!.respond({
      type: "CLASSIFY_REJECTED",
      reason: "corrupt",
    });
    await expect(pending2).rejects.toThrow("classify-worker:corrupt");
    expect(h.workers).toHaveLength(2);
    expect(h.workers[1]!.terminated).toBe(true);
  });

  it("rejects malformed worker messages and still terminates", async () => {
    const h = makeHarness();
    const pending = classifyInWorker(fixture("text/en-basic.pdf"), h);
    h.workers[0]!.respond({ type: "BOGUS" });
    await expect(pending).rejects.toThrow("classify-worker:protocol");
    expect(h.workers[0]!.terminated).toBe(true);
  });
});
