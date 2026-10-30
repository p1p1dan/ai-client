import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLegacyHistoryEvents,
  pilabReplayScenarios,
} from '@shared/__tests__/fixtures/pilabExperience';
import {
  applyRuntimeEvents,
  type ChatSession,
  type ChatSessionsState,
} from '../chatSessions';

function baseState(sessionId: string): ChatSessionsState {
  const session: ChatSession = {
    id: sessionId,
    projectId: 'project-replay',
    workspaceId: 'workspace-replay',
    title: sessionId,
    status: 'idle',
    updatedAt: 0,
  };
  return {
    projects: [],
    workspaces: [],
    sessions: [session],
    messages: {},
    activeSessionId: sessionId,
    recentSessionIds: [],
    pendingPermissions: [],
    pendingQuestions: [],
    hostBoundSessionIds: [sessionId],
    unreadSessionIds: [],
    runtimeReady: true,
    lastError: null,
    historyErrors: {},
    selectSession: () => {},
    sendMessage: async () => {},
    respondQuestion: async () => false,
    closePlanReview: async () => {},
    initRuntime: () => () => {},
  };
}

function fold(state: ChatSessionsState, events: readonly RuntimeEvent[]): ChatSessionsState {
  return { ...state, ...applyRuntimeEvents(state, [...events]) };
}

function replay(events: readonly RuntimeEvent[], state?: ChatSessionsState): ChatSessionsState {
  const sessionId = events[0]?.sessionId ?? state?.activeSessionId;
  if (!sessionId) throw new Error('replay requires a session');
  return fold(state ?? baseState(sessionId), events);
}

function snapshot(state: ChatSessionsState): unknown {
  return JSON.parse(JSON.stringify(state)) as unknown;
}

const scenario = (id: string) => {
  const found = pilabReplayScenarios.find((item) => item.id === id);
  if (!found) throw new Error(`missing scenario ${id}`);
  return found.createEvents();
};

describe('PiLab constructed replay through the real renderer reducer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('F01 produces the same state across every pause/resume boundary', () => {
    const events = scenario('F01');
    const expected = replay(events);
    for (let pause = 1; pause <= events.length; pause += 1) {
      const paused = replay(events.slice(0, pause));
      const resumed = replay(events.slice(pause), paused);
      expect(snapshot(resumed)).toEqual(snapshot(expected));
    }
  });

  it('replaying from the same initial state is deterministic and needs no host or model', () => {
    for (const id of ['F01', 'F02', 'F03', 'F04', 'F05', 'F06']) {
      const events = scenario(id);
      expect(snapshot(replay(events))).toEqual(snapshot(replay(events)));
    }
  });

  it('F03 keeps both interactions pending before resolution and retires them afterwards', () => {
    const events = scenario('F03');
    const resolveAt = events.findIndex((event) => event.type === 'permission.resolved');
    expect(resolveAt).toBeGreaterThan(0);
    const waiting = replay(events.slice(0, resolveAt));
    expect(waiting.pendingPermissions.map((item) => item.permissionId)).toEqual(['permission-1']);
    expect(waiting.pendingQuestions.map((item) => item.questionId)).toEqual(['question-1']);
    const settled = replay(events.slice(resolveAt), waiting);
    expect(settled.pendingPermissions).toEqual([]);
    expect(settled.pendingQuestions).toEqual([]);
  });

  it('F08 opens old DSH and Claude SDK history through the same reducer', () => {
    for (const engine of ['dsh', 'claude-sdk'] as const) {
      const events = createLegacyHistoryEvents(engine);
      const state = replay(events);
      const messages = state.messages[events[0].sessionId ?? ''];
      expect(messages).toHaveLength(2);
      expect(messages[1].blocks.map((block) => block.type)).toEqual([
        'text', 'tool_call', 'tool_result',
      ]);
    }
  });
});
