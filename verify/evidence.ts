/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T070 — deterministic evidence and versioning (host side).
 *
 * - `canonicalJson` serializes with sorted keys at every depth, so the same
 *   PDF + the same marks always produce byte-identical report bytes,
 *   regardless of object construction order. Arrays keep their order
 *   (warnings are mark-number-ordered; selections follow the request).
 * - `EVIDENCE_VERSIONS` freezes the engine/policy version strings. They are
 *   `as const`; changing any of them requires a spec amendment, and the
 *   test pins their exact values so a change fails loudly.
 * - `VERIFY_VISUAL_THRESHOLDS` records the deterministic check thresholds
 *   pinned by the verify policy version — the same constants the worker
 *   checks against, re-exported here so the evidence record cites them.
 */

import {
  AA_BOUNDARY_PX,
  FILL_BLACK_TOLERANCE,
  FILL_UNIFORMITY_TOLERANCE,
  GLYPH_EXCLUSION_MARGIN_PX,
  OUTSIDE_TOLERANCE,
  RETAINED_TOLERANCE,
  VISUAL_SCALE,
} from "./checks/visual.js";
import {
  REDACTION_POLICY_VERSION,
  SAVE_POLICY_VERSION,
  TRANSFORM_ENGINE_VERSION,
} from "../redact/protocol.js";
import { VERIFY_ENGINE_VERSION, VERIFY_POLICY_VERSION } from "./protocol.js";
import type { VerificationReport } from "../model.js";

/**
 * Frozen version pins for every run's evidence. Changing any value
 * requires a spec amendment — see evidence.test.ts.
 */
export const EVIDENCE_VERSIONS = {
  transformEngine: TRANSFORM_ENGINE_VERSION,
  verifyEngine: VERIFY_ENGINE_VERSION,
  verifyPolicy: VERIFY_POLICY_VERSION,
  redactionPolicy: REDACTION_POLICY_VERSION,
  savePolicy: SAVE_POLICY_VERSION,
} as const;

/**
 * The deterministic thresholds the visual checks apply, pinned by the
 * verify policy version above. Recorded here so the evidence cites the
 * exact numbers the worker enforced.
 */
export const VERIFY_VISUAL_THRESHOLDS = {
  visualScale: VISUAL_SCALE,
  aaBoundaryPx: AA_BOUNDARY_PX,
  fillUniformityTolerance: FILL_UNIFORMITY_TOLERANCE,
  fillBlackTolerance: FILL_BLACK_TOLERANCE,
  retainedTolerance: RETAINED_TOLERANCE,
  outsideTolerance: OUTSIDE_TOLERANCE,
  glyphExclusionMarginPx: GLYPH_EXCLUSION_MARGIN_PX,
} as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, v] of entries) out[key] = canonicalize(v);
    return out;
  }
  return value;
}

/**
 * Deterministic JSON: sorted keys at every depth. `undefined` object
 * values are dropped (JSON semantics); array order is preserved.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** The identical-bytes artifact: same PDF + same marks → same bytes. */
export function canonicalReportBytes(report: VerificationReport): Uint8Array {
  return new TextEncoder().encode(canonicalJson(report));
}
