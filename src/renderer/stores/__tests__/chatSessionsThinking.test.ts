import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { applyRuntimeEvent, type ChatSessionsState } from '../chatSessions';

function baseState(overrides: Partial<ChatSessionsState> = {}): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: [],
    messages: { s1: [{ id: 'asst-1', sessionId: 's1', role: 'assistant', blocks: [] }] },
    activeSessionId: null,
    recentSessionIds: [],
    pendingPermission: null,
    hostBoundSessionIds: [],
    runtimeReady: false,
    lastError: null,
    historyErrors: {},
    ...overrides,
  } as ChatSessionsState;
}

function thinkingEvent(type: 'thinking.started' | 'thinking.delta', text?: string): RuntimeEvent {
  return {
    type,
    seq: 1,
    timestamp: 1000,
    sessionId: 's1',
    payload: {
      messageId: 'asst-1',
      blockId: 'asst-1-thinking',
      ...(text !== undefined ? { text } : {}),
    },
  } as RuntimeEvent;
}

describe('applyRuntimeEvent — thinking events (C-05)', () => {
  it('thinking.started appends an empty thinking block once (idempotent on same blockId)', () => {
    const state = baseState();
    const patch = applyRuntimeEvent(state, thinkingEvent('thinking.started'));
    const message = patch.messages?.s1?.find((item) => item.id === 'asst-1');
    expect(message?.blocks).toEqual([{ id: 'asst-1-thinking', type: 'thinking', text: '' }]);

    const next = { ...state, ...patch } as ChatSessionsState;
    expect(applyRuntimeEvent(next, thinkingEvent('thinking.started'))).toEqual({});
  });

  it('thinking.delta appends to the thinking block, creating it as thinking-typed when absent', () => {
    const state = baseState();
    const first = applyRuntimeEvent(state, thinkingEvent('thinking.delta', 'Let me '));
    const afterFirst = { ...state, ...first } as ChatSessionsState;
    const second = applyRuntimeEvent(afterFirst, thinkingEvent('thinking.delta', 'compute.'));

    const message = second.messages?.s1?.find((item) => item.id === 'asst-1');
    expect(message?.blocks).toEqual([
      { id: 'asst-1-thinking', type: 'thinking', text: 'Let me compute.' },
    ]);
  });

  it('thinking events for an unknown message are dropped without state changes', () => {
    const state = baseState({ messages: {} });
    expect(applyRuntimeEvent(state, thinkingEvent('thinking.started'))).toEqual({});
    expect(applyRuntimeEvent(state, thinkingEvent('thinking.delta', 'x'))).toEqual({});
  });
});
