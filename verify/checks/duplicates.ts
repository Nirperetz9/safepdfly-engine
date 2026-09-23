/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T068 — duplicate-occurrence warning (selection scope).
 *
 * The selected value is derived from the SOURCE document: the normalized
 * text of the source's text items intersecting the marked rectangle. The
 * CANDIDATE is then searched for that exact value (after normalization)
 * at UNMARKED locations — candidate text items intersecting any marked
 * rectangle on the page are excluded from the search. A surviving copy
 * means the user marked one occurrence of a value that exists elsewhere;
 * only the marked occurrence was removed.
 *
 * The warning identifies page and mark numbers only — never content.
 * This check never fails verification: it is advisory. It is also
 * independent of the removal checks: a selection that still shows its
 * text inside the mark fails those; this warns about the rest.
 */

import type { VerifyCheckContext } from "../handler.js";
import type { VerifyRect, VerifyWarning } from "../protocol.js";
import type { VerifyPage, VerifyTextItem } from "../engine.js";
import {
  boxesOverlap,
  hasVisibleText,
  normalizeTextValue,
  textItemBox,
  type TextBox,
} from "./text.js";

function rectRegion(rect: VerifyRect): TextBox {
  return {
    x0: Math.min(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1),
    x1: Math.max(rect.x0, rect.x1),
    y1: Math.max(rect.y0, rect.y1),
  };
}

/**
 * The selected value: normalized text of the source items intersecting the
 * mark, joined in content order. Item granularity: a text item that merely
 * overlaps the mark contributes its whole string — the value is exact at
 * item level, not character level. Empty when the mark covered no readable
 * text (nothing to warn about).
 */
export function selectedValueForRect(
  sourceItems: readonly VerifyTextItem[],
  rect: VerifyRect,
): string {
  const region = rectRegion(rect);
  const parts: string[] = [];
  for (const item of sourceItems) {
    if (!hasVisibleText(item.str)) continue;
    const box = textItemBox(item);
    if (box === null) continue;
    if (boxesOverlap(box, region)) parts.push(item.str);
  }
  // Space-joined: separate text items are separate runs, and the
  // normalization collapses any doubling. Both sides build values the
  // same way, so the comparison stays consistent.
  return normalizeTextValue(parts.join(" "));
}

/**
 * Normalized candidate page text EXCLUDING every marked rectangle on that
 * page — occurrences found here are at unmarked locations by construction.
 */
export function unmarkedPageText(
  candidateItems: readonly VerifyTextItem[],
  pageRects: readonly VerifyRect[],
): string {
  const regions = pageRects.map(rectRegion);
  const parts: string[] = [];
  for (const item of candidateItems) {
    if (!hasVisibleText(item.str)) continue;
    const box = textItemBox(item);
    if (box === null) continue;
    if (regions.some((region) => boxesOverlap(box, region))) continue;
    parts.push(item.str);
  }
  return normalizeTextValue(parts.join(" "));
}

/**
 * One warning per mark whose selected value survives at an unmarked
 * location, pointing at the first such page. Unreadable pages contribute
 * nothing rather than failing: absence of evidence is not a warning.
 */
export async function runDuplicateWarnings(
  ctx: VerifyCheckContext,
): Promise<VerifyWarning[]> {
  const { candidate, source, message } = ctx;
  const warnings: VerifyWarning[] = [];

  // 1. Derive each mark's selected value from the source.
  const values = new Map<VerifyRect, string>();
  const sourcePages = new Map<number, VerifyPage | null>();
  for (const rect of message.rects) {
    let page = sourcePages.get(rect.page);
    if (page === undefined) {
      page = null;
      if (Number.isInteger(rect.page) && rect.page >= 0 && rect.page < source.numPages) {
        try {
          page = await source.page(rect.page + 1);
        } catch {
          page = null;
        }
      }
      sourcePages.set(rect.page, page);
    }
    if (page === null) continue;
    let items: readonly VerifyTextItem[];
    try {
      items = await page.textItems();
    } catch {
      continue;
    }
    const value = selectedValueForRect(items, rect);
    if (value !== "") values.set(rect, value);
  }
  if (values.size === 0) return warnings;

  // 2. Search the candidate, page by page, outside marked rectangles.
  const rectsByPage = new Map<number, VerifyRect[]>();
  for (const rect of message.rects) {
    const list = rectsByPage.get(rect.page) ?? [];
    list.push(rect);
    rectsByPage.set(rect.page, list);
  }
  const pending = new Set(values.keys());
  for (let pageIndex = 0; pageIndex < candidate.numPages && pending.size > 0; pageIndex += 1) {
    let candPage: VerifyPage;
    try {
      candPage = await candidate.page(pageIndex + 1);
    } catch {
      continue;
    }
    let items: readonly VerifyTextItem[];
    try {
      items = await candPage.textItems();
    } catch {
      continue;
    }
    const haystack = unmarkedPageText(items, rectsByPage.get(pageIndex) ?? []);
    if (haystack === "") continue;
    for (const [rect, value] of values) {
      if (!pending.has(rect)) continue;
      if (haystack.includes(value)) {
        warnings.push({
          code: "duplicate-occurrence",
          pageIndex,
          selectionNumber: rect.number,
        });
        pending.delete(rect);
      }
    }
  }

  // Deterministic order: by mark number.
  warnings.sort((a, b) => a.selectionNumber - b.selectionNumber);
  return warnings;
}
