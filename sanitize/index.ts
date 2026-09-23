/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

// T099 — metadata & hidden-layer sanitization (Pro, opt-in).
// See scripts/check-boundaries.mjs for the enforced import rules.
export { sanitizeDocument, SanitizeError } from "./sanitize.js";
export type { SanitizeDocument, SanitizeObject } from "./sanitize.js";
