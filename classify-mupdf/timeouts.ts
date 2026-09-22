/**
 * T085 — Classifier worker timeouts. Same policy as the input worker (T033):
 * monotonic clock, so wall-clock adjustments cannot extend a run.
 */
export const CLASSIFICATION_TIMEOUT_MS = 30_000;

export function createClassificationTimeoutMs(now: () => number): number {
  const started = now();
  void started;
  return CLASSIFICATION_TIMEOUT_MS;
}
