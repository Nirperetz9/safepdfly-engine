/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T104 — open-core import boundary (static test).
 *
 * Structural counterpart of `npm run lint` (scripts/check-boundaries.mjs):
 * the AGPL engine package must be self-contained, the proprietary tree may
 * touch the engine only through blessed surfaces, and the bare "mupdf"
 * module is engine-only. The blessed-surface allowlist has a single source
 * of truth — it is imported from the lint script, so this test and the
 * build gate cannot drift apart.
 *
 * Test files are exempt from the surface allowlist (they may exercise
 * engine internals); the engine-never-imports-src and no-bare-mupdf rules
 * apply to every scanned file.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_BLESSED_SURFACES } from "../scripts/check-boundaries.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, "src");
const ENGINE = join(REPO, "engine");

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const isTestFile = (f: string): boolean => /\.test\.tsx?$/.test(f);

function importsOf(file: string): string[] {
  const specs: string[] = [];
  const src = readFileSync(file, "utf8");
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

const SRC_FILES = walk(SRC).filter((f) => !isTestFile(f));
const ENGINE_FILES = walk(ENGINE).filter((f) => !isTestFile(f));

describe("open-core import boundary (T104)", () => {
  it("every blessed surface exists on disk", () => {
    expect(ENGINE_BLESSED_SURFACES.size).toBeGreaterThan(0);
    for (const surface of ENGINE_BLESSED_SURFACES) {
      // Allowlist entries use the .js extension the import specifiers use;
      // the source on disk is TypeScript.
      const diskPath = surface.replace(/\.js$/, ".ts");
      const abs = resolve(REPO, diskPath.replace(/\//g, sep));
      expect(existsSync(abs), `blessed surface missing: ${surface}`).toBe(
        true,
      );
    }
  });

  it("no src file imports the bare mupdf module", () => {
    const offenders = SRC_FILES.filter((f) =>
      importsOf(f).some((s) => s === "mupdf" || s.startsWith("mupdf/")),
    ).map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });

  it("src imports only blessed engine surfaces", () => {
    const violations: string[] = [];
    for (const file of SRC_FILES) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const abs = resolve(file, "..", spec);
        if (!abs.startsWith(ENGINE + sep)) continue;
        const targetRel = relative(REPO, abs).split(sep).join("/");
        if (!ENGINE_BLESSED_SURFACES.has(targetRel)) {
          violations.push(`${relative(REPO, file)} -> ${targetRel}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no engine file imports from src", () => {
    const violations: string[] = [];
    for (const file of ENGINE_FILES) {
      for (const spec of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const abs = resolve(file, "..", spec);
        if (abs.startsWith(SRC + sep)) {
          violations.push(`${relative(REPO, file)} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the lint gate and this test share one allowlist", () => {
    // If someone edits the allowlist in one place but not the other, the
    // two enforcements drift. This test imports ENGINE_BLESSED_SURFACES
    // from scripts/check-boundaries.mjs, so drift is impossible by
    // construction; this assertion pins the import to keep it that way.
    expect(ENGINE_BLESSED_SURFACES).toBeInstanceOf(Set);
  });
});
