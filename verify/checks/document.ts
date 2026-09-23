/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T065 — Document checks (fresh dual extraction: source + candidate).
 *
 * Every check compares the candidate against the SOURCE reopened in this
 * same worker and against the session's expected page descriptors:
 *  - document.page-count: page count unchanged.
 *  - document.page-view: effective visible box (CropBox ∩ MediaBox) per
 *    page, exact match — a full rewrite must preserve page boxes bit for
 *    bit; any drift is a genuine document change, so this is strict.
 *  - document.page-rotation: /Rotate per page, normalized.
 *  - document.js-actions / .attachments / .fields: no newly introduced
 *    active or unsupported features — the candidate's sets must be subsets
 *    of the source's sets (removal is not introduction).
 *
 * A check that cannot be evaluated (engine error on a page) is
 * indeterminate — ambiguity, never a silent pass. Reason codes are stable
 * keys; raw engine detail never leaves the worker.
 */
import type { VerifyCheckContext } from "../handler.js";
import type { VerifyDocumentCheck } from "../protocol.js";
import type { VerifyDoc } from "../engine.js";

const CODE = {
  pageCount: {
    ok: "verify.document.page-count.ok",
    mismatch: "verify.document.page-count.mismatch",
  },
  pageView: {
    ok: "verify.document.page-view.ok",
    mismatch: "verify.document.page-view.mismatch",
    missing: "verify.document.page-view.missing",
    error: "verify.document.page-view.error",
  },
  pageRotation: {
    ok: "verify.document.page-rotation.ok",
    mismatch: "verify.document.page-rotation.mismatch",
    error: "verify.document.page-rotation.error",
  },
  jsActions: {
    ok: "verify.document.js-actions.ok",
    introduced: "verify.document.js-actions.introduced",
    error: "verify.document.js-actions.error",
  },
  attachments: {
    ok: "verify.document.attachments.ok",
    introduced: "verify.document.attachments.introduced",
    error: "verify.document.attachments.error",
  },
  fields: {
    ok: "verify.document.fields.ok",
    introduced: "verify.document.fields.introduced",
    error: "verify.document.fields.error",
  },
} as const;

function normalizeRotation(degrees: number): number {
  return ((Math.round(degrees) % 360) + 360) % 360;
}

function boxesEqual(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** The names in `introduced` that are not in `baseline`. */
function introduced(
  baseline: readonly string[],
  current: readonly string[],
): string[] {
  const known = new Set(baseline);
  return current.filter((name) => !known.has(name));
}

async function subsetCheck(
  doc: VerifyDoc,
  baseline: VerifyDoc,
  read: (d: VerifyDoc) => Promise<readonly string[]>,
  check: string,
  codes: { ok: string; introduced: string; error: string },
): Promise<VerifyDocumentCheck> {
  try {
    const [before, after] = await Promise.all([read(baseline), read(doc)]);
    const extra = introduced(before, after);
    return extra.length === 0
      ? { check, outcome: "pass", reasonCode: codes.ok }
      : { check, outcome: "fail", reasonCode: codes.introduced };
  } catch {
    return { check, outcome: "indeterminate", reasonCode: codes.error };
  }
}

export async function runDocumentChecks(
  ctx: VerifyCheckContext,
): Promise<VerifyDocumentCheck[]> {
  const { candidate, source, message } = ctx;
  const checks: VerifyDocumentCheck[] = [];

  // Page count: candidate must match the freshly reopened source AND the
  // session's published expectation.
  const countOk =
    candidate.numPages === source.numPages &&
    candidate.numPages === message.expectedPages.length;
  checks.push({
    check: "document.page-count",
    outcome: countOk ? "pass" : "fail",
    reasonCode: countOk ? CODE.pageCount.ok : CODE.pageCount.mismatch,
  });

  // Per-page geometry: view box and rotation for every expected page.
  const pages = Math.min(candidate.numPages, message.expectedPages.length);
  for (let i = 0; i < pages; i += 1) {
    const expected = message.expectedPages[i];
    if (expected === undefined) continue;
    let page;
    try {
      page = await candidate.page(i + 1);
    } catch {
      checks.push({
        check: "document.page-view",
        page: i,
        outcome: "indeterminate",
        reasonCode: CODE.pageView.error,
      });
      checks.push({
        check: "document.page-rotation",
        page: i,
        outcome: "indeterminate",
        reasonCode: CODE.pageRotation.error,
      });
      continue;
    }
    const viewOk = boxesEqual(page.view, expected.view);
    checks.push({
      check: "document.page-view",
      page: i,
      outcome: viewOk ? "pass" : "fail",
      reasonCode: viewOk ? CODE.pageView.ok : CODE.pageView.mismatch,
    });
    const rotationOk =
      normalizeRotation(page.rotate) === normalizeRotation(expected.rotation);
    checks.push({
      check: "document.page-rotation",
      page: i,
      outcome: rotationOk ? "pass" : "fail",
      reasonCode: rotationOk
        ? CODE.pageRotation.ok
        : CODE.pageRotation.mismatch,
    });
  }
  // Expected pages the candidate does not have at all.
  for (let i = pages; i < message.expectedPages.length; i += 1) {
    checks.push({
      check: "document.page-view",
      page: i,
      outcome: "fail",
      reasonCode: CODE.pageView.missing,
    });
  }

  // No newly introduced active/unsupported features (candidate ⊆ source).
  checks.push(
    await subsetCheck(
      candidate,
      source,
      (d) => d.jsActionNames(),
      "document.js-actions",
      CODE.jsActions,
    ),
  );
  checks.push(
    await subsetCheck(
      candidate,
      source,
      (d) => d.attachmentNames(),
      "document.attachments",
      CODE.attachments,
    ),
  );
  checks.push(
    await subsetCheck(
      candidate,
      source,
      (d) => d.fieldNames(),
      "document.fields",
      CODE.fields,
    ),
  );

  return checks;
}
