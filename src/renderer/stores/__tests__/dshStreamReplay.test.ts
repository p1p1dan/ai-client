// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { englishTranslate } from '@shared/i18n';
import { deriveContextOccupancy, readPiUsagePayload } from '@shared/piUsage';
import {
  type DshJobSummary,
  type RuntimeEvent,
  SESSION_FAILED_HOST_CRASHED,
  type SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
import type { HistoryMessage } from '@shared/types/sessionHistory';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flattenTurnItems,
  groupMessagesIntoTurns,
  type TurnItem,
} from '@/components/chat/chatTurn';
import { COMPACT_INSTRUCTIONS_UNSUPPORTED } from '@/components/chat/compactCommand';
import { autoTurnHeadView, dshNoticeRowView } from '@/components/chat/dshTimelineRowModel';
import {
  canRespondToPermission,
  derivePermissionAutoNote,
  derivePermissionGrantScopeNote,
  deriveQuestionCardState,
} from '@/components/chat/questionCardModel';
import { continueBlockedReason, retryRunningRequestId } from '@/components/chat/retryLastTurn';
import { parseAttachmentRejection } from '@/components/chat/sendDispatchError';
import { canContinueSession, deriveSessionFailure } from '@/components/chat/sessionFailure';
import {
  applyPanelsSnapshot,
  initialSessionPanels,
  panelsMark,
  reduceSessionPanels,
  type SessionPanelsState,
} from '@/components/chat/sessionPanelsModel';
import {
  derivePermissionOrigin,
  initialSubagentActivity,
  reduceSubagentActivity,
  type SubagentActivityState,
} from '@/components/chat/subagentActivityModel';
import { deriveJobsWindowView } from '@/components/chat/subwindowsModel';
import { deriveToolRowView, type ToolRowView } from '@/components/chat/toolCard';
import { turnEndCause } from '@/components/chat/turnEndCause';
import {
  initialSessionRuntimeFacts,
  reduceSessionRuntimeFacts,
  type SessionRuntimeFactsState,
} from '@/components/workspace-shell/surfaces/contextSurfaceModel';
import {
  acknowledgeFailedStatus,
  applyRuntimeEvent,
  applyRuntimeEvents,
  type ChatMessage,
  type ChatSession,
  type ChatSessionsState,
  statusForNextTurn,
} from '../chatSessions';
import { resetResumeCandidatesForTests } from '../historyReplayMerge';
import { usePendingUserMessagesStore } from '../pendingUserMessages';

// The real English translator: the rows interpolate, and an identity stub would
// assert on strings no user ever sees.
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate }) }));

/**
 * dsh-rebase P1-4e (decision 100 rule 3) — what the user sees when DSH drives.
 *
 * The streams below are not written by hand: `src/dsh-host/tools/bridge-record.ts`
 * drove the product bridge through a real DSH host and the local fake gateway,
 * one session per scenario, and saved what the channel carried
 * (`stream.<scenario>.json`), plus what the bridge answered over worker RPC
 * (`rpc.<scenario>.json`: the history a reopened session gets, rewind and fork
 * answers). That gate fails when DSH or the bridge stops producing them; this
 * suite fails when the renderer stops reducing them into the right screen.
 *
 * Every scenario the recorder writes must have a `scenario(...)` block here —
 * the coverage test at the bottom lists the ones that do not. A new recording
 * with nothing asserting on it would be a stream nobody watches.
 *
 * What the recording cannot carry, and how this suite stands in for it:
 *   - `seq` / `timestamp` are dropped by the recorder; they are re-applied from
 *     the array order, as `nativeStreamReplay.test.ts` does.
 *   - epoch milliseconds are recorded as `<ms>`; they become fixed numbers in
 *     recording order, so a clock still reads as a number.
 *   - token counts are recorded as 0, so the usage ring's arithmetic is the
 *     unit tests' business (`piUsage`, `composerUsageDetails`); here only the
 *     shape of what is folded is asserted.
 *   - Main's own envelope around a recorded answer (a reopen's
 *     `session.resumed` + `session.history` + `idle`, a host crash's
 *     `disconnected` + `session.failed`) is rebuilt with the shapes
 *     `WorkerManager` dispatches; its own tests pin those shapes.
 */

const FIXTURE_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'shared',
  '__tests__',
  'fixtures',
  'dsh'
);
const T0 = 1_790_000_000_000;

/** Every scenario the recorder saved a stream for, from the directory itself. */
const RECORDED = readdirSync(FIXTURE_DIR)
  .filter((name) => /^stream\..+\.json$/.test(name))
  .map((name) => name.slice('stream.'.length, -'.json'.length))
  .sort();

/** `<ms>` placeholders back to numbers, in order of appearance. */
function restamp(value: unknown, clock: { next: number }): unknown {
  if (value === '<ms>') {
    clock.next += 1;
    return clock.next;
  }
  if (Array.isArray(value)) return value.map((item) => restamp(item, clock));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, restamp(item, clock)])
    );
  }
  return value;
}

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
}

function loadStream(name: string): RuntimeEvent[] {
  const clock = { next: T0 };
  return (readFixture(`stream.${name}.json`) as Array<Record<string, unknown>>).map(
    (event, index) => ({
      ...(restamp(event, clock) as Record<string, unknown>),
      seq: index + 1,
      timestamp: T0 + index * 1_000,
    })
  ) as RuntimeEvent[];
}

/** The rpc samples are read by path, per scenario. */
type Rpc = Record<string, any>;

function loadRpc(name: string): Rpc {
  return restamp(readFixture(`rpc.${name}.json`), { next: T0 + 500_000 }) as Rpc;
}

const sessionIdOf = (name: string) => `rec-${name}`;

function session(id: string): ChatSession {
  return {
    id,
    projectId: 'project-demo',
    workspaceId: 'ws-main',
    title: id,
    status: 'idle',
    updatedAt: 0,
  };
}

function baseState(ids: readonly string[]): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: ids.map(session),
    messages: {},
    activeSessionId: ids[0] ?? null,
    recentSessionIds: [],
    pendingPermissions: [],
    pendingQuestions: [],
    hostBoundSessionIds: [...ids],
    unreadSessionIds: [],
    runtimeReady: true,
    lastError: null,
    historyErrors: {},
    selectSession: () => {},
    sendMessage: async () => {},
    stopActiveSession: async () => {},
    respondQuestion: async () => false,
    initRuntime: () => () => {},
  };
}

/** Fold events the way the store's batched flush does. */
function fold(state: ChatSessionsState, events: readonly RuntimeEvent[]): ChatSessionsState {
  return { ...state, ...applyRuntimeEvents(state, [...events]) };
}

function sessionIdsIn(events: readonly RuntimeEvent[]): string[] {
  return [...new Set(events.map((event) => event.sessionId).filter(Boolean) as string[])];
}

function replay(events: readonly RuntimeEvent[]): ChatSessionsState {
  return fold(baseState(sessionIdsIn(events)), events);
}

/** Fold up to (not including) the first event `stop` matches. */
function replayUntil(
  events: readonly RuntimeEvent[],
  stop: (event: RuntimeEvent) => boolean
): ChatSessionsState {
  const index = events.findIndex(stop);
  if (index < 0) throw new Error('the recording has no such event');
  return replay(events.slice(0, index));
}

/** The statuses a session went through, repeats collapsed. */
function statusTrail(events: readonly RuntimeEvent[], sessionId: string): SessionRuntimeStatus[] {
  const seen: SessionRuntimeStatus[] = [];
  let state = baseState(sessionIdsIn(events));
  for (const event of events) {
    state = fold(state, [event]);
    const status = state.sessions.find((item) => item.id === sessionId)?.status;
    if (status && seen.at(-1) !== status) seen.push(status);
  }
  return seen;
}

const bucket = (state: ChatSessionsState, sessionId: string): ChatMessage[] =>
  state.messages[sessionId] ?? [];
const sessionOf = (state: ChatSessionsState, sessionId: string) =>
  state.sessions.find((item) => item.id === sessionId);

const textOf = (message: ChatMessage | null | undefined): string =>
  (message?.blocks ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

interface TurnView {
  /** What heads the turn: the prompt, or `origin:<kind>` for one nobody typed. */
  head: string;
  items: TurnItem['kind'][];
  answer: string;
  rows: ToolRowView[];
  notices: TurnItem[];
}

function toolRowsOf(items: readonly TurnItem[]): ToolRowView[] {
  return items.flatMap((item) =>
    item.kind === 'toolGroup'
      ? item.entries.flatMap((entry) =>
          entry.kind === 'run' ? [deriveToolRowView(entry.run)] : []
        )
      : []
  );
}

/** One turn per prompt, as the timeline draws them. */
function turnsOf(state: ChatSessionsState, sessionId: string): TurnView[] {
  return groupMessagesIntoTurns(bucket(state, sessionId)).map((turn) => {
    const items = flattenTurnItems(turn);
    return {
      head: turn.user?.origin ? `origin:${turn.user.origin.kind}` : textOf(turn.user),
      items: items.map((item) => item.kind),
      answer: items
        .filter((item) => item.kind === 'text')
        .map((item) => (item.kind === 'text' ? (item.block.text ?? '') : ''))
        .join(''),
      rows: toolRowsOf(items),
      notices: items.filter((item) => item.kind === 'notice'),
    };
  });
}

const rowSummary = (row: ToolRowView) => ({
  tool: row.toolName,
  verb: row.verb,
  running: row.running,
  failed: row.failed,
  outcome: row.outcome ?? null,
});

/** Main's `publishHistoryTriplet`: what a reopened (or restarted) session receives. */
function historyTriplet(
  sessionId: string,
  messages: readonly HistoryMessage[],
  mode: 'initial' | 'refresh',
  requestId = `reopen-${sessionId}`
): RuntimeEvent[] {
  const base = { sessionId, requestId, seq: 0, timestamp: T0 };
  return [
    { ...base, type: 'session.resumed', payload: { agent: 'dsh', runtimeIdentity: 'stub' } },
    {
      ...base,
      type: 'session.history',
      payload: {
        runtimeIdentity: 'stub',
        workspacePath: '<workspace>',
        mode,
        messages: [...messages],
        offset: 0,
        totalCount: messages.length,
        hasMore: false,
      },
    },
    { ...base, type: 'session.status', payload: { status: 'idle' } },
  ] as RuntimeEvent[];
}

/** Open a session from the page the bridge answered, as a fresh window would. */
function reopen(sessionId: string, messages: readonly HistoryMessage[]): ChatSessionsState {
  return fold(baseState([sessionId]), historyTriplet(sessionId, messages, 'initial'));
}

function foldFacts(events: readonly RuntimeEvent[]): SessionRuntimeFactsState {
  return events.reduce(reduceSessionRuntimeFacts, initialSessionRuntimeFacts);
}

function foldPanels(events: readonly RuntimeEvent[]): SessionPanelsState {
  return events.reduce(reduceSessionPanels, initialSessionPanels);
}

function foldLanes(events: readonly RuntimeEvent[]): SubagentActivityState {
  return events.reduce(reduceSubagentActivity, initialSubagentActivity);
}

const covered = new Set<string>();

/** One recorded scenario's block; registers it for the coverage test. */
function scenario(name: string, body: (events: RuntimeEvent[], sessionId: string) => void) {
  covered.add(name);
  describe(`scenario ${name}`, () => {
    body(loadStream(name), sessionIdOf(name));
  });
}

beforeEach(() => {
  resetResumeCandidatesForTests();
  usePendingUserMessagesStore.setState({ bySession: {} });
});

// ---- every recording ------------------------------------------------------------------

/** Scenarios whose recording stops with a turn still open (the host was killed). */
const ENDS_MID_TURN = new Set(['crash-resume']);
/** Scenarios whose last turn fails, so the failure card stays up. */
const ENDS_FAILED = new Set(['fail']);

describe('every recorded stream', () => {
  /**
   * The defects this suite exists for are silent: a delta, a thinking block or
   * a tool row addressed to a message the renderer never opened is dropped
   * with an empty patch and no error. So each such event must have changed
   * the timeline when it was folded.
   */
  it.each(RECORDED)('%s: every block event lands on an open message', (name) => {
    const events = loadStream(name);
    let state = baseState(sessionIdsIn(events));
    const dropped: string[] = [];
    for (const event of events) {
      const patch = applyRuntimeEvent(state, event);
      if (
        [
          'message.delta',
          'thinking.started',
          'thinking.delta',
          'tool.started',
          'tool.completed',
        ].includes(event.type) &&
        patch.messages === undefined
      ) {
        dropped.push(`${event.type}#${event.seq}`);
      }
      state = { ...state, ...patch };
    }
    expect(dropped).toEqual([]);
  });

  it.each(RECORDED)('%s: each prompt is on screen exactly once', (name) => {
    const events = loadStream(name);
    const state = replay(events);
    for (const event of events) {
      if (event.type !== 'message.started' || event.payload.role !== 'user') continue;
      const copies = bucket(state, event.sessionId as string).filter(
        (message) => message.id === event.payload.messageId
      );
      expect(copies, event.payload.messageId).toHaveLength(1);
    }
  });

  /**
   * The optimistic bubble a send puts up is retired by the echo carrying the
   * send's `attemptId`; without it the prompt stays on screen twice. A turn
   * the engine started by itself (`origin`) has no bubble and no attempt.
   */
  it.each(RECORDED)('%s: every typed prompt echoes the attempt that sent it', (name) => {
    for (const event of loadStream(name)) {
      if (event.type !== 'message.started' || event.payload.role !== 'user') continue;
      if (event.payload.origin) {
        expect(event.payload.attemptId).toBeUndefined();
        continue;
      }
      expect(event.payload.attemptId, event.payload.messageId).toMatch(/^(attempt|interject)-/);
    }
  });

  it.each(RECORDED)('%s: ends at rest, with no card left to answer', (name) => {
    const events = loadStream(name);
    const state = replay(events);
    expect(state.pendingPermissions).toEqual([]);
    expect(state.pendingQuestions).toEqual([]);
    for (const sessionId of sessionIdsIn(events)) {
      const current = sessionOf(state, sessionId);
      if (ENDS_MID_TURN.has(name)) {
        expect(current?.status).toBe('running');
        continue;
      }
      expect(current?.status).toBe(ENDS_FAILED.has(name) ? 'failed' : 'idle');
      // The composer's gate: the next message may go.
      expect(statusForNextTurn(current)).toBe('idle');
      // No row still spinning once the turn is over.
      expect(
        turnsOf(state, sessionId).flatMap((turn) => turn.rows.filter((row) => row.running))
      ).toEqual([]);
    }
  });

  it.each(RECORDED)('%s: the settled usage reaches the usage chip', (name) => {
    const events = loadStream(name);
    const settled = events.filter(
      (event) =>
        event.type === 'usage.updated' && (event.payload as { pending?: boolean }).pending !== true
    );
    const facts = foldFacts(events);
    for (const sessionId of sessionIdsIn(settled)) {
      // The last settled bill, never a pending tick: the chip labels its rows
      // as the latest settled request.
      const last = settled.filter((event) => event.sessionId === sessionId).at(-1);
      expect(facts[sessionId]?.usage).toBeDefined();
      expect(facts[sessionId]?.usage).toEqual(readPiUsagePayload(last?.payload));
    }
  });
});

// ---- scenarios ------------------------------------------------------------------------

scenario('stream', (events, id) => {
  it('streams one answer into one turn', () => {
    const turns = turnsOf(replay(events), id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      head: 'P0-STREAM: stream a paragraph back to me.',
      items: ['text'],
    });
    expect(turns[0]?.answer).toMatch(/^DSH 引擎经 aiclient-bridge 流式回复/);
  });

  it('runs, then goes idle', () => {
    expect(statusTrail(events, id)).toEqual(['idle', 'running', 'idle']);
  });

  it('retires the optimistic bubble with the echo of its attempt', () => {
    usePendingUserMessagesStore.getState().publish({
      attemptId: 'attempt-STREAM',
      sessionId: id,
      text: 'P0-STREAM: stream a paragraph back to me.',
      attachments: [],
      startedAt: 0,
    });
    for (const event of events) {
      if (
        event.type === 'message.started' &&
        event.payload.role === 'user' &&
        event.payload.attemptId
      ) {
        usePendingUserMessagesStore
          .getState()
          .acknowledgeAttempt(id, event.payload.attemptId, event.payload.messageId);
      }
    }
    expect(usePendingUserMessagesStore.getState().bySession[id]?.[0]?.authoritativeMessageId).toBe(
      'dsh-user-5'
    );
  });
});

scenario('tool', (events, id) => {
  it('shows the command row running with its settled arguments, then done', () => {
    const mid = replayUntil(events, (event) => event.type === 'tool.completed');
    expect(turnsOf(mid, id)[0]?.rows.map(rowSummary)).toEqual([
      { tool: 'bash', verb: 'Running', running: true, failed: false, outcome: null },
    ]);
    expect(turnsOf(mid, id)[0]?.rows[0]?.arg).toContain('bridge tool row ok');

    const turn = turnsOf(replay(events), id)[0];
    expect(turn?.items).toEqual(['toolGroup', 'text']);
    expect(turn?.rows.map(rowSummary)).toEqual([
      { tool: 'bash', verb: 'Ran', running: false, failed: false, outcome: null },
    ]);
    expect(turn?.rows[0]?.output).toContain('bridge tool row ok');
    expect(turn?.answer).toBe('Tool row finished: the workspace listing is above.');
  });
});

scenario('fail', (events, id) => {
  it('keeps the failure card up, settled, with Continue offered', () => {
    const state = replay(events);
    const current = sessionOf(state, id);
    expect(current).toMatchObject({ status: 'failed', failureSettled: true });
    expect(current?.runtimeErrorCode).toBe('PROVIDER_ERROR');
    const view = deriveSessionFailure({
      error: current?.runtimeError,
      errorCode: current?.runtimeErrorCode,
    });
    expect(view.title).toBe('The model service returned an error');
    expect(view.showsDetail).toBe(true);
    expect(current?.runtimeError).toContain('P1-FAIL: the fake upstream failed this request');
    expect(canContinueSession(view, true)).toBe(true);
    expect(continueBlockedReason({ failureSettled: true, sendInFlight: false })).toBeNull();
  });

  it('draws no empty reply for the request that failed', () => {
    const turns = turnsOf(replay(events), id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.items).toEqual([]);
  });

  it('holds Continue until the closing idle arrives', () => {
    const beforeIdle = replay(events.slice(0, -1));
    expect(sessionOf(beforeIdle, id)?.failureSettled).toBeUndefined();
  });
});

scenario('fail-retry', (events, id) => {
  const rpc = loadRpc('fail-retry');
  const retryStart = events.findIndex((event) => event.requestId === 'turn-RETRY');

  it('fails first, like `fail`', () => {
    const failed = replay(events.slice(0, retryStart));
    expect(sessionOf(failed, id)).toMatchObject({ status: 'failed', failureSettled: true });
  });

  it('continues without a second prompt, and the answer lands in the same turn', () => {
    // The composer acknowledges the failure at its commit point, then the retry runs.
    let state = replay(events.slice(0, retryStart));
    state = { ...state, sessions: acknowledgeFailedStatus(state.sessions, id) };
    // A retry is admitted by its first `running`, the id the IPC reply names.
    expect(retryRunningRequestId(events[retryStart] as RuntimeEvent, id)).toBe(
      rpc.retry.accepted.result.requestId
    );
    state = fold(state, events.slice(retryStart));
    const turns = turnsOf(state, id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.answer).toBe('P1-FAILONCE recovered after the retry.');
    expect(sessionOf(state, id)).toMatchObject({ status: 'idle', runtimeError: undefined });
    expect(state.lastError).toBeNull();
  });

  it('refuses a second Continue once the turn has answered', () => {
    expect(rpc.retry.refused).toMatchObject({ ok: false, code: 'WORKER_RETRY_UNAVAILABLE' });
  });
});

scenario('think', (events, id) => {
  it('opens the reasoning ahead of the answer, on the answering message', () => {
    const state = replay(events);
    const owner = bucket(state, id).find((message) =>
      message.blocks.some((block) => block.type === 'thinking')
    );
    expect(owner?.blocks.map((block) => block.type)).toEqual(['thinking', 'text']);
    expect(owner?.blocks[0]?.text).toContain('Six times seven is forty-two.');
    const turn = turnsOf(state, id)[0];
    expect(turn?.items).toEqual(['toolGroup', 'text']);
    expect(turn?.answer).toBe('Thought it through: the answer is 42.');
  });
});

scenario('stop-stream', (events, id) => {
  it('keeps the half-written answer and marks the turn stopped by the user', () => {
    const state = replay(events);
    const turn = groupMessagesIntoTurns(bucket(state, id))[0];
    expect(turnEndCause(turn?.body ?? [])).toBe('user_stop');
    const answer = turnsOf(state, id)[0]?.answer ?? '';
    expect(answer).toMatch(/^STREAMED-stop-stream 〔2〕/);
    expect(answer).not.toContain('〔30〕');
  });

  it('shows stopping, then idle', () => {
    expect(statusTrail(events, id)).toEqual(['idle', 'running', 'stopping', 'idle']);
  });

  it('reports the cut request as usage unknown, not as free', () => {
    expect(foldFacts(events)[id]?.usage?.unreported).toBe(true);
  });
});

scenario('stop-tool', (events, id) => {
  it('ends the command row as stopped, in the done form, and the turn as the user’s', () => {
    const state = replay(events);
    expect(turnsOf(state, id)[0]?.rows.map(rowSummary)).toEqual([
      { tool: 'bash', verb: 'Ran', running: false, failed: false, outcome: 'stopped' },
    ]);
    expect(turnEndCause(groupMessagesIntoTurns(bucket(state, id))[0]?.body ?? [])).toBe(
      'user_stop'
    );
    expect(statusTrail(events, id)).toEqual(['idle', 'running', 'stopping', 'idle']);
  });
});

scenario('compact', (events, id) => {
  const rpc = loadRpc('compact');

  it('answers a command send with its own line and no model turn', () => {
    const turns = turnsOf(replay(events), id);
    expect(turns.map((turn) => turn.head)).toEqual([
      'P0-STREAM: stream a paragraph back to me.',
      'P0-TOOL: list the workspace.',
      '/goal',
    ]);
    const command = turns[2];
    expect(command?.items).toEqual(['notice']);
    const notice = command?.notices[0];
    expect(notice?.kind === 'notice' && dshNoticeRowView(notice.message)).toMatchObject({
      kind: 'command',
      text: expect.stringMatching(/^No goal is currently set\.\nUsage: \/goal/),
    });
  });

  it('refuses /compact with instructions under the code the composer words', () => {
    expect(rpc.compact.refused.code).toBe(COMPACT_INSTRUCTIONS_UNSUPPORTED);
    // DSH's `/compact` draws nothing live; the summary is there on the next open.
    expect(rpc.compact.eventsAfter).toBe(0);
  });

  it('shows the context summary as a notice when the chat is opened again', () => {
    const turns = turnsOf(reopen(id, rpc.history.page.messages), id);
    const last = turns.at(-1);
    expect(last?.items.at(-1)).toBe('notice');
    const notice = last?.notices.at(-1);
    expect(notice?.kind === 'notice' && textOf(notice.message)).toMatch(/^Context summary\n/);
    // Not one of DSH's light notice lines: a summary is the Alert-style row.
    expect(notice?.kind === 'notice' && dshNoticeRowView(notice.message)).toBeNull();
  });
});

scenario('crash-resume', (events, id) => {
  const rpc = loadRpc('crash-resume');
  const restarted = rpc.bootstrap[1].initialHistory.page.messages as HistoryMessage[];
  const crashRequest = events[0]?.requestId as string;
  /** Main's `handleLifecycle` for a host that died mid-turn. */
  const crash = [
    {
      type: 'session.status',
      sessionId: id,
      requestId: crashRequest,
      seq: 0,
      timestamp: T0,
      payload: { status: 'disconnected' },
    },
    {
      type: 'session.failed',
      sessionId: id,
      requestId: crashRequest,
      seq: 0,
      timestamp: T0,
      payload: {
        error: 'DSH host exited (signal SIGKILL)',
        errorCode: SESSION_FAILED_HOST_CRASHED,
      },
    },
  ] as RuntimeEvent[];

  it('leaves the command row running when the host dies under it', () => {
    expect(turnsOf(replay(events), id)[0]?.rows.map(rowSummary)).toEqual([
      { tool: 'bash', verb: 'Running', running: true, failed: false, outcome: null },
    ]);
  });

  it('names the engine as the cause on the failure card', () => {
    const state = fold(replay(events), crash);
    const current = sessionOf(state, id);
    expect(
      deriveSessionFailure({ error: current?.runtimeError, errorCode: current?.runtimeErrorCode })
        .title
    ).toBe('The chat engine stopped unexpectedly');
  });

  it('after the restart, shows the interrupted note and the outcome-unknown row, once', () => {
    let state = fold(replay(events), crash);
    state = fold(state, historyTriplet(id, restarted, 'refresh', 'restart-1'));
    const turns = turnsOf(state, id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.head).toBe(
      'P0-SLEEPTOOL {"token":"crash-resume","seconds":10} run a long command.'
    );
    // Started, then the engine died: it may or may not have run. Done-form
    // verb, no red, no body (the only text is the engine's note to the model).
    expect(turns[0]?.rows.map(rowSummary)).toEqual([
      { tool: 'bash', verb: 'Ran', running: false, failed: false, outcome: 'outcomeUnknown' },
    ]);
    expect(turns[0]?.rows[0]?.body).toBeUndefined();
    const notice = turns[0]?.notices.at(-1);
    expect(notice?.kind === 'notice' && notice.message.blocks[0]?.notice?.key).toBe(
      'This turn was interrupted when the engine stopped unexpectedly.'
    );
    expect(statusForNextTurn(sessionOf(state, id))).toBe('idle');
  });
});

scenario('rewind', (events, id) => {
  const rpc = loadRpc('rewind');
  const recall = events.findIndex((event) => event.requestId === 'turn-RECALL');
  const page = rpc.history.page.messages as HistoryMessage[];
  /** The page Main replays right after the rewind (`mode: 'branch'`). */
  const branch = page.filter((message) => rpc.rewind.historyIds.includes(message.id));

  it('replaces the timeline with the rewound page, then takes the next turn', () => {
    expect(branch.map((message) => message.id)).toEqual(rpc.rewind.historyIds);
    let state = replay(events.slice(0, recall));
    expect(turnsOf(state, id).map((turn) => turn.head)).toEqual([
      'alpha REWIND-KEEP-1, no scenario.',
      'beta REWIND-DROP-2, no scenario.',
    ]);
    state = fold(state, [
      {
        type: 'session.history',
        sessionId: id,
        requestId: 'rewind-1',
        seq: 0,
        timestamp: T0,
        payload: {
          runtimeIdentity: 'stub',
          workspacePath: '<workspace>',
          mode: 'branch',
          messages: branch,
          offset: 0,
          totalCount: branch.length,
          hasMore: false,
        },
      } as RuntimeEvent,
    ]);
    state = fold(state, events.slice(recall));
    const turns = turnsOf(state, id);
    expect(turns.map((turn) => turn.head)).toEqual([
      'alpha REWIND-KEEP-1, no scenario.',
      'P0-RECALL {"markers":["REWIND-KEEP-1","REWIND-DROP-2"]} which markers do you see?',
    ]);
    expect(turns[1]?.answer).toBe('P0-RECALL present=REWIND-KEEP-1 missing=REWIND-DROP-2');
    // The timeline is the page the bridge now answers for this session.
    expect(turns.map((turn) => turn.head)).toEqual(
      turnsOf(reopen(id, page), id).map((turn) => turn.head)
    );
  });

  it('hands the dropped prompt back for editing', () => {
    expect(rpc.rewind.editorText).toBe('beta REWIND-DROP-2, no scenario.');
  });
});

scenario('fork', (events, id) => {
  const rpc = loadRpc('fork');
  const child = 'rec-fork-child';
  const childInitial = rpc.childBootstrap.initialHistory.page.messages as HistoryMessage[];

  it('keeps every turn on the source', () => {
    const turns = turnsOf(replay(events), id);
    expect(turns.map((turn) => turn.head)).toEqual([
      'gamma FORK-BASE-1, no scenario.',
      'delta FORK-AFTER-2, no scenario.',
      'P0-RECALL {"markers":["FORK-BASE-1","FORK-AFTER-2"]} which markers do you see?',
    ]);
    expect(turns[2]?.answer).toBe('P0-RECALL present=FORK-BASE-1,FORK-AFTER-2 missing=-');
  });

  it('opens the fork at the fork point, and its next turn sees only that far', () => {
    expect(childInitial.map((message) => message.id)).toEqual(rpc.fork.historyIds);
    let state = reopen(child, childInitial);
    expect(turnsOf(state, child).map((turn) => turn.head)).toEqual([
      'gamma FORK-BASE-1, no scenario.',
    ]);
    state = fold(
      state,
      events.filter((event) => event.sessionId === child)
    );
    const turns = turnsOf(state, child);
    expect(turns.map((turn) => turn.head)).toEqual([
      'gamma FORK-BASE-1, no scenario.',
      'P0-RECALL {"markers":["FORK-BASE-1","FORK-AFTER-2"]} which markers do you see?',
    ]);
    expect(turns[1]?.answer).toBe('P0-RECALL present=FORK-BASE-1 missing=FORK-AFTER-2');
  });

  it('keeps the two conversations apart', () => {
    const state = replay(events);
    expect(bucket(state, child).every((message) => !message.id.includes('rec-fork-t'))).toBe(true);
    expect(bucket(state, id).every((message) => !message.id.includes('fork-child'))).toBe(true);
  });
});

scenario('usage', (events, id) => {
  it('bills every settled request with its context and the session’s running total', () => {
    const settled = events.filter(
      (event) =>
        event.type === 'usage.updated' && (event.payload as { pending?: boolean }).pending !== true
    );
    // A tool step and an answer, then the second turn's answer.
    expect(settled).toHaveLength(3);
    for (const event of settled) {
      // The shape the chip reads; the counts themselves are recorded as 0.
      expect(Object.keys((event.payload as { context: object }).context).sort()).toEqual([
        'contextWindow',
        'percent',
        'tokens',
      ]);
      expect((event.payload as { session: object }).session).toMatchObject({
        turns: expect.any(Number),
        totalTokens: expect.any(Number),
      });
    }
    const turnEnds = events
      .map((event, index) => (event.type === 'session.completed' ? index : -1))
      .filter((index) => index >= 0);
    expect(turnEnds).toHaveLength(2);
    for (const end of turnEnds) {
      expect(foldFacts(events.slice(0, end))[id]?.usage?.unreported).toBeUndefined();
    }
    // Zeroed counts leave the ring nothing to fill: a blank, never a false 0%.
    expect(deriveContextOccupancy(foldFacts(events)[id]?.usage?.context)).toBeNull();
  });

  it('ignores the pending tick in between', () => {
    const pending = events.findIndex(
      (event) => event.type === 'usage.updated' && (event.payload as { pending?: boolean }).pending
    );
    const before = foldFacts(events.slice(0, pending));
    expect(reduceSessionRuntimeFacts(before, events[pending] as RuntimeEvent)).toBe(before);
  });

  it('draws the tool step and both answers', () => {
    const turns = turnsOf(replay(events), id);
    expect(turns.map((turn) => turn.items)).toEqual([['toolGroup', 'text'], ['text']]);
  });
});

scenario('job-notice', (events, id) => {
  it('marks the command row as a background job, and heads the wake-up turn as the job’s', () => {
    const state = replay(events);
    const turns = turnsOf(state, id);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.rows[0]?.backgroundJob).toBeDefined();
    expect(turns[1]?.head).toBe('origin:job');
    const head = groupMessagesIntoTurns(bucket(state, id))[1]?.user ?? null;
    expect(autoTurnHeadView(head)).toMatchObject({
      origin: { kind: 'job' },
      detail: 'bash sleep 3; echo job-notice-done [status: completed, exit code: 0]',
    });
    expect(turns[1]?.answer).toBe('The background job reported back: done.');
  });

  it('lists the job in the jobs window while it runs', () => {
    const view = deriveJobsWindowView({
      panels: foldPanels(events).bySession[id],
      lanes: [],
      hidden: [],
    });
    expect(view.rows.map((row) => [row.jobId, row.kind, row.status])).toEqual([
      ['bash-2', 'command', 'running'],
    ]);
  });
});

scenario('jobs-kill', (events, id) => {
  const rpc = loadRpc('jobs-kill');

  it('offers Stop on the running job, and shows it killed after the kill', () => {
    const panels = foldPanels(events);
    const running = deriveJobsWindowView({ panels: panels.bySession[id], lanes: [], hidden: [] });
    expect(running.rows.map((row) => [row.jobId, row.status, row.stop])).toEqual([
      ['bash-1', 'running', 'stop'],
    ]);
    expect(rpc.jobs.kill.outcome).toBe('requested');
    // The window asks again (`worker.panels`) and takes the answer. The
    // recorder keeps only the answer's clock-free fields (id, kind, status),
    // so the rest of each row is the live projection's.
    const live = panels.bySession[id]?.jobs ?? [];
    const afterKill = rpc.jobs.afterKill as Array<Pick<DshJobSummary, 'id' | 'kind' | 'status'>>;
    expect(afterKill.map((job) => job.id)).toEqual(live.map((job) => job.id));
    const answer: DshJobSummary[] = live.map((job) => ({
      ...job,
      ...afterKill.find((after) => after.id === job.id),
    }));
    const after = applyPanelsSnapshot(
      panels,
      id,
      [{ key: 'jobs', view: answer }],
      panelsMark(panels, id)
    );
    const killed = deriveJobsWindowView({ panels: after.bySession[id], lanes: [], hidden: [] });
    expect(killed.rows.map((row) => [row.jobId, row.status, row.stop, row.removable])).toEqual([
      ['bash-1', 'killed', null, true],
    ]);
  });

  it('wakes into a turn headed by the job, saying it was killed', () => {
    const state = replay(events);
    const head = groupMessagesIntoTurns(bucket(state, id))[1]?.user ?? null;
    expect(autoTurnHeadView(head)?.detail).toContain('[status: killed');
    expect(turnsOf(state, id)[1]?.answer).toBe('P1-JOBKILL: the ticker was stopped.');
  });
});

scenario('sub-cont', (events, id) => {
  const rpc = loadRpc('sub-cont');
  const lane = rpc.lane.map((event: Record<string, unknown>) => ({
    ...event,
    sessionId: id,
    seq: 0,
    timestamp: T0,
  })) as RuntimeEvent[];

  it('heads each wake-up turn as the subagent’s', () => {
    const turns = turnsOf(replay(events), id);
    expect(turns.map((turn) => turn.head)).toEqual([
      'P1-SUBCONT: delegate to a continuable subagent.',
      'origin:subagent',
      'origin:subagent',
    ]);
    expect(turns[0]?.rows.map((row) => row.toolName)).toEqual(['subagent']);
    expect(turns[1]?.rows.map((row) => row.toolName)).toEqual(['send_message']);
    expect(turns[2]?.answer).toBe('Both runs of the subagent reported back.');
  });

  it('keeps both runs of the child on one lane', () => {
    const lanes = foldLanes(lane);
    const child = lanes.lanes['toolu_id-4'];
    expect(child).toMatchObject({ agentId: 'id-7', status: 'completed', taskType: 'subagent' });
    expect(child?.rows.filter((row) => row.kind === 'text')).toHaveLength(2);
    expect(child?.report?.status).toBe('completed');
  });

  it('lists the child as continuable, and no longer running', () => {
    const panels = foldPanels(events).bySession[id];
    expect(panels?.subagentCatalog?.map((entry) => [entry.id, entry.mode])).toEqual([
      ['id-7', 'continuable'],
    ]);
    const view = deriveJobsWindowView({
      panels,
      lanes: Object.values(foldLanes(lane).lanes),
      hidden: [],
    });
    expect(view.rows).toEqual([]);
  });
});

scenario('question', (events, id) => {
  it('docks the first card until it is answered', () => {
    const mid = replayUntil(events, (event) => event.type === 'question.resolved');
    expect(mid.pendingQuestions).toMatchObject([
      { sessionId: id, questionId: 'dsh-question-id-17' },
    ]);
    expect(sessionOf(mid, id)?.status).toBe('waiting_question');
  });

  it('freezes one card answered and the other skipped', () => {
    const state = replay(events);
    const cards = bucket(state, id)
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'question');
    expect(cards.map((card) => [card.questionId, deriveQuestionCardState(card)])).toEqual([
      ['dsh-question-id-17', 'answered'],
      ['dsh-question-id-18', 'skipped'],
    ]);
    expect(cards[0]?.questionAnswers).toEqual({
      scope: 'Renderer',
      checks: 'tsc, smoke, then record, also lint',
    });
    const turns = turnsOf(state, id);
    expect(turns.map((turn) => turn.items.includes('question'))).toEqual([true, true]);
    expect(turns[1]?.answer).toContain('"selected":[]');
  });
});

scenario('steer', (events, id) => {
  const rpc = loadRpc('steer');

  it('takes the interjection in as a prompt of its own, and the turn goes on', () => {
    const turns = turnsOf(replay(events), id);
    expect(turns.map((turn) => turn.head)).toEqual([
      'P1-STEER: two tool steps.',
      'STEER-NOTE-A also report the step count.',
    ]);
    expect(turns[1]?.answer).toBe('P1-STEER finished; heard: STEER-NOTE-A.');
    expect(turns.flatMap((turn) => turn.rows.map(rowSummary))).toEqual([
      { tool: 'bash', verb: 'Ran', running: false, failed: false, outcome: null },
      { tool: 'bash', verb: 'Ran', running: false, failed: false, outcome: null },
    ]);
    // One run throughout: the interjection did not end it.
    expect(statusTrail(events, id)).toEqual(['idle', 'running', 'idle']);
    expect(rpc.interject.running.result).toEqual({ interjected: true, turnActive: true });
  });

  it('retires the interjection’s optimistic bubble with its echo', () => {
    usePendingUserMessagesStore.getState().publish({
      attemptId: 'interject-STEER',
      sessionId: id,
      text: 'STEER-NOTE-A also report the step count.',
      attachments: [],
      startedAt: 0,
    });
    for (const event of events) {
      if (
        event.type === 'message.started' &&
        event.payload.role === 'user' &&
        event.payload.attemptId
      ) {
        usePendingUserMessagesStore
          .getState()
          .acknowledgeAttempt(id, event.payload.attemptId, event.payload.messageId);
      }
    }
    expect(usePendingUserMessagesStore.getState().bySession[id]?.[0]?.authoritativeMessageId).toBe(
      'dsh-user-17'
    );
  });

  it('finds no turn to join once idle, so the composer sends normally', () => {
    expect(rpc.interject.idle.result).toEqual({ interjected: false, turnActive: false });
  });
});

scenario('image', (events, id) => {
  const rpc = loadRpc('image');
  const chip = [{ kind: 'image', mediaType: 'image/png', name: 'dot.png' }];

  it('shows the image chip on the prompt, live and reopened', () => {
    const live = bucket(replay(events), id).find((message) => message.role === 'user');
    expect(live?.attachments).toEqual(chip);
    const reopened = bucket(reopen(id, rpc.history.page.messages), id).find(
      (message) => message.role === 'user'
    );
    expect(reopened?.attachments).toEqual(chip);
    expect(turnsOf(replay(events), id)[0]?.answer).toBe('P1-IMAGE saw 1 image block(s).');
  });

  it('names the refused attachment the way the composer reads it', () => {
    expect(rpc.rejected.eventsAfter).toBe(0);
    // WorkerManager passes the worker's code and sentence through; Electron wraps them.
    const error = new Error(
      `Error invoking remote method 'chat:sendMessage': WorkerSlotError: ${rpc.rejected.code}: ${rpc.rejected.message}`
    );
    expect(parseAttachmentRejection(error)).toEqual({
      code: 'IMAGE_DIMENSION_TOO_LARGE',
      name: 'wide.png',
    });
  });
});

scenario('file-attach', (events, id) => {
  const rpc = loadRpc('file-attach');
  const chip = [{ kind: 'text', mediaType: 'text/plain', name: 'notes.txt' }];

  it('shows the file chip, reads the file without a card, and answers from it', () => {
    const state = replay(events);
    expect(bucket(state, id).find((message) => message.role === 'user')?.attachments).toEqual(chip);
    const turn = turnsOf(state, id)[0];
    expect(turn?.rows.map(rowSummary)).toEqual([
      { tool: 'read', verb: 'Read', running: false, failed: false, outcome: null },
    ]);
    expect(events.some((event) => event.type === 'permission.requested')).toBe(false);
    expect(turn?.answer).toBe('P1-FILEREAD read: FILE-MARKER-NOTES.');
    const reopened = bucket(reopen(id, rpc.history.page.messages), id).find(
      (message) => message.role === 'user'
    );
    expect(reopened?.attachments).toEqual(chip);
  });
});

// ---- permissions (P1-6c) --------------------------------------------------------------

/** Each settled card, as its tool row words it once the approval is folded in. */
function decidedRows(state: ChatSessionsState, sessionId: string) {
  return turnsOf(state, sessionId).flatMap((turn) =>
    turn.rows.map((row) => ({
      command: row.arg,
      verb: row.verb,
      permission: row.permissionVerb ?? null,
      outcome: row.outcome ?? null,
    }))
  );
}

scenario('perm-card', (events, id) => {
  it('parks the turn on each card until it is answered', () => {
    const mid = replayUntil(events, (event) => event.type === 'permission.resolved');
    expect(sessionOf(mid, id)?.status).toBe('waiting_permission');
    const queued = mid.pendingPermissions[0];
    expect(queued?.permissionId).toBe('toolu_id-4');
    expect(canRespondToPermission(mid.pendingPermissions, id, 'toolu_id-4')).toBe(true);
    const card = bucket(mid, id)
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'permission_request');
    expect(card).toMatchObject({
      toolName: 'write',
      permissionAction: 'write_file',
      permissionKind: 'file_change',
      resolved: false,
    });
    expect(statusTrail(events, id)).toEqual([
      'idle',
      'running',
      'waiting_permission',
      'running',
      'waiting_permission',
      'running',
      'idle',
    ]);
  });

  it('folds each answer into its row: one allowed, one denied', () => {
    expect(decidedRows(replay(events), id)).toEqual([
      expect.objectContaining({ permission: 'Allowed', outcome: null }),
      expect.objectContaining({ permission: 'Denied', outcome: 'refused' }),
    ]);
  });
});

scenario('perm-grants', (events, id) => {
  it('says what Allow for session remembers, and asks nothing covered by it', () => {
    const state = replay(events);
    const cards = bucket(state, id)
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'permission_request');
    // `echo perm-grant-b` never raised a card; `echo … && rm …` did.
    expect(cards.map((card) => card.permissionId)).toEqual(['toolu_id-4', 'toolu_id-12']);
    expect(derivePermissionGrantScopeNote(cards[0]?.permissionGrantScope, cards[0]?.toolName)).toBe(
      'Allow for session remembers commands starting with echo'
    );
    expect(decidedRows(state, id).map((row) => row.permission)).toEqual([
      'Allowed for session',
      null,
      'Denied',
    ]);
  });
});

scenario('perm-deny', (events, id) => {
  it('refuses the protected read without a card', () => {
    const state = replay(events);
    expect(events.some((event) => event.type === 'permission.requested')).toBe(false);
    expect(decidedRows(state, id)).toEqual([
      { command: 'cat .env', verb: 'Run', permission: null, outcome: 'refused' },
    ]);
  });
});

scenario('perm-plan', (events, id) => {
  it('refuses the write without a card, and the read runs', () => {
    const state = replay(events);
    expect(events.some((event) => event.type === 'permission.requested')).toBe(false);
    expect(turnsOf(state, id)[0]?.rows.map(rowSummary)).toEqual([
      { tool: 'write', verb: 'Edit', running: false, failed: false, outcome: 'refused' },
      { tool: 'read', verb: 'Read', running: false, failed: false, outcome: null },
    ]);
  });
});

scenario('perm-gear', (events, id) => {
  const rpc = loadRpc('perm-gear');

  it('refuses a new mode while a card is up, and the widened gear answers the card', () => {
    expect(rpc.changes.mode).toMatchObject({ ok: false, code: 'WORKER_SESSION_BUSY' });
    expect(rpc.changes.gear).toMatchObject({ ok: true });
    const state = replay(events);
    expect(decidedRows(state, id)).toEqual([
      expect.objectContaining({ verb: 'Ran', permission: 'Allowed', outcome: null }),
    ]);
  });
});

scenario('perm-stop', (events, id) => {
  it('takes the card down as aborted and the call as never run', () => {
    const state = replay(events);
    const card = bucket(state, id)
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'permission_request');
    expect(card).toMatchObject({ resolved: true, allowed: false });
    expect(card && derivePermissionAutoNote(card)).toBe('auto: aborted');
    expect(turnsOf(state, id)[0]?.rows.map(rowSummary)).toEqual([
      { tool: 'bash', verb: 'Run', running: false, failed: false, outcome: 'notStarted' },
    ]);
    expect(statusTrail(events, id)).toEqual([
      'idle',
      'running',
      'waiting_permission',
      'stopping',
      'idle',
    ]);
  });
});

scenario('perm-restart', (events, id) => {
  const rpc = loadRpc('perm-restart');

  it('asks nothing after a restart, until the grant is forgotten', () => {
    const state = replay(events);
    const asked = turnsOf(state, id).map((turn) =>
      turn.rows.map((row) => row.permissionVerb ?? null)
    );
    expect(asked).toEqual([
      ['Allowed for session', null],
      [null, null],
      ['Denied', 'Denied'],
    ]);
    expect(rpc.grants.configured.grants).toEqual([]);
  });
});

scenario('perm-subagent', (events, id) => {
  it('names the subagent on the card it raised', () => {
    const requested = events.findIndex((event) => event.type === 'permission.requested');
    const lanes = foldLanes(events.slice(0, requested + 1));
    const origin = lanes.permissionOrigin['toolu_id-11'];
    expect(derivePermissionOrigin(origin)?.label).toBe('From subagent · Permission probe child');
  });

  it('draws the child’s work on its lane, and the delegation row done', () => {
    const lane = foldLanes(events).lanes['toolu_id-4'];
    expect(lane?.status).toBe('completed');
    expect(
      lane?.rows.map((row) => (row.kind === 'tool' ? `${row.name}:${row.status}` : row.kind))
    ).toEqual(['bash:ok', 'text']);
    expect(turnsOf(replay(events), id)[0]?.rows.map((row) => [row.toolName, row.running])).toEqual([
      ['subagent', false],
    ]);
  });
});

scenario('perm-search', (events, id) => {
  it('lists and searches without the protected files', () => {
    const rows = turnsOf(replay(events), id)[0]?.rows ?? [];
    expect(rows.map(rowSummary)).toEqual([
      { tool: 'glob', verb: 'Searched files', running: false, failed: false, outcome: null },
      { tool: 'grep', verb: 'Grepped', running: false, failed: false, outcome: null },
    ]);
    for (const row of rows) {
      expect(row.output ?? '').not.toMatch(/\.env|server\.key/);
    }
    expect(rows[1]?.hitSource).toContain('notes.txt');
  });
});

// ---- reopening ------------------------------------------------------------------------

/**
 * Where a reopened chat does not read like the live one, and why. Everything
 * else must match: a turn watched live and the same turn opened later from the
 * page the bridge answers (`rpc.history`) show the same prompts, rows, outcomes
 * and answers. Each exception is asserted to still differ, so the list cannot
 * outlive its reason.
 */
const REOPEN_DIFFERS: Readonly<Record<string, string>> = {
  compact: 'the summary row is written by /compact; a command send is not a turn in the log',
  'crash-resume': 'the restart adds the interrupted note and settles the row (asserted above)',
  fail: 'the failure card is live; the log keeps an empty reply, drawn as interrupted',
  fork: 'the source page is the one the fork left behind (asserted above)',
  rewind: 'the page after a rewind drops the retired turn (asserted above)',
  'perm-grants': 'the session-grant activity row is live only (decision 143)',
  'perm-restart': 'the session-grant activity row is live only (decision 143)',
  'perm-subagent': 'a child’s approval card is live only',
  question: 'the question card is live only; the answer stays in the ask_user_question row',
};

describe('reopening a recorded chat', () => {
  const screen = (state: ChatSessionsState, sessionId: string) =>
    turnsOf(state, sessionId).map((turn) => ({
      head: turn.head,
      items: turn.items,
      rows: turn.rows.map(
        (row) => `${row.toolName}:${row.outcome ?? (row.failed ? 'failed' : 'ok')}`
      ),
      answer: turn.answer,
    }));

  it.each(RECORDED)('%s: reads as it did live', (name) => {
    const id = sessionIdOf(name);
    const live = screen(replay(loadStream(name)), id);
    const reopened = screen(reopen(id, loadRpc(name).history.page.messages), id);
    if (REOPEN_DIFFERS[name]) {
      expect(reopened).not.toEqual(live);
    } else {
      expect(reopened).toEqual(live);
    }
  });
});

// ---- coverage -------------------------------------------------------------------------

describe('coverage', () => {
  it('asserts on every scenario the recorder writes', () => {
    expect(RECORDED.length).toBeGreaterThan(0);
    expect(RECORDED.filter((name) => !covered.has(name))).toEqual([]);
    expect([...covered].filter((name) => !RECORDED.includes(name))).toEqual([]);
  });
});
