import type { TurnStopCause } from '@shared/types/sessionHistory';
import type { ChatMessage } from '@/stores/chatSessions';

/**
 * Whether the user ended a turn — the question the timeline asks before it
 * opens a finished turn's process area by default.
 *
 * The answer lives on the turn's last assistant message as
 * `ChatMessage.stopCause`, written by two producers that agree by
 * construction:
 *
 * - live: `chatSessions.ts` stamps it off the terminal event —
 *   `session.completed` with `payload.stopCause === 'interjected'` (Ctrl+Enter)
 *   or `session.stopped` (Stop / "send now");
 * - replay: the runtime writes an `aiclient.runStop` custom entry when a run
 *   ends that way, and the history projection folds it onto the same message.
 *
 * Pure and structural (no store access), so it can run per turn inside a
 * render or a selector.
 */

export type { TurnStopCause };

/** The fields read off each message; any `ChatMessage` satisfies it. */
export type TurnEndCauseMessage = Pick<ChatMessage, 'role' | 'stopCause' | 'stopReason'>;

/**
 * Why this turn ended, when the user ended it; `null` when it ended on its own
 * (or has not ended yet — a live turn has no stamp until its terminal event).
 *
 * Only the LAST assistant message counts: if a later run continued the same
 * turn and finished normally, the turn's latest ending is the natural one.
 *
 * Fallback for history written before the run-stop record existed: a last
 * assistant message saved with `stopReason: 'aborted'` reads as `user_stop`.
 * There is no such fallback for Ctrl+Enter — an interjected run's messages
 * end normally, so older transcripts simply read `null`.
 *
 * @param body the turn's messages after its user message (`Turn.body`).
 */
export function turnEndCause(body: readonly TurnEndCauseMessage[]): TurnStopCause | null {
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const message = body[index];
    if (!message || message.role !== 'assistant') continue;
    if (message.stopCause) return message.stopCause;
    return message.stopReason === 'aborted' ? 'user_stop' : null;
  }
  return null;
}

/** `true` when {@link turnEndCause} names a cause — Ctrl+Enter or Stop. */
export function turnEndedByUser(body: readonly TurnEndCauseMessage[]): boolean {
  return turnEndCause(body) !== null;
}
