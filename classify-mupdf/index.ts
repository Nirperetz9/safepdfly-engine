/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

/**
 * T085 — Public surface of the isolated read-only MuPDF classifier.
 * See scripts/check-boundaries.mjs for the enforced import rules.
 */
export {
  classifySource,
  ClassifyError,
  type ClassifyDeps,
  type ClassifyFailureCode,
  type ClassifyPageEvidence,
  type ClassifyReport,
} from "./classifier.js";
export {
  openDocumentReadOnly,
  type NativeBox,
  type ReadOnlyDocument,
  type ReadOnlyPage,
} from "./readonly-facade.js";
export {
  CLASSIFY_MESSAGE_TYPES,
  isClassifyOutbound,
  type ClassifyInbound,
  type ClassifyMessageType,
  type ClassifyOutbound,
  type ClassifyReadyMessage,
  type ClassifyRejectedMessage,
  type ClassifySourceMessage,
} from "./protocol.js";
export {
  classifyInWorker,
  ClassifyWorkerError,
  type ClassifyWorkerClientDeps,
} from "./client.js";
export { CLASSIFICATION_TIMEOUT_MS } from "./timeouts.js";
