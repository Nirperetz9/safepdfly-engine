/**
 * T033 — PDF.js input worker: OPEN_SOURCE protocol, page descriptors.
 * See scripts/check-boundaries.mjs for the enforced import rules.
 */
export {
  INPUT_POLICY_VERSION,
  SUPPORT_REASON_CODES,
  isOpenSourceRequest,
  isSupportReasonCode,
  type InputWorkerResponse,
  type OpenSourceRequest,
  type SourceReady,
  type SourceRejected,
  type SupportReasonCode,
} from "./protocol.js";
export { createPdfJsEngine, type InputEngine } from "./engine.js";
export { DescriptorError, extractDescriptors } from "./descriptors.js";
export {
  dispatchMessage,
  handleOpenSource,
  handleUnknownMessage,
} from "./handler.js";
export { InputWorkerClient, type MinimalWorker } from "./client.js";
export {
  createRenderHandler,
  MAX_RENDER_SCALE,
  MIN_RENDER_SCALE,
  RENDER_POLICY_VERSION,
  type RenderFailureCode,
  type RenderHandlerDeps,
  type RenderWorkerRequest,
  type RenderWorkerResponse,
} from "./render.js";
export {
  RenderSupersededError,
  RenderWorkerClient,
  type MinimalRenderWorker,
  type RenderedPage,
} from "./render-client.js";
