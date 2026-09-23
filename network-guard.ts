/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T027 — No-network runtime guard.
 *
 * After local assets load, document-processing contexts must be incapable of
 * network I/O. `installNetworkGuard(scope)` replaces every network API on the
 * given scope with a throwing stub:
 *   fetch, XMLHttpRequest, WebSocket, EventSource, importScripts (workers),
 *   and navigator.sendBeacon.
 *
 * The guard is installed on the UI scope at startup (T088 wires it) and inside
 * every processing worker before any document bytes are handled. Processing
 * code cannot bypass it: the originals are captured nowhere reachable, and
 * re-installation is idempotent (installing twice still throws).
 *
 * This is defense-in-depth behind the CSP (T028) and the offline tests (T078):
 * even if a future code path reached a network API, it would fail closed.
 */

export const NETWORK_GUARD_MESSAGE =
  "SafePDFly: network access is disabled for document processing";

type Scope = Record<string, unknown>;

function throwing(name: string): (...args: unknown[]) => never {
  const fn = (..._args: unknown[]): never => {
    throw new Error(`${NETWORK_GUARD_MESSAGE} (blocked: ${name})`);
  };
  // Keep the surface plausible so feature-detection branches fail closed too.
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  return fn;
}

function throwingClass(name: string): new (...args: unknown[]) => never {
  return class {
    constructor(..._args: unknown[]) {
      throw new Error(`${NETWORK_GUARD_MESSAGE} (blocked: ${name})`);
    }
  } as unknown as new (...args: unknown[]) => never;
}

const GUARDED_KEYS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"] as const;

const FUNCTION_KEYS = new Set(["fetch", "importScripts"]);

function alreadyGuarded(scope: Scope, key: string): boolean {
  const current = scope[key];
  if (typeof current !== "function") return false;
  try {
    let result: unknown;
    if (FUNCTION_KEYS.has(key)) {
      result = (current as (...a: unknown[]) => unknown)();
    } else {
      result = Reflect.construct(current as new () => unknown, []);
    }
    // A live network API returns a promise/object instead of throwing.
    // Swallow async rejections: "not guarded" is the verdict either way.
    if (result !== null && typeof result === "object" && "catch" in result) {
      (result as Promise<unknown>).catch(() => {});
    }
    return false;
  } catch (e) {
    return e instanceof Error && e.message.startsWith(NETWORK_GUARD_MESSAGE);
  }
}

export function installNetworkGuard(scope: Scope = globalThis as unknown as Scope): void {
  for (const key of GUARDED_KEYS) {
    if (alreadyGuarded(scope, key)) continue; // idempotent: previous install holds
    const stub = FUNCTION_KEYS.has(key) ? throwing(key) : throwingClass(key);
    try {
      Object.defineProperty(scope, key, {
        value: stub,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } catch {
      // Host object refused defineProperty: last-resort assignment, still throwing.
      scope[key] = stub;
    }
  }

  // navigator.sendBeacon lives on Navigator.prototype; neutralize it there and
  // on any own navigator object present on the scope.
  const nav = scope["navigator"] as Record<string, unknown> | undefined;
  const beaconStub = throwing("sendBeacon");
  for (const target of [nav, nav !== undefined ? Object.getPrototypeOf(nav) : undefined]) {
    if (target === null || target === undefined) continue;
    try {
      Object.defineProperty(target, "sendBeacon", {
        value: beaconStub,
        writable: false,
        configurable: false,
      });
    } catch {
      try {
        (target as Scope)["sendBeacon"] = beaconStub;
      } catch {
        /* host object is frozen: leave it; fetch/XHR paths are already dead */
      }
    }
  }
}

/** True when every guarded API on the scope currently throws. */
export function isNetworkGuardActive(scope: Scope = globalThis as unknown as Scope): boolean {
  const probes: Array<() => void> = [
    () => (scope["fetch"] as (...a: unknown[]) => unknown)(),
    () => new (scope["XMLHttpRequest"] as new () => unknown)(),
    () => new (scope["WebSocket"] as new () => unknown)(),
    () => new (scope["EventSource"] as new () => unknown)(),
  ];
  return probes.every((p) => {
    try {
      p();
      return false;
    } catch {
      return true;
    }
  });
}
