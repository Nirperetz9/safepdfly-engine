// T058 — Transformation worker: APPLY_REDACTIONS, engine adapter, save policy.
// See scripts/check-boundaries.mjs for the enforced import rules.
export {
  REDACTION_POLICY_VERSION,
  SAVE_POLICY_VERSION,
  TRANSFORM_ENGINE_VERSION,
  TRANSFORM_MESSAGE_TYPES,
  isApplyRedactionsMessage,
  isTransformFailureCode,
  isTransformOutbound,
  type ApplyRedactionsMessage,
  type CandidateReadyMessage,
  type SelfCheckStatus,
  type TransformFailedMessage,
  type TransformFailureCode,
  type TransformInbound,
  type TransformMessageType,
  type TransformOutbound,
  type TransformPolicyVersions,
  type TransformRect,
} from "./protocol.js";
export {
  dispatchTransform,
  TRANSFORM_POLICY_VERSIONS,
  type TransformBackend,
} from "./handler.js";
export {
  applyRedactionsInWorker,
  TransformWorkerError,
  type TransformCandidate,
  type TransformRequest,
  type TransformWorkerClientDeps,
} from "./client.js";
export { TRANSFORM_TIMEOUT_MS, createTransformTimeoutMs } from "./timeouts.js";
