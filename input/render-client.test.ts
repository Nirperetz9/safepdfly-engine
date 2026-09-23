/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

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
  TextExtractError,
  TextExtractSupersededError,
  type MinimalRenderWorker,
  type RenderedPage,
} from "./render-client.js";
import type { TextItem } from "./protocol.js";
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

  /** Deliver a TEXT_PAGE_EXTRACTED for the given request id. */
  emitTextExtracted(requestId: number, items: TextItem[]): void {
    this.onmessage?.({
      data: {
        type: "TEXT_PAGE_EXTRACTED",
        requestId,
        pageIndex: 1,
        items,
      } satisfies RenderWorkerResponse,
    });
  }

  /** Deliver a TEXT_PAGE_FAILED for the given request id. */
  emitTextFailed(requestId: number, code: "extraction_failed" | "invalid_request"): void {
    this.onmessage?.({
      data: { type: "TEXT_PAGE_FAILED", requestId, code } satisfies RenderWorkerResponse,
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

describe("RenderWorkerClient.findPiiPage (T097)", () => {
  const ITEMS: TextItem[] = [
    { str: "hello", transform: [6, 0, 0, 10, 10, 700], width: 30, hasEOL: false },
  ];

  it("resolves raw text items for a page extraction", async () => {
    const worker = new FakeWorker();
    const client = new RenderWorkerClient(() => worker);
    await client.open(new ArrayBuffer(8));
    const p = client.extractTextPage(0);
    const posted = worker.posted[worker.posted.length - 1]!.message as {
      type: string;
      pageIndex: number;
    };
    expect(posted.type).toBe("EXTRACT_TEXT_PAGE");
    expect(posted.pageIndex).toBe(1); // worker uses 1-based pages
    worker.emitTextExtracted(1, ITEMS);
    await expect(p).resolves.toEqual(ITEMS);
    client.close();
  });

  it("rejects with TextExtractError carrying the worker failure code", async () => {
    const worker = new FakeWorker();
    const client = new RenderWorkerClient(() => worker);
    await client.open(new ArrayBuffer(8));
    const p = client.extractTextPage(0);
    worker.emitTextFailed(1, "extraction_failed");
    const error = await p.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TextExtractError);
    expect((error as TextExtractError).code).toBe("extraction_failed");
    client.close();
  });

  it("supersedes an older extraction when a new one starts", async () => {
    const worker = new FakeWorker();
    const client = new RenderWorkerClient(() => worker);
    await client.open(new ArrayBuffer(8));
    const p1 = client.extractTextPage(0);
    const p2 = client.extractTextPage(1);
    worker.emitTextExtracted(1, ITEMS); // stale
    worker.emitTextExtracted(2, []);
    await expect(p1).rejects.toBeInstanceOf(TextExtractSupersededError);
    await expect(p2).resolves.toEqual([]);
    client.close();
  });

  it("rejects extractions when the client is not open", async () => {
    const worker = new FakeWorker();
    const client = new RenderWorkerClient(() => worker);
    await expect(client.extractTextPage(0)).rejects.toThrow("not open");
    await client.open(new ArrayBuffer(8));
    client.close();
    await expect(client.extractTextPage(0)).rejects.toThrow("not open");
  });
});
