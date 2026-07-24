import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  applyRuntimeEvent,
  type ChatMessage,
  type ChatSession,
  type ChatSessionsState,
} from '../chatSessions';

// Behavior-lock tests for the pure applyRuntimeEvent reducer, ahead of the C-08
// refactor. These freeze CURRENT behavior — including quirks — not the ideal one.

const SESSION_ID = 'session-1';

function baseState(overrides: Partial<ChatSessionsState> = {}): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: [],
    messages: {},
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

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    sessionId: SESSION_ID,
    role: 'assistant',
    blocks: [],
    ...overrides,
  };
}

describe('applyRuntimeEvent — message.started', () => {
  it('creates a new message with empty blocks; a repeat with the same messageId replaces it', () => {
    const state = baseState();
    const started: RuntimeEvent = {
      type: 'message.started',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'msg-1', role: 'user' },
    };

    const patch1 = applyRuntimeEvent(state, started);
    expect(patch1.messages).toEqual({
      [SESSION_ID]: [{ id: 'msg-1', sessionId: SESSION_ID, role: 'user', blocks: [] }],
    });

    // Add a block, then re-send message.started with the same messageId — upsert
    // semantics replace the whole message, so the block is lost (blocks reset).
    const state2 = { ...state, ...patch1 } as ChatSessionsState;
    const delta: RuntimeEvent = {
      type: 'message.delta',
      seq: 2,
      sessionId: SESSION_ID,
      timestamp: 2,
      payload: { messageId: 'msg-1', blockId: 'b1', text: 'hello' },
    };
    const patch2 = applyRuntimeEvent(state2, delta);
    const state3 = { ...state2, ...patch2 } as ChatSessionsState;
    expect(state3.messages[SESSION_ID][0].blocks).toEqual([
      { id: 'b1', type: 'text', text: 'hello' },
    ]);

    const patch3 = applyRuntimeEvent(state3, started);
    expect(patch3.messages).toEqual({
      [SESSION_ID]: [{ id: 'msg-1', sessionId: SESSION_ID, role: 'user', blocks: [] }],
    });
  });
});

describe('applyRuntimeEvent — message.delta', () => {
  it('concatenates text when two deltas share the same blockId', () => {
    const state = baseState({ messages: { [SESSION_ID]: [makeMessage({ blocks: [] })] } });
    const delta1: RuntimeEvent = {
      type: 'message.delta',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'msg-1', blockId: 'b1', text: 'Hel' },
    };
    const patch1 = applyRuntimeEvent(state, delta1);
    const state2 = { ...state, ...patch1 } as ChatSessionsState;
    const delta2: RuntimeEvent = {
      type: 'message.delta',
      seq: 2,
      sessionId: SESSION_ID,
      timestamp: 2,
      payload: { messageId: 'msg-1', blockId: 'b1', text: 'lo' },
    };
    const patch2 = applyRuntimeEvent(state2, delta2);
    const updated = patch2.messages?.[SESSION_ID]?.find((message) => message.id === 'msg-1');

    expect(updated?.blocks).toEqual([{ id: 'b1', type: 'text', text: 'Hello' }]);
  });

  it('pushes a second block when a new blockId targets an existing message', () => {
    const state = baseState({
      messages: {
        [SESSION_ID]: [makeMessage({ blocks: [{ id: 'b1', type: 'text', text: 'first' }] })],
      },
    });
    const delta: RuntimeEvent = {
      type: 'message.delta',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'msg-1', blockId: 'b2', text: 'second' },
    };

    const patch = applyRuntimeEvent(state, delta);
    const updated = patch.messages?.[SESSION_ID]?.find((message) => message.id === 'msg-1');

    expect(updated?.blocks).toEqual([
      { id: 'b1', type: 'text', text: 'first' },
      { id: 'b2', type: 'text', text: 'second' },
    ]);
  });

  it('returns {} for an unknown messageId (state unchanged, no crash)', () => {
    const state = baseState({ messages: {} });
    const delta: RuntimeEvent = {
      type: 'message.delta',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'missing', blockId: 'b1', text: 'x' },
    };

    expect(applyRuntimeEvent(state, delta)).toEqual({});
  });
});

describe('applyRuntimeEvent — thinking.started', () => {
  it('adds a thinking block once; a duplicate with the same blockId is a no-op', () => {
    const state = baseState({ messages: { [SESSION_ID]: [makeMessage({ blocks: [] })] } });
    const started: RuntimeEvent = {
      type: 'thinking.started',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'msg-1', blockId: 'th-1' },
    };

    const patch1 = applyRuntimeEvent(state, started);
    const updated = patch1.messages?.[SESSION_ID]?.find((message) => message.id === 'msg-1');
    expect(updated?.blocks).toEqual([{ id: 'th-1', type: 'thinking', text: '' }]);

    const state2 = { ...state, ...patch1 } as ChatSessionsState;
    const patch2 = applyRuntimeEvent(state2, started);
    expect(patch2).toEqual({});
  });
});

describe('applyRuntimeEvent — thinking.delta', () => {
  it('creates the thinking block even when it arrives before thinking.started (out-of-order)', () => {
    const state = baseState({ messages: { [SESSION_ID]: [makeMessage({ blocks: [] })] } });
    const delta: RuntimeEvent = {
      type: 'thinking.delta',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'msg-1', blockId: 'th-1', text: 'pondering' },
    };

    const patch = applyRuntimeEvent(state, delta);
    const updated = patch.messages?.[SESSION_ID]?.find((message) => message.id === 'msg-1');

    expect(updated?.blocks).toEqual([{ id: 'th-1', type: 'thinking', text: 'pondering' }]);
  });

  it('returns {} for an unknown messageId', () => {
    const state = baseState({ messages: {} });
    const delta: RuntimeEvent = {
      type: 'thinking.delta',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'missing', blockId: 'th-1', text: 'pondering' },
    };

    expect(applyRuntimeEvent(state, delta)).toEqual({});
  });
});

describe('applyRuntimeEvent — tool.started / tool.completed', () => {
  it('tool.started appends a tool_call block; tool.completed appends a tool_result block', () => {
    const state = baseState({ messages: { [SESSION_ID]: [makeMessage({ blocks: [] })] } });
    const started: RuntimeEvent = {
      type: 'tool.started',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'msg-1', toolCallId: 'call-1', name: 'Read', input: { path: 'a.ts' } },
    };

    const patch1 = applyRuntimeEvent(state, started);
    const afterStart = patch1.messages?.[SESSION_ID]?.find((message) => message.id === 'msg-1');
    expect(afterStart?.blocks).toEqual([
      {
        id: 'call-1',
        type: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'Read',
        toolInput: { path: 'a.ts' },
      },
    ]);

    const state2 = { ...state, ...patch1 } as ChatSessionsState;
    const completed: RuntimeEvent = {
      type: 'tool.completed',
      seq: 2,
      sessionId: SESSION_ID,
      timestamp: 2,
      payload: { messageId: 'msg-1', toolCallId: 'call-1', ok: true, output: 'done' },
    };
    const patch2 = applyRuntimeEvent(state2, completed);
    const afterComplete = patch2.messages?.[SESSION_ID]?.find((message) => message.id === 'msg-1');

    expect(afterComplete?.blocks[1]).toEqual({
      id: 'call-1-result',
      type: 'tool_result',
      toolCallId: 'call-1',
      toolOk: true,
      toolOutput: 'done',
      text: undefined,
    });
  });

  it('tool.completed sets text to the error message only when ok is false', () => {
    const state = baseState({ messages: { [SESSION_ID]: [makeMessage({ blocks: [] })] } });
    const completed: RuntimeEvent = {
      type: 'tool.completed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'msg-1', toolCallId: 'call-2', ok: false, error: 'boom' },
    };

    const patch = applyRuntimeEvent(state, completed);
    const updated = patch.messages?.[SESSION_ID]?.find((message) => message.id === 'msg-1');

    expect(updated?.blocks[0]).toEqual({
      id: 'call-2-result',
      type: 'tool_result',
      toolCallId: 'call-2',
      toolOk: false,
      toolOutput: undefined,
      text: 'boom',
    });
  });

  it('returns {} for an unknown messageId on both tool.started and tool.completed', () => {
    const state = baseState({ messages: {} });
    const started: RuntimeEvent = {
      type: 'tool.started',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'missing', toolCallId: 'call-1', name: 'Read' },
    };
    const completed: RuntimeEvent = {
      type: 'tool.completed',
      seq: 2,
      sessionId: SESSION_ID,
      timestamp: 2,
      payload: { messageId: 'missing', toolCallId: 'call-1', ok: true },
    };

    expect(applyRuntimeEvent(state, started)).toEqual({});
    expect(applyRuntimeEvent(state, completed)).toEqual({});
  });
});

describe('applyRuntimeEvent — permission.requested', () => {
  it('attaches the block to the latest assistant message and sets pendingPermission + status', () => {
    const assistantA = makeMessage({ id: 'asst-1', role: 'assistant', blocks: [] });
    const userMessage = makeMessage({ id: 'user-1', role: 'user', blocks: [] });
    const assistantB = makeMessage({ id: 'asst-2', role: 'assistant', blocks: [] });
    const state = baseState({
      sessions: [makeSession({ status: 'running' })],
      messages: { [SESSION_ID]: [assistantA, userMessage, assistantB] },
    });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: {
        permissionId: 'perm-1',
        toolName: 'Bash',
        description: 'run ls',
        input: { cmd: 'ls' },
      },
    };

    const patch = applyRuntimeEvent(state, event);
    const target = patch.messages?.[SESSION_ID]?.find((message) => message.id === 'asst-2');

    expect(target?.blocks).toEqual([
      {
        id: 'perm-1',
        type: 'permission_request',
        permissionId: 'perm-1',
        toolName: 'Bash',
        toolDescription: 'run ls',
        toolInput: { cmd: 'ls' },
        resolved: false,
      },
    ]);
    expect(patch.pendingPermission).toEqual({
      sessionId: SESSION_ID,
      permissionId: 'perm-1',
      messageId: 'asst-2',
    });
    expect(patch.sessions?.find((session) => session.id === SESSION_ID)?.status).toBe(
      'waiting_permission'
    );
  });

  it('creates a synthetic message id when no eligible assistant message exists', () => {
    const state = baseState({ sessions: [makeSession()], messages: {} });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-2', toolName: 'Bash' },
    };

    const patch = applyRuntimeEvent(state, event);
    const synthetic = patch.messages?.[SESSION_ID]?.find(
      (message) => message.id === 'msg-perm-perm-2'
    );

    expect(synthetic).toBeDefined();
    expect(synthetic?.role).toBe('assistant');
    expect(patch.pendingPermission?.messageId).toBe('msg-perm-perm-2');
    expect(synthetic?.blocks).toEqual([
      {
        id: 'perm-2',
        type: 'permission_request',
        permissionId: 'perm-2',
        toolName: 'Bash',
        toolDescription: undefined,
        toolInput: undefined,
        resolved: false,
      },
    ]);
  });

  it('attaches to the target session own latest assistant message, ignoring a newer cross-session decoy', () => {
    const targetAssistant = makeMessage({ id: 'asst-target', role: 'assistant', blocks: [] });
    // Decoy: a different session's assistant message, placed LATER in the array so a
    // reducer that forgets to filter by sessionId would pick this one instead.
    const decoyAssistant = makeMessage({
      id: 'asst-decoy',
      sessionId: 'session-2',
      role: 'assistant',
      blocks: [],
    });
    const state = baseState({
      sessions: [
        makeSession({ status: 'running' }),
        makeSession({ id: 'session-2', status: 'running' }),
      ],
      messages: { [SESSION_ID]: [targetAssistant], 'session-2': [decoyAssistant] },
    });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-cross', toolName: 'Bash' },
    };

    const patch = applyRuntimeEvent(state, event);
    const target = patch.messages?.[SESSION_ID]?.find((message) => message.id === 'asst-target');

    expect(patch.pendingPermission?.messageId).toBe('asst-target');
    expect(target?.blocks).toEqual([
      {
        id: 'perm-cross',
        type: 'permission_request',
        permissionId: 'perm-cross',
        toolName: 'Bash',
        toolDescription: undefined,
        toolInput: undefined,
        resolved: false,
      },
    ]);
    // The other session's bucket is untouched byte-for-byte, not merely its decoy message's blocks.
    expect(patch.messages?.['session-2']).toEqual([decoyAssistant]);
  });

  it('falls back to a synthetic message when only h:-prefixed assistant messages exist', () => {
    const historyAssistant = makeMessage({ id: 'h:asst-1', role: 'assistant', blocks: [] });
    const state = baseState({
      sessions: [makeSession()],
      messages: { [SESSION_ID]: [historyAssistant] },
    });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-3', toolName: 'Bash' },
    };

    const patch = applyRuntimeEvent(state, event);
    const historyAfter = patch.messages?.[SESSION_ID]?.find((message) => message.id === 'h:asst-1');
    const synthetic = patch.messages?.[SESSION_ID]?.find(
      (message) => message.id === 'msg-perm-perm-3'
    );

    expect(historyAfter?.blocks).toEqual([]);
    expect(synthetic).toBeDefined();
    expect(patch.pendingPermission?.messageId).toBe('msg-perm-perm-3');
  });
});

describe('applyRuntimeEvent — permission.resolved', () => {
  function stateWithPermissionBlock(): ChatSessionsState {
    const message = makeMessage({
      id: 'asst-1',
      role: 'assistant',
      blocks: [
        { id: 'perm-1', type: 'permission_request', permissionId: 'perm-1', resolved: false },
      ],
    });
    return baseState({
      sessions: [makeSession({ status: 'waiting_permission' })],
      messages: { [SESSION_ID]: [message] },
      pendingPermission: { sessionId: SESSION_ID, permissionId: 'perm-1', messageId: 'asst-1' },
    });
  }

  it('marks the matching block resolved/allowed and clears pendingPermission', () => {
    const state = stateWithPermissionBlock();
    const event: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-1', allow: true },
    };

    const patch = applyRuntimeEvent(state, event);
    const updated = patch.messages?.[SESSION_ID]?.find((message) => message.id === 'asst-1');

    expect(updated?.blocks[0]).toEqual({
      id: 'perm-1',
      type: 'permission_request',
      permissionId: 'perm-1',
      resolved: true,
      allowed: true,
    });
    expect(patch.pendingPermission).toBeNull();
  });

  it('is idempotent: applying the same resolved event twice stays consistent, no duplication', () => {
    const state = stateWithPermissionBlock();
    const event: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-1', allow: false },
    };

    const patch1 = applyRuntimeEvent(state, event);
    const state2 = { ...state, ...patch1 } as ChatSessionsState;
    const patch2 = applyRuntimeEvent(state2, event);

    expect(patch2.messages).toEqual(patch1.messages);
    expect(patch2.pendingPermission).toBeNull();
    const finalMessage = patch2.messages?.[SESSION_ID]?.find((message) => message.id === 'asst-1');
    expect(finalMessage?.blocks).toHaveLength(1);
    expect(finalMessage?.blocks[0]).toEqual({
      id: 'perm-1',
      type: 'permission_request',
      permissionId: 'perm-1',
      resolved: true,
      allowed: false,
    });
  });

  it('clears pendingPermission and leaves messages untouched when the permissionId matches no block', () => {
    const state = stateWithPermissionBlock();
    const event: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-does-not-exist', allow: true },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.pendingPermission).toBeNull();
    expect(patch.messages).toEqual(state.messages);
  });
});

describe('applyRuntimeEvent — session.stopped (stop freeze)', () => {
  it('sets status to idle without dropping any messages/blocks', () => {
    const message = makeMessage({
      id: 'asst-1',
      blocks: [{ id: 'b1', type: 'text', text: 'hello' }],
    });
    const state = baseState({
      sessions: [makeSession({ status: 'running' })],
      messages: { [SESSION_ID]: [message] },
    });
    const event: RuntimeEvent = {
      type: 'session.stopped',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.sessions?.find((session) => session.id === SESSION_ID)?.status).toBe('idle');
    // No `messages` key in the patch at all — content is preserved untouched.
    expect(patch.messages).toBeUndefined();
  });

  it('does not guard message.delta after session.stopped — deltas still append (current tolerance)', () => {
    const message = makeMessage({ id: 'asst-1', blocks: [] });
    const state = baseState({
      sessions: [makeSession({ status: 'idle' })],
      messages: { [SESSION_ID]: [message] },
    });
    const delta: RuntimeEvent = {
      type: 'message.delta',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'asst-1', blockId: 'b1', text: 'late text' },
    };

    const patch = applyRuntimeEvent(state, delta);
    const updated = patch.messages?.[SESSION_ID]?.find((item) => item.id === 'asst-1');

    expect(updated?.blocks).toEqual([{ id: 'b1', type: 'text', text: 'late text' }]);
  });
});

describe('applyRuntimeEvent — session.status recentSessionIds', () => {
  it('moves an existing sessionId to the front and dedupes', () => {
    const state = baseState({ recentSessionIds: ['other-1', SESSION_ID, 'other-2'] });
    const event: RuntimeEvent = {
      type: 'session.status',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { status: 'running' },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.recentSessionIds).toEqual([SESSION_ID, 'other-1', 'other-2']);
  });

  it('caps the list at 8, evicting the oldest entry', () => {
    const existing = ['s2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];
    const state = baseState({ recentSessionIds: existing });
    const event: RuntimeEvent = {
      type: 'session.status',
      seq: 1,
      sessionId: 's1',
      timestamp: 1,
      payload: { status: 'running' },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.recentSessionIds).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
    expect(patch.recentSessionIds).toHaveLength(8);
    expect(patch.recentSessionIds).not.toContain('s9');
  });
});

describe('applyRuntimeEvent — session.created / session.resumed', () => {
  it('adds sessionId to hostBoundSessionIds exactly once and enriches runtimeIdentity', () => {
    const state = baseState({
      sessions: [makeSession()],
      hostBoundSessionIds: [],
    });
    const created: RuntimeEvent = {
      type: 'session.created',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { runtimeIdentity: 'rt-1' },
    };

    const patch1 = applyRuntimeEvent(state, created);
    expect(patch1.hostBoundSessionIds).toEqual([SESSION_ID]);
    expect(patch1.sessions?.find((session) => session.id === SESSION_ID)?.runtimeIdentity).toBe(
      'rt-1'
    );

    // Repeat with session.resumed — idempotent on hostBoundSessionIds, identity re-enriched.
    const state2 = { ...state, ...patch1 } as ChatSessionsState;
    const resumed: RuntimeEvent = {
      type: 'session.resumed',
      seq: 2,
      sessionId: SESSION_ID,
      timestamp: 2,
      payload: { runtimeIdentity: 'rt-2' },
    };
    const patch2 = applyRuntimeEvent(state2, resumed);

    expect(patch2.hostBoundSessionIds).toEqual([SESSION_ID]);
    expect(patch2.sessions?.find((session) => session.id === SESSION_ID)?.runtimeIdentity).toBe(
      'rt-2'
    );
  });

  it('preserves the existing runtimeIdentity when the payload has none', () => {
    const state = baseState({
      sessions: [makeSession({ runtimeIdentity: 'rt-old' })],
      hostBoundSessionIds: [SESSION_ID],
    });
    const event: RuntimeEvent = {
      type: 'session.resumed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.sessions?.find((session) => session.id === SESSION_ID)?.runtimeIdentity).toBe(
      'rt-old'
    );
    expect(patch.hostBoundSessionIds).toEqual([SESSION_ID]);
  });
});

describe('applyRuntimeEvent — event routing edge cases', () => {
  it('returns {} when sessionId is missing, even for an otherwise-handled event type', () => {
    const state = baseState();
    // Cast bypasses the type-level `sessionId: string` requirement to simulate
    // a malformed/edge-case event at runtime.
    const event = {
      type: 'message.delta',
      seq: 1,
      timestamp: 1,
      payload: { messageId: 'msg-1', blockId: 'b1', text: 'hi' },
    } as unknown as RuntimeEvent;

    expect(applyRuntimeEvent(state, event)).toEqual({});
  });

  it('returns {} for a recognized-but-unhandled event type (message.completed)', () => {
    const state = baseState();
    const event: RuntimeEvent = {
      type: 'message.completed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'msg-1' },
    };

    expect(applyRuntimeEvent(state, event)).toEqual({});
  });
});

describe('applyRuntimeEvent — session.failed / session.completed', () => {
  it('session.failed sets status failed and lastError from payload.error', () => {
    const state = baseState({ sessions: [makeSession({ status: 'running' })] });
    const event: RuntimeEvent = {
      type: 'session.failed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { error: 'boom' },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.sessions?.find((session) => session.id === SESSION_ID)?.status).toBe('failed');
    expect(patch.lastError).toBe('boom');
  });

  it('falls back to "Session failed" when payload.error is absent', () => {
    const state = baseState({ sessions: [makeSession({ status: 'running' })] });
    const event: RuntimeEvent = {
      type: 'session.failed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.lastError).toBe('Session failed');
  });

  it('session.completed sets status idle', () => {
    const state = baseState({ sessions: [makeSession({ status: 'running' })] });
    const event: RuntimeEvent = {
      type: 'session.completed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.sessions?.find((session) => session.id === SESSION_ID)?.status).toBe('idle');
  });
});
