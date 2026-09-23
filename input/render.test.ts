/**
 * T041 — Render worker protocol tests.
 *
 * The handler is exercised with a stub engine: open/render/close lifecycle,
 * fail-closed validation (bad scale, bad page, unknown message, render
 * error), and the pixel-budget clamp that closes oversized bitmaps instead
 * of transferring them.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createRenderHandler,
  RENDER_POLICY_VERSION,
  type RenderWorkerRequest,
} from "./render.js";
import type { InputEngine, InputEngineDoc } from "./engine.js";

function fakeBitmap() {
  return { close: vi.fn(), width: 10, height: 10 } as unknown as ImageBitmap;
}

function stubEngine(opts: { failRender?: boolean; pages?: number } = {}): InputEngine {
  const doc: InputEngineDoc = {
    numPages: opts.pages ?? 3,
    page: async () => {
      throw new Error("not used");
    },
    renderPage: async () => {
      if (opts.failRender) throw new Error("engine boom");
      return { bitmap: fakeBitmap(), width: 10, height: 10 };
    },
    destroy: async () => {},
  };
  return { name: "pdfjs", version: "stub", open: async () => doc };
}

function handler(engine?: InputEngine) {
  return createRenderHandler({ engine: engine ?? stubEngine() });
}

const OPEN: RenderWorkerRequest = { type: "OPEN_RENDERER", policyVersion: RENDER_POLICY_VERSION };

describe("render worker protocol", () => {
  it("opens, renders, and closes", async () => {
    const h = handler();
    expect(await h.dispatch(OPEN, new ArrayBuffer(8))).toEqual({ type: "RENDERER_OPENED" });
    const res = await h.dispatch(
      { type: "RENDER_PAGE", requestId: 1, pageIndex: 2, scale: 2, maxPixels: 1_000_000 },
      undefined,
    );
    expect(res.type).toBe("PAGE_RENDERED");
    if (res.type === "PAGE_RENDERED") {
      expect(res.requestId).toBe(1);
      expect(res.scale).toBe(2);
    }
    expect(await h.dispatch({ type: "CLOSE_RENDERER" }, undefined)).toEqual({
      type: "RENDERER_CLOSED",
    });
  });

  it("fails closed on policy version mismatch and empty bytes", async () => {
    const h = handler();
    expect(
      await h.dispatch({ type: "OPEN_RENDERER", policyVersion: 999 }, new ArrayBuffer(8)),
    ).toMatchObject({ type: "RENDER_FAILED", code: "invalid_request" });
    expect(await h.dispatch(OPEN, new ArrayBuffer(0))).toMatchObject({
      type: "RENDER_FAILED",
      code: "invalid_request",
    });
  });

  it("rejects renders before open and after close", async () => {
    const h = handler();
    expect(
      await h.dispatch({ type: "RENDER_PAGE", requestId: 1, pageIndex: 1, scale: 1, maxPixels: 1000 }, undefined),
    ).toMatchObject({ type: "RENDER_FAILED", code: "not_open" });
    await h.dispatch(OPEN, new ArrayBuffer(8));
    await h.dispatch({ type: "CLOSE_RENDERER" }, undefined);
    expect(
      await h.dispatch({ type: "RENDER_PAGE", requestId: 2, pageIndex: 1, scale: 1, maxPixels: 1000 }, undefined),
    ).toMatchObject({ type: "RENDER_FAILED", code: "closed" });
  });

  it("rejects out-of-range pages and scales", async () => {
    const h = handler();
    await h.dispatch(OPEN, new ArrayBuffer(8));
    const bad: RenderWorkerRequest[] = [
      { type: "RENDER_PAGE", requestId: 1, pageIndex: 0, scale: 1, maxPixels: 1000 },
      { type: "RENDER_PAGE", requestId: 2, pageIndex: 4, scale: 1, maxPixels: 1000 },
      { type: "RENDER_PAGE", requestId: 3, pageIndex: 1, scale: 0, maxPixels: 1000 },
      { type: "RENDER_PAGE", requestId: 4, pageIndex: 1, scale: 100, maxPixels: 1000 },
      { type: "RENDER_PAGE", requestId: 5, pageIndex: 1, scale: 1, maxPixels: -1 },
    ];
    for (const m of bad) {
      expect(await h.dispatch(m, undefined)).toMatchObject({
        type: "RENDER_FAILED",
        code: "invalid_request",
      });
    }
  });

  it("closes oversized bitmaps instead of transferring them", async () => {
    const close = vi.fn();
    const engine = stubEngine();
    const h = createRenderHandler({
      engine: {
        ...engine,
        open: async () => ({
          numPages: 1,
          page: async () => {
            throw new Error("not used");
          },
          renderPage: async () => ({
            bitmap: { close } as unknown as ImageBitmap,
            width: 100,
            height: 100,
          }),
          destroy: async () => {},
        }),
      },
    });
    await h.dispatch(OPEN, new ArrayBuffer(8));
    const res = await h.dispatch(
      { type: "RENDER_PAGE", requestId: 1, pageIndex: 1, scale: 1, maxPixels: 9999 },
      undefined,
    );
    expect(res).toMatchObject({ type: "RENDER_FAILED", code: "invalid_request" });
    expect(close).toHaveBeenCalled();
  });

  it("maps engine errors to render_failed without leaking details", async () => {
    const h = handler(stubEngine({ failRender: true }));
    await h.dispatch(OPEN, new ArrayBuffer(8));
    const res = await h.dispatch(
      { type: "RENDER_PAGE", requestId: 1, pageIndex: 1, scale: 1, maxPixels: 1_000_000 },
      undefined,
    );
    expect(res).toMatchObject({ type: "RENDER_FAILED", code: "render_failed" });
    expect(JSON.stringify(res)).not.toContain("boom");
  });

  it("fails closed on unknown messages", async () => {
    const h = handler();
    expect(
      await h.dispatch({ type: "BOGUS" } as unknown as RenderWorkerRequest, undefined),
    ).toMatchObject({ type: "RENDER_FAILED", code: "invalid_request" });
  });
});

describe("FIND_PII_PAGE (T097)", () => {
  function textItem(str: string, x: number, y: number): {
    str: string;
    transform: [number, number, number, number, number, number];
    width: number;
    hasEOL: boolean;
  } {
    return { str, transform: [6, 0, 0, 10, x, y], width: str.length * 6, hasEOL: false };
  }

  function piiHandler(
    pages: Array<ReturnType<typeof textItem>[]>,
    opts: { failText?: boolean } = {},
  ) {
    const doc: InputEngineDoc = {
      numPages: pages.length,
      page: async (n: number) => ({
        rotate: 0,
        userUnit: 1,
        view: [0, 0, 612, 792] as const,
        hasNonWhitespaceText: async () => true,
        countOperators: async () => 0,
        textItems: async () => {
          if (opts.failText) throw new Error("engine boom");
          return pages[n - 1] ?? [];
        },
      }),
      renderPage: async () => {
        throw new Error("not used");
      },
      destroy: async () => {},
    };
    const engine: InputEngine = { name: "pdfjs", version: "stub", open: async () => doc };
    return createRenderHandler({ engine });
  }

  const SCAN = (pageIndex: number, kinds: readonly string[] = ["id-number"]) =>
    ({
      type: "FIND_PII_PAGE",
      requestId: 7,
      pageIndex,
      kinds,
    }) as unknown as RenderWorkerRequest;

  it("returns candidate geometry for a matching page", async () => {
    const h = piiHandler([[textItem("תעודת זהות: 123456782.", 10, 700)]]);
    await h.dispatch(OPEN, new ArrayBuffer(8));
    const res = await h.dispatch(SCAN(1), undefined);
    expect(res.type).toBe("PII_PAGE_FOUND");
    if (res.type !== "PII_PAGE_FOUND") return;
    expect(res.requestId).toBe(7);
    expect(res.pageIndex).toBe(1);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]!.kind).toBe("id-number");
    // Geometry only: the matched value itself never crosses the boundary.
    expect(JSON.stringify(res)).not.toContain("123456782");
    const c = res.candidates[0]!;
    expect(c.x1).toBeGreaterThan(c.x0);
    expect(c.y1).toBeGreaterThan(c.y0);
  });

  it("returns no candidates when nothing matches", async () => {
    const h = piiHandler([[textItem("no personal details here", 10, 700)]]);
    await h.dispatch(OPEN, new ArrayBuffer(8));
    const res = await h.dispatch(SCAN(1), undefined);
    expect(res).toMatchObject({ type: "PII_PAGE_FOUND", candidates: [] });
  });

  it("fails closed with no_text_layer when the page has no usable text", async () => {
    const h = piiHandler([[textItem("   ", 10, 700)]]);
    await h.dispatch(OPEN, new ArrayBuffer(8));
    const res = await h.dispatch(SCAN(1), undefined);
    expect(res).toMatchObject({ type: "PII_PAGE_FAILED", code: "no_text_layer" });
  });

  it("fails closed with extraction_failed when text extraction throws", async () => {
    const h = piiHandler([[]], { failText: true });
    await h.dispatch(OPEN, new ArrayBuffer(8));
    const res = await h.dispatch(SCAN(1), undefined);
    expect(res).toMatchObject({ type: "PII_PAGE_FAILED", code: "extraction_failed" });
    expect(JSON.stringify(res)).not.toContain("boom");
  });

  it("fails closed on bad page numbers and bad kind lists", async () => {
    const h = piiHandler([[textItem("hello", 10, 700)]]);
    await h.dispatch(OPEN, new ArrayBuffer(8));
    expect(await h.dispatch(SCAN(0), undefined)).toMatchObject({
      type: "PII_PAGE_FAILED",
      code: "invalid_request",
    });
    expect(await h.dispatch(SCAN(5), undefined)).toMatchObject({
      type: "PII_PAGE_FAILED",
      code: "invalid_request",
    });
    expect(await h.dispatch(SCAN(1, []), undefined)).toMatchObject({
      type: "PII_PAGE_FAILED",
      code: "invalid_kinds",
    });
    expect(await h.dispatch(SCAN(1, ["ssn"]), undefined)).toMatchObject({
      type: "PII_PAGE_FAILED",
      code: "invalid_kinds",
    });
  });

  it("fails closed before open and after close", async () => {
    const h = piiHandler([[textItem("hello", 10, 700)]]);
    expect(await h.dispatch(SCAN(1), undefined)).toMatchObject({
      type: "PII_PAGE_FAILED",
      code: "not_open",
    });
    await h.dispatch(OPEN, new ArrayBuffer(8));
    await h.dispatch({ type: "CLOSE_RENDERER" }, undefined);
    expect(await h.dispatch(SCAN(1), undefined)).toMatchObject({
      type: "PII_PAGE_FAILED",
      code: "closed",
    });
  });
});
