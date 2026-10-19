import { beforeEach, describe, expect, it } from 'vitest';
import {
  prunePendingReplies,
  selectPendingReply,
  useTurnSendStatusStore,
  withoutPendingReply,
} from '../turnSendStatus';

/**
 * T-31 review batch, F3: the in-flight status slot is global and its writers
 * are not.
 *
 * `runSend`'s ticker, phase switch and `finally` all live in a closure that can
 * outlive the `ChatComposer` instance that created them (the middle column
 * tears down on a layout change, a session switch, a workspace switch). Every
 * case below is a write arriving from such a dead send while a live one owns
 * the slot; before the ownership token each one of them corrupted or blanked
 * the head the user was watching.
 */

const snapshot = (sessionId: string) => ({
  sessionId,
  phase: 'handshake' as const,
  elapsedSeconds: 0,
  // The commit stamp (2026-09-19). Distinct from `elapsedSeconds` on purpose:
  // that one is phase-relative and is reset at dispatch, this one never moves.
  turnStartedAtMs: 1_700_000_000_000,
  budgetMs: 60_000,
  attachmentCount: 0,
  attachmentBytes: 0,
  promptChars: 0,
});

beforeEach(() => {
  useTurnSendStatusStore.setState({ status: null });
});

describe('turnSendStatus ownership (F3)', () => {
  const { begin, update, end } = useTurnSendStatusStore.getState();

  it('begin publishes the snapshot and hands back a token', () => {
    const owner = begin(snapshot('s1'), null);
    const status = useTurnSendStatusStore.getState().status;
    expect(status?.sessionId).toBe('s1');
    expect(status?.owner).toBe(owner);
  });

  it('mints a distinct token per send', () => {
    const first = begin(snapshot('s1'), null);
    const second = begin(snapshot('s1'), null);
    expect(second).not.toBe(first);
  });

  it('the owner can patch its own snapshot', () => {
    const owner = begin(snapshot('s1'), null);
    update(owner, { phase: 'awaiting', elapsedSeconds: 4 });
    expect(useTurnSendStatusStore.getState().status).toMatchObject({
      phase: 'awaiting',
      elapsedSeconds: 4,
    });
  });

  // Instance A unmounts mid-send; its 1s ticker is still alive and keeps
  // publishing seconds. Instance B has since started its own send. Without the
  // token, B's head counts A's clock.
  it('F3: a superseded send cannot patch the live snapshot', () => {
    const stale = begin(snapshot('s1'), null);
    const live = begin(snapshot('s2'), null);
    update(stale, { elapsedSeconds: 99 });
    expect(useTurnSendStatusStore.getState().status).toMatchObject({
      sessionId: 's2',
      elapsedSeconds: 0,
      owner: live,
    });
  });

  // Same setup, but it is A's `finally` (or its unmount cleanup) that arrives
  // late. Without the token this clears B's slot and the turn head goes blank
  // for the rest of B's wait — no spinner, no seconds, nothing.
  it('F3: a superseded send cannot clear the live snapshot', () => {
    const stale = begin(snapshot('s1'), null);
    const live = begin(snapshot('s2'), null);
    end(stale);
    expect(useTurnSendStatusStore.getState().status).toMatchObject({ owner: live });
  });

  it('the owner can clear its own snapshot', () => {
    const owner = begin(snapshot('s1'), null);
    end(owner);
    expect(useTurnSendStatusStore.getState().status).toBeNull();
  });

  // The unmount cleanup fires for every teardown, including ones with no send
  // in flight at all, and a late `finally` can follow its own `end`.
  it('F3: ending an already-ended send is inert', () => {
    const owner = begin(snapshot('s1'), null);
    end(owner);
    end(owner);
    expect(useTurnSendStatusStore.getState().status).toBeNull();

    const next = begin(snapshot('s2'), null);
    end(owner);
    expect(useTurnSendStatusStore.getState().status).toMatchObject({ owner: next });
  });

  it('F3: writes against an empty slot are inert rather than resurrecting a snapshot', () => {
    const owner = begin(snapshot('s1'), null);
    end(owner);
    update(owner, { elapsedSeconds: 12 });
    expect(useTurnSendStatusStore.getState().status).toBeNull();
  });
});

/**
 * Final review (F2/F4 residue): where the session's message list stood when the
 * send began. It is the only thing that separates the turn a send just opened
 * from a restored transcript's trailing unanswered prompt — the two are
 * structurally identical (`user !== null`, `body.length === 0`).
 */
describe('turnSendStatus baseline (F2/F4 residue)', () => {
  const { begin, end } = useTurnSendStatusStore.getState();

  beforeEach(() => {
    useTurnSendStatusStore.setState({ status: null, baseline: null });
  });

  it('begin records the session and the last message id at the commit point', () => {
    begin(snapshot('s1'), 'h:u-unanswered');
    expect(useTurnSendStatusStore.getState().baseline).toEqual({
      sessionId: 's1',
      messageId: 'h:u-unanswered',
    });
  });

  it('an empty session records a null baseline rather than no baseline', () => {
    begin(snapshot('s1'), null);
    expect(useTurnSendStatusStore.getState().baseline).toEqual({
      sessionId: 's1',
      messageId: null,
    });
  });

  // The property `ownsSessionFailure` depends on: by the time `session.failed`
  // reaches the store, `runSend`'s `finally` has usually already cleared the
  // live snapshot. Clearing the baseline with it would leave the failure unable
  // to tell a just-sent turn from a restored one.
  it('F4 residue: end clears the snapshot and KEEPS the baseline', () => {
    const owner = begin(snapshot('s1'), 'm-prev');
    end(owner);
    expect(useTurnSendStatusStore.getState().status).toBeNull();
    expect(useTurnSendStatusStore.getState().baseline).toEqual({
      sessionId: 's1',
      messageId: 'm-prev',
    });
  });

  // T-19 releases a queue one entry at a time, each through its own `begin`.
  it('F2 residue: each queued send advances the baseline', () => {
    const first = begin(snapshot('s1'), 'm-prev');
    end(first);
    begin(snapshot('s1'), 'm-echo-1');
    expect(useTurnSendStatusStore.getState().baseline?.messageId).toBe('m-echo-1');
  });

  it('the baseline is session-scoped so a switch mid-send cannot borrow it', () => {
    begin(snapshot('s1'), 'm-a');
    begin(snapshot('s2'), 'm-b');
    expect(useTurnSendStatusStore.getState().baseline).toEqual({
      sessionId: 's2',
      messageId: 'm-b',
    });
  });
});

/**
 * F2 (2026-08-18 §4.5): the pending-reply watch — the second, independent
 * slot that keeps the turn head (and its Stop button) alive after `status` is
 * torn down but the Host-admitted turn is still actually running.
 */
describe('turnSendStatus pendingReply (F2 §4.5)', () => {
  const { begin, end, armPendingReply, clearPendingReply } = useTurnSendStatusStore.getState();

  beforeEach(() => {
    useTurnSendStatusStore.setState({ status: null, baseline: null, pendingReplies: {} });
  });

  it('[PR-1] armPendingReply publishes one watch per session; a later arm replaces only its own', () => {
    armPendingReply({ sessionId: 's1', turnStartedAtMs: 1000 });
    armPendingReply({ sessionId: 's2', turnStartedAtMs: 2000 });
    // Decision 205 follow-up: s2's watch no longer takes s1's away.
    expect(useTurnSendStatusStore.getState().pendingReplies).toEqual({
      s1: { sessionId: 's1', turnStartedAtMs: 1000 },
      s2: { sessionId: 's2', turnStartedAtMs: 2000 },
    });

    armPendingReply({ sessionId: 's1', turnStartedAtMs: 3000 });
    expect(selectPendingReply(useTurnSendStatusStore.getState(), 's1')).toEqual({
      sessionId: 's1',
      turnStartedAtMs: 3000,
    });
    expect(selectPendingReply(useTurnSendStatusStore.getState(), 's2')?.turnStartedAtMs).toBe(2000);
  });

  it('[PR-2] clearPendingReply clears that session only', () => {
    armPendingReply({ sessionId: 's1', turnStartedAtMs: 1000 });
    armPendingReply({ sessionId: 's2', turnStartedAtMs: 2000 });
    clearPendingReply('s1');
    expect(selectPendingReply(useTurnSendStatusStore.getState(), 's1')).toBeNull();
    expect(selectPendingReply(useTurnSendStatusStore.getState(), 's2')).not.toBeNull();
  });

  it('[PR-3] clearPendingReply for a session with no watch changes nothing', () => {
    armPendingReply({ sessionId: 's1', turnStartedAtMs: 1000 });
    const before = useTurnSendStatusStore.getState().pendingReplies;

    clearPendingReply('s2');
    expect(useTurnSendStatusStore.getState().pendingReplies).toBe(before);

    // Also a no-op against the initial, empty map — must not throw.
    useTurnSendStatusStore.setState({ pendingReplies: {} });
    expect(() => clearPendingReply('s1')).not.toThrow();
    expect(useTurnSendStatusStore.getState().pendingReplies).toEqual({});
    expect(selectPendingReply(useTurnSendStatusStore.getState(), null)).toBeNull();
  });

  it('[PR-5] the lifecycle helpers drop or prune watches by session', () => {
    const watches = {
      s1: { sessionId: 's1', turnStartedAtMs: 1 },
      s2: { sessionId: 's2', turnStartedAtMs: 2 },
    };
    expect(withoutPendingReply(watches, 's1')).toEqual({ s2: watches.s2 });
    expect(withoutPendingReply(watches, 's9')).toBe(watches);
    expect(prunePendingReplies(watches, new Set(['s2']))).toEqual({ s2: watches.s2 });
    expect(prunePendingReplies(watches, new Set(['s1', 's2']))).toBe(watches);
  });

  // `runSend`'s `finally` arms the watch and calls `end` right after, in the
  // same breath. If the two shared one slot, `end` would blank the watch it
  // was just handed, and the turn head would vanish at the exact moment it is
  // supposed to take over.
  it('[PR-4] status and pendingReply are independent slots', () => {
    const owner = begin(snapshot('s1'), null);
    armPendingReply({ sessionId: 's1', turnStartedAtMs: 500 });
    end(owner);
    expect(useTurnSendStatusStore.getState().status).toBeNull();
    expect(selectPendingReply(useTurnSendStatusStore.getState(), 's1')).toEqual({
      sessionId: 's1',
      turnStartedAtMs: 500,
    });
  });
});

/**
 * F456 slice ④ §7.4 — the `↑` prompt-size field.
 *
 * A separate section from the ownership and baseline groups above on purpose:
 * this is a plain payload field, and mixing it into the ownership cases would
 * make those cases assert two unrelated propositions at once.
 */
describe('turnSendStatus promptChars (F456 §7.4)', () => {
  const { begin, update } = useTurnSendStatusStore.getState();

  it('carries the committed prompt size through to the reader', () => {
    begin({ ...snapshot('s1'), promptChars: 428 }, null);
    expect(useTurnSendStatusStore.getState().status?.promptChars).toBe(428);
  });

  /**
   * The count is fixed at the commit point and the ticker patches only the
   * clock, so a phase/seconds update must leave it alone — a snapshot whose
   * prompt size drifted mid-send would be describing a different message than
   * the one in flight.
   */
  it('survives the phase switch and every seconds tick untouched', () => {
    const owner = begin({ ...snapshot('s1'), promptChars: 428 }, null);
    update(owner, { phase: 'awaiting' });
    update(owner, { elapsedSeconds: 12 });
    expect(useTurnSendStatusStore.getState().status).toMatchObject({
      phase: 'awaiting',
      elapsedSeconds: 12,
      promptChars: 428,
    });
  });
});
