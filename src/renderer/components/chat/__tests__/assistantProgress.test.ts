import { describe, expect, it } from 'vitest';
import {
  classifyAssistantProgress,
  countAssistantMessagesWithBlocks,
  isHostErrorForSend,
  isSessionCompletedForSend,
  isSessionFailedForSend,
  isUserEchoForSend,
  readSessionFailedError,
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
