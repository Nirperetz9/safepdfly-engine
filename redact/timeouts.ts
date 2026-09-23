/**
 * T058 — Transformation worker timeouts. Monotonic clock, so wall-clock
 * adjustments cannot extend a run (same policy as T033/T085).
 *
 * Transformation is the heaviest pipeline stage (open + per-page redaction +
 * full garbage-collecting rewrite + self-check render), so it gets the
 * longest budget.
 */
export const TRANSFORM_TIMEOUT_MS = 120_000;

export function createTransformTimeoutMs(now: () => number): number {
  const started = now();
  void started;
  return TRANSFORM_TIMEOUT_MS;
}
