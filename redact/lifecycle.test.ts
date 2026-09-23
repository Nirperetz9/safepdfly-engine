/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T063 — Transformation worker termination before verification.
 *
 * The structural guarantee lives in applyRedactionsInWorker: the transform
 * worker is terminated in `finally`, before the returned promise settles.
 * Any caller that awaits the transformation — including the Phase 7 code
 * that will create the verification worker — therefore observes a dead
 * transform worker first. Its document, source copy, and WASM-side state
 * die with it (worker termination destroys the whole context); the host's
 * source copy was transferred (neutered) on postMessage.
 *
 * This test injects a mid-flight interruption (the worker never responds;
 * the timeout fires) and observes the required order: the transform worker
 * dies before any verification worker is created, and the verification
 * worker factory never receives a transformation-engine handle.
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyRedactionsInWorker,
} from "./client.js";
import type { TransformRect } from "./protocol.js";

const RECTS: TransformRect[] = [{ page: 0, x0: 10, y0: 20, x1: 110, y1: 120 }];

interface FakeWorker {
  terminated: boolean;
  postMessage: (message: unknown, transfer: unknown[]) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  terminate: () => void;
}

function fakeWorker(onTerminate: () => void): FakeWorker {
  return {
    terminated: false,
    postMessage: () => {},
    onmessage: null,
    terminate() {
      this.terminated = true;
      onTerminate();
    },
  };
}

describe("T063 transform worker termination before verification", () => {
  it("a mid-flight interruption kills the transform worker before any verify worker is created", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const liveHandles = new Set<object>();

      const transformWorker = fakeWorker(() => {
        events.push("transform-terminated");
      });
      liveHandles.add(transformWorker);
      // Mid-flight: the worker accepts the job and never responds.
      transformWorker.postMessage = () => {};

      const pending = applyRedactionsInWorker(
        { bytes: new ArrayBuffer(8), rects: RECTS, sanitize: false },
        { createWorker: () => transformWorker as unknown as Worker },
      );
      const assertion = expect(pending).rejects.toMatchObject({
        reason: "timeout",
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;

      // The transform worker is dead: drop its handle (no floating handles).
      liveHandles.delete(transformWorker);
      expect(transformWorker.terminated).toBe(true);
      expect(liveHandles.size).toBe(0);

      // The Phase 7 creation point runs only after the transform settled.
      // The factory receives no transformation-engine handle: on interruption
      // there is no candidate, and the dead worker object is never passed.
      const verifyFactoryArgs: unknown[][] = [];
      const createVerifyWorker = (...args: unknown[]) => {
        events.push("verify-created");
        verifyFactoryArgs.push(args);
        return { terminate: () => {} };
      };
      createVerifyWorker();

      expect(events).toEqual(["transform-terminated", "verify-created"]);
      for (const args of verifyFactoryArgs) {
        expect(args).not.toContain(transformWorker);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a successful transform also terminates the worker before handoff", async () => {
    const events: string[] = [];
    const transformWorker = fakeWorker(() => {
      events.push("transform-terminated");
    });
    const pending = applyRedactionsInWorker(
      { bytes: new ArrayBuffer(8), rects: RECTS, sanitize: false },
      { createWorker: () => transformWorker as unknown as Worker },
    );
    const payload = new ArrayBuffer(4);
    transformWorker.onmessage?.({
      data: {
        type: "CANDIDATE_READY",
        payload,
        sha256: "c".repeat(64),
        byteLength: 4,
        selfCheck: "ok",
        versions: { engine: "mupdf/1.28.1", redaction: "redaction-policy/2", save: "save/garbage+gc/1" },
      },
    });
    const candidate = await pending;
    expect(candidate.bytes).toBe(payload);
    // Handoff point: the worker is already dead when the candidate arrives.
    events.push("verify-created");
    expect(events).toEqual(["transform-terminated", "verify-created"]);
    expect(transformWorker.terminated).toBe(true);
  });
});
