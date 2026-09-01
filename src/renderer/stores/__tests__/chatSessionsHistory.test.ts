import type { RuntimeEvent, SessionHistoryEvent } from '@shared/types/runtimeEvents';
import type { HistoryMessage } from '@shared/types/sessionHistory';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyRuntimeEvent,
  type ChatMessage,
  type ChatSession,
  type ChatSessionsState,
} from '../chatSessions';
import { resetResumeCandidatesForTests } from '../historyReplayMerge';

const SESSION_ID = 'session-1';

// The replay-coverage merge keeps its resume watermark in module state
// (leaf-module rule) — it must not leak between cases.
beforeEach(() => {
  resetResumeCandidatesForTests();
});

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
  payloadOverrides: Partial<SessionHistoryEvent['payload']> = {},
  requestId = 'req-1'
): RuntimeEvent {
  return {
    type: 'session.history',
    seq: 1,
    sessionId: SESSION_ID,
    requestId,
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

/** Arms the replay-coverage watermark exactly like a real resume does. */
function makeResumedEvent(requestId = 'req-1'): RuntimeEvent {
  return {
    type: 'session.resumed',
    seq: 0,
    sessionId: SESSION_ID,
    requestId,
    timestamp: 1000,
    payload: { runtimeIdentity: 'rt-1' },
  };
}

/** Folds successive patches so multi-event sequences read like the wire. */
function applyAll(
  state: ChatSessionsState,
  events: readonly RuntimeEvent[]
): { state: ChatSessionsState; lastPatch: Partial<ChatSessionsState> } {
  let current = state;
  let lastPatch: Partial<ChatSessionsState> = {};
  for (const event of events) {
    lastPatch = applyRuntimeEvent(current, event);
    current = { ...current, ...lastPatch } as ChatSessionsState;
  }
  return { state: current, lastPatch };
}

// One user message and one assistant message (text + tool_call + tool_result + thinking).
const HISTORY_MESSAGES: HistoryMessage[] = [
  {
    id: 'h:uuid-1',
    entryId: 'uuid-1',
    role: 'user',
    timestamp: 1500,
    blocks: [{ type: 'text', id: 'h:uuid-1:0', text: 'hello from history' }],
  },
  {
    id: 'h:uuid-2',
    entryId: 'uuid-2',
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
  it('preserves exact Pi entry ids and branch replacement drops the abandoned active path', () => {
    const abandoned: ChatMessage = {
      id: 'h:old-branch',
      entryId: 'old-branch',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [{ id: 'old', type: 'text', text: 'B/C branch' }],
    };
    const runtime: ChatMessage = {
      id: 'asst-live',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [{ id: 'live', type: 'text', text: 'must not survive branch replacement' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: { [SESSION_ID]: [abandoned, runtime] },
    });
    const patch = applyRuntimeEvent(
      state,
      makeHistoryEvent({
        mode: 'branch',
        messages: HISTORY_MESSAGES,
        offset: 0,
        limit: 80,
        totalCount: 2,
        hasMore: false,
        branchRevision: 4,
      })
    );

    expect(patch.messages?.[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
    ]);
    expect(patch.messages?.[SESSION_ID]?.map((message) => message.entryId)).toEqual([
      'uuid-1',
      'uuid-2',
    ]);
    expect(patch.historyBranchRevisions).toEqual({ [SESSION_ID]: 4 });
  });
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

  it('replaces h:* by prefix and keeps runtime messages the replay does not cover, history first', () => {
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
      messages: {
        [SESSION_ID]: [staleHistoryMessage, runtimeUserMessage, runtimeAssistantMessage],
        'session-other': [otherSessionMessage],
      },
    });
    const event = makeHistoryEvent({ messages: HISTORY_MESSAGES });

    const patch = applyRuntimeEvent(state, event);
    const bucket = patch.messages?.[SESSION_ID] ?? [];
    const ids = bucket.map((message) => message.id);

    expect(ids).not.toContain('h:stale-uuid');
    expect(ids).toContain('user-1');
    expect(ids).toContain('asst-1');
    expect(ids).toContain('h:uuid-1');
    expect(ids).toContain('h:uuid-2');

    // History is spliced before this session's remaining (runtime) messages.
    // The runtime texts here differ from every history row on purpose — the
    // replay does not cover them, so the coverage merge (round-6 Bug B) must
    // keep them exactly like the old prefix-replace did.
    expect(ids.indexOf('h:uuid-1')).toBeLessThan(ids.indexOf('user-1'));
    expect(ids.indexOf('h:uuid-2')).toBeLessThan(ids.indexOf('asst-1'));

    // The other session's bucket is untouched byte-for-byte.
    expect(patch.messages?.['session-other']).toEqual([otherSessionMessage]);
  });

  it('folds a pre-resume echo the replay covers to exactly one copy and leaves other sessions alone', () => {
    // Round-6 Bug B crime scene at reducer level: the failed turn's live echo
    // carries the same text as the replayed history row and must not render
    // twice after `session.resumed → session.history` lands.
    const runtimeEcho: ChatMessage = {
      id: 'user-echo-1',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'user-echo-1:0', type: 'text', text: 'hello from history' }],
    };
    const otherSessionMessage: ChatMessage = {
      id: 'user-other',
      sessionId: 'session-other',
      role: 'user',
      blocks: [{ id: 'user-other:0', type: 'text', text: 'hello from history' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: {
        [SESSION_ID]: [runtimeEcho],
        'session-other': [otherSessionMessage],
      },
    });

    const { lastPatch } = applyAll(state, [
      makeResumedEvent(),
      makeHistoryEvent({ messages: HISTORY_MESSAGES }),
    ]);
    const bucket = lastPatch.messages?.[SESSION_ID] ?? [];

    expect(bucket.map((message) => message.id)).toEqual(['h:uuid-1', 'h:uuid-2']);
    // Same text, different session: reconciliation is strictly per-bucket.
    expect(lastPatch.messages?.['session-other']).toEqual([otherSessionMessage]);
  });

  it('keeps a post-resume message even when its text equals an old history row (watermark)', () => {
    // The refuted-v1 pin (review B3): the fresh turn's text INTENTIONALLY
    // equals HISTORY_MESSAGES[0] — only the resume watermark, not text,
    // separates it from the pre-resume echo. v1 ate it; v2 must not.
    const preResumeEcho: ChatMessage = {
      id: 'user-echo-1',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'user-echo-1:0', type: 'text', text: 'hello from history' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: { [SESSION_ID]: [preResumeEcho] },
    });

    const { state: resumedState } = applyAll(state, [makeResumedEvent()]);
    // A new send's echo lands after the resume, before the detached history
    // read completes — the exact race both review tracks flagged.
    const postResumeEcho: ChatMessage = {
      id: 'user-new',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'user-new:0', type: 'text', text: 'hello from history' }],
    };
    const racedState = {
      ...resumedState,
      messages: {
        ...resumedState.messages,
        [SESSION_ID]: [...(resumedState.messages[SESSION_ID] ?? []), postResumeEcho],
      },
    } as ChatSessionsState;

    const patch = applyRuntimeEvent(racedState, makeHistoryEvent({ messages: HISTORY_MESSAGES }));

    expect(patch.messages?.[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
      'user-new',
    ]);
  });

  it('keeps every runtime message when the history read failed, even on text collisions', () => {
    const runtimeEcho: ChatMessage = {
      id: 'user-echo-1',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'user-echo-1:0', type: 'text', text: 'hello from history' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: { [SESSION_ID]: [runtimeEcho] },
    });

    // A failed read carries no authority over runtime messages — losing the
    // echo here would turn "dedup" into message loss.
    const { lastPatch } = applyAll(state, [
      makeResumedEvent(),
      makeHistoryEvent({
        messages: HISTORY_MESSAGES,
        error: { code: 'jsonl_not_found', message: 'no file' },
      }),
    ]);

    expect(lastPatch.messages?.[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
      'user-echo-1',
    ]);
  });

  it('folds nothing without a matching resume: stale or unknown requestIds are inert', () => {
    const runtimeEcho: ChatMessage = {
      id: 'user-echo-1',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'user-echo-1:0', type: 'text', text: 'hello from history' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: { [SESSION_ID]: [runtimeEcho] },
    });

    // Armed for req-B; a replay correlated to some other request must not
    // fold, and must not destroy the snapshot req-B still owns.
    const { state: mismatchState, lastPatch: mismatchPatch } = applyAll(state, [
      makeResumedEvent('req-B'),
      makeHistoryEvent({ messages: HISTORY_MESSAGES }, 'req-stale'),
    ]);
    expect(mismatchPatch.messages?.[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
      'user-echo-1',
    ]);

    // The matching replay that arrives later still folds.
    const patch = applyRuntimeEvent(
      mismatchState,
      makeHistoryEvent({ messages: HISTORY_MESSAGES }, 'req-B')
    );
    expect(patch.messages?.[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
    ]);
  });

  it('a newer resume owns the watermark: the older replay is inert, the newer one folds', () => {
    const runtimeEcho: ChatMessage = {
      id: 'user-echo-1',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'user-echo-1:0', type: 'text', text: 'hello from history' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: { [SESSION_ID]: [runtimeEcho] },
    });

    const { state: doubleResumed } = applyAll(state, [
      makeResumedEvent('req-1'),
      makeResumedEvent('req-2'),
    ]);

    const stalePatch = applyRuntimeEvent(
      doubleResumed,
      makeHistoryEvent({ messages: HISTORY_MESSAGES }, 'req-1')
    );
    expect(stalePatch.messages?.[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
      'user-echo-1',
    ]);

    const freshPatch = applyRuntimeEvent(
      { ...doubleResumed, ...stalePatch } as ChatSessionsState,
      makeHistoryEvent({ messages: HISTORY_MESSAGES }, 'req-2')
    );
    expect(freshPatch.messages?.[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
    ]);
  });

  it('stays idempotent under coverage: a second apply of the same replay changes nothing', () => {
    const coveredEcho: ChatMessage = {
      id: 'user-echo-1',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'user-echo-1:0', type: 'text', text: 'hello from history' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: { [SESSION_ID]: [coveredEcho] },
    });
    const event = makeHistoryEvent({ messages: HISTORY_MESSAGES });

    const { state: afterFirst, lastPatch: patch1 } = applyAll(state, [makeResumedEvent(), event]);
    expect(patch1.messages?.[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
    ]);

    // The snapshot was consumed by the first apply — the duplicate replay
    // has no watermark, so it can only prefix-replace, never fold more.
    const patch2 = applyRuntimeEvent(afterFirst, event);
    expect(patch2.messages).toEqual(patch1.messages);
  });

  it('appends history at the array tail when the session has no remaining messages', () => {
    const state = baseState({
      sessions: [makeSession()],
      messages: {},
    });
    const event = makeHistoryEvent({ messages: HISTORY_MESSAGES });

    const patch = applyRuntimeEvent(state, event);

    expect(patch.messages?.[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
    ]);
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
    expect(patch.messages?.[SESSION_ID]).toHaveLength(2);
  });

  it('maps tool_call, tool_result and thinking blocks with the same field usage as the live branches', () => {
    const state = baseState({ sessions: [makeSession()] });
    const event = makeHistoryEvent({ messages: [HISTORY_MESSAGES[1]] });

    const patch = applyRuntimeEvent(state, event);
    const assistantMessage = patch.messages?.[SESSION_ID]?.find(
      (message) => message.id === 'h:uuid-2'
    );
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

  // 2026-08-10: without this passthrough a cold restart rebuilds the message
  // but never its chip — the Host now recovers the metadata, and the store
  // must carry it onto the same `attachments` field the live path writes.
  it('passes rebuilt attachment metadata through to ChatMessage.attachments', () => {
    const state = baseState({ sessions: [makeSession()] });
    const withAttachments: HistoryMessage = {
      id: 'h:uuid-att',
      role: 'user',
      timestamp: 1500,
      blocks: [{ type: 'text', id: 'h:uuid-att:0', text: 'look at this' }],
      attachments: [
        { kind: 'image', mediaType: 'image/png' },
        { kind: 'text', mediaType: 'text/plain', name: 'notes.txt' },
      ],
    };

    const patch = applyRuntimeEvent(state, makeHistoryEvent({ messages: [withAttachments] }));
    const message = patch.messages?.[SESSION_ID]?.[0];
    expect(message?.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png' },
      { kind: 'text', mediaType: 'text/plain', name: 'notes.txt' },
    ]);
  });

  it('omits the attachments key entirely for attachment-free history messages', () => {
    const state = baseState({ sessions: [makeSession()] });

    const patch = applyRuntimeEvent(state, makeHistoryEvent({ messages: HISTORY_MESSAGES }));
    for (const message of patch.messages?.[SESSION_ID] ?? []) {
      expect(message).not.toHaveProperty('attachments');
    }
  });

  it('carries an attachment-only history turn (no text blocks) through as a chip-bearing message', () => {
    const state = baseState({ sessions: [makeSession()] });
    const imageOnly: HistoryMessage = {
      id: 'h:uuid-img',
      role: 'user',
      timestamp: 1500,
      blocks: [],
      attachments: [{ kind: 'image', mediaType: 'image/png' }],
    };

    const patch = applyRuntimeEvent(state, makeHistoryEvent({ messages: [imageOnly] }));
    expect(patch.messages?.[SESSION_ID]?.[0]).toEqual({
      id: 'h:uuid-img',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [],
      attachments: [{ kind: 'image', mediaType: 'image/png' }],
    });
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
      messages: { [SESSION_ID]: [historyAssistant] },
    });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 999,
      payload: { permissionId: 'perm-1', toolName: 'Bash' },
    };

    const patch = applyRuntimeEvent(state, event);
    const messages = patch.messages?.[SESSION_ID] ?? [];

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
    expect(patch.pendingPermissions).toEqual([
      {
        sessionId: SESSION_ID,
        permissionId: 'perm-1',
        messageId: 'msg-perm-perm-1',
      },
    ]);
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
      messages: { [SESSION_ID]: [historyAssistant, runtimeAssistant] },
    });
    const event: RuntimeEvent = {
      type: 'permission.requested',
      seq: 1,
      sessionId: SESSION_ID,
      timestamp: 999,
      payload: { permissionId: 'perm-2', toolName: 'Bash' },
    };

    const patch = applyRuntimeEvent(state, event);
    const messages = patch.messages?.[SESSION_ID] ?? [];

    const runtimeMessageAfter = messages.find((message) => message.id === 'asst-1');
    expect(
      runtimeMessageAfter?.blocks.some(
        (block) => block.type === 'permission_request' && block.permissionId === 'perm-2'
      )
    ).toBe(true);
    expect(patch.pendingPermissions?.[0].messageId).toBe('asst-1');
  });
});

describe('T32 Pi hydration generations and pagination', () => {
  it('rejects a stale initial history event as a whole after a newer resume', () => {
    const state = baseState({
      sessions: [makeSession({ runtimeIdentity: '/sessions/new.jsonl' })],
      messages: {
        [SESSION_ID]: [
          {
            id: 'h:new',
            sessionId: SESSION_ID,
            role: 'user',
            blocks: [{ id: 'h:new:text:0', type: 'text', text: 'new history' }],
          },
        ],
      },
      historyErrors: { [SESSION_ID]: 'read_failed: current error' },
    });
    const { state: resumed } = applyAll(state, [makeResumedEvent('req-new')]);
    const stale = applyRuntimeEvent(
      resumed,
      makeHistoryEvent(
        {
          mode: 'initial',
          runtimeIdentity: '/sessions/old.jsonl',
          messages: HISTORY_MESSAGES,
          error: { code: 'read_failed', message: 'stale failure' },
        },
        'req-old'
      )
    );

    expect(stale).toEqual({});
  });

  it('prepends older pages idempotently and updates pagination metadata', () => {
    const newest: ChatMessage = {
      id: 'h:newest',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'h:newest:text:0', type: 'text', text: 'newest' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: { [SESSION_ID]: [newest] },
      historyPagination: {
        [SESSION_ID]: { nextOffset: 1, hydratedCount: 1, totalCount: 2, hasMore: true },
      },
    });
    const olderMessages: HistoryMessage[] = [
      {
        id: 'h:oldest',
        entryId: 'oldest',
        role: 'user',
        blocks: [{ type: 'text', id: 'h:oldest:text:0', text: 'oldest' }],
      },
    ];
    const event = makeHistoryEvent({
      mode: 'older',
      messages: olderMessages,
      offset: 1,
      limit: 80,
      totalCount: 2,
      hasMore: false,
    });
    const first = applyRuntimeEvent(state, event);
    const nextState = { ...state, ...first } as ChatSessionsState;
    const second = applyRuntimeEvent(nextState, event);

    expect(first.messages?.[SESSION_ID].map((message) => message.id)).toEqual([
      'h:oldest',
      'h:newest',
    ]);
    expect(second).toEqual({});
    expect(first.historyPagination?.[SESSION_ID]).toEqual({
      nextOffset: 2,
      hydratedCount: 2,
      totalCount: 2,
      hasMore: false,
    });
  });

  it('advances pagination by projected page coverage even when replay keeps a runtime attachment row', () => {
    const anchor: ChatMessage = {
      id: 'h:anchor',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [{ id: 'h:anchor:text:0', type: 'text', text: 'anchor' }],
    };
    const runtimeAttachment: ChatMessage = {
      id: 'user-runtime-image',
      sessionId: SESSION_ID,
      role: 'user',
      blocks: [{ id: 'user-runtime-image:text:0', type: 'text', text: 'inspect image' }],
      attachments: [{ kind: 'image', mediaType: 'image/png', name: 'screen.png' }],
    };
    const state = baseState({
      sessions: [makeSession()],
      messages: { [SESSION_ID]: [anchor, runtimeAttachment] },
    });
    const { state: resumed } = applyAll(state, [makeResumedEvent()]);
    const patch = applyRuntimeEvent(
      resumed,
      makeHistoryEvent({
        mode: 'initial',
        messages: [
          {
            id: 'h:anchor',
            entryId: 'anchor',
            role: 'assistant',
            blocks: [{ id: 'h:anchor:text:0', type: 'text', text: 'anchor' }],
          },
          {
            id: 'h:image',
            entryId: 'image',
            role: 'user',
            blocks: [{ id: 'h:image:text:0', type: 'text', text: 'inspect image' }],
          },
        ],
        offset: 0,
        limit: 80,
        totalCount: 3,
        hasMore: true,
      })
    );

    expect(patch.messages?.[SESSION_ID].map((message) => message.id)).toEqual([
      'h:anchor',
      'user-runtime-image',
    ]);
    expect(patch.historyPagination?.[SESSION_ID]).toMatchObject({
      nextOffset: 2,
      hydratedCount: 1,
      totalCount: 3,
      hasMore: true,
    });
  });

  it('keeps an interrupted empty Pi assistant visible with recovery metadata', () => {
    const state = baseState({ sessions: [makeSession()] });
    const { lastPatch } = applyAll(state, [
      makeResumedEvent(),
      makeHistoryEvent({
        mode: 'initial',
        messages: [
          {
            id: 'h:empty-assistant',
            entryId: 'empty-assistant',
            role: 'assistant',
            blocks: [],
            incomplete: true,
            stopReason: 'interrupted',
          },
        ],
        totalCount: 1,
        hasMore: false,
      }),
    ]);
    expect(lastPatch.messages?.[SESSION_ID]?.[0]).toMatchObject({
      id: 'h:empty-assistant',
      incomplete: true,
      stopReason: 'interrupted',
      blocks: [
        {
          type: 'text',
          text: 'Response interrupted before any assistant content was saved.',
        },
      ],
    });
  });
});
