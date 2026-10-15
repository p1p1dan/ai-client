/** How `withRetry` paces its attempts unless the caller passes its own policy. */
export const DEFAULT_POLICY = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 200,
  factor: 3,
  maxDelayMs: 2000,
});
