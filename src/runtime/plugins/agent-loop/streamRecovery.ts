/**
 * Stream-phase recovery: a provider answer that died after it started.
 *
 * `createProviderRetryStream` next door owns the other half — a request that
 * never produced a `start` event. It cannot own this one, because recovering
 * from a half-delivered answer means rewinding the TRANSCRIPT, and the retry
 * wrapper has no access to it.
 *
 * This module used to be a private method on `SubagentRun` (`retryPendingStream`),
 * which is why the delegate loop was the only thing in the runtime that could
 * survive a cut stream while the main conversation — the one the user is
 * watching — could not. Decision 029 clause 4 overturned the documented
 * trade-off ("the parent loop only takes pre-stream failures") and this file is
 * the shared capability that replaces it.
 *
 * ## The rules that make this a retry and not a restart
 *
 * 1. **One budget across both phases.** Every claim goes through the same
 *    `ProviderRetryController`, so a turn that fails once before the stream and
 *    twice during it has spent three retries, not three plus three. The budget
 *    is not reset at the phase boundary and not doubled (PI-Desktop's rule,
 *    `runtime.ts` 4140-4168 / 4230-4289, ADR 0050).
 * 2. **Only the failed assistant message is dropped.** Every tool the loop
 *    already executed stays executed and its results stay in context. Restarting
 *    the turn would run them again — for a delegate that writes files, twice.
 * 3. **A transcript that is not in the expected shape fails loudly.** If the
 *    last message is not the assistant message that just failed, there is
 *    nothing safe to rewind, and continuing from a guess is worse than
 *    reporting the original provider error.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ClassifiedProviderError } from './providerErrors.ts';
import {
  classifyProviderError,
  delayWithAbort,
  type ProviderRetryController,
  providerRateLimitDelayMs,
  providerSetupRetryDelayMs,
} from './providerRetry.ts';

/** A stream failure that claimed a retry and is waiting to be re-asked. */
export interface PendingStreamRetry {
  error: ClassifiedProviderError;
  /** The retry number `claim` handed out, used to index the backoff ladder. */
  attempt: number;
}

/** What a failed assistant message means: retry it, or report it. */
export interface StreamFailureVerdict {
  pending?: PendingStreamRetry;
  failure?: { code: string; message: string };
}

/**
 * Classify a `stopReason: "error"` assistant message and try to claim a retry.
 *
 * The caller is responsible for only asking about messages that actually
 * failed. An ABORTED message is not a failure and must never reach here: pi
 * gives it `stopReason: "aborted"`, and treating a user's Stop as a provider
 * fault would re-ask a request the user just cancelled.
 *
 * A verdict with neither field set is impossible: either the failure is re-asked
 * or it is reported, and "the stream failed and nothing happens" is the outcome
 * this function exists to make unreachable.
 */
export function claimStreamRetry(
  message: AssistantMessage,
  controller: ProviderRetryController
): StreamFailureVerdict {
  const classified = classifyProviderError(
    message.errorMessage ?? 'the provider stream failed',
    // The captured HTTP status outranks a generic body — some adapters answer a
    // rate-limited request with `fetch failed` — which is the same rule the
    // request phase applies.
    controller.status()
  );
  // pi turns EVERY throw inside its loop into an assistant message with
  // `stopReason: "error"` — a session append that failed, a compaction
  // checkpoint that could not be persisted, a listener that threw. Those are
  // local faults wearing a provider failure's clothes, and re-asking the
  // request spends the whole ladder on something a second attempt cannot fix.
  // Only a failure the provider's own stream reported is re-asked.
  if (!controller.providerStreamFailed()) {
    return { failure: { code: classified.code, message: classified.message } };
  }
  const attempt = controller.claim(classified);
  if (attempt === undefined) {
    // Budget spent, or an error re-sending cannot fix. Either way the turn
    // reports now rather than looping on it.
    return { failure: { code: classified.code, message: classified.message } };
  }
  return { pending: { error: classified, attempt } };
}

/** The slice of a pi `Agent` this recovery drives. */
export interface RecoverableAgent {
  state: { messages: AgentMessage[] };
  continue(): Promise<unknown>;
  waitForIdle(): Promise<unknown>;
}

export interface RecoverPendingStreamInput {
  agent: RecoverableAgent;
  pending: PendingStreamRetry;
  controller: ProviderRetryController;
  signal?: AbortSignal;
  /**
   * Called with the message this recovery is about to drop, before it is
   * dropped — the hook the parent loop needs so its session file and its
   * transcript stay the same shape. A delegate has no session and passes none.
   */
  onRewind?: (message: AgentMessage) => void;
}

export interface RecoverPendingStreamResult {
  /** Set when the recovery could not be attempted at all; see rule 3 above. */
  failure?: { code: string; message: string };
  /** False when the run was aborted during the wait. */
  attempted: boolean;
}

/**
 * Wait out the backoff, drop the failed message, and re-ask.
 *
 * The wait uses the same ladder the request phase does — a gateway that is
 * struggling is equally struggling whichever side of the `start` event it broke
 * on, and a second schedule would be a second thing to keep in step with the
 * user's 2026-09-11 ruling.
 */
export async function recoverPendingStream(
  input: RecoverPendingStreamInput
): Promise<RecoverPendingStreamResult> {
  const { agent, pending, controller, signal } = input;
  const messages = [...agent.state.messages];
  const last = messages.at(-1);
  if (last?.role !== 'assistant') {
    return {
      attempted: false,
      failure: { code: pending.error.code, message: pending.error.message },
    };
  }
  messages.pop();
  input.onRewind?.(last);
  agent.state.messages = messages;

  const headers = controller.headers();
  const delayMs =
    pending.error.code === 'PROVIDER_RATE_LIMITED'
      ? providerRateLimitDelayMs(pending.attempt, headers)
      : providerSetupRetryDelayMs(pending.attempt, headers);
  const now = controller.now ?? Date.now;
  const status = controller.status();
  controller.onRetry?.({
    error: pending.error,
    attempt: pending.attempt,
    delayMs,
    ...(status !== undefined ? { status } : {}),
    // The attempt that died is the last one the budget opened; its `startedAt`
    // is what makes "this request had been running for 118s" sayable.
    attemptStartedAt: controller.lastAttempt()?.startedAt ?? now(),
    retryAt: now() + delayMs,
  });
  const sleep = controller.sleep ?? delayWithAbort;
  await sleep(delayMs, signal);
  if (signal?.aborted) return { attempted: false };
  // The wait is over, so the banner that announced it comes down. Unlike the
  // request phase — where `createProviderRetryStream` can take it down at the
  // exact `start` event — the new request here is made by the agent loop, and
  // if IT fails before streaming the retry wrapper raises the banner again.
  controller.onRetrySettled?.();
  await agent.continue();
  await agent.waitForIdle();
  return { attempted: true };
}
