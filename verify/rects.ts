/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T093 — Transform-worker → verification rectangle projection.
 *
 * The verification worker (T064) consumes VerifyRects: plain-data
 * rectangles in canonical PDF space (default user space, y-up, origin at
 * the MediaBox origin) — the same space the stored selections live in.
 *
 * Per the T093 task, VerifyRects are derived from the TransformRects that
 * were actually applied (viewport points, y-down) through the approved
 * geometry core's viewport→PDF conversion (T024, `viewportToPdf`) — never
 * an ad-hoc flip. The property tests in rects.test.ts prove the
 * TransformRect → VerifyRect projection round-trips to the original
 * canonical rect within tolerance for rotated and cropped pages.
 */
import { viewportToPdf } from "../geometry/transforms.js";
import type { PageContext, PageIndex } from "../geometry/types.js";
import type { SelectionId } from "../model.js";
import type { TransformRect } from "../redact/protocol.js";
import type { VerifyRect } from "./protocol.js";

/** The selection identity a VerifyRect carries (never document content). */
export interface VerifyRectSelection {
  readonly id: SelectionId;
  /** Stable 1-based mark number shown in the UI. */
  readonly number: number;
}

/**
 * Derive the verification rect from the transform rect that was applied,
 * using the page context the transform ran under. Throws (fail closed)
 * when the transform rect maps outside the visible page — a caller must
 * treat that as a failed run, never as a checkable rect.
 */
export function toVerifyRectFromTransform(
  transform: TransformRect,
  selection: VerifyRectSelection,
  context: PageContext,
  page: PageIndex,
): VerifyRect {
  const canonical = viewportToPdf(
    page,
    {
      x: transform.x0,
      y: transform.y0,
      w: transform.x1 - transform.x0,
      h: transform.y1 - transform.y0,
    },
    1,
    context,
  );
  const { x0, y0, x1, y1 } = canonical.rect;
  return {
    page,
    x0,
    y0,
    x1,
    y1,
    selectionId: selection.id,
    number: selection.number,
  };
}
