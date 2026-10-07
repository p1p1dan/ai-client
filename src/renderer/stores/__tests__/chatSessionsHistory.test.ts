import type { RuntimeEvent, SessionHistoryEvent } from '@shared/types/runtimeEvents';
import type { HistoryMessage } from '@shared/types/sessionHistory';
import { beforeEach, describe, expect, it } from 'vitest';
import { pairToolBlocks, toolRunOutcome } from '@/components/chat/toolCard';
import { deriveSessionReview } from '@/components/workspace-shell/sessionReview';
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
    pendingQuestions: [],
    hostBoundSessionIds: [],
    unreadSessionIds: [],
    runtimeReady: false,
    lastError: null,
    historyErrors: {},
    selectSession: () => {},
    sendMessage: async () => {},
    stopActiveSession: async () => {},
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
  it('restores recorded diffs without duplicating them on a second hydration', () => {
    const state = baseState({ sessions: [makeSession()] });
    const event = makeHistoryEvent({
      messages: [
        {
          id: 'h:review',
          role: 'assistant',
          blocks: [
            {
              id: 'call',
              type: 'tool_call',
              toolCallId: 'write-1',
              name: 'write',
              input: { path: '/repo/a', content: 'after' },
            },
            {
              id: 'result',
              type: 'tool_result',
              toolCallId: 'write-1',
              ok: true,
              output: 'written',
              review: {
                version: 1,
                path: '/repo/a',
                status: 'modified',
                patch: '@@ -1,1 +1,1 @@\n-before\n+after',
              },
            },
          ],
        },
      ],
    });
    const first = { ...state, ...applyRuntimeEvent(state, event) };
    const second = { ...first, ...applyRuntimeEvent(first, event) };
    const entries = deriveSessionReview(second.messages[SESSION_ID]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'modified',
      patch: '@@ -1,1 +1,1 @@\n-before\n+after',
      added: 1,
      removed: 1,
    });
    expect(entries[0].preview).toBeUndefined();
  });
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
      timestamp: 1500,
    });
  });

  /**
   * The turn clock's only durable source (2026-09-22).
   *
   * `useMessageMetadata` is an in-memory registry fed by live Runtime Events,
   * so it holds exactly the turns the open window watched run. Every replayed
   * turn had no clock at all, which went unnoticed until the process fold head
   * was made to report the clock and nothing else — and then rendered a head
   * with no text. This field is what gives a restored turn 「已工作 6 分 41 秒」;
   * `historyTurnClock.test.ts` asserts the other end of the same wire.
   */
  it('carries the history entry timestamp through to the message', () => {
    const state = baseState({ sessions: [makeSession()] });
    const dated: HistoryMessage = {
      id: 'h:uuid-dated',
      role: 'assistant',
      timestamp: 1_700_000_000_000,
      blocks: [{ type: 'text', id: 'b1', text: 'done' }],
    };

    const patch = applyRuntimeEvent(state, makeHistoryEvent({ messages: [dated] }));
    expect(patch.messages?.[SESSION_ID]?.[0]?.timestamp).toBe(1_700_000_000_000);
  });

  /**
   * The A07 `:2399` half of the same field: an entry Pi could not date carries
   * no key at all, rather than a `0` the clock would happily format as a
   * duration. Same discipline as `attachments` two cases up.
   */
  it('omits the timestamp key entirely for an undated history message', () => {
    const state = baseState({ sessions: [makeSession()] });
    const undated: HistoryMessage = {
      id: 'h:uuid-undated',
      role: 'assistant',
      blocks: [{ type: 'text', id: 'b1', text: 'done' }],
    };

    const patch = applyRuntimeEvent(state, makeHistoryEvent({ messages: [undated] }));
    expect(patch.messages?.[SESSION_ID]?.[0]).not.toHaveProperty('timestamp');
  });

  /**
   * N2 (devbox 2026-09-24): a Ctrl+Enter turn read 「已工作 20 秒」 live and
   * 「1 秒」 after a restart, because the only record of when it ended — the
   * tool result and run-stop entries folded into its last assistant message —
   * never reached the timeline. `historyTurnClock.test.ts [HIST-CLOCK-3]` is
   * the other end of this wire.
   */
  it('[N2-MAP-1] carries settledAt through, and omits the key when the projection had none', () => {
    const state = baseState({ sessions: [makeSession()] });
    const settled: HistoryMessage = {
      id: 'h:uuid-settled',
      role: 'assistant',
      timestamp: 1_700_000_000_322,
      settledAt: 1_700_000_020_368,
      stopCause: 'interjected',
      blocks: [{ type: 'text', id: 'b1', text: 'start' }],
    };
    const plain: HistoryMessage = {
      id: 'h:uuid-plain',
      role: 'assistant',
      timestamp: 1_700_000_030_000,
      blocks: [{ type: 'text', id: 'b2', text: 'done' }],
    };

    const patch = applyRuntimeEvent(state, makeHistoryEvent({ messages: [settled, plain] }));
    const [first, second] = patch.messages?.[SESSION_ID] ?? [];
    expect(first?.settledAt).toBe(1_700_000_020_368);
    expect(first?.timestamp).toBe(1_700_000_000_322);
    expect(second).not.toHaveProperty('settledAt');
  });

  /**
   * N5 (devbox 2026-09-24): the replay half of `ToolOutcomeDetails`. The flags
   * land in `toolOutput.details` exactly where the live `tool.completed`
   * output puts them, so the row reads one structured field on both paths.
   */
  it('[N5-MAP-1] maps refused / notStarted results into the structured details the row reads', () => {
    const state = baseState({ sessions: [makeSession()] });
    const call = (toolCallId: string, name: string) => ({
      id: `${toolCallId}:call`,
      type: 'tool_call' as const,
      toolCallId,
      name,
      input: {},
    });
    const message: HistoryMessage = {
      id: 'h:uuid-outcomes',
      role: 'assistant',
      blocks: [
        call('w1', 'TaskWait'),
        {
          id: 'w1:result',
          type: 'tool_result',
          toolCallId: 'w1',
          ok: true,
          output: 'Refused: nothing left.',
          refused: true,
        },
        call('l1', 'TaskList'),
        {
          id: 'l1:result',
          type: 'tool_result',
          toolCallId: 'l1',
          ok: false,
          error: 'The run ended before this call started.',
          notStarted: true,
        },
        call('s1', 'TaskStop'),
        { id: 's1:result', type: 'tool_result', toolCallId: 's1', ok: true, output: 'Stopped.' },
      ],
    };

    const patch = applyRuntimeEvent(state, makeHistoryEvent({ messages: [message] }));
    const results = (patch.messages?.[SESSION_ID]?.[0]?.blocks ?? []).filter(
      (block) => block.type === 'tool_result'
    );
    expect(results[0]?.toolOutput).toEqual({
      content: [{ type: 'text', text: 'Refused: nothing left.' }],
      details: { refused: true },
    });
    expect(results[1]?.toolOutput).toEqual({
      content: [{ type: 'text', text: '' }],
      details: { notStarted: true },
    });
    expect(results[1]?.text).toBe('The run ended before this call started.');
    // An ordinary result keeps its plain string: nothing structured to carry.
    expect(results[2]?.toolOutput).toBe('Stopped.');
    // And the timeline reads them as the live path does.
    const runs = pairToolBlocks(patch.messages?.[SESSION_ID]?.[0]?.blocks ?? []);
    expect(runs.map((run) => toolRunOutcome(run))).toEqual(['refused', 'notStarted', null]);
  });

  /**
   * T130: a replayed stopped bash lands in the same `{ content, details }`
   * shape the live `tool.completed` output has, so a reopened session reads
   * "… · Stopped" exactly as the live row did.
   */
  it('[BASH-STOP-7] maps a stopped result into details.stopped, keeping its partial output', () => {
    const state = baseState({ sessions: [makeSession()] });
    const text = 'a\n[exit=null; aborted]';
    const message: HistoryMessage = {
      id: 'h:uuid-stopped',
      role: 'assistant',
      blocks: [
        {
          id: 'b1:call',
          type: 'tool_call',
          toolCallId: 'b1',
          name: 'bash',
          input: { command: 'sleep 30' },
        },
        {
          id: 'b1:result',
          type: 'tool_result',
          toolCallId: 'b1',
          ok: false,
          output: text,
          error: text,
          stopped: true,
        },
      ],
    };

    const patch = applyRuntimeEvent(state, makeHistoryEvent({ messages: [message] }));
    const blocks = patch.messages?.[SESSION_ID]?.[0]?.blocks ?? [];
    const result = blocks.find((block) => block.type === 'tool_result');
    expect(result?.toolOk).toBe(false);
    expect(result?.toolOutput).toEqual({
      content: [{ type: 'text', text }],
      details: { stopped: true },
    });
    const [run] = pairToolBlocks(blocks);
    expect(toolRunOutcome(run as NonNullable<typeof run>)).toBe('stopped');
    expect(run?.output).toBe(text);
  });

  /**
   * dsh-rebase decision 032: a DSH session reopened after the engine died
   * mid-call replays that call as "outcome unknown", in the same `details`
   * shape a live row would carry it in.
   */
  it('[P1-4a-UNKNOWN-2] maps an outcome-unknown result into details.outcomeUnknown', () => {
    const state = baseState({ sessions: [makeSession()] });
    const note = 'The tool call was interrupted after it was recorded. Its outcome is unknown.';
    const message: HistoryMessage = {
      id: 'h:step-1',
      role: 'assistant',
      incomplete: true,
      stopReason: 'interrupted',
      blocks: [
        { id: 'c1:call', type: 'tool_call', toolCallId: 'c1', name: 'bash', input: {} },
        {
          id: 'c1:result',
          type: 'tool_result',
          toolCallId: 'c1',
          ok: false,
          output: note,
          error: note,
          outcomeUnknown: true,
        },
      ],
    };

    const patch = applyRuntimeEvent(state, makeHistoryEvent({ messages: [message] }));
    const blocks = patch.messages?.[SESSION_ID]?.[0]?.blocks ?? [];
    expect(blocks.find((block) => block.type === 'tool_result')?.toolOutput).toEqual({
      content: [{ type: 'text', text: note }],
      details: { outcomeUnknown: true },
    });
    const [run] = pairToolBlocks(blocks);
    expect(toolRunOutcome(run as NonNullable<typeof run>)).toBe('outcomeUnknown');
  });
});

/**
 * T023 — a history line the APP wrote, not the model.
 *
 * `HistoryNotice` is the only thing separating the two, and everything hangs
 * on the store carrying it: without this field the imported-history banner is
 * indistinguishable from transcript text and has to pick a language in the
 * worker, which is how it came to be Chinese on English installs.
 */
describe('applyRuntimeEvent — history notices survive the mapping (T023)', () => {
  const NOTICE_KEY = 'This history was imported from a {{sourceKind}} session.';

  it('carries a notice through to the block, English text included', () => {
    const state = baseState({ sessions: [makeSession()] });
    const event = makeHistoryEvent({
      messages: [
        {
          id: 'h:provenance',
          role: 'system',
          blocks: [
            {
              id: 'banner',
              type: 'text',
              text: 'This history was imported from a claude-code session.',
              notice: { key: NOTICE_KEY, params: { sourceKind: 'claude-code' } },
            },
          ],
        },
      ],
    });
    const next = { ...state, ...applyRuntimeEvent(state, event) };
    const block = next.messages[SESSION_ID]?.[0]?.blocks[0];
    expect(block?.notice).toEqual({ key: NOTICE_KEY, params: { sourceKind: 'claude-code' } });
    // `text` is untouched, so a surface that ignores the notice still paints a
    // complete English sentence rather than a raw key.
    expect(block?.text).toBe('This history was imported from a claude-code session.');
  });

  it('leaves model text with no notice at all, so nothing translates it', () => {
    const state = baseState({ sessions: [makeSession()] });
    const event = makeHistoryEvent({
      messages: [
        {
          id: 'h:assistant',
          role: 'assistant',
          blocks: [{ id: 'said', type: 'text', text: 'Allow' }],
        },
      ],
    });
    const next = { ...state, ...applyRuntimeEvent(state, event) };
    const block = next.messages[SESSION_ID]?.[0]?.blocks[0];
    // 'Allow' IS a dictionary key. An assistant that says it must still say it
    // — the absent field is what stops the transcript being rewritten.
    expect(block).not.toHaveProperty('notice');
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

  it('carries the run-stop cause from replayed history onto the message', () => {
    const state = baseState({ sessions: [makeSession()] });
    const { lastPatch } = applyAll(state, [
      makeResumedEvent(),
      makeHistoryEvent({
        mode: 'initial',
        messages: [
          {
            id: 'h:interjected',
            entryId: 'interjected',
            role: 'assistant',
            blocks: [{ type: 'text', id: 'h:interjected:text:0', text: 'reading' }],
            stopReason: 'toolUse',
            stopCause: 'interjected',
          },
          {
            id: 'h:plain',
            entryId: 'plain',
            role: 'assistant',
            blocks: [{ type: 'text', id: 'h:plain:text:0', text: 'done' }],
            stopReason: 'stop',
          },
        ],
        totalCount: 2,
        hasMore: false,
      }),
    ]);
    const messages = lastPatch.messages?.[SESSION_ID] ?? [];
    expect(messages[0]?.stopCause).toBe('interjected');
    // Absent, not `undefined`-valued: exact-shape assertions elsewhere hold.
    expect(messages[1] && 'stopCause' in messages[1]).toBe(false);
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
    // P1-7e (problem 7, decision 140): a note, not a reply — a system row the
    // timeline draws in the reader's language (`turnEnd`), with an English
    // rendering for surfaces that do not read the marker.
    expect(lastPatch.messages?.[SESSION_ID]?.[0]).toMatchObject({
      id: 'h:empty-assistant',
      role: 'system',
      incomplete: true,
      stopReason: 'interrupted',
      turnEnd: { kind: 'interrupted' },
      blocks: [
        {
          type: 'text',
          text: 'This turn was interrupted. No reply was saved.',
        },
      ],
    });
  });

  it('[E2B-TURN-END] a failed empty assistant becomes a note carrying the recorded failure; a stopped one says it stopped', () => {
    const state = baseState({ sessions: [makeSession()] });
    const { lastPatch } = applyAll(state, [
      makeResumedEvent(),
      makeHistoryEvent({
        mode: 'initial',
        messages: [
          {
            id: 'h:u1',
            entryId: 'u1',
            role: 'user',
            blocks: [{ type: 'text', id: 'h:u1:text:0', text: 'P1-FAIL: go' }],
          },
          {
            id: 'h:u1:end',
            entryId: 'u1:end',
            role: 'assistant',
            timestamp: 5_000,
            blocks: [],
            incomplete: true,
            stopReason: 'error',
            failure: { errorCode: 'PROVIDER_ERROR', error: 'P1-FAIL: upstream failed' },
          },
          {
            id: 'h:u2',
            entryId: 'u2',
            role: 'user',
            blocks: [{ type: 'text', id: 'h:u2:text:0', text: 'stop me' }],
          },
          {
            id: 'h:u2:end',
            entryId: 'u2:end',
            role: 'assistant',
            blocks: [],
            incomplete: true,
            stopReason: 'aborted',
            stopCause: 'user_stop',
          },
        ],
        totalCount: 4,
        hasMore: false,
      }),
    ]);
    const messages = lastPatch.messages?.[SESSION_ID] ?? [];
    expect(messages[1]).toMatchObject({
      id: 'h:u1:end',
      role: 'system',
      timestamp: 5_000,
      turnEnd: {
        kind: 'failed',
        errorCode: 'PROVIDER_ERROR',
        error: 'P1-FAIL: upstream failed',
      },
    });
    expect(messages[1]?.blocks.map((block) => block.text)).toEqual([
      'This turn did not finish. No reply was saved.',
    ]);
    expect(messages[3]).toMatchObject({ role: 'system', turnEnd: { kind: 'stopped' } });
    // Rows that saved something are replies, as before.
    expect(messages[0]).not.toHaveProperty('turnEnd');
    expect(messages[0]?.role).toBe('user');
  });
});

/**
 * dsh-rebase P1-4d1 — the P1-1 point-check's open question: after a refused
 * send, and on Continue, Main resumes the SAME live DSH slot again and replays
 * its first page (`session.resumed` + `session.history` initial). With P1-4a
 * that page is no longer empty. Does it overwrite the timeline the window
 * already shows?
 */
describe('applyRuntimeEvent — a warm resume on a live DSH slot (dsh-rebase P1-4d1)', () => {
  const STEP_1 = 'dsh-aiclient-s1-t1-s1';
  const STEP_2 = 'dsh-aiclient-s1-t1-s2';
  const event = (type: string, payload: Record<string, unknown>, requestId = 'turn-1') =>
    ({ type, seq: 0, sessionId: SESSION_ID, requestId, timestamp: 2000, payload }) as RuntimeEvent;

  /** The live stream of one DSH turn: a prompt, a tool step, a text step, a notice, then a goal round's head. */
  const liveTurn: RuntimeEvent[] = [
    event('message.started', { messageId: 'dsh-user-7', role: 'user', attemptId: 'a-1' }),
    event('message.delta', { messageId: 'dsh-user-7', blockId: 'dsh-user-7-text', text: 'run' }),
    event('message.completed', { messageId: 'dsh-user-7' }),
    event('message.started', { messageId: STEP_1, role: 'assistant' }),
    event('tool.started', { messageId: STEP_1, toolCallId: 'c1', name: 'bash', input: {} }),
    event('tool.completed', { messageId: STEP_1, toolCallId: 'c1', ok: true, output: 'ok' }),
    event('message.completed', { messageId: STEP_1 }),
    event('message.started', { messageId: STEP_2, role: 'assistant' }),
    event('message.delta', { messageId: STEP_2, blockId: `${STEP_2}-b0`, text: 'done' }),
    event('message.completed', { messageId: STEP_2 }),
    event('custom.message', {
      messageId: 'dsh-notice-12',
      customType: 'dsh:tool-jobs',
      content: 'bash sleep 1 exited 0',
    }),
    event('message.started', {
      messageId: 'dsh-user-15',
      role: 'user',
      origin: { kind: 'goal', round: 2, maxRounds: 4 },
    }),
    event('message.completed', { messageId: 'dsh-user-15' }),
  ];

  /** The first page the bridge answers the second resume with (history cache, liveMessageId). */
  const page: HistoryMessage[] = [
    {
      id: 'h:u0',
      entryId: 'u0',
      role: 'user',
      blocks: [{ type: 'text', id: 'h:u0:text:0', text: 'before' }],
    },
    {
      id: 'h:m7',
      entryId: 'm7',
      role: 'user',
      blocks: [{ type: 'text', id: 'h:m7:text:0', text: 'run' }],
      liveMessageId: 'dsh-user-7',
    },
    {
      id: 'h:m8',
      entryId: 'm8',
      role: 'assistant',
      blocks: [
        { type: 'tool_call', id: 'h:m8:tool-call:c1', toolCallId: 'c1', name: 'bash', input: {} },
        {
          type: 'tool_result',
          id: 'h:m8:tool-result:c1',
          toolCallId: 'c1',
          ok: true,
          output: 'ok',
        },
      ],
      liveMessageId: STEP_1,
    },
    {
      id: 'h:m9',
      entryId: 'm9',
      role: 'assistant',
      blocks: [{ type: 'text', id: 'h:m9:text:0', text: 'done' }],
      liveMessageId: STEP_2,
    },
    {
      id: 'h:m12',
      entryId: 'm12',
      role: 'system',
      blocks: [{ type: 'text', id: 'h:m12:notice:0', text: 'bash sleep 1 exited 0' }],
      liveMessageId: 'dsh-notice-12',
    },
    {
      id: 'h:m15',
      entryId: 'm15',
      role: 'user',
      blocks: [],
      origin: { kind: 'goal', round: 2, maxRounds: 4 },
      liveMessageId: 'dsh-user-15',
    },
  ];

  it('[D1-RESUME-STORE] keeps exactly one copy of every message, in order, with the head origin', () => {
    const opened = applyAll(baseState({ sessions: [makeSession()] }), [
      makeResumedEvent('req-1'),
      makeHistoryEvent({ messages: [page[0] as HistoryMessage] }, 'req-1'),
      ...liveTurn,
    ]).state;
    expect(opened.messages[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:u0',
      'dsh-user-7',
      STEP_1,
      STEP_2,
      'dsh-notice-12',
      'dsh-user-15',
    ]);
    // The live head already carries its origin.
    expect(opened.messages[SESSION_ID]?.at(-1)?.origin).toEqual({
      kind: 'goal',
      round: 2,
      maxRounds: 4,
    });

    // The refused send / Continue: the same slot is resumed and replays its page.
    const { state } = applyAll(opened, [
      makeResumedEvent('req-2'),
      makeHistoryEvent({ messages: page, totalCount: page.length }, 'req-2'),
    ]);

    const bucket = state.messages[SESSION_ID] ?? [];
    expect(bucket.map((message) => message.id)).toEqual([
      'h:u0',
      'h:m7',
      'h:m8',
      'h:m9',
      'h:m12',
      'h:m15',
    ]);
    expect(bucket[5]).toMatchObject({
      role: 'user',
      origin: { kind: 'goal', round: 2, maxRounds: 4 },
      liveMessageId: 'dsh-user-15',
    });
    // An ordinary row carries neither key.
    expect(bucket[0] && ('origin' in bucket[0] || 'liveMessageId' in bucket[0])).toBe(false);
  });
});

/**
 * dsh-rebase P1-7e (problem 2, decision 139): a fork is CREATED with its
 * history. Main publishes `session.created`, then the branch the fork
 * inherited as an `initial` page under the same request id. The `initial`
 * guard only knew resume watermarks, so it dropped that page and a new fork
 * opened on an empty timeline until the next cold start.
 */
describe('a fork opens with the history it was created with (P1-7e problem 2)', () => {
  function makeCreatedEvent(requestId: string): RuntimeEvent {
    return {
      type: 'session.created',
      seq: 0,
      sessionId: SESSION_ID,
      requestId,
      timestamp: 1000,
      payload: { agent: 'dsh', runtimeIdentity: '/dsh/aiclient-fork.dsh.json' },
    };
  }

  it('accepts the initial page that carries the create request id', () => {
    const { state } = applyAll(baseState({ sessions: [makeSession()] }), [
      makeCreatedEvent('fork-1'),
      makeHistoryEvent({ mode: 'initial', messages: HISTORY_MESSAGES, totalCount: 2 }, 'fork-1'),
    ]);
    expect(state.messages[SESSION_ID]?.map((message) => message.id)).toEqual([
      'h:uuid-1',
      'h:uuid-2',
    ]);
    expect(state.historyPagination?.[SESSION_ID]).toMatchObject({ hydratedCount: 2 });
    expect(state.hostBoundSessionIds).toContain(SESSION_ID);
  });

  it('lands even before the row exists (the fork row is added when the IPC answers)', () => {
    const { state } = applyAll(baseState(), [
      makeCreatedEvent('fork-1'),
      makeHistoryEvent({ mode: 'initial', messages: HISTORY_MESSAGES }, 'fork-1'),
    ]);
    expect(state.messages[SESSION_ID]).toHaveLength(2);
  });

  it('still refuses an initial page of any other request', () => {
    const { state: created } = applyAll(baseState({ sessions: [makeSession()] }), [
      makeCreatedEvent('fork-1'),
    ]);
    expect(
      applyRuntimeEvent(
        created,
        makeHistoryEvent({ mode: 'initial', messages: HISTORY_MESSAGES }, 'req-other')
      )
    ).toEqual({});
  });

  it('lets a later resume take the watermark over, as before', () => {
    const { state } = applyAll(baseState({ sessions: [makeSession()] }), [
      makeCreatedEvent('create-1'),
      makeResumedEvent('resume-2'),
    ]);
    expect(
      applyRuntimeEvent(
        state,
        makeHistoryEvent({ mode: 'initial', messages: HISTORY_MESSAGES }, 'create-1')
      )
    ).toEqual({});
    expect(
      applyRuntimeEvent(
        state,
        makeHistoryEvent({ mode: 'initial', messages: HISTORY_MESSAGES }, 'resume-2')
      ).messages?.[SESSION_ID]
    ).toHaveLength(2);
  });
});

/**
 * dsh-rebase decision 146 (GW-18): a turn cut off before any of its reply
 * arrived — here by sign-out (Main's `forced` stop, then `released`). The
 * live store writes the history's own note in place of the empty assistant
 * message, so a chat reopened from memory (no replay, T092) shows
 * 「这一轮已停止」; a later replay replaces that note with the history's
 * row by its live id, so the turn never shows two.
 */
describe('a turn stopped before any reply (decision 146, GW-18)', () => {
  const STEP_1 = 'dsh-aiclient-s1-t1-s1';
  const event = (type: string, payload: Record<string, unknown>, requestId = 'turn-1') =>
    ({ type, seq: 0, sessionId: SESSION_ID, requestId, timestamp: 2000, payload }) as RuntimeEvent;

  const liveTurn: RuntimeEvent[] = [
    event('message.started', { messageId: 'dsh-user-3', role: 'user' }),
    event('message.delta', { messageId: 'dsh-user-3', blockId: 'dsh-user-3-text', text: 'go' }),
    event('message.completed', { messageId: 'dsh-user-3' }),
    event('message.started', { messageId: STEP_1, role: 'assistant' }),
    event('session.stopped', { stopCause: 'forced' }),
    event('session.status', { status: 'disconnected', disconnectReason: 'released' }),
  ];

  const placeholder = (liveMessageId?: string): HistoryMessage => ({
    id: 'h:u1:end',
    entryId: 'u1:end',
    role: 'assistant',
    timestamp: 3000,
    blocks: [],
    incomplete: true,
    stopReason: 'aborted',
    ...(liveMessageId ? { liveMessageId } : {}),
  });
  const page = (liveMessageId?: string): HistoryMessage[] => [
    {
      id: 'h:u1',
      entryId: 'u1',
      role: 'user',
      timestamp: 2000,
      blocks: [{ type: 'text', id: 'h:u1:text:0', text: 'go' }],
      liveMessageId: 'dsh-user-3',
    },
    placeholder(liveMessageId),
  ];

  const stopped = () =>
    applyAll(baseState({ sessions: [makeSession({ status: 'running' })] }), liveTurn).state;

  it('[GW18-LIVE-NOTE] the empty reply becomes the stopped note the history would replay', () => {
    const bucket = stopped().messages[SESSION_ID] ?? [];
    expect(bucket.map((message) => message.id)).toEqual(['dsh-user-3', STEP_1]);
    expect(bucket[1]).toMatchObject({
      role: 'system',
      turnEnd: { kind: 'stopped' },
      incomplete: true,
      stopReason: 'aborted',
      stopCause: 'user_stop',
    });
    expect(bucket[1]?.blocks.map((block) => block.text)).toEqual([
      'This turn was stopped. No reply was saved.',
    ]);
    // The same shape a replay maps the history's placeholder to.
    const replayed = applyAll(baseState({ sessions: [makeSession()] }), [
      makeHistoryEvent({ mode: 'branch', messages: page() }),
    ]).state.messages[SESSION_ID]?.[1];
    expect(replayed).toMatchObject({ role: 'system', turnEnd: { kind: 'stopped' } });
    expect(replayed?.blocks.map((block) => block.text)).toEqual(
      bucket[1]?.blocks.map((block) => block.text)
    );
  });

  it('[GW18-LIVE-ONCE] a second stop (the user, then sign-out) changes nothing more', () => {
    const state = stopped();
    const patch = applyRuntimeEvent(state, event('session.stopped', { stopCause: 'forced' }));
    expect(patch.messages).toBeUndefined();
  });

  it('[GW18-REPLAY-ONE] a later replay keeps one note: the history row takes the live one’s place', () => {
    const { state } = applyAll(stopped(), [
      makeResumedEvent('req-2'),
      makeHistoryEvent({ messages: page(STEP_1), totalCount: 2 }, 'req-2'),
    ]);
    const bucket = state.messages[SESSION_ID] ?? [];
    expect(bucket.map((message) => message.id)).toEqual(['h:u1', 'h:u1:end']);
    expect(bucket.filter((message) => message.turnEnd)).toHaveLength(1);
  });

  it('[GW18-REPLAY-UNLINKED] without the live id the replay cannot tell them apart (why the projection names it)', () => {
    const { state } = applyAll(stopped(), [
      makeResumedEvent('req-2'),
      makeHistoryEvent({ messages: page(), totalCount: 2 }, 'req-2'),
    ]);
    const bucket = state.messages[SESSION_ID] ?? [];
    expect(bucket.filter((message) => message.turnEnd)).toHaveLength(2);
  });

  it('[GW18-AFTER-REPLY] a stop after part of the reply arrived only marks it, as before', () => {
    const { state } = applyAll(baseState({ sessions: [makeSession({ status: 'running' })] }), [
      ...liveTurn.slice(0, 4),
      event('message.delta', { messageId: STEP_1, blockId: `${STEP_1}-b0`, text: 'half' }),
      event('session.stopped', {}),
    ]);
    const last = state.messages[SESSION_ID]?.at(-1);
    expect(last).toMatchObject({ id: STEP_1, role: 'assistant', stopCause: 'user_stop' });
    expect(last).not.toHaveProperty('turnEnd');
  });
});

/**
 * dsh-rebase decision 156 (decision 146 rule 22): a turn whose request failed
 * before any of its reply arrived. Live, the bridge's empty assistant message
 * stays as it was on screen (the failure card says what happened) and is only
 * stamped `stopReason: 'error'`. The history's failure placeholder carries no
 * live id (the projection names a stopped request's copy, not a failed one's),
 * so the renderer names it from the turn's rows and a replay keeps one note.
 */
describe('a turn whose request failed before any reply (decision 156)', () => {
  const STEP_1 = 'dsh-aiclient-s1-t1-s1';
  const event = (type: string, payload: Record<string, unknown>, requestId = 'turn-1') =>
    ({ type, seq: 0, sessionId: SESSION_ID, requestId, timestamp: 2000, payload }) as RuntimeEvent;

  const liveTurn: RuntimeEvent[] = [
    event('message.started', { messageId: 'dsh-user-3', role: 'user' }),
    event('message.delta', { messageId: 'dsh-user-3', blockId: 'dsh-user-3-text', text: 'go' }),
    event('message.completed', { messageId: 'dsh-user-3' }),
    event('message.started', { messageId: STEP_1, role: 'assistant' }),
    event('message.completed', { messageId: STEP_1 }),
    event('session.failed', { error: '500 upstream', errorCode: 'PROVIDER_ERROR' }),
    event('session.status', { status: 'idle' }),
  ];

  const page: HistoryMessage[] = [
    {
      id: 'h:u1',
      entryId: 'u1',
      role: 'user',
      timestamp: 2000,
      blocks: [{ type: 'text', id: 'h:u1:text:0', text: 'go' }],
      liveMessageId: 'dsh-user-3',
    },
    {
      id: 'h:u1:end',
      entryId: 'u1:end',
      role: 'assistant',
      timestamp: 3000,
      blocks: [],
      incomplete: true,
      stopReason: 'error',
      failure: { errorCode: 'PROVIDER_ERROR', error: '500 upstream' },
    },
  ];

  const failed = () =>
    applyAll(baseState({ sessions: [makeSession({ status: 'running' })] }), liveTurn).state;

  it('[E156-12-LIVE] the empty reply stays empty on screen and is marked as the failed request', () => {
    const state = failed();
    const bucket = state.messages[SESSION_ID] ?? [];
    expect(bucket.map((message) => message.id)).toEqual(['dsh-user-3', STEP_1]);
    expect(bucket[1]).toMatchObject({ role: 'assistant', blocks: [], stopReason: 'error' });
    expect(bucket[1]).not.toHaveProperty('turnEnd');
    expect(state.sessions.find((session) => session.id === SESSION_ID)?.status).toBe('failed');
  });

  it('[E156-12-REPLAY-ONE] a later replay keeps one note: the history row takes the empty copy’s place', () => {
    const { state } = applyAll(failed(), [
      makeResumedEvent('req-2'),
      makeHistoryEvent({ messages: page, totalCount: 2 }, 'req-2'),
    ]);
    const bucket = state.messages[SESSION_ID] ?? [];
    expect(bucket.map((message) => message.id)).toEqual(['h:u1', 'h:u1:end']);
    expect(bucket[1]).toMatchObject({ role: 'system', turnEnd: { kind: 'failed' } });
  });

  it('[E156-12-INTERJECTED] the copy after a Ctrl+Enter message in the same turn is found too', () => {
    const { state } = applyAll(baseState({ sessions: [makeSession({ status: 'running' })] }), [
      ...liveTurn.slice(0, 3),
      event('message.started', { messageId: 'dsh-aiclient-s1-t1-s0', role: 'assistant' }),
      event('message.delta', {
        messageId: 'dsh-aiclient-s1-t1-s0',
        blockId: 'b0',
        text: 'Reading first.',
      }),
      event('message.started', { messageId: 'dsh-user-4', role: 'user' }),
      event('message.delta', { messageId: 'dsh-user-4', blockId: 'dsh-user-4-text', text: 'also' }),
      ...liveTurn.slice(3),
      makeResumedEvent('req-2'),
      makeHistoryEvent(
        {
          messages: [
            page[0] as HistoryMessage,
            {
              id: 'h:a0',
              entryId: 'a0',
              role: 'assistant',
              timestamp: 2500,
              blocks: [{ type: 'text', id: 'h:a0:text:0', text: 'Reading first.' }],
              liveMessageId: 'dsh-aiclient-s1-t1-s0',
            },
            {
              id: 'h:u2',
              entryId: 'u2',
              role: 'user',
              timestamp: 2600,
              blocks: [{ type: 'text', id: 'h:u2:text:0', text: 'also' }],
              liveMessageId: 'dsh-user-4',
            },
            page[1] as HistoryMessage,
          ],
          totalCount: 4,
        },
        'req-2'
      ),
    ]);
    const bucket = state.messages[SESSION_ID] ?? [];
    expect(bucket.map((message) => message.id)).toEqual(['h:u1', 'h:a0', 'h:u2', 'h:u1:end']);
  });

  it('[E156-12-NO-OWN-MESSAGE] a failure with no message of its own marks nothing of the turn before', () => {
    const { state } = applyAll(baseState({ sessions: [makeSession({ status: 'running' })] }), [
      ...liveTurn.slice(0, 4),
      event('message.delta', { messageId: STEP_1, blockId: `${STEP_1}-b0`, text: 'Done.' }),
      event('message.completed', { messageId: STEP_1 }),
      event('session.completed', {}),
      // The next send is refused before any request: no echo, no reply.
      event('session.failed', { error: 'model missing' }, 'turn-2'),
    ]);
    const last = state.messages[SESSION_ID]?.at(-1);
    expect(last).toMatchObject({ id: STEP_1, role: 'assistant' });
    expect(last).not.toHaveProperty('stopReason');
  });

  it('[E156-12-AFTER-REPLY] a failure after part of the reply arrived marks nothing', () => {
    const { state } = applyAll(baseState({ sessions: [makeSession({ status: 'running' })] }), [
      ...liveTurn.slice(0, 4),
      event('message.delta', { messageId: STEP_1, blockId: `${STEP_1}-b0`, text: 'half' }),
      event('session.failed', { error: '500 upstream' }),
    ]);
    expect(state.messages[SESSION_ID]?.at(-1)).not.toHaveProperty('stopReason');
  });
});
