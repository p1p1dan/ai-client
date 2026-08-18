import { beforeEach, describe, expect, it } from 'vitest';
import { useTurnSendStatusStore } from '../turnSendStatus';

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
  budgetMs: 60_000,
  attachmentCount: 0,
  attachmentBytes: 0,
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
    useTurnSendStatusStore.setState({ status: null, baseline: null, pendingReply: null });
  });

  it('[PR-1] armPendingReply publishes the watch, and a later arm replaces it', () => {
    armPendingReply({ sessionId: 's1', turnStartedAtMs: 1000 });
    expect(useTurnSendStatusStore.getState().pendingReply).toEqual({
      sessionId: 's1',
      turnStartedAtMs: 1000,
    });

    armPendingReply({ sessionId: 's2', turnStartedAtMs: 2000 });
    expect(useTurnSendStatusStore.getState().pendingReply).toEqual({
      sessionId: 's2',
      turnStartedAtMs: 2000,
    });
  });

  it('[PR-2] clearPendingReply with the matching sessionId clears it to null', () => {
    armPendingReply({ sessionId: 's1', turnStartedAtMs: 1000 });
    clearPendingReply('s1');
    expect(useTurnSendStatusStore.getState().pendingReply).toBeNull();
  });

  it('[PR-3] clearPendingReply is a no-op unless the sessionId matches, and on an already-null slot', () => {
    const watch = { sessionId: 's1', turnStartedAtMs: 1000 };
    armPendingReply(watch);
    const before = useTurnSendStatusStore.getState().pendingReply;

    clearPendingReply('s2');
    expect(useTurnSendStatusStore.getState().pendingReply).toBe(before);

    // Also a no-op against the initial, already-null slot — must not throw.
    useTurnSendStatusStore.setState({ pendingReply: null });
    expect(() => clearPendingReply('s1')).not.toThrow();
    expect(useTurnSendStatusStore.getState().pendingReply).toBeNull();
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
    expect(useTurnSendStatusStore.getState().pendingReply).toEqual({
      sessionId: 's1',
      turnStartedAtMs: 500,
    });
  });
});
