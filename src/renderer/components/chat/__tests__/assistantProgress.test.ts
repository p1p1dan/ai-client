import { describe, expect, it } from 'vitest';
import {
  classifyAssistantProgress,
  collectAssistantMessageIds,
  countAssistantMessagesWithBlocks,
  hasNewAssistantMessage,
  isHostErrorForSend,
  isSessionCompletedForSend,
  isSessionFailedForSend,
  isUserEchoForSend,
  MAX_PENDING_HOST_ERRORS,
  pushPendingHostError,
  readSessionFailedError,
  resolveAbandonProgress,
  resolvePendingHostError,
  shouldAdmitPendingHostError,
} from '../assistantProgress';

function event(type: string, payload?: Record<string, unknown>) {
  return { type, sessionId: 'session-live', payload };
}

describe('classifyAssistantProgress', () => {
  it('ignores the echoed USER message from EventNormalizer.beginTurn', () => {
    const ids = new Set<string>();
    expect(
      classifyAssistantProgress(event('message.started', { messageId: 'u-1', role: 'user' }), ids)
    ).toBe('ignore');
    expect(
      classifyAssistantProgress(
        event('message.delta', { messageId: 'u-1', blockId: 'b', text: 'hi' }),
        ids
      )
    ).toBe('ignore');
    expect(classifyAssistantProgress(event('message.completed', { messageId: 'u-1' }), ids)).toBe(
      'ignore'
    );
    expect(ids.size).toBe(0);
  });

  it('counts assistant message.started and its subsequent deltas', () => {
    const ids = new Set<string>();
    expect(
      classifyAssistantProgress(
        event('message.started', { messageId: 'a-1', role: 'assistant' }),
        ids
      )
    ).toBe('assistant');
    expect(ids.has('a-1')).toBe(true);
    expect(
      classifyAssistantProgress(
        event('message.delta', { messageId: 'a-1', blockId: 'b', text: 'PONG' }),
        ids
      )
    ).toBe('assistant');
    expect(classifyAssistantProgress(event('message.completed', { messageId: 'a-1' }), ids)).toBe(
      'assistant'
    );
  });

  it('ignores assistant-looking deltas that have no matching envelope (out of order)', () => {
    const ids = new Set<string>();
    expect(
      classifyAssistantProgress(event('message.delta', { messageId: 'ghost', text: 'x' }), ids)
    ).toBe('ignore');
    expect(classifyAssistantProgress(event('message.completed', { messageId: 'ghost' }), ids)).toBe(
      'ignore'
    );
  });

  it('counts tool / permission / question / thinking as unambiguous assistant-turn signals', () => {
    const ids = new Set<string>();
    expect(
      classifyAssistantProgress(
        event('tool.started', { messageId: 'a-1', toolCallId: 't1', name: 'Write' }),
        ids
      )
    ).toBe('assistant');
    expect(
      classifyAssistantProgress(
        event('tool.completed', { messageId: 'a-1', toolCallId: 't1', ok: true }),
        ids
      )
    ).toBe('assistant');
    expect(
      classifyAssistantProgress(
        event('permission.requested', { permissionId: 'p1', toolName: 'Write' }),
        ids
      )
    ).toBe('assistant');
    expect(
      classifyAssistantProgress(
        event('question.requested', { questionId: 'q1', prompt: 'pick' }),
        ids
      )
    ).toBe('assistant');
    expect(
      classifyAssistantProgress(
        event('thinking.delta', { messageId: 'a-1', blockId: 'tb', text: 'hmm' }),
        ids
      )
    ).toBe('assistant');
  });

  it('ignores session lifecycle, status, and host.error events', () => {
    const ids = new Set<string>();
    expect(classifyAssistantProgress(event('session.created'), ids)).toBe('ignore');
    expect(classifyAssistantProgress(event('session.status', { status: 'running' }), ids)).toBe(
      'ignore'
    );
    expect(classifyAssistantProgress(event('session.completed'), ids)).toBe('ignore');
    expect(
      classifyAssistantProgress(event('host.error', { code: 'x', message: 'boom' }), ids)
    ).toBe('ignore');
    expect(ids.size).toBe(0);
  });
});

describe("isHostErrorForSend (F3: session/requestId scoping for runSend's host.error listener)", () => {
  it('accepts an event whose sessionId matches the send target', () => {
    expect(
      isHostErrorForSend(
        { sessionId: 'session-a', requestId: 'req-unrelated' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(true);
  });

  it('rejects an event whose sessionId belongs to a different (e.g. background) session', () => {
    expect(
      isHostErrorForSend(
        { sessionId: 'session-b' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(false);
  });

  it('sessionId match wins even if requestId happens to also match — no double-guessing once sessionId is known', () => {
    expect(
      isHostErrorForSend(
        { sessionId: 'session-a', requestId: 'req-current' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(true);
  });

  it("a session-less event (e.g. send()'s session_not_found) is accepted only via a matching requestId", () => {
    expect(
      isHostErrorForSend(
        { requestId: 'req-current' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(true);
  });

  it('a session-less event with a mismatched requestId is rejected', () => {
    expect(
      isHostErrorForSend(
        { requestId: 'req-other' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(false);
  });

  it('a session-less event is rejected when this attempt has no outstanding requestId yet', () => {
    expect(
      isHostErrorForSend({ requestId: 'req-other' }, { sessionId: 'session-a', requestId: null })
    ).toBe(false);
  });

  it('a session-less, requestId-less event is rejected (nothing to correlate it to)', () => {
    expect(isHostErrorForSend({}, { sessionId: 'session-a', requestId: 'req-current' })).toBe(
      false
    );
  });
});

describe('isHostErrorForSend strict mode (A3, round-4 point-check fix)', () => {
  it('non-strict (default): sessionId match wins even when requestId differs — unchanged behavior', () => {
    expect(
      isHostErrorForSend(
        { sessionId: 'session-a', requestId: 'req-other' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(true);
  });

  it('strict: rejects a sessionId match whose requestId does NOT match the currently-outstanding request', () => {
    expect(
      isHostErrorForSend(
        { sessionId: 'session-a', requestId: 'req-other' },
        { sessionId: 'session-a', requestId: 'req-current' },
        { strict: true }
      )
    ).toBe(false);
  });

  it('strict: accepts a sessionId + requestId match', () => {
    expect(
      isHostErrorForSend(
        { sessionId: 'session-a', requestId: 'req-current' },
        { sessionId: 'session-a', requestId: 'req-current' },
        { strict: true }
      )
    ).toBe(true);
  });

  it('strict: still rejects a different session outright, same as non-strict', () => {
    expect(
      isHostErrorForSend(
        { sessionId: 'session-b', requestId: 'req-current' },
        { sessionId: 'session-a', requestId: 'req-current' },
        { strict: true }
      )
    ).toBe(false);
  });

  it('strict: falls back to sessionId-only matching while this attempt has no outstanding requestId yet', () => {
    expect(
      isHostErrorForSend(
        { sessionId: 'session-a', requestId: 'req-anything' },
        { sessionId: 'session-a', requestId: null },
        { strict: true }
      )
    ).toBe(true);
  });

  it('strict: session-less event matching still requires the requestId, same as non-strict', () => {
    expect(
      isHostErrorForSend(
        { requestId: 'req-current' },
        { sessionId: 'session-a', requestId: 'req-current' },
        { strict: true }
      )
    ).toBe(true);
    expect(
      isHostErrorForSend(
        { requestId: 'req-other' },
        { sessionId: 'session-a', requestId: 'req-current' },
        { strict: true }
      )
    ).toBe(false);
  });
});

describe('isUserEchoForSend (R15, round-2 iteration-2 review: pure wiring coverage for sawUserEcho)', () => {
  it('is true for a message.started{role: user} event scoped to this session', () => {
    expect(
      isUserEchoForSend(
        event('message.started', { messageId: 'u-1', role: 'user' }),
        'session-live'
      )
    ).toBe(true);
  });

  it('is false for a message.started{role: assistant} event — that is progress, not the echo', () => {
    expect(
      isUserEchoForSend(
        event('message.started', { messageId: 'a-1', role: 'assistant' }),
        'session-live'
      )
    ).toBe(false);
  });

  it('is false for any other event type, even with role: user in the payload', () => {
    expect(isUserEchoForSend(event('message.delta', { role: 'user' }), 'session-live')).toBe(false);
  });

  it("is false for a DIFFERENT session's user echo — must not poison this attempt's evidence", () => {
    expect(
      isUserEchoForSend(
        { type: 'message.started', sessionId: 'session-other', payload: { role: 'user' } },
        'session-live'
      )
    ).toBe(false);
  });

  it('is false when the event carries no sessionId at all', () => {
    expect(
      isUserEchoForSend({ type: 'message.started', payload: { role: 'user' } }, 'session-live')
    ).toBe(false);
  });
});

describe('isSessionFailedForSend / readSessionFailedError (R3, round-2 iteration-2 review)', () => {
  it('is true for a session.failed event scoped to this session', () => {
    expect(isSessionFailedForSend(event('session.failed', { error: 'boom' }), 'session-live')).toBe(
      true
    );
  });

  it("is false for a DIFFERENT session's session.failed — must not short-circuit this attempt's wait", () => {
    expect(
      isSessionFailedForSend(
        { type: 'session.failed', sessionId: 'session-other', payload: { error: 'boom' } },
        'session-live'
      )
    ).toBe(false);
  });

  it('is false for a different event type on the same session (e.g. session.completed)', () => {
    expect(isSessionFailedForSend(event('session.completed'), 'session-live')).toBe(false);
  });

  it('reads the payload error message when present', () => {
    expect(readSessionFailedError({ error: 'gateway 500' })).toBe('gateway 500');
  });

  it('falls back to a generic message when the payload carries no error string', () => {
    expect(readSessionFailedError(undefined)).toBe('Session failed');
    expect(readSessionFailedError({})).toBe('Session failed');
    expect(readSessionFailedError({ error: '' })).toBe('Session failed');
  });
});

describe('isSessionCompletedForSend (S4, round-2 iteration-3 review)', () => {
  it('is true for a session.completed event scoped to this session', () => {
    expect(isSessionCompletedForSend(event('session.completed'), 'session-live')).toBe(true);
  });

  it("is false for a DIFFERENT session's session.completed", () => {
    expect(
      isSessionCompletedForSend(
        { type: 'session.completed', sessionId: 'session-other' },
        'session-live'
      )
    ).toBe(false);
  });

  it('is false for a different event type on the same session (e.g. session.stopped) — chatSessions.ts collapses both to the same idle status, but this must not', () => {
    expect(isSessionCompletedForSend(event('session.stopped'), 'session-live')).toBe(false);
  });
});

describe('countAssistantMessagesWithBlocks (S4, round-2 iteration-3 review)', () => {
  it('counts only assistant-role messages that carry at least one block', () => {
    expect(
      countAssistantMessagesWithBlocks([
        { id: 'm1', role: 'user', blocks: [{ type: 'text' }] },
        { id: 'm2', role: 'assistant', blocks: [] },
        { id: 'm3', role: 'assistant', blocks: [{ type: 'text' }] },
        { id: 'm4', role: 'assistant', blocks: [{ type: 'tool_call' }, { type: 'text' }] },
      ])
    ).toBe(2);
  });

  it('is 0 for an empty list', () => {
    expect(countAssistantMessagesWithBlocks([])).toBe(0);
  });

  it('advances when a NEW assistant message with blocks is appended — the cursor property the abandon marker relies on', () => {
    const before = [{ id: 'm1', role: 'assistant', blocks: [{ type: 'text' }] }];
    const after = [...before, { id: 'm2', role: 'assistant', blocks: [{ type: 'text' }] }];
    const cursorBefore = countAssistantMessagesWithBlocks(before);
    const cursorAfter = countAssistantMessagesWithBlocks(after);
    expect(cursorAfter).toBeGreaterThan(cursorBefore);
  });

  it('iteration-4 fix: excludes replayed `h:`-prefixed history messages, so a session.history hydration cannot spuriously advance the cursor', () => {
    expect(
      countAssistantMessagesWithBlocks([
        { id: 'h:1', role: 'assistant', blocks: [{ type: 'text' }] },
        { id: 'h:2', role: 'assistant', blocks: [{ type: 'text' }] },
      ])
    ).toBe(0);
  });

  it('iteration-4 fix: a history hydration alongside existing runtime messages counts only the runtime ones', () => {
    const runtimeOnly = [{ id: 'm1', role: 'assistant', blocks: [{ type: 'text' }] }];
    const withReplayedHistory = [
      { id: 'h:1', role: 'assistant', blocks: [{ type: 'text' }] },
      { id: 'h:2', role: 'assistant', blocks: [{ type: 'text' }] },
      ...runtimeOnly,
    ];
    expect(countAssistantMessagesWithBlocks(runtimeOnly)).toBe(
      countAssistantMessagesWithBlocks(withReplayedHistory)
    );
  });
});

describe('collectAssistantMessageIds / hasNewAssistantMessage (round-6 verify major)', () => {
  // A session that already completed one turn: this is the SECOND send's
  // normal starting state, not an edge case.
  const preexisting = [
    { id: 'asst-old', role: 'assistant', blocks: [{ type: 'text' }] },
    { id: 'h:1', role: 'assistant', blocks: [{ type: 'text' }] },
    { id: 'user-1', role: 'user', blocks: [{ type: 'text' }] },
  ];

  it('the baseline collects only runtime assistant messages with blocks', () => {
    expect([...collectAssistantMessageIds(preexisting)]).toEqual(['asst-old']);
  });

  it('a pre-existing runtime assistant is NOT progress for a new send', () => {
    // The refuted predicate was "any runtime assistant exists": true here
    // before this send produced anything — releasing the wait with zero
    // evidence and unsubscribing its listeners.
    const baseline = collectAssistantMessageIds(preexisting);
    expect(hasNewAssistantMessage(preexisting, baseline)).toBe(false);
  });

  it('a replay landing mid-wait is NOT progress (h:* never counts)', () => {
    const baseline = collectAssistantMessageIds(preexisting);
    const afterReplay = [
      ...preexisting,
      { id: 'h:2', role: 'assistant', blocks: [{ type: 'text' }] },
    ];
    expect(hasNewAssistantMessage(afterReplay, baseline)).toBe(false);
  });

  it('only an assistant id unseen at dispatch time is progress', () => {
    const baseline = collectAssistantMessageIds(preexisting);
    const afterReply = [
      ...preexisting,
      { id: 'asst-new', role: 'assistant', blocks: [{ type: 'text' }] },
    ];
    expect(hasNewAssistantMessage(afterReply, baseline)).toBe(true);
  });

  it('an old id folded away by the replay merge does not fake progress', () => {
    const baseline = collectAssistantMessageIds(preexisting);
    const afterFold = [{ id: 'h:folded', role: 'assistant', blocks: [{ type: 'text' }] }];
    expect(hasNewAssistantMessage(afterFold, baseline)).toBe(false);
  });
});

describe('resolveAbandonProgress (round-6 B2 marker state machine)', () => {
  it('a replay shrink re-bases the armed cursor without landing', () => {
    expect(
      resolveAbandonProgress({ armedCursor: 2, currentCursor: 1, waitingInteraction: false })
    ).toEqual({ nextArmedCursor: 1, landed: false });
  });

  it('hydration-only h:* growth never lands (runtime cursor unchanged)', () => {
    expect(
      resolveAbandonProgress({ armedCursor: 1, currentCursor: 1, waitingInteraction: false })
    ).toEqual({ nextArmedCursor: 1, landed: false });
  });

  it('one genuinely new reply after the re-base lands', () => {
    const shrunk = resolveAbandonProgress({
      armedCursor: 2,
      currentCursor: 1,
      waitingInteraction: false,
    });
    expect(
      resolveAbandonProgress({
        armedCursor: shrunk.nextArmedCursor,
        currentCursor: 2,
        waitingInteraction: false,
      }).landed
    ).toBe(true);
  });

  it('waiting_permission / waiting_question land regardless of the cursor', () => {
    expect(
      resolveAbandonProgress({ armedCursor: 2, currentCursor: 1, waitingInteraction: true }).landed
    ).toBe(true);
  });
});

describe('shouldAdmitPendingHostError (F2, round-4 Codex NEEDS-FIX #1)', () => {
  it('admits a stashed event once the target requestId is known and strictly matches', () => {
    expect(
      shouldAdmitPendingHostError(
        { sessionId: 'session-a', requestId: 'req-current' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(true);
  });

  it('discards a stashed event whose requestId does not match the now-known target requestId', () => {
    expect(
      shouldAdmitPendingHostError(
        { sessionId: 'session-a', requestId: 'req-stale' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(false);
  });

  it('never admits while the target requestId is still unknown — nothing to stash-resolve against yet', () => {
    expect(
      shouldAdmitPendingHostError(
        { sessionId: 'session-a', requestId: 'req-anything' },
        { sessionId: 'session-a', requestId: null }
      )
    ).toBe(false);
  });

  it('discards a stashed event for a different session even once a requestId is known', () => {
    expect(
      shouldAdmitPendingHostError(
        { sessionId: 'session-b', requestId: 'req-current' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(false);
  });

  it('admits a stashed session-less event (e.g. session_not_found) once its requestId matches the now-known target', () => {
    expect(
      shouldAdmitPendingHostError(
        { requestId: 'req-current' },
        { sessionId: 'session-a', requestId: 'req-current' }
      )
    ).toBe(true);
  });
});

describe('pushPendingHostError (F2b, round-4 Codex re-review, second pass)', () => {
  it('admits a single event into an empty list', () => {
    const event = { sessionId: 'session-a', requestId: 'req-1' };
    expect(pushPendingHostError([], event)).toEqual([event]);
  });

  it('preserves FIFO order under the cap', () => {
    const a = { sessionId: 'session-a', requestId: 'req-1' };
    const b = { sessionId: 'session-a', requestId: 'req-2' };
    expect(pushPendingHostError([a], b)).toEqual([a, b]);
  });

  it('exceeding the cap evicts the OLDEST candidate first, keeping the most recent MAX_PENDING_HOST_ERRORS', () => {
    let list: readonly { sessionId: string; requestId: string }[] = [];
    for (let i = 1; i <= MAX_PENDING_HOST_ERRORS + 2; i += 1) {
      list = pushPendingHostError(list, { sessionId: 'session-a', requestId: `req-${i}` });
    }
    expect(list).toHaveLength(MAX_PENDING_HOST_ERRORS);
    // The two oldest (req-1, req-2) are gone; the most recent MAX survive.
    expect(list.map((e) => e.requestId)).toEqual(
      Array.from({ length: MAX_PENDING_HOST_ERRORS }, (_, i) => `req-${i + 3}`)
    );
  });

  it('never exceeds the cap by more than one push at a time', () => {
    let list: readonly { requestId: string }[] = [];
    for (let i = 0; i < 10; i += 1) {
      list = pushPendingHostError(list, { requestId: `req-${i}` });
      expect(list.length).toBeLessThanOrEqual(MAX_PENDING_HOST_ERRORS);
    }
  });
});

describe('resolvePendingHostError (F2b, round-4 Codex re-review, second pass)', () => {
  it('候选命中: finds the candidate whose requestId strictly matches the now-known target', () => {
    const stale = { sessionId: 'session-a', requestId: 'req-stale' };
    const genuine = { sessionId: 'session-a', requestId: 'req-current' };
    expect(
      resolvePendingHostError([stale, genuine], {
        sessionId: 'session-a',
        requestId: 'req-current',
      })
    ).toBe(genuine);
  });

  it('候选未命中: returns null when no candidate matches the target requestId', () => {
    const stale1 = { sessionId: 'session-a', requestId: 'req-stale-1' };
    const stale2 = { sessionId: 'session-a', requestId: 'req-stale-2' };
    expect(
      resolvePendingHostError([stale1, stale2], {
        sessionId: 'session-a',
        requestId: 'req-current',
      })
    ).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(resolvePendingHostError([], { sessionId: 'session-a', requestId: 'req-current' })).toBe(
      null
    );
  });

  it('跨 session 不收: a same-requestId candidate from a DIFFERENT session is never admitted', () => {
    const otherSession = { sessionId: 'session-b', requestId: 'req-current' };
    expect(
      resolvePendingHostError([otherSession], { sessionId: 'session-a', requestId: 'req-current' })
    ).toBeNull();
  });

  it('picks the FIRST matching candidate when (implausibly) more than one matches', () => {
    const first = { sessionId: 'session-a', requestId: 'req-current' };
    const second = { sessionId: 'session-a', requestId: 'req-current' };
    expect(
      resolvePendingHostError([first, second], { sessionId: 'session-a', requestId: 'req-current' })
    ).toBe(first);
  });
});
