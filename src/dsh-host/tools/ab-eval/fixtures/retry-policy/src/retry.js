import { isRetryable } from './errors.js';
import { DEFAULT_POLICY } from './policy.js';

/** Delay before the next attempt, after attempt number `attempt` (1-based) failed. */
export function delayFor(attempt, policy = DEFAULT_POLICY) {
  const raw = policy.baseDelayMs * policy.factor ** (attempt - 1);
  return Math.min(raw, policy.maxDelayMs);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `task` until it succeeds, fails with a non-retryable error, or attempts run out. */
export async function withRetry(task, policy = DEFAULT_POLICY, sleep = defaultSleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= policy.maxAttempts || !isRetryable(error)) throw error;
      await sleep(delayFor(attempt, policy));
    }
  }
}
