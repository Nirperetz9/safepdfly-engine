/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T061 — Pre-transformation preconditions.
 *
 * 1. Each unmet precondition fails closed before transformation begins,
 *    with its stable code and no document content.
 * 2. Budget math: published limits re-verified, plus the 2x rewrite +
 *    verification headroom against the peak-memory target (boundary values
 *    accepted, anything above breaches).
 * 3. Fingerprint: deterministic; any geometry change alters it.
 * 4. Round-trip: a genuine canonical rect validates; a rect whose context
 *    shifted (or that was never valid) does not.
 */
import { describe, expect, it } from "vitest";
import {
  makeCanonicalRect,
  makePageContext,
} from "../geometry/transforms.js";
import { Brand } from "../geometry/types.js";
import type { CanonicalRect } from "../geometry/types.js";
import { BUDGET_POLICY } from "../support-policy/budgets.js";
import {
  checkTransformBudgets,
  checkTransformPreconditions,
  fingerprintPageGeometry,
  isRoundTripValid,
  type TransformPreconditionInput,
} from "./preconditions.js";

const MIB = 1024 * 1024;

function context() {
  return makePageContext([0, 0, 595, 842], 0, 1);
}

function rect(): CanonicalRect {
  return makeCanonicalRect(Brand.pageIndex(0), 100, 100, 200, 150, context());
}

function fingerprint() {
  return fingerprintPageGeometry({
    mediaBox: [0, 0, 595, 842],
    cropBox: [0, 0, 595, 842],
    rotation: 0,
    userUnit: 1,
  });
}

function goodInput(): TransformPreconditionInput {
  return {
    engineVerdicts: { mupdf: "supported", pdfjs: "supported" },
    rects: [rect()],
    expectedFingerprints: [fingerprint()],
    actualFingerprints: [fingerprint()],
    unsupportedFeatureFound: false,
    sanitizableFindings: [],
    sanitizeApplied: false,
    byteLength: 1024,
    pageCount: 1,
  };
}

describe("checkTransformPreconditions", () => {
  it("passes when every precondition holds", () => {
    expect(checkTransformPreconditions(goodInput())).toEqual({ ok: true });
  });

  it("fails closed when an engine did not classify the input as supported", () => {
    for (const verdicts of [
      { mupdf: "rejected" as const, pdfjs: "supported" as const },
      { mupdf: "supported" as const, pdfjs: "indeterminate" as const },
      { mupdf: "checking" as const, pdfjs: "checking" as const },
    ]) {
      expect(
        checkTransformPreconditions({ ...goodInput(), engineVerdicts: verdicts }),
      ).toEqual({ ok: false, code: "not-supported" });
    }
  });

  it("fails closed when an unsupported feature was discovered", () => {
    expect(
      checkTransformPreconditions({ ...goodInput(), unsupportedFeatureFound: true }),
    ).toEqual({ ok: false, code: "unsupported-feature" });
  });

  it("T103: fails closed when a sanitizable finding stands and sanitization was not applied", () => {
    expect(
      checkTransformPreconditions({
        ...goodInput(),
        sanitizableFindings: ["embedded-files"],
        sanitizeApplied: false,
      }),
    ).toEqual({ ok: false, code: "unsupported-feature" });
  });

  it("T103: passes when sanitization was applied for the standing findings", () => {
    expect(
      checkTransformPreconditions({
        ...goodInput(),
        sanitizableFindings: ["embedded-files", "java-script"],
        sanitizeApplied: true,
      }),
    ).toEqual({ ok: true });
  });

  it("T103: applying sanitization with no findings changes nothing", () => {
    expect(
      checkTransformPreconditions({ ...goodInput(), sanitizeApplied: true }),
    ).toEqual({ ok: true });
  });

  it("fails closed with no rectangles", () => {
    expect(checkTransformPreconditions({ ...goodInput(), rects: [] })).toEqual({
      ok: false,
      code: "no-valid-rectangle",
    });
  });

  it("fails closed when a rectangle is not round-trip-valid", () => {
    // A rect that no longer lies on the visible page (e.g. the page geometry
    // shifted after the selection was made): the round trip breaks.
    const offPage: CanonicalRect = {
      page: Brand.pageIndex(0),
      rect: {
        x0: Brand.pdfPoint(700),
        y0: Brand.pdfPoint(100),
        x1: Brand.pdfPoint(800),
        y1: Brand.pdfPoint(150),
      },
      context: context(),
    };
    expect(isRoundTripValid(offPage)).toBe(false);
    expect(
      checkTransformPreconditions({ ...goodInput(), rects: [offPage] }),
    ).toEqual({ ok: false, code: "no-valid-rectangle" });
  });

  it("fails closed when page fingerprints no longer match", () => {
    expect(
      checkTransformPreconditions({
        ...goodInput(),
        actualFingerprints: [
          fingerprintPageGeometry({
            mediaBox: [0, 0, 595, 842],
            cropBox: [0, 0, 600, 842],
            rotation: 0,
            userUnit: 1,
          }),
        ],
      }),
    ).toEqual({ ok: false, code: "fingerprint-mismatch" });

    expect(
      checkTransformPreconditions({
        ...goodInput(),
        actualFingerprints: [fingerprint(), fingerprint()],
      }),
    ).toEqual({ ok: false, code: "fingerprint-mismatch" });
  });

  it("fails closed when budgets do not permit the rewrite plus verification", () => {
    expect(
      checkTransformPreconditions({
        ...goodInput(),
        byteLength: BUDGET_POLICY.maxInputBytes + 1,
      }),
    ).toEqual({ ok: false, code: "over-limit" });
    expect(
      checkTransformPreconditions({
        ...goodInput(),
        pageCount: BUDGET_POLICY.maxPages + 1,
      }),
    ).toEqual({ ok: false, code: "over-limit" });
  });

  it("carries no document content in the failure", () => {
    const result = checkTransformPreconditions({
      ...goodInput(),
      actualFingerprints: ["changed"],
    });
    expect(JSON.stringify(result).includes("595")).toBe(false);
  });
});

describe("checkTransformBudgets math", () => {
  it("accepts boundary values, rejects anything above", () => {
    expect(
      checkTransformBudgets(BUDGET_POLICY.maxInputBytes, BUDGET_POLICY.maxPages),
    ).toBe(null);
    expect(checkTransformBudgets(BUDGET_POLICY.maxInputBytes + 1, 1)).toBe(
      "over-limit",
    );
    expect(checkTransformBudgets(1024, BUDGET_POLICY.maxPages + 1)).toBe(
      "over-limit",
    );
  });

  it("the published limits leave headroom for rewrite + verification", () => {
    // Structural invariant: even the largest admissible input, doubled
    // (input + candidate co-resident during the rewrite), stays within the
    // peak-memory target. Raising maxInputBytes must revisit this.
    expect(BUDGET_POLICY.maxInputBytes * 2).toBeLessThanOrEqual(
      BUDGET_POLICY.peakMemoryTargetMiB * MIB,
    );
  });
});

describe("fingerprintPageGeometry", () => {
  it("is deterministic for identical geometry", () => {
    expect(fingerprintPageGeometry({
      mediaBox: [0, 0, 595, 842],
      cropBox: [0, 0, 595, 842],
      rotation: 0,
      userUnit: 1,
    })).toBe(fingerprint());
  });

  it("changes when any geometric invariant changes", () => {
    const base = {
      mediaBox: [0, 0, 595, 842] as const,
      cropBox: [0, 0, 595, 842] as const,
      rotation: 0,
      userUnit: 1,
    };
    const variants = [
      { ...base, rotation: 90 },
      { ...base, userUnit: 2 },
      { ...base, cropBox: [0, 0, 595, 841] as const },
      { ...base, mediaBox: [0, 0, 596, 842] as const },
    ];
    for (const v of variants) {
      expect(fingerprintPageGeometry(v)).not.toBe(fingerprint());
    }
  });
});

describe("isRoundTripValid", () => {
  it("accepts a genuine canonical rect", () => {
    expect(isRoundTripValid(rect())).toBe(true);
  });

  it("accepts a rotated-context rect", () => {
    const ctx = makePageContext([0, 0, 595, 842], 90, 1);
    const r = makeCanonicalRect(Brand.pageIndex(0), 100, 100, 200, 150, ctx);
    expect(isRoundTripValid(r)).toBe(true);
  });

  it("rejects a rect that lies outside the visible page", () => {
    const offPage: CanonicalRect = {
      page: Brand.pageIndex(0),
      rect: {
        x0: Brand.pdfPoint(700),
        y0: Brand.pdfPoint(100),
        x1: Brand.pdfPoint(800),
        y1: Brand.pdfPoint(150),
      },
      context: context(),
    };
    expect(isRoundTripValid(offPage)).toBe(false);
  });
});
