/**
 * T033 — PDF.js input worker protocol tests.
 *
 * The handler is exercised directly (same code the browser worker entry
 * runs) against synthetic fixtures only. No real private documents.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  INPUT_POLICY_VERSION,
  InputWorkerClient,
  createPdfJsEngine,
  dispatchMessage,
  handleOpenSource,
  handleUnknownMessage,
  type InputEngine,
  type MinimalWorker,
  type SourceReady,
  type SourceRejected,
} from "./index.js";

const require = createRequire(import.meta.url);

function fixture(name: string): ArrayBuffer {
  const url = new URL(
    `../../../prototypes/engine-validation/fixtures/${name}`,
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

const CANARY = "SafePDFly synthetic fixture";

describe("OPEN_SOURCE protocol", () => {
  it("opens a basic text PDF: SOURCE_READY with frozen descriptors", async () => {
    const res = await handleOpenSource(fixture("text/en-basic.pdf"), {
      engine: makeEngine(),
    });
    expect(res.type).toBe("SOURCE_READY");
    const ready = res as SourceReady;
    expect(ready.pageCount).toBe(1);
    expect(ready.descriptors).toHaveLength(1);
    expect(ready.engineVersion).toBe("6.3.289");
    expect(ready.policyVersion).toBe(INPUT_POLICY_VERSION);
    expect(ready.support).toBe("supported");
    expect(typeof ready.sessionId).toBe("string");
    expect(ready.sessionId.length).toBeGreaterThan(0);
    expect(Object.isFrozen(ready.descriptors)).toBe(true);
    expect(Object.isFrozen(ready.descriptors[0])).toBe(true);
    const d = ready.descriptors[0]!;
    expect(d.classification).toBe("text_based");
    expect(d.context.rotation).toBe(0);
    expect(d.context.userUnit).toBe(1);
  });

  it("opens Hebrew and mixed-direction fixtures", async () => {
    for (const name of ["text/he-basic.pdf", "text/mixed-bidi.pdf"]) {
      const res = await handleOpenSource(fixture(name), {
        engine: makeEngine(),
      });
      expect(res.type, name).toBe("SOURCE_READY");
      expect((res as SourceReady).descriptors[0]!.classification).toBe(
        "text_based",
      );
    }
  });

  it("captures rotation, crop box, and user unit", async () => {
    const rotated = (await handleOpenSource(fixture("graphics/rotated-90.pdf"), {
      engine: makeEngine(),
    })) as SourceReady;
    expect(rotated.descriptors[0]!.context.rotation).toBe(90);

    const crop = (await handleOpenSource(fixture("graphics/cropbox.pdf"), {
      engine: makeEngine(),
    })) as SourceReady;
    const [x0, y0, x1, y1] = crop.descriptors[0]!.context.cropBox;
    expect([x0, y0, x1, y1]).toEqual([50, 500, 545, 820]);

    const uu = (await handleOpenSource(fixture("graphics/userunit.pdf"), {
      engine: makeEngine(),
    })) as SourceReady;
    expect(uu.descriptors[0]!.context.userUnit).toBe(2);
  });

  it("issues unique opaque session ids", async () => {
    const opts = { engine: makeEngine() };
    const a = (await handleOpenSource(fixture("text/en-basic.pdf"), opts)) as SourceReady;
    const b = (await handleOpenSource(fixture("text/en-basic.pdf"), opts)) as SourceReady;
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("SOURCE_READY carries no document content", async () => {
    const res = await handleOpenSource(fixture("text/en-basic.pdf"), {
      engine: makeEngine(),
    });
    expect(JSON.stringify(res)).not.toContain(CANARY);
  });
});

describe("fail-closed rejections", () => {
  const cases: Array<[string, string]> = [
    ["negative/corrupt.pdf", "damaged"],
    ["negative/zero-page.pdf", "empty"],
    ["negative/zero-byte.pdf", "wrong-type"],
    ["negative/encrypted.pdf", "locked"],
  ];
  for (const [name, code] of cases) {
    it(`${name} -> ${code}`, async () => {
      const res = (await handleOpenSource(fixture(name), {
        engine: makeEngine(),
      })) as SourceRejected;
      expect(res.type).toBe("SOURCE_REJECTED");
      expect(res.reasonCode).toBe(code);
      expect(res.outcome).toBe("rejected");
    });
  }

  it("never accepts a URL or non-buffer input", async () => {
    for (const bad of [
      "https://example.com/evil.pdf",
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      null,
      undefined,
      42,
    ]) {
      const res = await handleOpenSource(bad, { engine: makeEngine() });
      expect(res.type).toBe("SOURCE_REJECTED");
      expect((res as SourceRejected).reasonCode).toBe("wrong-type");
    }
  });

  it("rejections carry no document content, filename, or parser dump", async () => {
    const res = await handleOpenSource(fixture("negative/encrypted.pdf"), {
      engine: makeEngine(),
    });
    const json = JSON.stringify(res);
    expect(json).not.toContain("encrypted.pdf");
    expect(json).not.toContain("No password given");
    expect(json).not.toContain("%PDF");
    // Only the allowlisted envelope keys cross the boundary.
    expect(Object.keys(res).sort()).toEqual(
      ["outcome", "pageNumbers", "reasonCode", "type"].sort(),
    );
  });

  it("unknown messages fail closed as indeterminate", async () => {
    const direct = handleUnknownMessage("BOGUS");
    expect(direct).toMatchObject({
      type: "SOURCE_REJECTED",
      outcome: "indeterminate",
      reasonCode: "unexpected",
    });
    const dispatched = await dispatchMessage({ type: "NOPE" }, undefined, {
      engine: makeEngine(),
    });
    expect(dispatched.type).toBe("SOURCE_REJECTED");
    expect((dispatched as SourceRejected).outcome).toBe("indeterminate");
  });

  it("engine failures without a known name become indeterminate", async () => {
    const boom: InputEngine = {
      name: "pdfjs",
      version: "6.3.289",
      open: () => Promise.reject(new Error("weird internal failure")),
    };
    const res = (await handleOpenSource(fixture("text/en-basic.pdf"), {
      engine: boom,
    })) as SourceRejected;
    expect(res.outcome).toBe("indeterminate");
    expect(res.reasonCode).toBe("unexpected");
    expect(JSON.stringify(res)).not.toContain("weird internal failure");
  });
});

describe("engine hardening options", () => {
  it("disables XFA and never uses a remote worker URL", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fakePage = {
      rotate: 0,
      userUnit: 1,
      view: [0, 0, 100, 100],
      getTextContent: async () => ({ items: [] }),
    };
    const fakeDoc = {
      numPages: 1,
      getPage: async () => fakePage,
    };
    const fakePdfjs = {
      version: "6.3.289",
      GlobalWorkerOptions: {} as Record<string, unknown>,
      getDocument: (opts: Record<string, unknown>) => {
        seen.push(opts);
        return {
          promise: Promise.resolve(fakeDoc),
          destroy: async () => undefined,
        };
      },
    };
    const engine = createPdfJsEngine(
      fakePdfjs as unknown as typeof pdfjs,
      { workerSrc: "/self-hosted/pdf.worker.mjs" },
    );
    await engine.open(new Uint8Array([1, 2, 3]));
    expect(seen).toHaveLength(1);
    // XFA processing is explicitly disabled for untrusted input.
    expect(seen[0]!.enableXfa).toBe(false);
    // The pinned PDF.js 6.3.289 has no eval-of-document-content path
    // (verified: no `new Function(` in the worker bundle), so there is no
    // `isEvalSupported` option to set — and none is passed.
    expect("isEvalSupported" in seen[0]!).toBe(false);
    expect(fakePdfjs.GlobalWorkerOptions.workerSrc).toBe(
      "/self-hosted/pdf.worker.mjs",
    );
    expect(String(fakePdfjs.GlobalWorkerOptions.workerSrc)).not.toMatch(
      /^https?:\/\//,
    );
  });
});

describe("InputWorkerClient", () => {
  function fakeWorker(
    respond: (bytes: ArrayBuffer) => unknown,
  ): MinimalWorker & { terminated: boolean; transferred: unknown } {
    const w: MinimalWorker & { terminated: boolean; transferred: unknown } = {
      terminated: false,
      transferred: undefined,
      onmessage: null,
      onerror: null,
      postMessage(message: unknown, transfer?: Transferable[]) {
        w.transferred = transfer;
        const bytes = (message as { bytes: ArrayBuffer }).bytes;
        queueMicrotask(() => w.onmessage?.({ data: respond(bytes) }));
      },
      terminate() {
        w.terminated = true;
      },
    };
    return w;
  }

  it("transfers the buffer, resolves the typed response, then terminates", async () => {
    let workerRef: (MinimalWorker & { terminated: boolean }) | undefined;
    const client = new InputWorkerClient(() => {
      const w = fakeWorker(() => ({ type: "SOURCE_REJECTED" as const }));
      workerRef = w;
      return w;
    });
    const bytes = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer;
    const res = await client.openSource(bytes);
    expect(res.type).toBe("SOURCE_REJECTED");
    expect(workerRef!.terminated).toBe(true);
  });

  it("times out and terminates a silent worker", async () => {
    let workerRef: (MinimalWorker & { terminated: boolean }) | undefined;
    const client = new InputWorkerClient(
      () => {
        const w = fakeWorker(() => ({ type: "SOURCE_REJECTED" as const }));
        // Never respond.
        w.postMessage = () => undefined;
        workerRef = w;
        return w;
      },
      { timeoutMs: 50 },
    );
    await expect(
      client.openSource(new ArrayBuffer(8)),
    ).rejects.toThrow("timed out");
    expect(workerRef!.terminated).toBe(true);
  });
});
