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
