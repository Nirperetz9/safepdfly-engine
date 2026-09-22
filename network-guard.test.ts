/**
 * T027 validation — throwing-spy tests in UI-like and worker-like contexts.
 * After installNetworkGuard, every network API throws synchronously, and the
 * guard cannot be bypassed by processing code.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { installNetworkGuard, isNetworkGuardActive } from "./network-guard.js";

function workerLikeScope(): Record<string, unknown> {
  return {
    fetch: () => Promise.resolve("should-not-happen"),
    XMLHttpRequest: class {},
    WebSocket: class {},
    EventSource: class {},
    importScripts: () => {},
    navigator: { sendBeacon: () => true },
  };
}

describe("network guard", () => {
  it("blocks every network API in a worker-like scope", () => {
    const scope = workerLikeScope();
    installNetworkGuard(scope);
    expect(() => (scope["fetch"] as () => unknown)()).toThrow(/network access is disabled/);
    expect(() => new (scope["XMLHttpRequest"] as new () => unknown)()).toThrow(/blocked: XMLHttpRequest/);
    expect(() => new (scope["WebSocket"] as new () => unknown)()).toThrow(/blocked: WebSocket/);
    expect(() => new (scope["EventSource"] as new () => unknown)()).toThrow(/blocked: EventSource/);
    expect(() => (scope["importScripts"] as () => unknown)()).toThrow(/blocked: importScripts/);
    expect(() =>
      (scope["navigator"] as { sendBeacon: () => boolean }).sendBeacon(),
    ).toThrow(/blocked: sendBeacon/);
    expect(isNetworkGuardActive(scope)).toBe(true);
  });

  it("cannot be bypassed by reassigning from processing code", () => {
    const scope = workerLikeScope();
    installNetworkGuard(scope);
    // The properties are non-writable, non-configurable: reassignment fails.
    expect(() => {
      "use strict";
      (scope as Record<string, unknown>)["fetch"] = () => Promise.resolve("evil");
    }).toThrow();
    expect(isNetworkGuardActive(scope)).toBe(true);
  });

  it("is idempotent: installing twice still blocks", () => {
    const scope = workerLikeScope();
    installNetworkGuard(scope);
    installNetworkGuard(scope);
    expect(isNetworkGuardActive(scope)).toBe(true);
  });

  it("works on the real UI global scope (jsdom)", () => {
    installNetworkGuard();
    expect(isNetworkGuardActive()).toBe(true);
    expect(() => globalThis.fetch("https://example.com")).toThrow(/network access is disabled/);
    expect(() => new WebSocket("wss://example.com")).toThrow(/blocked: WebSocket/);
    expect(() => new EventSource("https://example.com")).toThrow(/blocked: EventSource/);
    // No restore: vitest isolates each test file in its own jsdom global,
    // and the production install happens once at app startup, never undone.
  });
});
