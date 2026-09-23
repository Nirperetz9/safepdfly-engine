/**
 * T041 — RenderWorkerClient tests.
 *
 * A fake in-memory worker stands in for the real Web Worker: open/render/
 * close message flow, supersede semantics (only the latest render resolves;
 * stale bitmaps are closed), and idempotent close.
 */
import { describe, expect, it, vi } from "vitest";
import {
  RenderSupersededError,
  RenderWorkerClient,
  type MinimalRenderWorker,
  type RenderedPage,
} from "./render-client.js";
import type { RenderWorkerResponse } from "./render.js";

interface PostedMessage {
  message: unknown;
  transfer?: Transferable[];
}

function fakeBitmap() {
  return { close: vi.fn() } as unknown as ImageBitmap;
}

class FakeWorker implements MinimalRenderWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  terminated = false;
  readonly posted: PostedMessage[] = [];

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
    const m = message as { type?: string };
    if (m.type === "OPEN_RENDERER") {
      queueMicrotask(() =>
        this.onmessage?.({ data: { type: "RENDERER_OPENED" } satisfies RenderWorkerResponse }),
      );
    }
  }

  /** Deliver a PAGE_RENDERED for the given request id. */
  emitRendered(requestId: number): ImageBitmap {
    const bitmap = fakeBitmap();
    this.onmessage?.({
      data: {
        type: "PAGE_RENDERED",
        requestId,
        width: 10,
        height: 10,
        scale: 2,
        bitmap,
      } satisfies RenderWorkerResponse,
    });
    return bitmap;
  }

  emitFailed(requestId: number): void {
    this.onmessage?.({
      data: { type: "RENDER_FAILED", requestId, code: "render_failed" } satisfies RenderWorkerResponse,
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("RenderWorkerClient", () => {
  it("opens by transferring a copy of the bytes", async () => {
    const worker = new FakeWorker();
    const client = new RenderWorkerClient(() => worker);
    const bytes = new ArrayBuffer(8);
    await client.open(bytes);
    expect(worker.posted).toHaveLength(1);
    const posted = worker.posted[0]!.message as { type: string; bytes: ArrayBuffer };
    expect(posted.type).toBe("OPEN_RENDERER");
    // A copy is transferred; the caller's buffer stays usable.
    expect(posted.bytes).not.toBe(bytes);
    expect(bytes.byteLength).toBe(8);
    client.close();
  });

  it("resolves the latest render and supersedes earlier ones", async () => {
    const worker = new FakeWorker();
    const client = new RenderWorkerClient(() => worker);
    await client.open(new ArrayBuffer(8));
    const p1 = client.renderPage(0, 2, 1_000_000);
    const p2 = client.renderPage(1, 2, 1_000_000);
    worker.emitRendered(1); // stale
    worker.emitRendered(2); // latest
    await expect(p1).rejects.toBeInstanceOf(RenderSupersededError);
    const page: RenderedPage = await p2;
    expect(page.width).toBe(10);
    expect(page.scale).toBe(2);
    client.close();
  });

  it("closes stale bitmaps instead of painting them", async () => {
    const worker = new FakeWorker();
    const client = new RenderWorkerClient(() => worker);
    await client.open(new ArrayBuffer(8));
    const p1 = client.renderPage(0, 2, 1_000_000);
    const p2 = client.renderPage(0, 2, 1_000_000);
    const stale = worker.emitRendered(1);
    await expect(p1).rejects.toBeInstanceOf(RenderSupersededError);
    expect(stale.close).toHaveBeenCalled();
    worker.emitRendered(2);
    await p2;
    client.close();
  });

  it("rejects renders with render_failed and closes idempotently", async () => {
    const worker = new FakeWorker();
    const client = new RenderWorkerClient(() => worker);
    await client.open(new ArrayBuffer(8));
    const p = client.renderPage(0, 2, 1_000_000);
    worker.emitFailed(1);
    await expect(p).rejects.toThrow("render failed");
    client.close();
    client.close(); // idempotent
    expect(worker.terminated).toBe(true);
    await expect(client.renderPage(0, 2, 1_000_000)).rejects.toThrow("not open");
  });
});
