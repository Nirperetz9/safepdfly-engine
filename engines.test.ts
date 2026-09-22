/**
 * T084 — Engine pin enforcement.
 *
 * The transformation engine (MuPDF.js) and the independent
 * rendering/input/verifier engine (PDF.js) are pinned to the exact versions
 * validated in Phase 1 (T021). This test fails the build if:
 * - package.json declares anything but the exact pin (no ^, ~, ranges),
 * - the installed node_modules copy differs from the pin,
 * - package-lock.json records a different resolved version.
 *
 * Any pin change requires rerunning the full validation matrix per
 * docs/governance/engine-pins.md.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const PINS: Record<string, string> = {
  mupdf: "1.28.1",
  "pdfjs-dist": "6.3.289",
};

function pkg(subpath: string): { version: string } & Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, subpath), "utf-8"));
}

describe("engine pins", () => {
  it("package.json declares the exact validated pins (no ranges)", () => {
    const { dependencies } = pkg("package.json") as unknown as { dependencies: Record<string, string> };
    for (const [name, pin] of Object.entries(PINS)) {
      expect(dependencies[name], name).toBe(pin);
    }
  });

  it("installed node_modules copies match the pins", () => {
    for (const [name, pin] of Object.entries(PINS)) {
      expect(pkg(join("node_modules", name, "package.json")).version, name).toBe(pin);
    }
  });

  it("package-lock.json resolves the pins", () => {
    const lock = pkg("package-lock.json") as unknown as { packages: Record<string, { version: string }> };
    for (const [name, pin] of Object.entries(PINS)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(pin);
    }
  });

  it("MuPDF.js ships its WASM payload locally (no CDN fetch at runtime)", () => {
    expect(pkg("node_modules/mupdf/package.json").version).toBe("1.28.1");
    // The WASM binary travels with the npm payload (dist/mupdf-wasm.wasm);
    // the app must serve it same-origin (worker-src 'self' blob:) — never
    // from a CDN.
    expect(existsSync(join(root, "node_modules", "mupdf", "dist", "mupdf-wasm.wasm"))).toBe(true);
  });
});
