/**
 * Copyright (C) 2026 SafePDFly contributors.
 *
 * This file is part of the SafePDFly engine, licensed under the GNU Affero
 * General Public License v3.0 or later. See LICENSE in the engine package
 * root for the full text.
 */

// T064 — Independent verification: fresh PDF.js worker, digest-gated checks.
// See scripts/check-boundaries.mjs for the enforced import rules.
export {
  VERIFY_ENGINE_VERSION,
  VERIFY_POLICY_VERSION,
  VERIFY_MESSAGE_TYPES,
  VERIFY_FAILURE_CODES,
  VERIFY_FAILURE_OUTCOME,
  isVerifyFailureCode,
  isVerifyCandidateMessage,
  isVerifyCheckpointMessage,
  isVerifyOutbound,
  type VerifyMessageType,
  type VerifyRect,
  type ExpectedPage,
  type VerifyPolicyVersions,
  type VerifyCandidateMessage,
  type VerifyCheckpoint,
  type VerifyCheckpointMessage,
  type VerifyDocumentCheck,
  type VerifySelectionCheck,
  type SelectionCheckAspect,
  type VerifyWarning,
  type VerifyWorkerResult,
  type VerifyResultMessage,
  type VerifyFailureCode,
  type VerifyFailedMessage,
  type VerifyInbound,
  type VerifyOutbound,
} from "./protocol.js";
export {
  dispatchVerify,
  VERIFY_MAX_CANDIDATE_BYTES,
  type VerifyCheckContext,
  type VerifyCheckRunner,
  type VerifyHandlerDeps,
} from "./handler.js";
export {
  verifyCandidateInWorker,
  VerifyWorkerError,
  type VerifyWorkerClientDeps,
  type VerifyRequest,
} from "./client.js";
export {
  createPdfJsVerifyEngine,
  type PdfJsModule,
  type VerifyTextItem,
  type VerifyPixels,
  type VerifyPage,
  type VerifyDoc,
  type VerifyEngine,
  type PdfJsVerifyEngineOptions,
} from "./engine.js";
export { VERIFY_TIMEOUT_MS, createVerifyTimeoutMs } from "./timeouts.js";
export { runVerificationChecks } from "./checks.js";
export {
  toVerifyRectFromTransform,
  type VerifyRectSelection,
} from "./rects.js";
export { runDocumentChecks } from "./checks/document.js";
export { runTextChecks, textItemBox, hasVisibleText, normalizeTextValue, boxesOverlap } from "./checks/text.js";
export {
  runDuplicateWarnings,
  selectedValueForRect,
  unmarkedPageText,
} from "./checks/duplicates.js";
export {
  assembleVerificationReport,
  REPORT_SELECTION_MISSING,
  REPORT_ASPECT_MISSING,
  type AssemblerSelection,
} from "./assembler.js";
export {
  canonicalJson,
  canonicalReportBytes,
  EVIDENCE_VERSIONS,
  VERIFY_VISUAL_THRESHOLDS,
} from "./evidence.js";
export {
  runVisualChecks,
  toDeviceBox,
  VISUAL_SCALE,
  AA_BOUNDARY_PX,
  FILL_UNIFORMITY_TOLERANCE,
  FILL_BLACK_TOLERANCE,
  RETAINED_TOLERANCE,
  OUTSIDE_TOLERANCE,
  GLYPH_EXCLUSION_MARGIN_PX,
  type VisualCheckOutput,
} from "./checks/visual.js";
