/**
 * 「为什么会报错」 — what a stopped turn tells the user, in words they can act on.
 *
 * ## The problem this answers (2026-09-21 user report)
 *
 * 「主要是停下了很莫名其妙，用户不知道发生了什么为什么报错了」. The app already
 * had the raw sentence — the runtime's `session.failed` payload carries the
 * provider's or the loop's own text, and the failed card printed it in mono
 * under the title. What it did not have was a reason. The user saw
 * 「tool loop exceeded 64 assistant turns」 or 「terminated」 in a red box and
 * had no way to tell a self-explanatory completion ceiling from a provider
 * that cut the connection from a bug in this app.
 *
 * ## Where the code comes from, and why the message alone is not enough
 *
 * `SessionTerminalEvent.payload` carries BOTH `error` (the sentence) and
 * `errorCode` (T066's machine-readable half, added so the operator log had
 * something greppable). The code is written by whoever knew what happened:
 * `turn_limit` by the loop's old 64-turn ceiling (legacy — see the entry
 * below), `stop_error` by `resolveError`
 * when a provider stream died, `context_too_large` by the preflight budget
 * check, `loop_threw` by an exception inside the loop.
 *
 * So the classification is a READ, never a substring guess — the same rule
 * `piModelSyncNoticeModel.ts` records for its own failures. Matching on the
 * message would be a second, drifting copy of a decision the emitting code
 * already made, and would put the wording of a provider's error body in charge
 * of what this app says about it.
 *
 * ## The message still ships, unchanged
 *
 * `detail` is the raw sentence and the card keeps printing it. It is the only
 * thing that distinguishes one `stop_error` from another, and the user's
 * second complaint is that stopping was unexplained — deleting the evidence in
 * favour of a tidy summary would reproduce that complaint one level up.
 */

import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';

/**
 * What the user can do about it. Exactly one per reason, and deliberately not
 * a list: a card that offers three buttons has not decided what it thinks.
 *
 *  - `continue` — re-sending can plausibly work. The turn stopped mid-flight
 *    (a provider cut, a transient fault, the model looping). The payload is
 *    still in the transcript, so the action is "keep going".
 *  - `configure` — re-sending fails identically until something changes
 *    outside the turn (the prompt is bigger than the model's window, the
 *    model itself is gone). A Continue button here would be a button that
 *    cannot work, which is the rule `modelMissingError.ts` already follows.
 *  - `none` — the user stopped it, or it completed. Nothing to offer, and
 *    nothing to explain.
 */
export type SessionFailureAction = 'continue' | 'configure' | 'none';

export interface SessionFailureView {
  /** One line: what kind of stop this is, in the user's terms. */
  title: string;
  /** One sentence: why it happened. */
  reason: string;
  /** One sentence: what to do, or what continuing will do. */
  hint: string;
  action: SessionFailureAction;
}

/**
 * The codes this app emits, and what each one means.
 *
 * `unknown` is the fallback for a code this build has never heard of (a newer
 * runtime, or a provider SDK's own code threaded through) — the card then says
 * what it can prove and offers Continue, because a stop with no explanation is
 * exactly the case where letting the user try again is worth more than
 * guessing.
 */
const FAILURE_VIEWS = {
  // Legacy. Since decision 040 the runtime no longer ENDS a run as
  // `turn_limit`: reaching the interactive ceiling pauses after a tool-less
  // wrap-up turn and arrives as `session.completed` + `stopCause`, drawn by
  // `TurnCeilingNotice`, not this card. Kept so sessions recorded under the old
  // 64-turn cap still render their original card instead of the unknown
  // fallback; subagents report their own `maxTurns` cap as `truncated`.
  turn_limit: {
    title: 'Stopped at the tool-call ceiling',
    reason:
      'The assistant called tools 64 turns in a row without finishing. This app stops the turn there so a loop cannot spend without bound.',
    hint: 'Send a message to carry on from here — the work so far is kept.',
    action: 'continue',
  },
  context_too_large: {
    title: 'The prompt no longer fits the model',
    reason:
      'This chat’s history plus your message is larger than the window the model accepts, so the turn was never sent.',
    hint: 'Start a new chat, or pick a model with a larger context window.',
    action: 'configure',
  },
  stop_error: {
    title: 'The model’s reply was cut off',
    reason: 'The provider answered and then the stream ended before it finished.',
    hint: 'Continue to ask again — the part that arrived is kept.',
    action: 'continue',
  },
  stop_aborted: {
    title: 'The turn was stopped',
    reason: 'The turn was cancelled before the model finished replying.',
    hint: 'Send a message to carry on when you are ready.',
    action: 'none',
  },
  aborted: {
    title: 'The turn was stopped',
    reason: 'The turn was cancelled before the model finished replying.',
    hint: 'Send a message to carry on when you are ready.',
    action: 'none',
  },
  loop_threw: {
    title: 'The turn ended on an internal error',
    reason: 'Something inside this app failed while the turn was running.',
    hint: 'Continue to try again. If it fails the same way, send the detail below.',
    action: 'continue',
  },
  // The runtime's subagent loop guard (2026-09-24): a reply that kept writing
  // the same Task* call was cut while it streamed, and nothing in it ran.
  // `continue` because the conversation before that reply is intact and a
  // fresh message is exactly how the user carries on.
  tool_call_repetition: {
    title: 'The model repeated the same tool calls, so its reply was stopped',
    reason:
      'The model kept writing the same subagent tool call in one reply without waiting for any result. This app interrupted that reply and ran none of the tool calls in it.',
    hint: 'Send a message to carry on — everything before this reply is kept. If it happens again, try another model.',
    action: 'continue',
  },
  no_assistant_message: {
    title: 'The model never answered',
    reason: 'The turn ended without the model producing a reply.',
    hint: 'Continue to ask again. If it keeps happening, check the model settings.',
    action: 'continue',
  },
  timeout: {
    title: 'The model took too long',
    reason: 'The provider did not finish the request within the timeout this app allows.',
    hint: 'Continue to try again — a slow provider often answers on a second attempt.',
    action: 'continue',
  },
  // T067's `*: ` prefix convention puts this in front of the sentence for the
  // thrown path; both spellings reach here as the same code.
  lock_timeout: {
    title: 'Another process is holding this chat',
    reason: 'This chat is open in another window or process, so the turn could not run.',
    hint: 'Close the other window, then continue.',
    action: 'continue',
  },
  // H/21 P0's model-directory failure — copy shared with the card that already
  // renders it, via `model_missing` in `historyError.ts`. Kept here so a
  // session-level `session.failed` carrying this code gets the SAME wording
  // rather than the generic fallback.
  model_missing: {
    title: 'The model this chat uses is not installed',
    reason: 'The model this chat was created with is not in this app’s model directory.',
    hint: 'Open settings and add the model, then continue.',
    action: 'configure',
  },
  unknown: {
    title: 'The turn stopped',
    reason: 'This app does not recognise the reason the turn ended with.',
    hint: 'Continue to try again. The detail below is what to report if it repeats.',
    action: 'continue',
  },
} as const;

/** The codes above, plus the open-ended case. */
export type KnownSessionFailureCode = keyof typeof FAILURE_VIEWS;

/**
 * `errorCode` is a bare string on the wire — a newer runtime may send one this
 * build has never heard of, and that must render the fallback rather than
 * nothing. `Object.hasOwn`, not `in`: a code of `'constructor'` would otherwise
 * be a hit through the prototype.
 */
export function toSessionFailureCode(code: string | undefined | null): KnownSessionFailureCode {
  if (typeof code !== 'string' || code === '') return 'unknown';
  return Object.hasOwn(FAILURE_VIEWS, code) ? (code as KnownSessionFailureCode) : 'unknown';
}

/**
 * The failed turn's card, as data.
 *
 * Everything returned here is a CATALOG KEY, not display text — the caller
 * translates. This is a plain `.ts` with no translator in scope for the same
 * reason `piModelSyncNoticeModel.ts` is: the wording has to be assertable in
 * the node-env suite, and `i18nCoverage.test.ts` cannot see a key reached
 * through a field.
 *
 * The five reason fields are picked per code rather than composed from
 * fragments: 「工具调用达到上限」 and 「模型回答被截断」 are different kinds of stop,
 * not one sentence with a substitution in it.
 */
export function deriveSessionFailure(input: {
  error?: string | null;
  errorCode?: string | null;
}): SessionFailureView {
  const view = FAILURE_VIEWS[toSessionFailureCode(input.errorCode)];
  return {
    title: view.title,
    reason: view.reason,
    hint: view.hint,
    action: view.action,
  };
}

/**
 * Whether a Continue affordance may be shown at all.
 *
 * Two conditions, both load-bearing:
 *
 *  - the reason allows it (`action === 'continue'`), because a button that
 *    cannot work is worse than no button;
 *  - there IS a message to resend. A failure that happened before any user
 *    message existed (a create handshake that never got that far) has nothing
 *    to continue FROM, and the card falls back to its written hint.
 */
export function canContinueSession(
  view: SessionFailureView,
  hasResumableMessage: boolean
): boolean {
  return view.action === 'continue' && hasResumableMessage;
}

/**
 * D1 (2026-09-24) — whether the timeline's failure card is the surface that
 * reports this session's error, so the composer's red box must stay down.
 *
 * The card renders exactly while the session is `'failed'` and prints the
 * same sentence the box would, under a title that names the kind of stop. The
 * box became the only durable surface when the runtime's closing `idle` kept
 * wiping `'failed'` (T062 round-2); now that the status survives, printing it a
 * second time — raw and in English — above the composer is the duplicate the
 * point-check photographed.
 */
export function failureCardOwnsError(sessionStatus: SessionRuntimeStatus | undefined): boolean {
  return sessionStatus === 'failed';
}
