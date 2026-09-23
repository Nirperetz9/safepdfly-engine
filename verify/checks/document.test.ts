/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T065 — document check tests: page count, view boxes, rotations, and no
 * newly introduced active/unsupported features, all from fresh dual
 * extraction (source + candidate) in the verification worker.
 */
import { describe, expect, it } from "vitest";
import { runDocumentChecks } from "./document.js";
import type { VerifyCheckContext } from "../handler.js";
import type { VerifyCandidateMessage, ExpectedPage, VerifyDocumentCheck } from "../protocol.js";
import type { VerifyDoc } from "../engine.js";
import { VERIFY_ENGINE_VERSION, VERIFY_POLICY_VERSION } from "../protocol.js";
import type { Sha256Digest } from "../../geometry/index.js";

type Box = readonly [number, number, number, number];

interface FakeDocOpts {
  numPages?: number;
  views?: Record<number, Box>;
  rotates?: Record<number, number>;
  throwOnPage?: ReadonlySet<number>;
  js?: readonly string[];
  attachments?: readonly string[];
  fields?: readonly string[];
  throwOnFeatures?: boolean;
}

function fakeDoc(opts: FakeDocOpts = {}): VerifyDoc {
  return {
    numPages: opts.numPages ?? 1,
    page: async (n: number) => {
      if (opts.throwOnPage?.has(n)) throw new Error("page error");
      return {
        view: opts.views?.[n] ?? ([0, 0, 100, 200] as Box),
        rotate: opts.rotates?.[n] ?? 0,
        textItems: async () => [],
        render: async () => {
          throw new Error("not needed");
        },
        toDevice: () => [0, 0] as const,
      };
    },
    jsActionNames: async () => {
      if (opts.throwOnFeatures) throw new Error("feature error");
      return opts.js ?? [];
    },
    attachmentNames: async () => {
      if (opts.throwOnFeatures) throw new Error("feature error");
      return opts.attachments ?? [];
    },
    fieldNames: async () => {
      if (opts.throwOnFeatures) throw new Error("feature error");
      return opts.fields ?? [];
    },
    close: async () => undefined,
  };
}

function expectedPages(count: number): ExpectedPage[] {
  return Array.from({ length: count }, (_, i) => ({
    page: i,
    view: [0, 0, 100, 200] as Box,
    rotation: 0 as const,
  }));
}

function ctx(
  candidate: VerifyDoc,
  source: VerifyDoc,
  pages = 1,
): VerifyCheckContext {
  const message: VerifyCandidateMessage = {
    type: "VERIFY_CANDIDATE",
    sourceBytes: new ArrayBuffer(4),
    candidateBytes: new ArrayBuffer(8),
    expectedCandidateSha256: "x" as Sha256Digest,
    rects: [],
    expectedPages: expectedPages(pages),
    policy: { engine: VERIFY_ENGINE_VERSION, verify: VERIFY_POLICY_VERSION },
  };
  return { candidate, source, message };
}

function byCheck(checks: readonly VerifyDocumentCheck[], name: string) {
  return checks.filter((c) => c.check === name);
}

describe("runDocumentChecks (T065)", () => {
  it("passes everything when candidate matches source and expectations", async () => {
    const checks = await runDocumentChecks(ctx(fakeDoc(), fakeDoc()));
    expect(checks.every((c) => c.outcome === "pass")).toBe(true);
    expect(checks.every((c) => c.reasonCode.endsWith(".ok"))).toBe(true);
    expect(byCheck(checks, "document.page-count")).toHaveLength(1);
    expect(byCheck(checks, "document.page-view")).toHaveLength(1);
    expect(byCheck(checks, "document.page-rotation")).toHaveLength(1);
  });

  it("fails page count when the candidate lost a page", async () => {
    const checks = await runDocumentChecks(
      ctx(fakeDoc({ numPages: 1 }), fakeDoc({ numPages: 2 }), 2),
    );
    const count = byCheck(checks, "document.page-count")[0]!;
    expect(count.outcome).toBe("fail");
    expect(count.reasonCode).toBe("verify.document.page-count.mismatch");
    // The missing expected page is recorded, not silently skipped.
    const views = byCheck(checks, "document.page-view");
    expect(views.find((c) => "page" in c && c.page === 1)?.reasonCode).toBe(
      "verify.document.page-view.missing",
    );
  });

  it("fails the view check for a page whose box drifted", async () => {
    const candidate = fakeDoc({ views: { 1: [0, 0, 100, 199] } });
    const checks = await runDocumentChecks(ctx(candidate, fakeDoc()));
    const view = byCheck(checks, "document.page-view")[0]!;
    expect(view.outcome).toBe("fail");
    expect(view.reasonCode).toBe("verify.document.page-view.mismatch");
    expect(view.page).toBe(0);
  });

  it("fails the rotation check on a rotated page (normalized)", async () => {
    const candidate = fakeDoc({ rotates: { 1: 450 } }); // 450 normalizes to 90
    const checks = await runDocumentChecks(ctx(candidate, fakeDoc()));
    const rotation = byCheck(checks, "document.page-rotation")[0]!;
    expect(rotation.outcome).toBe("fail");
    expect(rotation.reasonCode).toBe("verify.document.page-rotation.mismatch");
  });

  it("passes rotation when the raw value is an equivalent angle", async () => {
    const candidate = fakeDoc({ rotates: { 1: 360 } });
    const checks = await runDocumentChecks(ctx(candidate, fakeDoc()));
    expect(byCheck(checks, "document.page-rotation")[0]!.outcome).toBe("pass");
  });

  it("fails on a newly introduced JS action", async () => {
    const checks = await runDocumentChecks(
      ctx(fakeDoc({ js: ["Open"] }), fakeDoc()),
    );
    const js = byCheck(checks, "document.js-actions")[0]!;
    expect(js.outcome).toBe("fail");
    expect(js.reasonCode).toBe("verify.document.js-actions.introduced");
  });

  it("passes when the source already had the same JS action (not newly introduced)", async () => {
    const checks = await runDocumentChecks(
      ctx(fakeDoc({ js: ["Open"] }), fakeDoc({ js: ["Open"] })),
    );
    expect(byCheck(checks, "document.js-actions")[0]!.outcome).toBe("pass");
  });

  it("passes when the candidate removed a source feature (removal is not introduction)", async () => {
    const checks = await runDocumentChecks(
      ctx(fakeDoc({ attachments: [] }), fakeDoc({ attachments: ["a.pdf"] })),
    );
    expect(byCheck(checks, "document.attachments")[0]!.outcome).toBe("pass");
  });

  it("fails on a newly introduced attachment and field", async () => {
    const checks = await runDocumentChecks(
      ctx(
        fakeDoc({ attachments: ["b.pdf"], fields: ["form.name"] }),
        fakeDoc(),
      ),
    );
    expect(byCheck(checks, "document.attachments")[0]!.reasonCode).toBe(
      "verify.document.attachments.introduced",
    );
    expect(byCheck(checks, "document.fields")[0]!.reasonCode).toBe(
      "verify.document.fields.introduced",
    );
  });

  it("marks per-page geometry indeterminate when a page cannot be read", async () => {
    const candidate = fakeDoc({ throwOnPage: new Set([1]) });
    const checks = await runDocumentChecks(ctx(candidate, fakeDoc()));
    const view = byCheck(checks, "document.page-view")[0]!;
    const rotation = byCheck(checks, "document.page-rotation")[0]!;
    expect(view.outcome).toBe("indeterminate");
    expect(rotation.outcome).toBe("indeterminate");
  });

  it("marks feature checks indeterminate when the engine cannot answer", async () => {
    const candidate = fakeDoc({ throwOnFeatures: true });
    const checks = await runDocumentChecks(ctx(candidate, fakeDoc()));
    for (const name of [
      "document.js-actions",
      "document.attachments",
      "document.fields",
    ]) {
      const check = byCheck(checks, name)[0]!;
      expect(check.outcome).toBe("indeterminate");
      expect(check.reasonCode.endsWith(".error")).toBe(true);
    }
  });
});
