/**
 * dsh-rebase P1-7e (decision 140): the provider failures DSH must not retry by
 * itself, whatever the route's retry policy says about their class.
 *
 * DSH retries a failed model request by its code alone (`dsh-llm-retry`:
 * `retryableCodes`, `SERVER` among them). A company gateway's stream gate
 * (`stream_gate_precommit` / `prebuffer_overflow`) can answer with a 5xx, and
 * the same request then fails the same way three more times, each after a
 * backoff, before the user sees why. A model that refuses a parameter
 * (`… is not supported for this model`) is the same kind of failure. Their
 * text is the only thing that tells them apart (`classifyDshFailureText`),
 * and the route's policy has no knob for text, so this hook answers first:
 * prepended on `agent/request-error`, it leaves such a failure terminal and
 * passes every other one on untouched — to the loop guard, image offload,
 * `llm-retry`. The loop guard does the same for its own cut
 * (`loopGuard.ts`).
 */

import { isUnretryableDshFailure } from '../../shared/dshFailureCodes.ts';

/** dsh-agent `RequestErrorAction`; `undefined` leaves the failure terminal. */
export type DshRequestErrorAction = { readonly kind: 'retry' } | undefined;

/** `agent/request-error`'s payload, as far as this hook reads it. */
export interface DshRequestErrorPayload {
  readonly failure?: { readonly message?: unknown; readonly code?: unknown };
}

type RequestErrorListener = (
  payload: DshRequestErrorPayload,
  next: () => Promise<DshRequestErrorAction>
) => Promise<DshRequestErrorAction>;

/** The slice of a row's Cordis context this hook needs. */
export interface RetryVetoContext {
  on(
    name: 'agent/request-error',
    listener: RequestErrorListener,
    options: { prepend: true }
  ): unknown;
}

/** The listener itself: exported for the unit test. */
export const vetoUnretryableFailure: RequestErrorListener = (payload, next) =>
  isUnretryableDshFailure(payload?.failure) ? Promise.resolve(undefined) : next();

export function installRetryVeto(ctx: RetryVetoContext): void {
  ctx.on('agent/request-error', vetoUnretryableFailure, { prepend: true });
}
