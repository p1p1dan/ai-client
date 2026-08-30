import { HISTORY_MESSAGE_ID_PREFIX } from '@shared/types/sessionHistory';
import type { SendPhase } from './attachments';

/**
 * T-31 turn-head decision layer (review batch F1 / F2 / F4 / F12).
 *
 * Everything in this module used to be an inline expression inside
 * `MessageTimeline.tsx` — which is exactly why the adversarial review found
 * three defects in it at once. These are the wiring decisions with the highest
 * blast radius in the whole reply anatomy (which turn owns the live status,
 * which turn owns a session failure, what the head degrades to when T-06
 * metadata does not exist), and a node-only vitest can assert every one of them
 * as a truth table as long as they are plain functions over plain data.
 *
 * No store import, no React import, no `MessageMetadata` import: the metadata
 * shape below is declared structurally so this file stays a leaf.
 */

/**
 * The three T-06 metadata fields the head reasons about. Structurally
 * compatible with `MessageMetadata` — declared here so this module does not
 * depend on the registry that produces it.
 */
export interface TurnHeadMetadata {
  startedAt?: number | null;
  completedAt?: number | null;
  latencyMs?: number | null;
}

/**
 * Session statuses that mean "this turn is still in flight" for the purposes of
 * the turn shell (F12).
 *
 * Deliberately NOT `thinkingCard.isTurnActive`, and deliberately not a change
 * to it: that predicate answers "is a thinking block still streaming", where
 * `waiting_permission` / `waiting_question` are correctly false (nothing is
 * streaming while the CLI waits on the user). The turn SHELL needs the opposite
 * answer — during an authorization wait the head must not disappear and the
 * `Collapsible` must not unmount, or the very card the user has to answer
 * flickers out from under the mouse. Two questions, two predicates.
 */
export function isTurnInFlight(status: string): boolean {
  return (
    status === 'running' ||
    status === 'starting' ||
    status === 'waiting_permission' ||
    status === 'waiting_question'
  );
}

/**
 * Live evidence that a turn holds a message which STARTED and never completed.
 *
 * This is the shared judgement behind F2 (which turn does an in-flight send
 * describe) and F4 (which turn owns a session failure). Both used to key off
 * `latencyMs == null`, which is true for three completely different situations:
 * a turn that is genuinely mid-flight, a turn that was interrupted, and a
 * replayed history turn that never had metadata at all. Only the first has a
 * `message.started` with no `message.completed` behind it, so that pair — not
 * the absence of a latency — is the actual signal.
 *
 * Consequence that matters most: restored history produces NO metadata
 * whatsoever, so `startedAt` is `undefined` and this returns false. A hydrated
 * session can therefore never be mistaken for an in-flight one.
 */
export function hasLiveTurnEvidence(
  bodyMetadata: readonly (TurnHeadMetadata | undefined)[]
): boolean {
  return bodyMetadata.some(
    (metadata) => metadata != null && metadata.startedAt != null && metadata.completedAt == null
  );
}

/**
 * Is this the id of a REPLAYED history message rather than a runtime one?
 *
 * `agent-host/historyReader.ts` mints every replayed message as
 * `` `${HISTORY_MESSAGE_ID_PREFIX}${uuid}` `` (its two mint sites, plus the
 * per-block `…:0` form), and `shared/types/sessionHistory.ts` states the prefix
 * as contract — `historyReplayMerge.ts` and the store's own replace semantics
 * already depend on it. The constant is imported, never re-spelled, so this
 * cannot drift from the mint.
 *
 * Exported here rather than added to the shared module because two of the four
 * existing inline `startsWith` call sites live in the red-line
 * `chatSessions.ts`; consolidating them is out of scope for this batch.
 */
export function isReplayedMessageId(messageId: string): boolean {
  return messageId.startsWith(HISTORY_MESSAGE_ID_PREFIX);
}

export interface TurnOpenedBySendInput {
  /** The turn was opened by a user message. */
  hasUser: boolean;
  /** The turn has no body message yet. */
  bodyEmpty: boolean;
  /** That user message's id; `null` for an orphan turn. */
  userMessageId: string | null;
  /** A send-begin baseline is known for THIS session (`turnSendStatus.baseline`). */
  baselineKnown: boolean;
  /** Last message id in the bucket when the last send began; `null` for a then-empty session. */
  baselineMessageId: string | null;
}

/**
 * Was this turn opened by the most recent send — i.e. is its user message the
 * Host's echo of a prompt committed after that send began?
 *
 * The shape `hasUser && bodyEmpty` is NOT sufficient on its own, and that was
 * the residual defect the final review caught. `historyReader` preserves a
 * trailing user message with no reply, and `groupMessagesIntoTurns` folds it
 * into a turn with exactly that shape — so a restored session whose transcript
 * ends in an unanswered prompt presents a turn indistinguishable from a fresh
 * echo. Both `deriveSendStatusBinding` and `ownsSessionFailure` used the shape
 * alone, and the guard that saved every OTHER restored case (the `handshake`
 * rung) sits *below* it, so it never ran. A previously abandoned runtime turn
 * (Stop, or the deliberate 45s abandon) has the same shape and the same
 * problem.
 *
 * Identity settles it, through TWO conjunctive guards. Neither is sufficient
 * alone, and the pair is not redundant — each covers what the other cannot.
 *
 * **Guard 1, the replayed-id test.** Covers a history turn hydrated at ANY
 * moment, including after the baseline was sampled. That timing is real, not
 * theoretical: for a resumable session whose bucket is still empty, `runSend`
 * samples `baseline = null`, its resume branch then waits only for
 * `session.resumed`, and the Host runs `replayHistory` DETACHED
 * (`claudeRuntime.ts`'s `void this.replayHistory(input)`) — so `session.history`
 * can hydrate a trailing user-only turn after the baseline and before the echo.
 * Against `baseline = null` the id comparison alone says `'h:u-x' !== null`,
 * i.e. "this send opened it", which is exactly wrong.
 *
 * **Guard 2, the baseline comparison.** Covers what guard 1 cannot: a PREVIOUS
 * runtime send whose turn never received a reply (Stop, or the 45s abandon that
 * deliberately leaves the turn running). That turn carries a runtime id, so no
 * id-shape test can exclude it; only "this message already existed when the
 * send began" can. Three facts make the comparison safe rather than clever:
 *  - the baseline is captured before `chat.send`, so no echo can be in it;
 *  - a T-19 queue release calls `begin` once per entry, strictly in sequence,
 *    so consecutive sends each advance the baseline past the previous turn;
 *  - with no baseline at all (no send in this session since the window opened)
 *    the answer is `false` — conservative, and correct, since a user-only turn
 *    can then only be restored history.
 */
export function isTurnOpenedByCurrentSend(input: TurnOpenedBySendInput): boolean {
  if (!input.hasUser || !input.bodyEmpty) return false;
  if (input.userMessageId == null) return false;
  // Guard 1: a replayed message was never opened by a send, whenever it landed.
  if (isReplayedMessageId(input.userMessageId)) return false;
  // Guard 2: it must not have existed when this send began.
  if (!input.baselineKnown) return false;
  return input.userMessageId !== input.baselineMessageId;
}

/** Where the composer's in-flight snapshot is painted (§3.3). */
export type TurnSendBinding = 'attached' | 'pending';

export interface SendStatusBindingInput {
  /** The session has at least one turn. */
  hasLastTurn: boolean;
  /** The last turn was opened by a user message (not an orphan history turn). */
  lastTurnHasUser: boolean;
  /** The last turn has not received a single body message yet. */
  lastTurnBodyEmpty: boolean;
  /** The last turn's user message id, for the baseline comparison. */
  lastTurnUserMessageId: string | null;
  /** A send-begin baseline is known for this session. */
  baselineKnown: boolean;
  /** Last message id in the bucket when the last send began. */
  baselineMessageId: string | null;
  /** Send phase of the snapshot being bound. */
  phase: SendPhase;
  /** The session is in flight (`isTurnInFlight`). */
  sessionActive: boolean;
  /** `hasLiveTurnEvidence` over the last turn's body metadata. */
  lastTurnHasLiveMessage: boolean;
}

/**
 * Which turn an in-flight send's status describes (§3.3).
 *
 * `attached` paints the snapshot into the last turn's head; `pending` renders
 * it as a standalone head below the last turn (`PendingTurnHead`).
 *
 * Branch order and why:
 *  1. **No turns at all** — a fresh session, or a send whose user echo has not
 *     landed. There is nothing to attach to; the standalone head is the only
 *     thing keeping the waiting state on screen at all.
 *  2. **The last turn is the one this send opened** — its user message has been
 *     echoed back by the Host and no reply has arrived. This is the normal
 *     attached case, and it is a POSITIVE test ("this turn was just opened")
 *     rather than the old negative one ("this turn has no latency"), which was
 *     also true of every restored, stopped and abandoned turn in the session.
 *     `isTurnOpenedByCurrentSend` — not the turn's shape — is what decides it:
 *     a restored transcript ending in an unanswered prompt has the identical
 *     shape and would otherwise match here, ABOVE the handshake guard that
 *     catches every other restored case.
 *  3. **Handshake** — nothing has been transmitted yet, so the turn this send
 *     belongs to definitionally does not exist. Whatever the last turn is
 *     (a completed one, a restored one, an abandoned one), it is not this
 *     send's. This is the branch that keeps a new send's "Starting Agent
 *     Host…" from overwriting the previous turn's `Worked for Ns`.
 *  4. Otherwise the snapshot is only attached while the last turn actually
 *     shows live evidence AND the session is running — the short window
 *     between the first streamed block and `runSend` returning, where flipping
 *     to `pending` would render a second head below a turn that already has
 *     one.
 */
export function deriveSendStatusBinding(input: SendStatusBindingInput): TurnSendBinding {
  if (!input.hasLastTurn) return 'pending';
  const openedByThisSend = isTurnOpenedByCurrentSend({
    hasUser: input.lastTurnHasUser,
    bodyEmpty: input.lastTurnBodyEmpty,
    userMessageId: input.lastTurnUserMessageId,
    baselineKnown: input.baselineKnown,
    baselineMessageId: input.baselineMessageId,
  });
  if (openedByThisSend) return 'attached';
  if (input.phase === 'handshake') return 'pending';
  return input.sessionActive && input.lastTurnHasLiveMessage ? 'attached' : 'pending';
}

export interface TurnFailureOwnershipInput {
  isLastTurn: boolean;
  /** `sessionStatus === 'failed'`. */
  sessionFailed: boolean;
  /** The turn was opened by a user message. */
  hasUser: boolean;
  /** The turn has no body message yet. */
  bodyEmpty: boolean;
  /** The turn's user message id, for the baseline comparison. */
  userMessageId: string | null;
  /** A send-begin baseline is known for this session. */
  baselineKnown: boolean;
  /** Last message id in the bucket when the last send began. */
  baselineMessageId: string | null;
  /** The turn's last assistant message carries a `latencyMs` (it finished). */
  turnComplete: boolean;
  /** `hasLiveTurnEvidence` over this turn's body metadata. */
  hasLiveMessage: boolean;
}

/**
 * Does this turn own the session's failure (§9-ζ / F4)?
 *
 * A red `Failed` head REPLACES the whole `Worked for Ns · 3 tools…` row, so
 * getting this wrong rewrites the record of a turn that succeeded. The old
 * judgement was `isLastTurn && sessionStatus === 'failed'`, which mislabels two
 * common cases: a completed turn followed by a failure that belongs to the
 * NEXT send (the user echo has not landed, so the completed turn is still
 * last), and a restored history turn in a session that later failed.
 *
 * The failure is only this turn's when the turn is demonstrably unfinished:
 *  - it was opened by the send that was running (`isTurnOpenedByCurrentSend`), or
 *  - one of its messages started and never completed (`hasLiveMessage`).
 *
 * A completed turn (`turnComplete`) is excluded outright, and a restored
 * history turn produces neither piece of evidence (no metadata at all), so it
 * falls through to `false` and keeps rendering flat. A pre-admission failure —
 * no turn exists yet — has no owner here at all and is left to the
 * session-level failure block, whose position §9-ζ keeps unchanged.
 *
 * The first bullet is a baseline comparison rather than the shape test
 * `hasUser && bodyEmpty` it replaces (final review): a restored transcript
 * ending in an unanswered prompt has exactly that shape and no metadata, so the
 * shape test stamped a red `Failed` on a turn from a previous day. This is also
 * why the baseline outlives `end()` — by the time `session.failed` lands, the
 * send's own `finally` has usually already cleared the live snapshot.
 */
export function ownsSessionFailure(input: TurnFailureOwnershipInput): boolean {
  if (!input.isLastTurn || !input.sessionFailed) return false;
  if (input.turnComplete) return false;
  if (
    isTurnOpenedByCurrentSend({
      hasUser: input.hasUser,
      bodyEmpty: input.bodyEmpty,
      userMessageId: input.userMessageId,
      baselineKnown: input.baselineKnown,
      baselineMessageId: input.baselineMessageId,
    })
  ) {
    return true;
  }
  return input.hasLiveMessage;
}

/*
 * `TurnHeadModel` / `TurnHeadInput` / `deriveTurnHeadModel` retired with the
 * turn meta row (T12-b, user decision 2026-08-29: follow pi-app and delete it).
 *
 * The chain was `status ?? workedFor ?? stats ?? thought ?? bare`, and the last
 * four rungs all answered one question: what should a FINISHED turn say about
 * itself when no duration was ever measured? F1 added them because a restored
 * history turn replays no T-06 metadata, so it used to print nothing at all
 * about a turn that plainly did work.
 *
 * Under pi-app's model a finished turn says nothing about itself, restored or
 * not — so the question the rungs answered no longer arises. Only the top rung
 * survives, and `MessageTimeline` now renders it directly: `status` is the sole
 * on-screen evidence that a turn is running, stalled, retrying or failed, which
 * is why F2's "lost stopwatch" defect was about this row and not the others.
 *
 * The other half of F1's claim — "`hasProcess` implies a non-null head", which
 * let `collapsible` be decided without waiting for metadata — expired earlier,
 * when D56 retired turn-level collapse entirely (2026-08-25).
 */
