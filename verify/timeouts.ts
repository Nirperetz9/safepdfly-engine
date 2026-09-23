/**
 * T064 — Verification worker timeouts. Monotonic clock, so wall-clock
 * adjustments cannot extend a run (same policy as T033/T058).
 *
 * Verification renders every page twice at 2× (source + candidate) plus
 * full text extraction, so it gets a larger budget than transformation.
 */
export const VERIFY_TIMEOUT_MS = 180_000;

export function createVerifyTimeoutMs(now: () => number): number {
  const started = now();
  void started;
  return VERIFY_TIMEOUT_MS;
}
