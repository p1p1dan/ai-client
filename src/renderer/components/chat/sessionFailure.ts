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
 * check, `loop_threw` by an exception inside the loop. Main writes two of its
 * own (dsh-rebase P1-3c): `dsh_host_crashed` and `dsh_engine_restarted`, for a
 * turn the shared DSH engine process took with it.
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
  /**
   * Whether the card prints the raw sentence under the reason. True for every
   * code whose sentence is the provider's or the loop's own evidence; false
   * where this app wrote it about its own engine process
   * ("Worker exited (code=null signal=SIGKILL)"), which the reason already
   * says in words and the operator log keeps.
   */
  showsDetail: boolean;
  /**
   * dsh-rebase P1-7e (decision 140): the hint stays on the card beside the
   * Continue button. For a failure that retrying usually repeats, the button
   * alone would promise what the hint has to take back.
   */
  hintWithContinue?: boolean;
  /** Decision 140: the Continue button's own label, when `Continue` would promise too much. */
  continueLabel?: string;
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
  // dsh-rebase P1-7c (plan P1-7 shard 04 §7): on DSH the guarded family also
  // takes in the background-job tools (`job_*`) and `send_message`
  // (`loopGuard/constants.ts` DELEGATION_TOOL_NAMES), so the sentence names both.
  tool_call_repetition: {
    title: 'The model repeated the same tool calls, so its reply was stopped',
    reason:
      'The model kept writing the same subagent or background-task tool call in one reply without waiting for any result. This app interrupted that reply and ran none of the tool calls in it.',
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
  // dsh-rebase P1-3c (decision 020): the one engine process every chat runs
  // in went away under this turn — a crash, a hang, a lost connection. Main
  // reopens every chat by itself, so nothing stands in the way of a retry.
  dsh_host_crashed: {
    title: 'The chat engine stopped unexpectedly',
    reason:
      'The engine that runs your chats exited while this reply was being written, so the reply was cut off. Your chats reconnect by themselves.',
    hint: 'Continue to ask again.',
    action: 'continue',
    detail: false,
  },
  // decision 021 ladder B, or the locked card's "Restart engine": the engine
  // was restarted on purpose, for another chat, and took this turn with it.
  dsh_engine_restarted: {
    title: 'The chat engine was restarted',
    reason:
      'The engine was restarted to recover another chat, so this reply was interrupted. Your chats reconnect by themselves.',
    hint: 'Continue to carry on from here.',
    action: 'continue',
    detail: false,
  },
  // dsh-rebase P1-5b (decision 034): the engine asked Main for the model
  // service's key and got none — signed out, or the system keyring is locked.
  // Resending fails the same way until that changes, so no Continue.
  CREDENTIALS_UNAVAILABLE: {
    title: 'The model service key is not available',
    reason:
      'This app could not hand the engine a key for the model service: your sign-in has expired, or the system keyring is locked.',
    hint: 'Sign in again, or unlock the system keyring, then send your message again.',
    action: 'configure',
  },
  // dsh-rebase P1-7c (decision 106 rule 42): the four provider classes DSH
  // reports that no card above already says (`src/shared/dshFailureCodes.ts`).
  // DSH's own sentence stays under each as the detail. DSH has already retried
  // the transient ones by itself (`dsh-llm-retry`) before any of them lands.
  PROVIDER_UNAUTHORIZED: {
    title: 'The model service refused the key',
    reason:
      'The model service did not accept the key this app sent for this model: it is invalid, expired, or not allowed to use this model.',
    hint: 'Sign in again or check the model in settings, then send your message again.',
    action: 'configure',
  },
  PROVIDER_RATE_LIMITED: {
    title: 'The model service is limiting requests',
    reason:
      'The model service turned the request away because too many were sent, or the quota for this model is used up.',
    hint: 'Wait a moment and continue. If it keeps happening, check the quota or pick another model.',
    action: 'continue',
  },
  NETWORK_ERROR: {
    title: 'The model service could not be reached',
    reason: 'The connection to the model service failed before a reply came back.',
    hint: 'Check the network or proxy, then continue.',
    action: 'continue',
  },
  PROVIDER_ERROR: {
    title: 'The model service returned an error',
    reason:
      'The model service answered with an error, or with an empty or malformed reply, even after retrying.',
    hint: 'Continue to try again. If it fails the same way, send the detail below or pick another model.',
    action: 'continue',
  },
  // dsh-rebase P1-7e (decision 140): the bridge reads these off the
  // provider's own text (`classifyDshFailureText`), and the host never
  // retries them. A company gateway's stream gate refuses the reply before
  // the model's first byte; the same request is refused again, so the card
  // keeps its hint beside a Continue that says it is a long shot.
  GATEWAY_STREAM_GATE: {
    title: 'The company gateway cut off this reply',
    reason: 'The company gateway stopped this reply before the model started to answer.',
    hint: 'Retrying the same request usually fails again. Switch to another model or lower the thinking level, and forward the error detail to the gateway administrator.',
    action: 'continue',
    hintWithContinue: true,
    continueLabel: 'Continue anyway',
  },
  // Decision 146 (GW-2): the company gateway has no upstream left for this
  // model (`no_available_providers`, or its "every provider is unavailable"
  // sentence). Not retried automatically; a later try may still work, so the
  // card keeps a Continue, labelled like the gate's, with the hint beside it.
  GATEWAY_NO_UPSTREAM: {
    title: 'The company gateway has no model service available',
    reason:
      'The company gateway answered that none of the model services behind it can take this request right now, so it never reached a model.',
    hint: 'This was not retried automatically, because retrying right away gets the same answer. Switch to another model or try again later; if it keeps happening, forward the error detail to the gateway administrator.',
    action: 'continue',
    hintWithContinue: true,
    continueLabel: 'Continue anyway',
  },
  // The provider refused a parameter this model does not take (`"thinking.type.disabled"
  // is not supported for this model`, `… requires adaptive thinking`): nothing
  // changes until the settings do. Decision 165: the hint names the switch for
  // both directions and where it lives (decision 168: the model settings panel).
  MODEL_SETTING_UNSUPPORTED: {
    title: 'The model settings do not fit this model',
    reason:
      'The model service refused a setting this app sent with the request, because this model does not support it.',
    hint: 'For an AI service you added, open Settings · Models · AI services → Edit → Model settings and select this model: Claude Opus 4.6 / Sonnet 4.6 and later need Adaptive thinking on (API style Anthropic Messages); older models need it off. Or turn off Reasoning for this model. For a model your administrator provides, forward the detail to them. Then send your message again.',
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
 * dsh-rebase P1-4d1: a DSH session names a failed request in the native
 * runtime's provider vocabulary (`src/shared/dshFailureCodes.ts`). Three of
 * those codes mean exactly what a card above already says, so they read it.
 * The rest (`PROVIDER_UNAUTHORIZED`, `PROVIDER_RATE_LIMITED`, `NETWORK_ERROR`,
 * `PROVIDER_ERROR`) have cards of their own since P1-7c (plan P1-7 shard 04
 * §7), with DSH's own sentence as the detail.
 */
const FAILURE_CODE_ALIASES: Readonly<Record<string, KnownSessionFailureCode>> = {
  TIMEOUT: 'timeout',
  CONTEXT_TOO_LARGE: 'context_too_large',
  MODEL_NOT_CONFIGURED: 'model_missing',
};

/**
 * `errorCode` is a bare string on the wire — a newer runtime may send one this
 * build has never heard of, and that must render the fallback rather than
 * nothing. `Object.hasOwn`, not `in`: a code of `'constructor'` would otherwise
 * be a hit through the prototype.
 */
export function toSessionFailureCode(code: string | undefined | null): KnownSessionFailureCode {
  if (typeof code !== 'string' || code === '') return 'unknown';
  if (Object.hasOwn(FAILURE_VIEWS, code)) return code as KnownSessionFailureCode;
  return Object.hasOwn(FAILURE_CODE_ALIASES, code)
    ? (FAILURE_CODE_ALIASES[code] as KnownSessionFailureCode)
    : 'unknown';
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
    showsDetail: !('detail' in view && view.detail === false),
    ...('hintWithContinue' in view && view.hintWithContinue ? { hintWithContinue: true } : {}),
    ...('continueLabel' in view ? { continueLabel: view.continueLabel } : {}),
  };
}

/**
 * Whether a Continue affordance may be shown at all.
 *
 * Two conditions, both load-bearing:
 *
 *  - the reason allows it (`action === 'continue'`), because a button that
 *    cannot work is worse than no button;
 *  - there IS a prompt in the transcript. A failure that happened before any
 *    user message existed (a create handshake that never got that far) has no
 *    turn to retry (T135: Continue re-runs the failed turn, it does not resend
 *    the prompt), and the card falls back to its written hint.
 *
 * Whether it may be PRESSED yet is a separate question — the failure must have
 * settled first; see `continueBlockedReason` in `retryLastTurn.ts`.
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
