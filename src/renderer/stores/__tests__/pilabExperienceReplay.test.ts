import {
  createLegacyHistoryEvents,
  pilabReplayScenarios,
} from '@shared/__tests__/fixtures/pilabExperience';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flattenTurnItems,
  groupMessagesIntoTurns,
  segmentTurnBody,
} from '@/components/chat/chatTurn';
import {
  initialSubagentActivity,
  reduceSubagentActivity,
} from '@/components/chat/subagentActivityModel';
import { deriveToolGroupRows } from '@/components/chat/toolCard';
import { splitTurnWorkGroup } from '@/components/chat/turnProcessFold';
import { applyRuntimeEvents, type ChatSession, type ChatSessionsState } from '../chatSessions';

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

  it('F04 preserves received blocks when message.started is repeated before resume', () => {
    const events = scenario('F04');
    const resumeAt = events.findIndex((event) => event.type === 'session.resumed');
    const state = replay(events.slice(0, resumeAt));
    const assistant = state.messages['pilab-replay-f04']?.find(
      (message) => message.id === 'recover-assistant'
    );

    expect(
      assistant?.blocks.map((block) => (block.type === 'text' ? block.text : block.type))
    ).toEqual(['好好', 'tool_call', 'tool_result', 'tool_call', 'tool_result']);
  });

  it('F04 ignores a replayed session/seq but keeps a legal identical delta with a new seq', () => {
    const events = scenario('F04');
    const firstDelta = events.find(
      (event) => event.type === 'message.delta' && event.payload.messageId === 'recover-assistant'
    );
    if (!firstDelta) throw new Error('F04 requires an assistant delta');
    const live = replay(events.slice(0, 5));
    const replayed = replay([firstDelta], live);
    const textOf = (state: ChatSessionsState) =>
      state.messages['pilab-replay-f04']
        ?.find((message) => message.id === 'recover-assistant')
        ?.blocks.filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');

    expect(textOf(live)).toBe('好好');
    expect(textOf(replayed)).toBe('好好');
    expect(textOf(replay([{ ...firstDelta, seq: 100 }], replayed))).toBe('好好好');
  });

  it('F04 accepts lower seq values after a new resume request starts a transport generation', () => {
    const events = scenario('F04');
    const resume = events.find((event) => event.type === 'session.resumed');
    if (!resume) throw new Error('F04 requires a resume');
    const live = replay(events.slice(0, events.indexOf(resume)));
    const restarted: RuntimeEvent[] = [
      { ...resume, seq: 1, requestId: 'recover-2' },
      {
        type: 'message.started',
        seq: 2,
        sessionId: 'pilab-replay-f04',
        timestamp: 1_800_000_002_000,
        payload: { messageId: 'after-restart', role: 'assistant' },
      },
      {
        type: 'message.delta',
        seq: 3,
        sessionId: 'pilab-replay-f04',
        timestamp: 1_800_000_002_100,
        payload: { messageId: 'after-restart', blockId: 'after-restart-text', text: '重启后正文' },
      },
    ];

    const state = replay(restarted, live);
    expect(
      state.messages['pilab-replay-f04']?.find((message) => message.id === 'after-restart')?.blocks
    ).toEqual([{ id: 'after-restart-text', type: 'text', text: '重启后正文' }]);
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

  it('F01 keeps both answers in place and pairs the early tool result by call ID', () => {
    const events = scenario('F01');
    const state = replay(events);
    const turn = groupMessagesIntoTurns(state.messages['pilab-replay-f01'])[0];
    if (!turn) throw new Error('F01 requires a turn');
    const items = flattenTurnItems(turn);
    const segments = segmentTurnBody(items);

    for (const settled of [false, true]) {
      expect(splitTurnWorkGroup(segments, settled).map((section) => section.kind)).toEqual([
        'processGroup',
        'answer',
        'processGroup',
        'answer',
        'processGroup',
      ]);
    }
    const runs = items.flatMap((item) =>
      item.kind === 'toolGroup'
        ? item.entries.flatMap((entry) => (entry.kind === 'run' ? [entry.run] : []))
        : []
    );
    expect(runs.map((run) => run.toolCallId)).toEqual(['call-a', 'call-b', 'call-early']);
    expect(runs.find((run) => run.toolCallId === 'call-early')).toMatchObject({
      status: 'ok',
      output: '先到的结果',
    });
  });

  it('F02 conserves all activity while reducing 42 thinking entries to six group entries', () => {
    const events = scenario('F02');
    const state = replay(events);
    const turn = groupMessagesIntoTurns(state.messages['pilab-replay-f02'])[0];
    if (!turn) throw new Error('F02 requires a turn');
    const items = flattenTurnItems(turn);
    const sections = splitTurnWorkGroup(segmentTurnBody(items), true);
    const processSections = sections.filter((section) => section.kind === 'processGroup');
    const rawEntries = items.flatMap((item) => (item.kind === 'toolGroup' ? item.entries : []));

    expect(sections.filter((section) => section.kind === 'answer')).toHaveLength(8);
    expect(processSections).toHaveLength(9);
    expect(rawEntries.filter((entry) => entry.kind === 'thinking')).toHaveLength(42);
    expect(rawEntries.filter((entry) => entry.kind === 'run')).toHaveLength(67);

    const rows = processSections.flatMap((section) =>
      section.kind === 'processGroup'
        ? deriveToolGroupRows(
            section.segments
              .flatMap((segment) => segment.items)
              .flatMap((item) => (item.kind === 'toolGroup' ? item.entries : []))
          )
        : []
    );
    expect(rows).toHaveLength(73);
    expect(rows.filter((row) => row.iconKind === 'thinking')).toHaveLength(6);
    expect(rows.filter((row) => row.iconKind !== 'thinking').map((row) => row.key)).toEqual(
      Array.from({ length: 67 }, (_, index) => `long-call-${index + 1}`)
    );
  });

  it('F05 keeps the stage reply independent and late subagent text on its old lane', () => {
    const events = scenario('F05');
    const state = replay(events);
    const turns = groupMessagesIntoTurns(state.messages['pilab-replay-f05']);
    expect(turns).toHaveLength(2);
    const firstItems = flattenTurnItems(turns[0]);
    expect(
      splitTurnWorkGroup(segmentTurnBody(firstItems), false).map((section) => section.kind)
    ).toEqual(['processGroup', 'answer']);

    const nextAssistant = state.messages['pilab-replay-f05'].find(
      (message) => message.id === 'next-assistant'
    );
    expect(JSON.stringify(nextAssistant?.blocks)).not.toContain('old-result');
    const activity = events.reduce(reduceSubagentActivity, initialSubagentActivity);
    expect(activity.lanes['task-parent']?.rows).toContainEqual({
      kind: 'text',
      id: 'old-result',
      text: '旧后台任务的新发现，仍归原任务。',
    });
  });

  it('F08 opens old DSH and Claude SDK history through the same reducer', () => {
    for (const engine of ['dsh', 'claude-sdk'] as const) {
      const events = createLegacyHistoryEvents(engine);
      const state = replay(events);
      const messages = state.messages[events[0].sessionId ?? ''];
      expect(messages).toHaveLength(2);
      expect(messages[1].blocks.map((block) => block.type)).toEqual([
        'text',
        'tool_call',
        'tool_result',
      ]);
    }
  });
});
