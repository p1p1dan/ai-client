import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { applySessionIndexRefresh } from '@/components/chat/sessionIndex/useSessionIndex';
import {
  applyRuntimeEvent,
  type ChatSession,
  type ChatSessionsState,
  useChatSessionsStore,
} from '../chatSessions';

/**
 * H/18 S3 — "this conversation finished something you have not seen".
 *
 * The marker is a fact about the READER, not about the session, so it lives
 * next to `activeSessionId` in this store rather than on `ChatSession`. These
 * tests pin the three rules it stands on: only a turn that ended by itself
 * counts, only a session the user was NOT reading counts, and opening the
 * conversation is what clears it.
 */

const SESSION_ID = 'session-1';

function baseState(overrides: Partial<ChatSessionsState> = {}): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: [session()],
    messages: {},
    activeSessionId: null,
    recentSessionIds: [],
    pendingPermissions: [],
    pendingQuestion: null,
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

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: SESSION_ID,
    projectId: 'project-demo',
    workspaceId: 'ws-main',
    title: 'Test session',
    status: 'running',
    updatedAt: 42,
    ...overrides,
  };
}

const completed: RuntimeEvent = {
  type: 'session.completed',
  sessionId: SESSION_ID,
} as RuntimeEvent;
const failed: RuntimeEvent = {
  type: 'session.failed',
  sessionId: SESSION_ID,
  payload: { error: 'boom' },
} as RuntimeEvent;
const stopped: RuntimeEvent = { type: 'session.stopped', sessionId: SESSION_ID } as RuntimeEvent;

describe('S3 marking a session unread', () => {
  it('marks a turn that completed on a session the user was not reading', () => {
    const patch = applyRuntimeEvent(baseState({ activeSessionId: 'other' }), completed);
    expect(patch.unreadSessionIds).toEqual([SESSION_ID]);
  });

  it('marks a failure the same way', () => {
    const patch = applyRuntimeEvent(baseState({ activeSessionId: 'other' }), failed);
    expect(patch.unreadSessionIds).toEqual([SESSION_ID]);
  });

  it('does NOT mark the session the user is looking at', () => {
    const state = baseState({ activeSessionId: SESSION_ID });
    const patch = applyRuntimeEvent(state, completed);
    expect(patch.unreadSessionIds).toEqual([]);
    // Same array identity, not merely an equal one: `session.completed` fires
    // every single turn, and a fresh array would re-render every row that reads
    // this list for a fact that did not change.
    expect(patch.unreadSessionIds).toBe(state.unreadSessionIds);
  });

  it('does NOT mark a session the user stopped on purpose', () => {
    const patch = applyRuntimeEvent(baseState({ activeSessionId: 'other' }), stopped);
    expect(patch.unreadSessionIds).toBeUndefined();
  });

  it('never lists the same session twice', () => {
    const state = baseState({ activeSessionId: 'other', unreadSessionIds: [SESSION_ID] });
    const patch = applyRuntimeEvent(state, completed);
    expect(patch.unreadSessionIds).toBe(state.unreadSessionIds);
  });
});

describe('S3 clearing the marker', () => {
  it('opening the conversation is what reads it', () => {
    useChatSessionsStore.setState({
      activeSessionId: 'other',
      unreadSessionIds: [SESSION_ID, 'another'],
    });

    useChatSessionsStore.getState().selectSession(SESSION_ID);

    expect(useChatSessionsStore.getState().unreadSessionIds).toEqual(['another']);
  });

  it('selecting an already-read session leaves the list identical', () => {
    useChatSessionsStore.setState({ activeSessionId: null, unreadSessionIds: ['another'] });
    const before = useChatSessionsStore.getState().unreadSessionIds;

    useChatSessionsStore.getState().selectSession(SESSION_ID);

    expect(useChatSessionsStore.getState().unreadSessionIds).toBe(before);
  });

  it('drops markers for sessions that no longer have a row', () => {
    // A closed or archived session has nothing left to click, so its marker
    // could never be read again — it would sit in the list for the rest of the
    // run and come back with the row if it ever returned.
    const patch = applySessionIndexRefresh([], {
      sessions: [session({ id: 'live' }), session({ id: 'gone' })],
      workspaces: [],
      unreadSessionIds: ['live', 'gone'],
    });

    expect(patch.sessions.map((item) => item.id)).toEqual(['live', 'gone']);

    const afterClose = applySessionIndexRefresh([], {
      sessions: [session({ id: 'live' })],
      workspaces: [],
      unreadSessionIds: ['live', 'gone'],
    });
    expect(afterClose.unreadSessionIds).toEqual(['live']);
  });

  it('keeps the same list identity when a refresh prunes nothing', () => {
    const unreadSessionIds = ['live'];
    const patch = applySessionIndexRefresh([], {
      sessions: [session({ id: 'live' })],
      workspaces: [],
      unreadSessionIds,
    });
    expect(patch.unreadSessionIds).toBe(unreadSessionIds);
  });
});
