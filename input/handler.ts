/**
 * T033 — Input worker message handler.
 *
 * Pure logic shared by the browser worker entry and the tests: given bytes,
 * produce exactly one typed response. Unknown messages fail closed. Engine
 * errors are mapped to the allowlisted reason codes — raw engine errors,
 * filenames, extracted text, and parser dumps never cross the boundary.
 */
import type { InputEngine } from "./engine.js";
import { DescriptorError, extractDescriptors } from "./descriptors.js";
import {
  INPUT_POLICY_VERSION,
  type InputWorkerResponse,
  type OpenSourceRequest,
  type SourceRejected,
  type SupportReasonCode,
} from "./protocol.js";

export interface OpenSourceOptions {
  readonly engine: InputEngine;
  /** Injectable id source for tests; defaults to crypto.randomUUID(). */
  readonly randomId?: () => string;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"

function isPdfBytes(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  const v = new Uint8Array(bytes, 0, PDF_MAGIC.length);
  return PDF_MAGIC.every((b, i) => v[i] === b);
}

function rejected(
  reasonCode: SupportReasonCode,
  outcome: "rejected" | "indeterminate" = "rejected",
  pageNumbers: readonly number[] = [],
): SourceRejected {
  return Object.freeze({
    type: "SOURCE_REJECTED",
    outcome,
    reasonCode,
    pageNumbers: Object.freeze([...pageNumbers]),
  }) as SourceRejected;
}

/**
 * Map an engine/parse failure to an allowlisted reason code. The original
 * error is discarded — its message is never forwarded, because parser
 * messages may quote document bytes.
 */
function mapEngineError(error: unknown): SourceRejected {
  const name =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown }).name
      : undefined;
  if (name === "PasswordException") return rejected("locked");
  if (error instanceof DescriptorError) {
    return rejected(
      "damaged",
      "rejected",
      error.pageNumber === undefined ? [] : [error.pageNumber],
    );
  }
  if (
    name === "InvalidPDFException" ||
    name === "MissingPDFException" ||
    name === "UnknownErrorException"
  ) {
    return rejected("damaged");
  }
  return rejected("unexpected", "indeterminate");
}

/**
 * Handle OPEN_SOURCE for a transferred ArrayBuffer. The buffer is the only
 * accepted input — URLs are never accepted (the signature takes bytes, and
 * non-ArrayBuffer input fails closed as wrong-type).
 */
export async function handleOpenSource(
  bytes: unknown,
  options: OpenSourceOptions,
): Promise<InputWorkerResponse> {
  if (!(bytes instanceof ArrayBuffer) || !isPdfBytes(bytes)) {
    return rejected("wrong-type");
  }
  const { engine } = options;
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  let doc: Awaited<ReturnType<InputEngine["open"]>> | undefined;
  try {
    doc = await engine.open(new Uint8Array(bytes));
    if (doc.numPages === 0) return rejected("empty");
    const descriptors = await extractDescriptors(doc);
    return Object.freeze({
      type: "SOURCE_READY",
      sessionId: randomId(),
      pageCount: doc.numPages,
      descriptors,
      engineVersion: engine.version,
      policyVersion: INPUT_POLICY_VERSION,
      support: "supported",
    });
  } catch (error) {
    return mapEngineError(error);
  } finally {
    // Never leak a half-opened document; ignore teardown errors.
    await doc?.destroy().catch(() => undefined);
  }
}

/** Unknown or malformed worker messages fail closed as indeterminate. */
export function handleUnknownMessage(type: unknown): SourceRejected {
  void type;
  return rejected("unexpected", "indeterminate");
}

/** Validate the request envelope before dispatch. */
export function dispatchMessage(
  message: unknown,
  bytes: unknown,
  options: OpenSourceOptions,
): Promise<InputWorkerResponse> {
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "OPEN_SOURCE"
  ) {
    void (message as OpenSourceRequest).policyVersion;
    return handleOpenSource(bytes, options);
  }
  return Promise.resolve(
    handleUnknownMessage(
      (message as { type?: unknown } | null)?.type,
    ),
  );
}
