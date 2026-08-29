import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { groupTimeline } from '@/components/chat/toolCard';
import {
  applyRuntimeEvent,
  applyRuntimeEvents,
  type ChatMessage,
  type ChatSessionsState,
} from '../chatSessions';

/**
 * T08-b — the permission plugin's decisions in the transcript.
 *
 * Two failures these lock down:
 *
 *  1. **The decision disappearing with the modal.** The approval dialog closes
 *     on answer; if the outcome is not written into the turn, scrolling back
 *     says a tool ran and nothing about whether anyone approved it.
 *  2. **`policy_allow` being invisible.** It resolves with no prompt at all, so
 *     without a row for it there is no evidence anywhere that the call was gated
 *     — which is indistinguishable from the permission system not running.
 */

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
    setDraftSessionAgent: () => false,
    sendMessage: async () => {},
    stopActiveSession: async () => {},
    respondPermission: async () => false,
    respondQuestion: async () => false,
    initRuntime: () => () => {},
    ...overrides,
  };
}

function assistantMessage(id = 'msg-1', sessionId = SESSION_ID): ChatMessage {
  return { id, sessionId, role: 'assistant', blocks: [] };
}

function activity(
  payload: Extract<RuntimeEvent, { type: 'permission.activity' }>['payload'],
  sessionId: string = SESSION_ID,
  seq = 1
): RuntimeEvent {
  return { type: 'permission.activity', seq, timestamp: seq, sessionId, payload };
}

function blocksOf(state: ChatSessionsState, sessionId = SESSION_ID, messageId = 'msg-1') {
  return state.messages[sessionId]?.find((message) => message.id === messageId)?.blocks ?? [];
}

describe('applyRuntimeEvent — permission.activity', () => {
  it('records a policy allow nobody was asked about', () => {
    const state = baseState({ messages: { [SESSION_ID]: [assistantMessage()] } });
    const next = {
      ...state,
      ...applyRuntimeEvent(
        state,
        activity({
          phase: 'decision',
          requestId: 'r1',
          surface: 'bash',
          value: 'git status',
          result: 'allow',
          resolution: 'policy_allow',
          origin: 'builtin',
        })
      ),
    } as ChatSessionsState;

    expect(blocksOf(next)).toEqual([
      {
        id: 'perm-activity-r1',
        type: 'permission_activity',
        permissionActivity: {
          phase: 'decision',
          requestId: 'r1',
          surface: 'bash',
          value: 'git status',
          result: 'allow',
          resolution: 'policy_allow',
          origin: 'builtin',
        },
      },
    ]);
  });

  /**
   * ONE block per requestId. The plugin broadcasts a `prompt` and then a
   * `decision` for the same gate; appending both would put every approval in the
   * transcript twice.
   */
  it('folds the decision onto the prompt row instead of appending a second one', () => {
    const state = baseState({ messages: { [SESSION_ID]: [assistantMessage()] } });
    const next = applyRuntimeEvents(state, [
      activity(
        { phase: 'prompt', requestId: 'r1', surface: 'bash', value: 'rm -rf /' },
        SESSION_ID,
        1
      ),
      activity(
        { phase: 'decision', requestId: 'r1', result: 'deny', resolution: 'user_denied' },
        SESSION_ID,
        2
      ),
    ]);

    const blocks = blocksOf(next as ChatSessionsState);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.permissionActivity).toMatchObject({
      requestId: 'r1',
      // Kept from the prompt: the decision does not repeat the command, and
      // blanking it would leave a verdict about nothing.
      surface: 'bash',
      value: 'rm -rf /',
      result: 'deny',
      resolution: 'user_denied',
    });
  });

  it('is idempotent under redelivery', () => {
    const state = baseState({ messages: { [SESSION_ID]: [assistantMessage()] } });
    const event = activity({ phase: 'decision', requestId: 'r1', result: 'allow' });
    const once = { ...state, ...applyRuntimeEvent(state, event) } as ChatSessionsState;
    const twice = applyRuntimeEvent(once, event);

    // No patch at all — the timeline re-renders on reference equality.
    expect(twice).toEqual({});
  });

  it('keeps two gates for the same tool call as two rows', () => {
    const state = baseState({ messages: { [SESSION_ID]: [assistantMessage()] } });
    const next = applyRuntimeEvents(state, [
      activity(
        { phase: 'decision', requestId: 'r1', surface: 'bash', result: 'allow' },
        SESSION_ID,
        1
      ),
      activity(
        { phase: 'decision', requestId: 'r2', surface: 'external_directory', result: 'deny' },
        SESSION_ID,
        2
      ),
    ]);
    expect(blocksOf(next as ChatSessionsState)).toHaveLength(2);
  });

  it('lands on the right session when two are live', () => {
    const state = baseState({
      messages: {
        [SESSION_ID]: [assistantMessage('msg-1')],
        other: [assistantMessage('msg-other', 'other')],
      },
    });
    const next = {
      ...state,
      ...applyRuntimeEvent(
        state,
        activity({ phase: 'decision', requestId: 'r1', result: 'allow' })
      ),
    } as ChatSessionsState;

    expect(blocksOf(next, SESSION_ID, 'msg-1')).toHaveLength(1);
    expect(blocksOf(next, 'other', 'msg-other')).toHaveLength(0);
  });

  /**
   * A session with no messages is one the user cannot see — materializing a
   * bucket for it would put a row in a transcript that does not exist.
   */
  it('drops an event for a session with nothing on screen', () => {
    const state = baseState();
    expect(applyRuntimeEvent(state, activity({ phase: 'decision', requestId: 'r1' }))).toEqual({});

    const userOnly = baseState({
      messages: { [SESSION_ID]: [{ id: 'u1', sessionId: SESSION_ID, role: 'user', blocks: [] }] },
    });
    expect(applyRuntimeEvent(userOnly, activity({ phase: 'decision', requestId: 'r1' }))).toEqual(
      {}
    );
  });
});

describe('groupTimeline — permission activity rows', () => {
  it('coalesces adjacent activity blocks into one item', () => {
    const items = groupTimeline({
      id: 'msg-1',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [
        { id: 'a1', type: 'permission_activity', permissionActivity: { requestId: 'r1' } },
        { id: 'a2', type: 'permission_activity', permissionActivity: { requestId: 'r2' } },
        { id: 't1', type: 'tool_call', toolCallId: 'c1', toolName: 'bash' },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(['permissionActivity', 'toolGroup']);
    const first = items[0];
    if (first?.kind !== 'permissionActivity') throw new Error('expected the activity item');
    expect(first.blocks.map((block) => block.id)).toEqual(['a1', 'a2']);
  });

  it('does not merge activity rows across a tool group', () => {
    const items = groupTimeline({
      id: 'msg-1',
      sessionId: SESSION_ID,
      role: 'assistant',
      blocks: [
        { id: 'a1', type: 'permission_activity', permissionActivity: { requestId: 'r1' } },
        { id: 't1', type: 'tool_call', toolCallId: 'c1', toolName: 'bash' },
        { id: 'a2', type: 'permission_activity', permissionActivity: { requestId: 'r2' } },
        { id: 't2', type: 'tool_call', toolCallId: 'c2', toolName: 'read' },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual([
      'permissionActivity',
      'toolGroup',
      'permissionActivity',
      'toolGroup',
    ]);
  });
});
