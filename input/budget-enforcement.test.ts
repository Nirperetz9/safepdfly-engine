/**
 * T040 — Input-worker budget enforcement (fail-fast gates).
 *
 * Stub engines prove each gate fires before expensive work happens;
 * the real-engine cases prove the gates fire on genuine fixtures.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { handleOpenSource } from "./handler.js";
import {
  createPdfJsEngine,
  type InputEngine,
  type InputEngineDoc,
  type InputEnginePage,
} from "./engine.js";
import type { SourceRejected, SourceReady } from "./protocol.js";

const require = createRequire(import.meta.url);

function fixture(name: string): ArrayBuffer {
  const url = require.resolve(
    `../../test/fixtures/${name}`,
  );
  const buf = readFileSync(url);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function pdfBytes(size: number): ArrayBuffer {
  const buf = new ArrayBuffer(size);
  new Uint8Array(buf).set([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  return buf;
}

interface StubPageOpts {
  view?: readonly [number, number, number, number];
  userUnit?: number;
  operators?: number;
}

function stubPage(opts: StubPageOpts = {}): InputEnginePage {
  return {
    rotate: 0,
    userUnit: opts.userUnit ?? 1,
    view: opts.view ?? [0, 0, 595, 842],
    hasNonWhitespaceText: async () => false,
    countOperators: async () => opts.operators ?? 10,
  };
}

interface StubEngine extends InputEngine {
  stats(): { opened: number; pagesRequested: number };
}

function stubEngine(pageCount: number, pageOpts: StubPageOpts = {}): StubEngine {
  let opened = 0;
  let pagesRequested = 0;
  return {
    name: "pdfjs",
    version: "stub",
    stats: () => ({ opened, pagesRequested }),
    open: async (_data: Uint8Array): Promise<InputEngineDoc> => {
      opened++;
      return {
        numPages: pageCount,
        page: async (_n: number): Promise<InputEnginePage> => {
          pagesRequested++;
          return stubPage(pageOpts);
        },
        renderPage: async () => {
          throw new Error("renderPage not stubbed");
        },
        destroy: async () => {},
      };
    },
  };
}

function asRejected(res: unknown): SourceRejected {
  expect((res as { type: string }).type).toBe("SOURCE_REJECTED");
  return res as SourceRejected;
}

describe("input worker budget gates", () => {
  it("rejects a >25 MiB buffer before opening the engine", async () => {
    const engine = stubEngine(1);
    const res = asRejected(
      await handleOpenSource(pdfBytes(25 * 1024 * 1024 + 1), { engine }),
    );
    expect(res.outcome).toBe("rejected");
    expect(res.reasonCode).toBe("over-limit");
    expect(res.limitLabel).toBe("25 MiB");
    expect(res.pageNumbers).toEqual([]);
    expect(engine.stats().opened).toBe(0);
  });

  it("accepts a buffer exactly at 25 MiB for engine parsing", async () => {
    // The stub engine reports one ordinary page: the size gate must not fire.
    const res = await handleOpenSource(pdfBytes(25 * 1024 * 1024), {
      engine: stubEngine(1),
    });
    expect((res as SourceReady).type).toBe("SOURCE_READY");
  });

  it("rejects 101 pages before extracting any page", async () => {
    const engine = stubEngine(101);
    const res = asRejected(
      await handleOpenSource(pdfBytes(1024), { engine }),
    );
    expect(res.reasonCode).toBe("over-limit");
    expect(res.limitLabel).toBe("100 pages");
    expect(engine.stats().pagesRequested).toBe(0);
  });

  it("rejects an oversized page with its 1-based page number", async () => {
    const res = asRejected(
      await handleOpenSource(pdfBytes(1024), {
        engine: stubEngine(1, { view: [0, 0, 20000, 20000] }),
      }),
    );
    expect(res.reasonCode).toBe("over-limit");
    expect(res.limitLabel).toBe("14,400 points");
    expect(res.pageNumbers).toEqual([1]);
  });

  it("rejects an operator-bomb page with its 1-based page number", async () => {
    const res = asRejected(
      await handleOpenSource(pdfBytes(1024), {
        engine: stubEngine(1, { operators: 2_000_001 }),
      }),
    );
    expect(res.reasonCode).toBe("over-limit");
    expect(res.limitLabel).toBe("2,000,000 operators");
    expect(res.pageNumbers).toEqual([1]);
  });

  it("does not attach a limitLabel to non-budget rejections", async () => {
    const res = asRejected(
      await handleOpenSource(new ArrayBuffer(8), { engine: stubEngine(1) }),
    );
    expect(res.reasonCode).toBe("wrong-type");
    expect("limitLabel" in res).toBe(false);
  });
});

describe("input worker budget gates on real fixtures", () => {
  function realEngine(): InputEngine {
    return createPdfJsEngine(pdfjs, {
      workerSrc: require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    });
  }

  it("rejects the oversize-dimension fixture as over-limit", async () => {
    const res = asRejected(
      await handleOpenSource(fixture("negative/oversize-dimension.pdf"), {
        engine: realEngine(),
      }),
    );
    expect(res.reasonCode).toBe("over-limit");
    expect(res.limitLabel).toBe("14,400 points");
  });

  it("keeps an ordinary document within budget", async () => {
    const res = await handleOpenSource(fixture("text/en-basic.pdf"), {
      engine: realEngine(),
    });
    expect((res as SourceReady).type).toBe("SOURCE_READY");
  });
});
