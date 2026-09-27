import { create } from 'zustand';

/**
 * "Continue" — a retry requested from somewhere that cannot perform it.
 *
 * ## The problem this answers (2026-09-21 user report)
 *
 * A turn that failed left the user at the bottom of a card saying 「Session
 * failed」 in red with the raw provider sentence under it and a hint telling
 * them they *could* resend from the composer. The composer's Retry is a round
 * icon beside the send button, and it is only ever armed by `ChatComposer`'s
 * own `retryable` snapshot — a state a component the user is not looking at
 * owns. The user's own words: 「停下了很莫名其妙,用户不知道发生了什么为什么报错了,
 * 同时停下来但也得给个明确的继续按钮」. Two complaints, and this file is the
 * second one.
 *
 * ## Why an intent store rather than a callback or a prop
 *
 * `runSend` — the only code that can start a turn — lives inside
 * `ChatComposer`, several levels below the timeline, and needs its closure
 * (session resolution, the handshake, the send latch). Threading it up as a
 * prop would put a callback on every component between the two purely as a
 * conduit, which is the same reasoning `settingsIntent.ts` and `navigation.ts`
 * already record for their own requests.
 *
 * ## `retry`: the failed turn itself (T135 / decision 045)
 *
 * Continue used to resend the failed prompt as a NEW user message, so the
 * model saw it twice and, with deterministic output, failed the same way
 * again. It now asks the worker to re-run the turn from the context before the
 * failure; nothing is sent. The payload still names the prompt's MESSAGE ID —
 * never its text, so a stale copy cannot survive a session switch — because
 * the prompt is the fallback when the worker finds nothing to re-run.
 *
 * ## `carry-on`: a pause, not a failure (decision 040)
 *
 * A run that paused at the turn ceiling completed; there is no failed turn to
 * retry. Its Continue asks for a plain "continue" instead, and names only the
 * session. The composer words the message itself.
 */
export type ContinueIntent =
  | { kind: 'retry'; sessionId: string; messageId: string }
  | { kind: 'carry-on'; sessionId: string };

interface ContinueIntentState {
  /** What to do, and the session it belongs to. */
  pending: ContinueIntent | null;
  requestContinue: (sessionId: string, messageId: string) => void;
  requestCarryOn: (sessionId: string) => void;
  clearContinue: () => void;
}

export const useContinueIntentStore = create<ContinueIntentState>((set) => ({
  pending: null,
  // Last write wins: two failures in a row leave one Continue to honour, and it
  // names the message the user was looking at when they clicked.
  requestContinue: (sessionId, messageId) =>
    set({ pending: { kind: 'retry', sessionId, messageId } }),
  requestCarryOn: (sessionId) => set({ pending: { kind: 'carry-on', sessionId } }),
  clearContinue: () => set({ pending: null }),
}));
