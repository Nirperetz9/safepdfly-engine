/**
 * T103 — execution-surface static test.
 *
 * Files that arrive with embedded files or document-level JavaScript now
 * reach the review workspace before sanitization, so the whole source
 * tree is pinned to have no execution surface for either:
 *
 *  1. Document JavaScript can never run: MuPDF.js ships with its JS engine
 *     off, and nothing in src may call `enableJS` (or register a JS event
 *     listener). PDF.js never executes document actions during page
 *     rendering — the pinned 6.3.289 bundle has no eval path over document
 *     content, and the only `getJSActions` call in src is the verifier's
 *     read-only name listing.
 *  2. Embedded files can never be opened or extracted: the only readers of
 *     the attachment surface are the classifier facade (presence detection)
 *     and the verifier engine (read-only name listing). Sanitization drops
 *     the name trees from the raw object model without ever extracting
 *     attachment bytes.
 *
 * A regression that wires any execution or extraction path fails the
 * build here, before it can reach a test fixture.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) {
      walk(full, out);
    } else if (
      /\.(ts|tsx)$/.test(name.name) &&
      !name.name.endsWith(".test.ts") &&
      !name.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = walk(join(ROOT, "src"));

function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of SOURCES) {
    const text = readFileSync(file, "utf8");
    if (pattern.test(text)) found.push(relative(ROOT, file));
  }
  return found;
}

describe("execution surface (T103)", () => {
  it("nothing enables the MuPDF.js JavaScript engine", () => {
    expect(hits(/\benableJS\s*\(/)).toEqual([]);
    expect(hits(/\bsetJSEventListener\s*\(/)).toEqual([]);
  });

  it("nothing dispatches or executes document actions", () => {
    expect(hits(/\bexecuteNamedAction\s*\(/)).toEqual([]);
  });

  it("getJSActions is read-only and lives only in the verifier engine", () => {
    expect(hits(/\bgetJSActions\s*\(/)).toEqual(["src/pdf/verify/engine.ts"]);
  });

  it("embedded-file bytes are never opened or extracted", () => {
    // Detection (classifier facade) and read-only name listing (verifier
    // engine) are the only readers of the attachment surface.
    expect(hits(/\bgetEmbeddedFiles\s*\(/)).toEqual([
      "src/pdf/classify-mupdf/readonly-facade.ts",
    ]);
    expect(hits(/\bgetAttachments\s*\(/)).toEqual(["src/pdf/verify/engine.ts"]);
  });

  it("sanitization drops the layers from the object model without extraction", () => {
    const text = readFileSync(
      join(ROOT, "src/pdf/sanitize/sanitize.ts"),
      "utf8",
    );
    for (const key of ["EmbeddedFiles", "JavaScript", "OpenAction", "AA"]) {
      expect(text, key).toContain(`"${key}"`);
    }
    // No byte extraction of attachments anywhere near the sanitize path.
    expect(text).not.toMatch(/getEmbeddedFiles|getAttachments/);
  });
});
