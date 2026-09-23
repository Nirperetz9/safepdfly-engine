/**
 * Shared test helpers for the redact path. Test-only; not imported by
 * product code.
 *
 * Fixture note (T074): the corpus lives at src/test/fixtures/ (committed,
 * synthetic only). The Phase 1 prototype fixtures under
 * prototypes/engine-validation/fixtures/ were copied there verbatim;
 * prototypes/ is never read anymore.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TransformRect } from "./protocol.js";

export const redactDir = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = join(redactDir, "..", "..", "test", "fixtures");
export const workersDir = join(redactDir, "..", "..", "app", "workers");

interface ManifestEntry {
  rects?: { page: number; rect: [number, number, number, number] }[];
  must_remove?: string[];
  must_keep?: string[];
}
export const manifest = JSON.parse(
  readFileSync(join(fixturesDir, "manifest.json"), "utf8"),
) as Record<string, ManifestEntry>;

/** Read a fixture PDF as a caller-owned ArrayBuffer. */
export function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(fixturesDir, name));
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/** Manifest viewport rects for a fixture, in TransformRect form. */
export function manifestRects(name: string): TransformRect[] {
  const entry = manifest[name];
  if (!entry?.rects) throw new Error(`no rects for ${name}`);
  return entry.rects.map((r) => ({
    page: r.page,
    x0: r.rect[0],
    y0: r.rect[1],
    x1: r.rect[2],
    y1: r.rect[3],
  }));
}

/**
 * Non-test sources in a directory, with comments stripped so prose may
 * discuss a forbidden concept while code may never contain it.
 */
export function sourcesIn(
  dir: string,
  prefix?: string,
): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter(
      (n) =>
        n.endsWith(".ts") &&
        !n.endsWith(".test.ts") &&
        n !== "test-utils.ts" &&
        (!prefix || n.startsWith(prefix)),
    )
    .map((n) => ({
      name: n,
      text: readFileSync(join(dir, n), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1"),
    }));
}

/** Count %%EOF markers: exactly 1 means a single-revision full rewrite. */
export function eofCount(bytes: ArrayBuffer): number {
  return (
    Buffer.from(bytes).toString("latin1").split("%%EOF").length - 1
  );
}
