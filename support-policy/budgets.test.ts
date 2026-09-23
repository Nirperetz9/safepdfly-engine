/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T040 — Budget policy checks, labels, and the budget error.
 *
 * Boundary values are accepted; anything above breaches. Every UX-facing
 * label is a published Plan number — no other numeric limit may appear in
 * user-facing copy.
 */
import { describe, expect, it } from "vitest";
import {
  BUDGET_POLICY,
  BudgetExceededError,
  checkClassifiedPageBudgets,
  checkDecodedImagePixels,
  checkInputSize,
  checkOperatorCount,
  checkPageCount,
  checkPhysicalDimensions,
  limitLabel,
} from "./budgets.js";

describe("budget checks", () => {
  it("input size: 25 MiB passes, one byte over breaches", () => {
    expect(checkInputSize(25 * 1024 * 1024)).toBeNull();
    expect(checkInputSize(25 * 1024 * 1024 + 1)).toBe("input-size");
  });

  it("page count: 100 passes, 101 breaches", () => {
    expect(checkPageCount(100)).toBeNull();
    expect(checkPageCount(101)).toBe("page-count");
  });

  it("page dimension: 14,400 pt passes on both axes, over on either breaches", () => {
    expect(checkPhysicalDimensions(14400, 14400)).toBeNull();
    expect(checkPhysicalDimensions(14401, 100)).toBe("page-dimension");
    expect(checkPhysicalDimensions(100, 14401)).toBe("page-dimension");
  });

  it("operator count: 2,000,000 passes, one over breaches", () => {
    expect(checkOperatorCount(2_000_000)).toBeNull();
    expect(checkOperatorCount(2_000_001)).toBe("operators");
  });

  it("decoded image pixels: 16 MP passes, one pixel over breaches", () => {
    expect(checkDecodedImagePixels(16 * 1024 * 1024)).toBeNull();
    expect(checkDecodedImagePixels(16 * 1024 * 1024 + 1)).toBe(
      "render-surface",
    );
  });
});

describe("limitLabel", () => {
  it("returns the published Plan number for every budget kind", () => {
    expect(limitLabel("input-size")).toBe("25 MiB");
    expect(limitLabel("page-count")).toBe("100 pages");
    expect(limitLabel("render-surface")).toBe("16 megapixels");
    expect(limitLabel("page-dimension")).toBe("14,400 points");
    expect(limitLabel("operators")).toBe("2,000,000 operators");
  });

  it("labels are policy-derived, not hard-coded duplicates", () => {
    expect(limitLabel("input-size")).toContain(
      String(BUDGET_POLICY.maxInputBytes / (1024 * 1024)),
    );
    expect(limitLabel("page-count")).toContain(String(BUDGET_POLICY.maxPages));
  });
});

describe("checkClassifiedPageBudgets", () => {
  const base = {
    pageNumber: 1,
    mediaWidthPt: 595,
    mediaHeightPt: 842,
    maxImagePixels: 0,
  };

  it("accepts an ordinary page", () => {
    expect(checkClassifiedPageBudgets(base)).toBeNull();
  });

  it("flags an oversized physical page with its page number", () => {
    expect(
      checkClassifiedPageBudgets({ ...base, mediaWidthPt: 20000 }),
    ).toEqual({ kind: "page-dimension", pageNumber: 1 });
  });

  it("flags a decoded-image bomb with its page number", () => {
    expect(
      checkClassifiedPageBudgets({ ...base, maxImagePixels: 25_000_000 }),
    ).toEqual({ kind: "render-surface", pageNumber: 1 });
  });

  it("checks dimensions before image pixels", () => {
    expect(
      checkClassifiedPageBudgets({
        ...base,
        mediaWidthPt: 20000,
        maxImagePixels: 25_000_000,
      }),
    ).toEqual({ kind: "page-dimension", pageNumber: 1 });
  });
});

describe("BudgetExceededError", () => {
  it("carries the kind and page number, no document content", () => {
    const err = new BudgetExceededError("operators", 3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BudgetExceededError");
    expect(err.kind).toBe("operators");
    expect(err.pageNumber).toBe(3);
    expect(err.message).not.toContain("3");
  });
});
