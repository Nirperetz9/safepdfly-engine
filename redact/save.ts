/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T060 — Candidate save path.
 *
 * The ONLY way a redaction candidate is serialized: a full non-incremental
 * rewrite with garbage collection. Incremental saving is forbidden — an
 * incremental update would append a new revision while leaving the original
 * (unredacted) objects recoverable in the file. save.test.ts enforces this
 * statically (no incremental option string in code) and dynamically (the
 * product output must contain exactly one %%EOF).
 */
import { PDFDocument } from "mupdf";

/** Save options for every candidate. Never "incremental". */
export const CANDIDATE_SAVE_OPTIONS = "garbage";

/**
 * Serialize a redacted document to candidate bytes: full rewrite with
 * garbage collection. Returns a caller-owned ArrayBuffer; asUint8Array may
 * view WASM memory, so the bytes are copied before the caller destroys doc.
 */
export function saveCandidate(doc: PDFDocument): ArrayBuffer {
  const saved = new Uint8Array(
    doc.saveToBuffer(CANDIDATE_SAVE_OPTIONS).asUint8Array(),
  );
  return saved.buffer as ArrayBuffer;
}
