import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { canRespondToPermission } from '@/components/chat/questionCardModel';
import {
  applyRuntimeEvent,
  applyRuntimeEvents,
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
    pendingPermissions: [],
    pendingQuestion: null,
    hostBoundSessionIds: [],
    runtimeReady: false,
    lastError: null,
    historyErrors: {},
    selectSession: () => {},
    sendMessage: async () => {},
    stopActiveSession: async () => {},
    respondPermission: async (_permissionId: string, _allow: boolean) => false,
    respondQuestion: async () => false,
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

  // Round-2 P0 (Chat attachments): optional-field addition — stores the
  // event's lightweight attachment metadata on the message, message-level.
  it('stores attachments metadata on the user message when the event carries any', () => {
    const state = baseState();
    const started: RuntimeEvent = {
      type: 'message.started',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: {
        messageId: 'msg-1',
        role: 'user',
        attachments: [{ kind: 'image', mediaType: 'image/png', name: 'shot.png' }],
      },
    };

    const patch = applyRuntimeEvent(state, started);
    expect(patch.messages).toEqual({
      [SESSION_ID]: [
        {
          id: 'msg-1',
          sessionId: SESSION_ID,
          role: 'user',
          blocks: [],
          attachments: [{ kind: 'image', mediaType: 'image/png', name: 'shot.png' }],
        },
      ],
    });
  });

  // F11 (round-2 review fix): `ChatMessage.model` was removed — it had zero
  // renderer consumers (the timeline's model display reads the event's real
  // model straight off the wire via messageMetadata.ts's own registry, never
  // this store). This test now pins the negative: the event's model id must
  // NOT be copied onto the stored message, even though the event carries one.
  it("does not store the event's model id on the message (F11: dead field removed, messageMetadata.ts owns model display)", () => {
    const state = baseState();
    const started: RuntimeEvent = {
      type: 'message.started',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'asst-1', role: 'assistant', model: 'claude-opus-4-8[1m]' },
    };

    const patch = applyRuntimeEvent(state, started);
    expect(patch.messages).toEqual({
      [SESSION_ID]: [
        {
          id: 'asst-1',
          sessionId: SESSION_ID,
          role: 'assistant',
          blocks: [],
        },
      ],
    });
  });

  it('omits the attachments key when the event carries none, and never carries a model key at all (F11)', () => {
    const state = baseState();
    const started: RuntimeEvent = {
      type: 'message.started',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'msg-1', role: 'user' },
    };

    const patch = applyRuntimeEvent(state, started);
    const message = patch.messages?.[SESSION_ID]?.[0];
    expect(message).not.toHaveProperty('attachments');
    expect(message).not.toHaveProperty('model');
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
  it('attaches the block to the latest assistant message and sets pendingPermissions + status', () => {
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
    expect(patch.pendingPermissions).toEqual([
      {
        sessionId: SESSION_ID,
        permissionId: 'perm-1',
        messageId: 'asst-2',
      },
    ]);
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
    expect(patch.pendingPermissions?.[0].messageId).toBe('msg-perm-perm-2');
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

    expect(patch.pendingPermissions?.[0].messageId).toBe('asst-target');
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
    expect(patch.pendingPermissions?.[0].messageId).toBe('msg-perm-perm-3');
  });

  // Round-2 P0 regression (4019fed): the Host uses the SDK toolUseID AS the
  // permissionId, which is the SAME id `tool.started` already used for that
  // turn's tool_call block. The idempotent-dedupe guard added in 4019fed
  // compared the incoming permissionId against every block id, not just
  // permission_request blocks, so it was always true here and the
  // permission_request block was silently dropped for every real permission
  // request — this is what the fix scopes the guard against.
  it('appends a permission_request block even when a tool_call block already shares its id', () => {
    const state = baseState({
      sessions: [makeSession({ status: 'running' })],
      messages: { [SESSION_ID]: [makeMessage({ id: 'asst-1', blocks: [] })] },
    });
    const toolStarted: RuntimeEvent = {
      type: 'tool.started',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { messageId: 'asst-1', toolCallId: 'toolu_1', name: 'Bash', input: { cmd: 'ls' } },
    };
    const patch1 = applyRuntimeEvent(state, toolStarted);
    const state2 = { ...state, ...patch1 } as ChatSessionsState;

    const permissionRequested: RuntimeEvent = {
      type: 'permission.requested',
      seq: 2,
      sessionId: SESSION_ID,
      timestamp: 2,
      payload: {
        permissionId: 'toolu_1',
        toolName: 'Bash',
        description: 'run ls',
        input: { cmd: 'ls' },
      },
    };
    const patch2 = applyRuntimeEvent(state2, permissionRequested);
    const target = patch2.messages?.[SESSION_ID]?.find((message) => message.id === 'asst-1');

    expect(target?.blocks.map((block) => block.type)).toEqual(['tool_call', 'permission_request']);
    expect(target?.blocks[1]).toEqual({
      id: 'toolu_1',
      type: 'permission_request',
      permissionId: 'toolu_1',
      toolName: 'Bash',
      toolDescription: 'run ls',
      toolInput: { cmd: 'ls' },
      resolved: false,
    });
    expect(canRespondToPermission(patch2.pendingPermissions ?? [], SESSION_ID, 'toolu_1')).toBe(
      true
    );
  });

  it('a redelivered permission.requested with the same permissionId stays idempotent', () => {
    const state = baseState({
      sessions: [makeSession({ status: 'running' })],
      messages: { [SESSION_ID]: [makeMessage({ id: 'asst-1', blocks: [] })] },
    });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-dup', toolName: 'Bash' },
    };
    const patch1 = applyRuntimeEvent(state, event);
    const state2 = { ...state, ...patch1 } as ChatSessionsState;
    const patch2 = applyRuntimeEvent(state2, { ...event, seq: 2, timestamp: 2 });

    const target = patch2.messages?.[SESSION_ID]?.find((message) => message.id === 'asst-1');
    expect(target?.blocks.filter((block) => block.type === 'permission_request')).toHaveLength(1);
    expect(
      patch2.pendingPermissions?.filter((item) => item.permissionId === 'perm-dup')
    ).toHaveLength(1);
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
      pendingPermissions: [{ sessionId: SESSION_ID, permissionId: 'perm-1', messageId: 'asst-1' }],
    });
  }

  it('marks the matching block resolved/allowed and dequeues it from pendingPermissions', () => {
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
    expect(patch.pendingPermissions).toEqual([]);
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

    // R12/R13 (round-2 iteration-2 review, RED-LINE approved): the block is
    // already resolved by the time patch2 runs — first resolution wins, and
    // a no-op redelivery now preserves object identity (no `messages` key
    // at all) instead of reallocating an equal-but-new bucket.
    expect(patch2.messages).toBeUndefined();
    // patch2 applies to a state where the entry is already gone, so the
    // second-round patch carries no pendingPermissions key at all (empty
    // patch — see withoutPermission's reference-stability contract).
    expect(patch2.pendingPermissions).toBeUndefined();
    const finalMessage = state2.messages[SESSION_ID]?.find((message) => message.id === 'asst-1');
    expect(finalMessage?.blocks).toHaveLength(1);
    expect(finalMessage?.blocks[0]).toEqual({
      id: 'perm-1',
      type: 'permission_request',
      permissionId: 'perm-1',
      resolved: true,
      allowed: false,
    });
  });

  it('R12: first resolution wins — a later resolved event with a DIFFERENT allow value must not flip an already-resolved block', () => {
    const state = stateWithPermissionBlock();
    const denyEvent: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-1', allow: false },
    };
    const patch1 = applyRuntimeEvent(state, denyEvent);
    const state2 = { ...state, ...patch1 } as ChatSessionsState;

    // A stale/compensating redelivery with the OPPOSITE allow value (the
    // Stop-race: an authoritative deny settles first, then a compensating
    // `allow:true` arrives for the same id) must not overwrite it.
    const allowEvent: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 2,
      sessionId: SESSION_ID,
      timestamp: 2,
      payload: { permissionId: 'perm-1', allow: true },
    };
    const patch2 = applyRuntimeEvent(state2, allowEvent);

    expect(patch2.messages).toBeUndefined();
    const finalMessage = state2.messages[SESSION_ID]?.find((message) => message.id === 'asst-1');
    expect(finalMessage?.blocks[0]).toEqual({
      id: 'perm-1',
      type: 'permission_request',
      permissionId: 'perm-1',
      resolved: true,
      allowed: false,
    });
  });

  // Behavior change (intentional, see design spec §1.3): the old single-slot
  // pending-permission field was cleared for ANY resolved event, even one
  // whose permissionId matched nothing — which is exactly the class of bug
  // this fix closes (a stray/late resolved must not starve a real pending
  // card). The queue now only dequeues an exact (sessionId, permissionId)
  // match; an unmatched id leaves it untouched.
  it('leaves the queue untouched when the permissionId matches no pending entry', () => {
    const state = stateWithPermissionBlock();
    const event: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-does-not-exist', allow: true },
    };

    const patch = applyRuntimeEvent(state, event);
    const nextState = { ...state, ...patch } as ChatSessionsState;

    expect(nextState.pendingPermissions).toEqual(state.pendingPermissions);
    // R13 (round-2 iteration-2 review, RED-LINE approved): a no-match event
    // now returns the ORIGINAL state's object identities (no `messages` key
    // at all), rather than reallocating an equal-but-new bucket for a no-op.
    expect(patch.messages).toBeUndefined();
    expect(nextState.messages).toBe(state.messages);
  });
});

// Regression coverage for the permission-queue concurrency fix: two `canUseTool`
// prompts can park at once (SDK concurrency), so `pendingPermissions` must behave
// as a real per-permissionId queue, never a single slot. N1+N2+A1 (see
// chatSessionsRespond.test.ts) are the minimal recreation of the original bug
// report (a starved second card, and the more dangerous silent misattribution).
describe('applyRuntimeEvent — pendingPermissions queue (concurrent park fix)', () => {
  function twoParkedState(): ChatSessionsState {
    const assistant = makeMessage({ id: 'asst-1', role: 'assistant', blocks: [] });
    const state = baseState({
      sessions: [makeSession({ status: 'running' })],
      messages: { [SESSION_ID]: [assistant] },
    });
    const eventA: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-A', toolName: 'Read' },
    };
    const eventB: RuntimeEvent = {
      type: 'permission.requested',
      seq: 2,
      sessionId: SESSION_ID,
      timestamp: 2,
      payload: { permissionId: 'perm-B', toolName: 'Read' },
    };
    const patchA = applyRuntimeEvent(state, eventA);
    const stateAfterA = { ...state, ...patchA } as ChatSessionsState;
    const patchB = applyRuntimeEvent(stateAfterA, eventB);
    return { ...stateAfterA, ...patchB } as ChatSessionsState;
  }

  it('N1: two concurrent requested events queue in arrival order on the same assistant message', () => {
    const state = twoParkedState();

    expect(state.pendingPermissions).toEqual([
      { sessionId: SESSION_ID, permissionId: 'perm-A', messageId: 'asst-1' },
      { sessionId: SESSION_ID, permissionId: 'perm-B', messageId: 'asst-1' },
    ]);
    const message = state.messages[SESSION_ID]?.find((item) => item.id === 'asst-1');
    expect(message?.blocks.map((block) => block.permissionId)).toEqual(['perm-A', 'perm-B']);
    expect(state.sessions.find((session) => session.id === SESSION_ID)?.status).toBe(
      'waiting_permission'
    );
  });

  it('N2: resolving the first entry only dequeues it — the second stays parked and unresolved', () => {
    const state = twoParkedState();
    const event: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 3,
      sessionId: SESSION_ID,
      timestamp: 3,
      payload: { permissionId: 'perm-A', allow: true },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.pendingPermissions).toEqual([
      { sessionId: SESSION_ID, permissionId: 'perm-B', messageId: 'asst-1' },
    ]);
    const message = patch.messages?.[SESSION_ID]?.find((item) => item.id === 'asst-1');
    expect(message?.blocks.find((block) => block.permissionId === 'perm-A')?.resolved).toBe(true);
    expect(message?.blocks.find((block) => block.permissionId === 'perm-B')?.resolved).toBe(false);
  });

  it('N3: resolving out of order (the second entry first) only dequeues that entry', () => {
    const state = twoParkedState();
    const event: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 3,
      sessionId: SESSION_ID,
      timestamp: 3,
      payload: { permissionId: 'perm-B', allow: false },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.pendingPermissions).toEqual([
      { sessionId: SESSION_ID, permissionId: 'perm-A', messageId: 'asst-1' },
    ]);
    const message = patch.messages?.[SESSION_ID]?.find((item) => item.id === 'asst-1');
    expect(message?.blocks.find((block) => block.permissionId === 'perm-A')?.resolved).toBe(false);
    expect(message?.blocks.find((block) => block.permissionId === 'perm-B')?.resolved).toBe(true);
  });

  it('N4: a redelivered permissionId does not duplicate the queue entry or the block (E11)', () => {
    const assistant = makeMessage({ id: 'asst-1', role: 'assistant', blocks: [] });
    const state = baseState({
      sessions: [makeSession({ status: 'running' })],
      messages: { [SESSION_ID]: [assistant] },
    });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-1', toolName: 'Bash' },
    };

    const patch1 = applyRuntimeEvent(state, event);
    const state2 = { ...state, ...patch1 } as ChatSessionsState;
    const patch2 = applyRuntimeEvent(state2, event);
    const state3 = { ...state2, ...patch2 } as ChatSessionsState;

    expect(state3.pendingPermissions).toHaveLength(1);
    const message = state3.messages[SESSION_ID]?.find((item) => item.id === 'asst-1');
    expect(message?.blocks).toHaveLength(1);
  });

  it('N5: resolving session A leaves session B entry untouched (E10)', () => {
    const assistantA = makeMessage({
      id: 'asst-a',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [
        { id: 'perm-a', type: 'permission_request', permissionId: 'perm-a', resolved: false },
      ],
    });
    const assistantB = makeMessage({
      id: 'asst-b',
      sessionId: 'session-2',
      role: 'assistant',
      blocks: [
        { id: 'perm-b', type: 'permission_request', permissionId: 'perm-b', resolved: false },
      ],
    });
    const state = baseState({
      sessions: [
        makeSession({ status: 'waiting_permission' }),
        makeSession({ id: 'session-2', status: 'waiting_permission' }),
      ],
      messages: { [SESSION_ID]: [assistantA], 'session-2': [assistantB] },
      pendingPermissions: [
        { sessionId: SESSION_ID, permissionId: 'perm-a', messageId: 'asst-a' },
        { sessionId: 'session-2', permissionId: 'perm-b', messageId: 'asst-b' },
      ],
    });
    const event: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-a', allow: true },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.pendingPermissions).toEqual([
      { sessionId: 'session-2', permissionId: 'perm-b', messageId: 'asst-b' },
    ]);
  });

  function twoSessionQueue(): ChatSessionsState {
    return baseState({
      sessions: [
        makeSession({ status: 'running' }),
        makeSession({ id: 'session-2', status: 'waiting_permission' }),
      ],
      pendingPermissions: [
        { sessionId: SESSION_ID, permissionId: 'perm-x', messageId: 'm1' },
        { sessionId: 'session-2', permissionId: 'perm-y', messageId: 'm2' },
      ],
    });
  }

  it('N6a: session.completed clears this session pending, keeps another session queued', () => {
    const state = twoSessionQueue();
    const event: RuntimeEvent = {
      type: 'session.completed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.pendingPermissions).toEqual([
      { sessionId: 'session-2', permissionId: 'perm-y', messageId: 'm2' },
    ]);
    expect(patch.sessions?.find((session) => session.id === SESSION_ID)?.status).toBe('idle');
  });

  it('N6b: session.failed clears this session pending and still sets lastError (no regression)', () => {
    const state = twoSessionQueue();
    const event: RuntimeEvent = {
      type: 'session.failed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { error: 'boom' },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.pendingPermissions).toEqual([
      { sessionId: 'session-2', permissionId: 'perm-y', messageId: 'm2' },
    ]);
    expect(patch.lastError).toBe('boom');
  });

  it('N6c: session.stopped clears this session pending and still leaves messages untouched', () => {
    const state = twoSessionQueue();
    const event: RuntimeEvent = {
      type: 'session.stopped',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.pendingPermissions).toEqual([
      { sessionId: 'session-2', permissionId: 'perm-y', messageId: 'm2' },
    ]);
    expect(patch.messages).toBeUndefined();
  });

  it('N7: a terminal event with nothing pending produces no pendingPermissions key (reference stability, §1.5)', () => {
    const state = baseState({
      sessions: [makeSession({ status: 'running' })],
      pendingPermissions: [],
    });
    const terminalEvents: RuntimeEvent[] = [
      { type: 'session.completed', seq: 1, sessionId: SESSION_ID, timestamp: 1 },
      { type: 'session.failed', seq: 2, sessionId: SESSION_ID, timestamp: 2 },
      { type: 'session.stopped', seq: 3, sessionId: SESSION_ID, timestamp: 3 },
    ];

    for (const event of terminalEvents) {
      const patch = applyRuntimeEvent(state, event);
      expect('pendingPermissions' in patch).toBe(false);
    }
  });

  it('N8: a single batch [requested A, requested B, resolved A] folds to queue=[B] with A resolved (E13)', () => {
    const assistant = makeMessage({ id: 'asst-1', role: 'assistant', blocks: [] });
    const state = baseState({
      sessions: [makeSession({ status: 'running' })],
      messages: { [SESSION_ID]: [assistant] },
    });
    const events: RuntimeEvent[] = [
      {
        type: 'permission.requested',
        seq: 1,
        sessionId: SESSION_ID,
        timestamp: 1,
        payload: { permissionId: 'perm-A', toolName: 'Bash' },
      },
      {
        type: 'permission.requested',
        seq: 2,
        sessionId: SESSION_ID,
        timestamp: 2,
        payload: { permissionId: 'perm-B', toolName: 'Bash' },
      },
      {
        type: 'permission.resolved',
        seq: 3,
        sessionId: SESSION_ID,
        timestamp: 3,
        payload: { permissionId: 'perm-A', allow: true },
      },
    ];

    const patch = applyRuntimeEvents(state, events);

    expect(patch.pendingPermissions).toEqual([
      { sessionId: SESSION_ID, permissionId: 'perm-B', messageId: 'asst-1' },
    ]);
    const message = patch.messages?.[SESSION_ID]?.find((item) => item.id === 'asst-1');
    expect(message?.blocks.find((block) => block.permissionId === 'perm-A')?.resolved).toBe(true);
    expect(message?.blocks.find((block) => block.permissionId === 'perm-B')?.resolved).toBe(false);
  });

  it('N9: resolved with no messages bucket for the session still dequeues, with no messages key in the patch', () => {
    const state = baseState({
      sessions: [makeSession({ status: 'waiting_permission' })],
      messages: {},
      pendingPermissions: [{ sessionId: SESSION_ID, permissionId: 'perm-1', messageId: 'asst-1' }],
    });
    const event: RuntimeEvent = {
      type: 'permission.resolved',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { permissionId: 'perm-1', allow: true },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.pendingPermissions).toEqual([]);
    expect(patch.messages).toBeUndefined();
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

// a1 (2026-07-30 net-visibility batch): session.status now optionally carries
// the CLI's own transport-retry loop for this turn.
describe('applyRuntimeEvent — session.status retry (a1)', () => {
  it('stores the retry payload on the session when session.status carries one', () => {
    const state = baseState({ sessions: [makeSession({ status: 'running' })] });
    const event: RuntimeEvent = {
      type: 'session.status',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: {
        status: 'running',
        retry: { attempt: 3, maxRetries: 10, delayMs: 4200, errorStatus: null, error: 'unknown' },
      },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.sessions?.find((session) => session.id === SESSION_ID)?.retry).toEqual({
      attempt: 3,
      maxRetries: 10,
      delayMs: 4200,
      errorStatus: null,
      error: 'unknown',
    });
  });

  it('clears a previously stored retry when a later session.status carries none', () => {
    const state = baseState({
      sessions: [
        makeSession({
          status: 'running',
          retry: { attempt: 2, maxRetries: 10, delayMs: 1000, errorStatus: null, error: 'unknown' },
        }),
      ],
    });
    const event: RuntimeEvent = {
      type: 'session.status',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { status: 'running' },
    };

    const patch = applyRuntimeEvent(state, event);

    expect(patch.sessions?.find((session) => session.id === SESSION_ID)?.retry).toBeUndefined();
  });

  it('clears a stored retry on session.completed/failed/stopped terminal events', () => {
    const withRetry = (status: ChatSession['status']) =>
      baseState({
        sessions: [
          makeSession({
            status,
            retry: {
              attempt: 1,
              maxRetries: 10,
              delayMs: 500,
              errorStatus: null,
              error: 'unknown',
            },
          }),
        ],
      });

    const completed = applyRuntimeEvent(withRetry('running'), {
      type: 'session.completed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
    });
    expect(completed.sessions?.find((session) => session.id === SESSION_ID)?.retry).toBeUndefined();

    const failed = applyRuntimeEvent(withRetry('running'), {
      type: 'session.failed',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
      payload: { error: 'boom' },
    });
    expect(failed.sessions?.find((session) => session.id === SESSION_ID)?.retry).toBeUndefined();

    const stopped = applyRuntimeEvent(withRetry('running'), {
      type: 'session.stopped',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 1,
    });
    expect(stopped.sessions?.find((session) => session.id === SESSION_ID)?.retry).toBeUndefined();
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
