import type { RuntimeEvent, SessionHistoryEvent } from '@shared/types/runtimeEvents';
import type { HistoryMessage } from '@shared/types/sessionHistory';
import { describe, expect, it } from 'vitest';
import {
  applyRuntimeEvent,
  type ChatMessage,
  type ChatSession,
  type ChatSessionsState,
} from '../chatSessions';

const SESSION_ID = 'session-1';

function baseState(overrides: Partial<ChatSessionsState> = {}): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: [],
    messages: [],
    activeSessionId: null,
    recentSessionIds: [],
    pendingPermission: null,
    pendingQuestion: null,
    hostBoundSessionIds: [],
    runtimeReady: false,
    lastError: null,
    historyErrors: {},
    selectSession: () => {},
    sendMessage: async () => {},
    stopActiveSession: async () => {},
    respondPermission: () => {},
    respondQuestion: () => {},
    initRuntime: () => () => {},
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: SESSION_ID,
    projectId: 'project-demo',
    workspaceId: 'ws-main',
    title: 'Test session',
    status: 'idle',
    updatedAt: 42,
    ...overrides,
  };
}

function makeHistoryEvent(
  payloadOverrides: Partial<SessionHistoryEvent['payload']> = {}
): RuntimeEvent {
  return {
    type: 'session.history',
    seq: 1,
    sessionId: SESSION_ID,
    requestId: 'req-1',
    timestamp: 1234,
    payload: {
      runtimeIdentity: 'rt-1',
      workspacePath: '/workspace',
      messages: [],
      truncated: false,
      omittedCount: 0,
      ...payloadOverrides,
    },
  };
}

// One user message and one assistant message (text + tool_call + tool_result + thinking).
const HISTORY_MESSAGES: HistoryMessage[] = [
  {
    id: 'h:uuid-1',
    role: 'user',
    timestamp: 1500,
    blocks: [{ type: 'text', id: 'h:uuid-1:0', text: 'hello from history' }],
  },
  {
    id: 'h:uuid-2',
    role: 'assistant',
    timestamp: 1600,
    model: 'claude-sonnet',
    blocks: [
      { type: 'text', id: 'h:uuid-2:0', text: 'hi there' },
      {
        type: 'tool_call',
        id: 'h:uuid-2:1',
        toolCallId: 'tool-1',
        name: 'Read',
        input: { path: 'a.ts' },
      },
      {
        type: 'tool_result',
        id: 'h:uuid-2:2',
        toolCallId: 'tool-1',
        ok: true,
        output: 'file contents',
      },
      { type: 'thinking', id: 'h:uuid-2:3', text: 'thinking...' },
    ],
  },
];

describe('applyRuntimeEvent — session.history (C-06)', () => {
  it('is idempotent: applying the same event twice yields the same messages/sessions/historyErrors', () => {
    const state = baseState({ sessions: [makeSession()] });
    const event = makeHistoryEvent({ messages: HISTORY_MESSAGES });

    const patch1 = applyRuntimeEvent(state, event);
    const stateAfterFirst = { ...state, ...patch1 } as ChatSessionsState;
    const patch2 = applyRuntimeEvent(stateAfterFirst, event);

    expect(patch2.messages).toEqual(patch1.messages);
    expect(patch2.sessions).toEqual(patch1.sessions);
    expect(patch2.historyErrors).toEqual(patch1.historyErrors);
  });

  it('replaces h:* messages by prefix, keeps runtime messages, and inserts history before them', () => {
    const staleHistoryMessage: ChatMessage = {
      id: 'h:stale-uuid',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'h:stale-uuid:0', type: 'text', text: 'stale' }],
    };
    const runtimeUserMessage: ChatMessage = {
      id: 'user-1',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'user-1-block', type: 'text', text: 'live message' }],
    };
    const runtimeAssistantMessage: ChatMessage = {
      id: 'asst-1',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [{ id: 'asst-1-block', type: 'text', text: 'live reply' }],
    };
    const otherSessionMessage: ChatMessage = {
      id: 'user-other',
      sessionId: 'session-other',
      role: 'user',
      blocks: [],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: [
        otherSessionMessage,
        staleHistoryMessage,
        runtimeUserMessage,
        runtimeAssistantMessage,
      ],
    });
    const event = makeHistoryEvent({ messages: HISTORY_MESSAGES });

    const patch = applyRuntimeEvent(state, event);
    const messages = patch.messages ?? [];
    const ids = messages.map((message) => message.id);

    expect(ids).not.toContain('h:stale-uuid');
    expect(ids).toContain('user-1');
    expect(ids).toContain('asst-1');
    expect(ids).toContain('user-other');
    expect(ids).toContain('h:uuid-1');
    expect(ids).toContain('h:uuid-2');

    // History is spliced before this session's remaining (runtime) messages.
    expect(ids.indexOf('h:uuid-1')).toBeLessThan(ids.indexOf('user-1'));
    expect(ids.indexOf('h:uuid-2')).toBeLessThan(ids.indexOf('asst-1'));
  });

  it('appends history at the array tail when the session has no remaining messages', () => {
    const state = baseState({
      sessions: [makeSession()],
      messages: [],
    });
    const event = makeHistoryEvent({ messages: HISTORY_MESSAGES });

    const patch = applyRuntimeEvent(state, event);

    expect(patch.messages?.map((message) => message.id)).toEqual(['h:uuid-1', 'h:uuid-2']);
  });

  it('records payload.error into historyErrors and clears it on a later successful ingest', () => {
    const state = baseState({ sessions: [makeSession()] });
    const errorEvent = makeHistoryEvent({
      messages: [],
      error: { code: 'jsonl_not_found', message: 'no file' },
    });

    const patchWithError = applyRuntimeEvent(state, errorEvent);
    expect(patchWithError.historyErrors).toEqual({ [SESSION_ID]: 'jsonl_not_found: no file' });
    // Must not touch the global lastError field.
    expect(patchWithError.lastError).toBeUndefined();

    const stateAfterError = { ...state, ...patchWithError } as ChatSessionsState;
    const successEvent = makeHistoryEvent({ messages: HISTORY_MESSAGES });
    const patchSuccess = applyRuntimeEvent(stateAfterError, successEvent);

    expect(patchSuccess.historyErrors).toEqual({});
  });

  it('bumps session.updatedAt to the last history message timestamp', () => {
    const state = baseState({ sessions: [makeSession({ updatedAt: 42 })] });
    const event = makeHistoryEvent({ messages: HISTORY_MESSAGES });

    const patch = applyRuntimeEvent(state, event);
    const updatedSession = patch.sessions?.find((session) => session.id === SESSION_ID);

    expect(updatedSession?.updatedAt).toBe(1600);
    expect(updatedSession?.runtimeIdentity).toBe('rt-1');
  });

  it('leaves updatedAt unchanged when the last history message has no timestamp', () => {
    const state = baseState({ sessions: [makeSession({ updatedAt: 42 })] });
    const noTimestampMessages: HistoryMessage[] = [
      { id: 'h:no-ts', role: 'user', blocks: [{ type: 'text', id: 'h:no-ts:0', text: 'hi' }] },
    ];
    const event = makeHistoryEvent({ messages: noTimestampMessages });

    const patch = applyRuntimeEvent(state, event);
    const updatedSession = patch.sessions?.find((session) => session.id === SESSION_ID);

    expect(updatedSession?.updatedAt).toBe(42);
  });

  it('inserts history messages without creating a session row when none exists', () => {
    const state = baseState({ sessions: [] });
    const event = makeHistoryEvent({ messages: HISTORY_MESSAGES });

    const patch = applyRuntimeEvent(state, event);

    expect(patch.sessions).toEqual([]);
    expect(patch.messages).toHaveLength(2);
  });

  it('maps tool_call, tool_result and thinking blocks with the same field usage as the live branches', () => {
    const state = baseState({ sessions: [makeSession()] });
    const event = makeHistoryEvent({ messages: [HISTORY_MESSAGES[1]] });

    const patch = applyRuntimeEvent(state, event);
    const assistantMessage = patch.messages?.find((message) => message.id === 'h:uuid-2');
    expect(assistantMessage).toBeDefined();

    const toolCallBlock = assistantMessage?.blocks.find((block) => block.type === 'tool_call');
    expect(toolCallBlock).toEqual({
      id: 'h:uuid-2:1',
      type: 'tool_call',
      toolCallId: 'tool-1',
      toolName: 'Read',
      toolInput: { path: 'a.ts' },
    });

    const toolResultBlock = assistantMessage?.blocks.find((block) => block.type === 'tool_result');
    expect(toolResultBlock).toEqual({
      id: 'h:uuid-2:2',
      type: 'tool_result',
      toolCallId: 'tool-1',
      toolOk: true,
      toolOutput: 'file contents',
      text: undefined,
    });

    // Thinking history maps 1:1 since CP3 enabled thinking (C-05).
    expect(assistantMessage?.blocks.find((block) => block.id === 'h:uuid-2:3')).toEqual({
      id: 'h:uuid-2:3',
      type: 'thinking',
      text: 'thinking...',
    });
    expect(assistantMessage?.blocks.map((block) => block.type)).toEqual([
      'text',
      'tool_call',
      'tool_result',
      'thinking',
    ]);
  });
});

describe('applyRuntimeEvent — session.updated (C-06)', () => {
  it('writes runtimeIdentity onto the matching session row without bumping updatedAt', () => {
    const state = baseState({ sessions: [makeSession({ updatedAt: 42 })] });
    const event: RuntimeEvent = {
      type: 'session.updated',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 999,
      payload: { runtimeIdentity: 'rt-discovered' },
    };

    const patch = applyRuntimeEvent(state, event);
    const updatedSession = patch.sessions?.find((session) => session.id === SESSION_ID);

    expect(updatedSession?.runtimeIdentity).toBe('rt-discovered');
    expect(updatedSession?.updatedAt).toBe(42);
  });

  it('is a no-op for sessions that do not exist', () => {
    const state = baseState({ sessions: [] });
    const event: RuntimeEvent = {
      type: 'session.updated',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 999,
      payload: { runtimeIdentity: 'rt-discovered' },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.sessions).toEqual([]);
  });
});

describe('applyRuntimeEvent — permission.requested excludes history messages (C-06)', () => {
  it('does not attach a permission card to an h:* history assistant message', () => {
    const historyAssistant: ChatMessage = {
      id: 'h:asst-hist',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [{ id: 'h:asst-hist:0', type: 'text', text: 'from history' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: [historyAssistant],
    });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 999,
      payload: { permissionId: 'perm-1', toolName: 'Bash' },
    };

    const patch = applyRuntimeEvent(state, event);
    const messages = patch.messages ?? [];

    const historyMessageAfter = messages.find((message) => message.id === 'h:asst-hist');
    expect(historyMessageAfter?.blocks.some((block) => block.type === 'permission_request')).toBe(
      false
    );

    // No eligible runtime assistant message exists, so the reducer synthesizes a new one.
    const syntheticMessage = messages.find((message) => message.id === 'msg-perm-perm-1');
    expect(syntheticMessage).toBeDefined();
    expect(
      syntheticMessage?.blocks.some(
        (block) => block.type === 'permission_request' && block.permissionId === 'perm-1'
      )
    ).toBe(true);
    expect(patch.pendingPermission).toEqual({
      sessionId: SESSION_ID,
      permissionId: 'perm-1',
      messageId: 'msg-perm-perm-1',
    });
  });

  it('still attaches to the latest runtime assistant message when one exists after history', () => {
    const historyAssistant: ChatMessage = {
      id: 'h:asst-hist',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [{ id: 'h:asst-hist:0', type: 'text', text: 'from history' }],
    };
    const runtimeAssistant: ChatMessage = {
      id: 'asst-1',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [{ id: 'asst-1-block', type: 'text', text: 'live reply' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: [historyAssistant, runtimeAssistant],
    });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 999,
      payload: { permissionId: 'perm-2', toolName: 'Bash' },
    };

    const patch = applyRuntimeEvent(state, event);
    const messages = patch.messages ?? [];

    const runtimeMessageAfter = messages.find((message) => message.id === 'asst-1');
    expect(
      runtimeMessageAfter?.blocks.some(
        (block) => block.type === 'permission_request' && block.permissionId === 'perm-2'
      )
    ).toBe(true);
    expect(patch.pendingPermission?.messageId).toBe('asst-1');
  });
});
