/**
 * T085 — Classifier worker protocol. Mirrors the input worker protocol shape
 * (contracts/processing-worker.md) with classify-specific messages.
 */
import type { ClassifyFailureCode, ClassifyReport } from "./classifier.js";

export const CLASSIFY_MESSAGE_TYPES = [
  "CLASSIFY_SOURCE",
  "CLASSIFY_READY",
  "CLASSIFY_REJECTED",
] as const;

export type ClassifyMessageType = (typeof CLASSIFY_MESSAGE_TYPES)[number];

export interface ClassifySourceMessage {
  type: "CLASSIFY_SOURCE";
  /** Document bytes. Transferred to the worker (neutered on the host side). */
  payload: ArrayBuffer;
}

export interface ClassifyReadyMessage {
  type: "CLASSIFY_READY";
  report: ClassifyReport;
}

export interface ClassifyRejectedMessage {
  type: "CLASSIFY_REJECTED";
  /**
   * Classifier-local failure code. The dual-engine orchestrator (T036)
   * translates this into the shared SupportReasonCode vocabulary.
   */
  reason: ClassifyFailureCode | "internal";
}

export type ClassifyInbound = ClassifySourceMessage;
export type ClassifyOutbound = ClassifyReadyMessage | ClassifyRejectedMessage;

/** Narrow an unknown worker message to a valid outbound message. */
export function isClassifyOutbound(value: unknown): value is ClassifyOutbound {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  if (type === "CLASSIFY_READY") {
    return typeof (value as { report?: unknown }).report === "object";
  }
  if (type === "CLASSIFY_REJECTED") {
    return (
      typeof (value as { reason?: unknown }).reason === "string"
    );
  }
  return false;
}

/**
 * T104 — open-core blessed surface: the classify report is the worker's
 * response payload, so its type is part of the protocol surface.
 */
export type { ClassifyReport } from "./classifier.js";
