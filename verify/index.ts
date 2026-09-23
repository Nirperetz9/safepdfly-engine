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
export { runDocumentChecks } from "./checks/document.js";
