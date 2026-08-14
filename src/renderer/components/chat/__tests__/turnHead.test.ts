import { describe, expect, it } from 'vitest';
import {
  deriveSendStatusBinding,
  deriveTurnHeadModel,
  hasLiveTurnEvidence,
  isTurnInFlight,
  isTurnOpenedByCurrentSend,
  ownsSessionFailure,
  type SendStatusBindingInput,
  type TurnFailureOwnershipInput,
  type TurnHeadInput,
  type TurnHeadMetadata,
  type TurnOpenedBySendInput,
} from '../turnHead';
import type { TurnStatus } from '../turnStatus';
import type { WorkedForRowText } from '../turnTiming';

/**
 * T-31 review batch, F1 / F2 / F4 / F12.
 *
 * These four functions are the timeline's wiring decisions — the ones that say
 * WHICH turn a live status belongs to, WHICH turn owns a failure, and what a
 * turn with no metadata is allowed to say. Every defect this batch fixed was an
 * inline expression that looked obviously right and was wrong for the one input
 * class nobody enumerated (restored history, which produces no metadata at
 * all). Hence: truth tables, with the history case present in every one.
 */

const STATUS: TurnStatus = { kind: 'awaiting', text: 'Waiting for the model…' };
const WORKED_FOR: WorkedForRowText = {
  verb: 'Worked for',
  arg: '1m 6s · 3 tools, 11 searches',
  argKind: 'prose',
};

const headInput = (over: Partial<TurnHeadInput> = {}): TurnHeadInput => ({
  status: null,
  workedFor: null,
  stats: null,
  hasProcess: false,
  thoughtOnly: false,
  ...over,
});

describe('deriveTurnHeadModel (F1)', () => {
  it('prefers the in-flight status over everything else', () => {
    const head = deriveTurnHeadModel(
      headInput({ status: STATUS, workedFor: WORKED_FOR, stats: '3 tools', hasProcess: true })
    );
    expect(head).toEqual({ kind: 'status', status: STATUS });
  });

  it('falls back to the completed row when there is no live status', () => {
    const head = deriveTurnHeadModel(
      headInput({ workedFor: WORKED_FOR, stats: '3 tools', hasProcess: true })
    );
    expect(head).toEqual({ kind: 'workedFor', row: WORKED_FOR });
  });

  // The whole reason this chain exists: a replayed history turn has neither a
  // status nor a latency, so both rungs above return null. Before F1 that meant
  // no head, which meant no trigger, which meant `collapsible === false` and a
  // force-expanded turn — §4.3's "restored history defaults to collapsed" was
  // unreachable and the reference shot's default state never appeared.
  it('F1: a restored history turn degrades to its call counts, not to nothing', () => {
    const head = deriveTurnHeadModel(
      headInput({ stats: '3 tools, 11 searches', hasProcess: true })
    );
    expect(head).toEqual({ kind: 'stats', text: '3 tools, 11 searches' });
  });

  it('F1: with no counts either, a turn with a process segment still gets a bare trigger', () => {
    expect(deriveTurnHeadModel(headInput({ hasProcess: true }))).toEqual({ kind: 'bare' });
  });

  // A replayed turn whose entire process is one thought has no tool run to
  // count, so `stats` is null — before this rung existed the chain fell
  // straight to `bare`, discarding the one thing the turn actually has to
  // say. D25 §2.4's bare "Thought, no arg" convention, one level up from the
  // per-row shape it was written for.
  it('thoughtOnly: a thinking-only process degrades to "Thought", not to a bare chevron', () => {
    const head = deriveTurnHeadModel(headInput({ hasProcess: true, thoughtOnly: true }));
    expect(head).toEqual({ kind: 'thought' });
  });

  // Priority: `thoughtOnly` sits BELOW `stats` in the chain — a turn that also
  // ran a tool has real counts to print, and `deriveTurnStats` only sets
  // `thoughtOnly` when it counted zero tool runs, but the two inputs are
  // independent at this layer, so the ordering itself must be asserted.
  it('thoughtOnly: stats still wins over "Thought" when both are set', () => {
    const head = deriveTurnHeadModel(
      headInput({ hasProcess: true, thoughtOnly: true, stats: '3 tools' })
    );
    expect(head).toEqual({ kind: 'stats', text: '3 tools' });
  });

  // Mutation check: with `thoughtOnly` false, the chain must still fall all
  // the way to `bare` — proves the new rung does not swallow the pre-existing
  // "no counts, no thought, but still a process segment" case.
  it('thoughtOnly: false leaves the bare-chevron case reachable', () => {
    expect(deriveTurnHeadModel(headInput({ hasProcess: true, thoughtOnly: false }))).toEqual({
      kind: 'bare',
    });
  });

  // The contrapositive is the invariant `MessageTimeline` relies on to decide
  // `collapsible` from `process.length > 0` alone.
  it('F1: hasProcess always yields a head — for every combination of the other four', () => {
    for (const status of [null, STATUS]) {
      for (const workedFor of [null, WORKED_FOR]) {
        for (const stats of [null, '', '2 tools']) {
          for (const thoughtOnly of [false, true]) {
            expect(
              deriveTurnHeadModel(
                headInput({ status, workedFor, stats, hasProcess: true, thoughtOnly })
              )
            ).not.toBeNull();
          }
        }
      }
    }
  });

  it('F1: with nothing to say and nothing to collapse, there is no head row at all', () => {
    expect(deriveTurnHeadModel(headInput())).toBeNull();
    expect(deriveTurnHeadModel(headInput({ stats: '' }))).toBeNull();
  });

  // A07 :2399 — the fallbacks print counts derived from `blocks`, never a
  // duration nothing measured. Nothing below may ever grow a "0s" branch.
  it('F1: no fallback rung fabricates a duration', () => {
    const stats = deriveTurnHeadModel(headInput({ stats: '3 tools', hasProcess: true }));
    expect(JSON.stringify(stats)).not.toMatch(/\d+\s*s\b/);
    expect(JSON.stringify(deriveTurnHeadModel(headInput({ hasProcess: true })))).not.toMatch(/\d/);
    expect(
      JSON.stringify(deriveTurnHeadModel(headInput({ hasProcess: true, thoughtOnly: true })))
    ).not.toMatch(/\d/);
  });
});

describe('hasLiveTurnEvidence (F2 / F4 shared judgement)', () => {
  it('true only for a message that started and never completed', () => {
    expect(hasLiveTurnEvidence([{ startedAt: 1000 }])).toBe(true);
  });

  it('false once the message completed', () => {
    expect(hasLiveTurnEvidence([{ startedAt: 1000, completedAt: 2000, latencyMs: 1000 }])).toBe(
      false
    );
  });

  // Restored history carries no T-06 metadata whatsoever — this is the input
  // class that made `latencyMs == null` an unusable proxy for "in flight".
  it('F2/F4: a restored history turn (no metadata at all) is never live', () => {
    expect(hasLiveTurnEvidence([undefined, undefined])).toBe(false);
    expect(hasLiveTurnEvidence([])).toBe(false);
    expect(hasLiveTurnEvidence([{}])).toBe(false);
  });

  it('scans the whole body, not just its last message', () => {
    const body: (TurnHeadMetadata | undefined)[] = [
      { startedAt: 1, completedAt: 2, latencyMs: 1 },
      { startedAt: 3 },
    ];
    expect(hasLiveTurnEvidence(body)).toBe(true);
  });
});

describe('isTurnInFlight (F12)', () => {
  it('F12: an authorization / question wait still counts as in flight', () => {
    expect(isTurnInFlight('waiting_permission')).toBe(true);
    expect(isTurnInFlight('waiting_question')).toBe(true);
  });

  it('covers the two streaming statuses', () => {
    expect(isTurnInFlight('running')).toBe(true);
    expect(isTurnInFlight('starting')).toBe(true);
  });

  it('every terminal / idle status is not in flight', () => {
    for (const status of ['idle', 'stopping', 'completed', 'failed', 'disconnected']) {
      expect(isTurnInFlight(status)).toBe(false);
    }
  });
});

/**
 * Message-id conventions, mirroring production so the scenarios below are the
 * real ones rather than shapes invented for the test:
 *  - replayed history messages carry `shared/types/sessionHistory.ts`'s `h:`
 *    prefix (minted in `agent-host/historyReader.ts`);
 *  - runtime messages — including the Host's echo of the user's own prompt —
 *    do not.
 *
 * The prefix is NOT what the code under test compares (a previously abandoned
 * runtime turn is user-only too, and carries a runtime id); it is here so a
 * reader can see at a glance which scenario each id belongs to.
 */
const HISTORY_USER_ANSWERED = 'h:u-answered';
const HISTORY_REPLY = 'h:a-answered';
/** The trailing prompt `historyReader` preserves when the transcript ends without a reply. */
const HISTORY_USER_UNANSWERED = 'h:u-unanswered';
/** The Host's echo of the prompt THIS send committed. */
const ECHO_USER = 'm-echo';
/** A previous runtime send's echo whose turn never received a reply (Stop / the 45s abandon). */
const ABANDONED_USER = 'm-abandoned';

describe('isTurnOpenedByCurrentSend (F2/F4 residue)', () => {
  const opened = (over: Partial<TurnOpenedBySendInput> = {}): TurnOpenedBySendInput => ({
    hasUser: true,
    bodyEmpty: true,
    userMessageId: ECHO_USER,
    baselineKnown: true,
    baselineMessageId: HISTORY_REPLY,
    ...over,
  });

  it('a user message that did not exist when the send began opened this turn', () => {
    expect(isTurnOpenedByCurrentSend(opened())).toBe(true);
  });

  // THE residual defect: `historyReader` preserves a trailing unanswered
  // prompt, `groupMessagesIntoTurns` folds it into `user !== null,
  // body.length === 0` — the exact shape of a fresh echo. The baseline is what
  // separates them: that prompt IS the last message at the send's commit point.
  it('F2/F4 residue: a restored unanswered prompt did NOT open this turn', () => {
    expect(
      isTurnOpenedByCurrentSend(
        opened({
          userMessageId: HISTORY_USER_UNANSWERED,
          baselineMessageId: HISTORY_USER_UNANSWERED,
        })
      )
    ).toBe(false);
  });

  // Same shape, runtime id: the id prefix alone would wrongly admit this one.
  it('F2/F4 residue: a previously abandoned runtime turn did NOT open this turn', () => {
    expect(
      isTurnOpenedByCurrentSend(
        opened({ userMessageId: ABANDONED_USER, baselineMessageId: ABANDONED_USER })
      )
    ).toBe(false);
  });

  it('an empty session baseline still admits the first echo', () => {
    expect(isTurnOpenedByCurrentSend(opened({ baselineMessageId: null }))).toBe(true);
  });

  // The timing the second review round found, and the reason the replayed-id
  // guard is CONJUNCTIVE with the baseline rather than an alternative to it.
  // For a resumable session whose bucket is still empty, `runSend` samples
  // `baseline = null`; its resume branch waits only for `session.resumed`, and
  // the Host runs `replayHistory` detached — so `session.history` can hydrate a
  // trailing user-only turn AFTER the baseline and BEFORE the echo. Against a
  // null baseline the id comparison alone reads `'h:u-x' !== null` -> "this
  // send opened it", which is exactly backwards.
  it('F2 residue II: history hydrated AFTER a null baseline is still not this send turn', () => {
    expect(
      isTurnOpenedByCurrentSend(
        opened({ userMessageId: HISTORY_USER_UNANSWERED, baselineMessageId: null })
      )
    ).toBe(false);
  });

  // Neither guard is redundant: this is the case the replayed-id test cannot
  // see (runtime id) and the baseline can, and the case above is the reverse.
  it('the two guards are conjunctive — neither covers the other case', () => {
    // Runtime id, already present at the baseline -> excluded by the baseline only.
    expect(
      isTurnOpenedByCurrentSend(
        opened({ userMessageId: ABANDONED_USER, baselineMessageId: ABANDONED_USER })
      )
    ).toBe(false);
    // Replayed id, absent from the baseline -> excluded by the id guard only.
    expect(
      isTurnOpenedByCurrentSend(
        opened({ userMessageId: HISTORY_USER_UNANSWERED, baselineMessageId: 'm-something-else' })
      )
    ).toBe(false);
  });

  it('every replayed id shape is excluded, whatever the baseline says', () => {
    for (const baselineMessageId of [null, 'm-runtime', HISTORY_REPLY, HISTORY_USER_UNANSWERED]) {
      expect(
        isTurnOpenedByCurrentSend(
          opened({ userMessageId: HISTORY_USER_UNANSWERED, baselineMessageId })
        )
      ).toBe(false);
    }
  });

  // No send since this window opened: a user-only turn can then only be
  // restored history, so the conservative answer is the correct one.
  it('with no baseline at all, nothing claims to have been opened by a send', () => {
    expect(isTurnOpenedByCurrentSend(opened({ baselineKnown: false }))).toBe(false);
    expect(
      isTurnOpenedByCurrentSend(opened({ baselineKnown: false, baselineMessageId: null }))
    ).toBe(false);
  });

  it('a turn with a reply, or with no user message, is out of scope', () => {
    expect(isTurnOpenedByCurrentSend(opened({ bodyEmpty: false }))).toBe(false);
    expect(isTurnOpenedByCurrentSend(opened({ hasUser: false, userMessageId: null }))).toBe(false);
  });
});

const binding = (over: Partial<SendStatusBindingInput> = {}): SendStatusBindingInput => ({
  hasLastTurn: true,
  lastTurnHasUser: true,
  lastTurnBodyEmpty: false,
  lastTurnUserMessageId: HISTORY_USER_ANSWERED,
  baselineKnown: true,
  baselineMessageId: HISTORY_REPLY,
  phase: 'handshake',
  sessionActive: false,
  lastTurnHasLiveMessage: false,
  ...over,
});

/** Restored transcript ending in an ANSWERED prompt; a new send has just begun. */
const restoredAnswered = (over: Partial<SendStatusBindingInput> = {}) =>
  binding({
    lastTurnHasUser: true,
    lastTurnBodyEmpty: false,
    lastTurnUserMessageId: HISTORY_USER_ANSWERED,
    baselineMessageId: HISTORY_REPLY,
    ...over,
  });

/**
 * Restored transcript ending in an UNANSWERED prompt (`historyReader` keeps
 * it); a new send has just begun, so the baseline is that very prompt.
 */
const restoredUnanswered = (over: Partial<SendStatusBindingInput> = {}) =>
  binding({
    lastTurnHasUser: true,
    lastTurnBodyEmpty: true,
    lastTurnUserMessageId: HISTORY_USER_UNANSWERED,
    baselineMessageId: HISTORY_USER_UNANSWERED,
    ...over,
  });

describe('deriveSendStatusBinding (F2)', () => {
  // Scenario: the very first message of a session. Nothing exists to attach to,
  // and the standalone head is the only thing on screen saying anything is
  // happening at all (§3.3).
  it('F2: first message of a session -> pending', () => {
    expect(deriveSendStatusBinding(binding({ hasLastTurn: false, baselineMessageId: null }))).toBe(
      'pending'
    );
  });

  // Scenario: normal follow-up, past the user echo. The Host has written the
  // user's message back, opening a turn with no reply yet — this send owns it.
  it('F2: the turn this send just opened -> attached', () => {
    const echoTurn = binding({
      lastTurnBodyEmpty: true,
      lastTurnUserMessageId: ECHO_USER,
      baselineMessageId: HISTORY_REPLY,
    });
    expect(deriveSendStatusBinding(echoTurn)).toBe('attached');
    expect(deriveSendStatusBinding({ ...echoTurn, phase: 'awaiting' })).toBe('attached');
  });

  // Scenario: restored history, then a new send. The old test (`no latency`)
  // was true of every replayed turn, so the handshake was painted onto the last
  // history turn's head and `PendingTurnHead` never rendered — the waiting
  // window showed nothing at all.
  it('F2: restored history + new send during the handshake -> pending', () => {
    expect(deriveSendStatusBinding(restoredAnswered({ phase: 'handshake' }))).toBe('pending');
  });

  // THE residue the final review caught. `historyReader` preserves a trailing
  // prompt that never got a reply, so the last restored turn is `user !== null,
  // body.length === 0` — structurally identical to a fresh echo, and matching
  // ABOVE the handshake guard that catches the answered case above. Without the
  // baseline this old turn claims the new send's clock.
  it('F2 residue: restored history ENDING IN AN UNANSWERED PROMPT + new send -> pending', () => {
    expect(deriveSendStatusBinding(restoredUnanswered({ phase: 'handshake' }))).toBe('pending');
    expect(deriveSendStatusBinding(restoredUnanswered({ phase: 'awaiting' }))).toBe('pending');
    // Even with the session already running (a resume that replays into a live
    // session), the restored prompt has no live metadata of its own.
    expect(
      deriveSendStatusBinding(restoredUnanswered({ phase: 'awaiting', sessionActive: true }))
    ).toBe('pending');
  });

  /**
   * Second review round: resume hydrates history in the middle of a send.
   *
   * Reachable order — resumable session (runtimeIdentity known, not Host-bound)
   * whose `messages[sessionId]` bucket is still EMPTY, user sends straight
   * away:
   *   1. `runSend` samples `baseline = null` (bucket empty);
   *   2. the resume branch dispatches and waits only for `session.resumed`;
   *   3. the Host emits `session.resumed`, then runs `replayHistory` DETACHED;
   *   4. `session.history` lands and hydrates a trailing `h:` user-only turn;
   *   5. the echo has still not arrived.
   * At step 5 the baseline comparison alone reads `'h:u-unanswered' !== null`
   * -> attached, and the just-restored prompt would wear this send's spinner.
   */
  it('F2 residue II: history hydrated between baseline and echo -> pending', () => {
    expect(
      deriveSendStatusBinding(restoredUnanswered({ baselineMessageId: null, phase: 'handshake' }))
    ).toBe('pending');
    expect(
      deriveSendStatusBinding(restoredUnanswered({ baselineMessageId: null, phase: 'awaiting' }))
    ).toBe('pending');
  });

  // Both arrival orders end up bound correctly.
  //
  // `resumed -> history -> echo`: the case above, then the echo opens a new
  // last turn with a runtime id -> attached.
  //
  // `resumed -> echo -> history`: DEPENDS ON `historyReplayMerge`'s ordering —
  // `mergeReplayedHistory` returns `[...historyMessages, ...runtime]` on every
  // path, so a late replay is spliced BEFORE the live rows and the echo turn
  // stays last. If that ordering ever changes, this assertion is the one that
  // should fail.
  it('F2 residue II: both hydration orders end bound to the echo turn', () => {
    const echoTurnAfterHistory = binding({
      lastTurnBodyEmpty: true,
      lastTurnUserMessageId: ECHO_USER,
      baselineMessageId: null,
      phase: 'awaiting',
    });
    expect(deriveSendStatusBinding(echoTurnAfterHistory)).toBe('attached');
    // Same inputs whichever order they arrived in: the last turn is the echo
    // turn and its id is a runtime one either way.
    expect(deriveSendStatusBinding({ ...echoTurnAfterHistory, phase: 'handshake' })).toBe(
      'attached'
    );
  });

  // Scenario: Stop, then a new send. The interrupted turn keeps a
  // started-never-completed message forever, but the session is idle, so it
  // cannot claim the new send's clock.
  it('F2: Stop-interrupted turn + new send -> pending', () => {
    expect(
      deriveSendStatusBinding(
        binding({ phase: 'handshake', lastTurnHasLiveMessage: true, sessionActive: false })
      )
    ).toBe('pending');
    expect(
      deriveSendStatusBinding(
        binding({ phase: 'awaiting', lastTurnHasLiveMessage: true, sessionActive: false })
      )
    ).toBe('pending');
  });

  // T-19 releases a queue strictly one entry at a time, each with its own
  // `begin`, so the baseline advances past the turn the previous entry opened.
  // Entry 2 must therefore not paint onto entry 1's still-unanswered turn.
  it('F2: consecutive queued sends do not bind entry 2 to entry 1 turn', () => {
    expect(
      deriveSendStatusBinding(
        binding({
          lastTurnBodyEmpty: true,
          lastTurnUserMessageId: ABANDONED_USER,
          baselineMessageId: ABANDONED_USER,
          phase: 'handshake',
        })
      )
    ).toBe('pending');
  });

  // Scenario: a completed turn is still last because the next send's echo has
  // not landed. Attaching here is what used to overwrite that turn's
  // `Worked for Ns` with "Starting Agent Host…".
  it('F2: completed turn + a fresh send -> pending', () => {
    expect(deriveSendStatusBinding(binding({ phase: 'handshake' }))).toBe('pending');
  });

  // The one case where a non-empty body still owns the snapshot: the first
  // block has landed but `runSend` has not returned yet. Flipping to `pending`
  // here would render a second head under a turn that already has one.
  it('F2: the first streamed block does not detach the live snapshot', () => {
    expect(
      deriveSendStatusBinding(
        binding({ phase: 'awaiting', sessionActive: true, lastTurnHasLiveMessage: true })
      )
    ).toBe('attached');
  });

  it('F2: an orphan history turn (no user message) never claims a send', () => {
    expect(
      deriveSendStatusBinding(
        binding({
          lastTurnHasUser: false,
          lastTurnBodyEmpty: true,
          lastTurnUserMessageId: null,
          phase: 'handshake',
        })
      )
    ).toBe('pending');
  });
});

const failure = (over: Partial<TurnFailureOwnershipInput> = {}): TurnFailureOwnershipInput => ({
  isLastTurn: true,
  sessionFailed: true,
  hasUser: true,
  bodyEmpty: false,
  userMessageId: HISTORY_USER_ANSWERED,
  baselineKnown: true,
  baselineMessageId: HISTORY_REPLY,
  turnComplete: false,
  hasLiveMessage: false,
  ...over,
});

/** The turn the failing send opened: its echo landed, no reply followed. */
const openEchoTurn = (over: Partial<TurnFailureOwnershipInput> = {}) =>
  failure({ bodyEmpty: true, userMessageId: ECHO_USER, baselineMessageId: HISTORY_REPLY, ...over });

/** Restored transcript ending in an unanswered prompt, in a session that later failed. */
const restoredUnansweredTurn = (over: Partial<TurnFailureOwnershipInput> = {}) =>
  failure({
    bodyEmpty: true,
    userMessageId: HISTORY_USER_UNANSWERED,
    baselineMessageId: HISTORY_USER_UNANSWERED,
    ...over,
  });

describe('ownsSessionFailure (F4)', () => {
  // ① a completed turn A, then a failure with no new user message: A must keep
  //    its `Worked for Ns · 3 tools…` row. Replacing it with a red `Failed`
  //    rewrites the record of a turn that succeeded.
  it('F4 ①: a completed turn never absorbs a later failure', () => {
    expect(ownsSessionFailure(failure({ turnComplete: true }))).toBe(false);
    expect(ownsSessionFailure(failure({ turnComplete: true, hasLiveMessage: true }))).toBe(false);
    expect(ownsSessionFailure(openEchoTurn({ turnComplete: true }))).toBe(false);
  });

  // ② an open turn B fails: B owns it, in both of its shapes (no reply yet, or
  //    a reply that started and never finished).
  it('F4 ②: the open turn owns the failure', () => {
    expect(ownsSessionFailure(openEchoTurn())).toBe(true);
    expect(ownsSessionFailure(failure({ hasLiveMessage: true }))).toBe(true);
  });

  // ③ pre-admission failure on an empty session: no turn exists, so the
  //    session-level block (§9-ζ, position unchanged) is the only report.
  it('F4 ③: with no turn of its own, nothing claims a pre-admission failure', () => {
    expect(ownsSessionFailure(failure({ isLastTurn: false }))).toBe(false);
  });

  // ④ restored history + a later failure: replayed turns have no metadata, so
  //    they produce neither piece of evidence and stay flat.
  it('F4 ④: a restored history turn is never labelled Failed', () => {
    expect(ownsSessionFailure(failure({ turnComplete: false, hasLiveMessage: false }))).toBe(false);
  });

  // ⑤ THE residue: the same restored transcript, but ending in an unanswered
  //    prompt. Same shape as ②'s echo turn, no metadata either way — only the
  //    baseline separates "the turn that was running when this failed" from
  //    "a prompt someone typed last Tuesday and never got an answer to".
  it('F4 residue: a restored UNANSWERED prompt is never labelled Failed', () => {
    expect(ownsSessionFailure(restoredUnansweredTurn())).toBe(false);
    // Nor when the failure arrives after the live snapshot was already cleared
    // (the usual case — `runSend`'s finally runs before `session.failed` lands),
    // which is exactly why the baseline outlives `end()`.
    expect(ownsSessionFailure(restoredUnansweredTurn({ turnComplete: false }))).toBe(false);
  });

  // The same resume timing, but the session fails before the echo: the
  // just-hydrated prompt must not be crowned with a red `Failed`.
  it('F4 residue II: history hydrated between baseline and echo is never Failed', () => {
    expect(ownsSessionFailure(restoredUnansweredTurn({ baselineMessageId: null }))).toBe(false);
    expect(ownsSessionFailure(restoredUnansweredTurn({ baselineMessageId: 'm-unrelated' }))).toBe(
      false
    );
  });

  // The window has seen no send at all, so no turn can be the one that failed.
  it('F4 residue: with no baseline, a user-only turn never claims the failure', () => {
    expect(ownsSessionFailure(openEchoTurn({ baselineKnown: false }))).toBe(false);
    expect(ownsSessionFailure(restoredUnansweredTurn({ baselineKnown: false }))).toBe(false);
  });

  it('F4: a healthy session never labels any turn Failed', () => {
    expect(ownsSessionFailure(openEchoTurn({ sessionFailed: false }))).toBe(false);
    expect(ownsSessionFailure(failure({ sessionFailed: false, hasLiveMessage: true }))).toBe(false);
  });

  it('F4: only the last turn can own the session failure', () => {
    expect(ownsSessionFailure(failure({ isLastTurn: false, hasLiveMessage: true }))).toBe(false);
    expect(ownsSessionFailure(openEchoTurn({ isLastTurn: false }))).toBe(false);
  });
});
