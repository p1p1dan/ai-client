/**
 * T135 / decision 045 — the failure card's 「继续」 retries the last turn.
 *
 * It used to re-send the previous prompt as a NEW user message: the model got
 * the same instruction twice, and with deterministic output it reproduced the
 * very failure the user was trying to get past. The retry path sends no text
 * at all — the worker re-asks the model from the context before the failure
 * (`chat.retryLastTurn`) — so the renderer draws no optimistic user bubble
 * and has no user echo to wait for.
 *
 * Pure module (no `window`, no React), so the node-env suite covers it.
 */

import type { ProgressEvent } from './assistantProgress';

/**
 * The retry's admission evidence: the request id of a `running` status for
 * `sessionId`, else `null`.
 *
 * A send proves admission with its user echo; a retry has none, so the run's
 * first `session.status: running` stands in for it. The caller matches the id
 * against the request its own IPC call returned — the event and the IPC reply
 * travel on different channels and can arrive in either order, so an id seen
 * before the reply is kept and checked once the reply lands.
 */
export function retryRunningRequestId(
  event: ProgressEvent & { requestId?: string },
  sessionId: string
): string | null {
  if (event.type !== 'session.status' || event.sessionId !== sessionId) return null;
  const status = (event.payload as { status?: unknown } | undefined)?.status;
  if (status !== 'running') return null;
  return typeof event.requestId === 'string' && event.requestId !== '' ? event.requestId : null;
}

/**
 * Whether a rejected `chat.retryLastTurn` means "there is no cut-short turn to
 * re-run" (Main's `retry_unavailable`). Word-bounded like
 * `parseSendDispatchErrorCode`, because Electron wraps the message in its own
 * prefix.
 */
export function isRetryUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(?:^|[^a-z0-9_])retry_unavailable(?![a-z0-9_])/.test(message);
}

/** Catalog keys for why the card's Continue is disabled right now. */
export const CONTINUE_BLOCKED_UNSETTLED = 'The last turn is still wrapping up';
export const CONTINUE_BLOCKED_IN_FLIGHT = 'Retrying the last turn…';

/**
 * Why Continue may not be pressed yet, or `null` when it may.
 *
 * - The failure has not settled: `session.failed` arrived but the run's
 *   closing `idle` has not, so the worker may still hold the turn and a retry
 *   would be refused as busy (decision 046: the worker is the authority on
 *   whether a turn runs).
 * - A send is already in flight for this session — this retry's own handshake,
 *   most likely. A second press would be skipped by the send latch anyway;
 *   saying so beats a button that silently does nothing.
 */
export function continueBlockedReason(input: {
  failureSettled: boolean;
  sendInFlight: boolean;
}): string | null {
  if (!input.failureSettled) return CONTINUE_BLOCKED_UNSETTLED;
  if (input.sendInFlight) return CONTINUE_BLOCKED_IN_FLIGHT;
  return null;
}
