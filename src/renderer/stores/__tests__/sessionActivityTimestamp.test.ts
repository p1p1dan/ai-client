/**
 * dsh-rebase decision 138 (P1-7d point-check issue 3): `updatedAt` is the
 * sidebar's "last activity" — Recent's order and 48h window, the folders'
 * order — and only real activity moves it.
 *
 * Before: every status write stamped `Date.now()`. The pool reclaiming an idle
 * worker (`disconnected`, capacity 6) and the engine restarting (every session
 * reopened, then `idle`) both wrote statuses to chats nobody had touched, and
 * those jumped to the top of Recent as "now" above the one in use.
 */
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRuntimeEvents, type ChatSession, type ChatSessionsState } from '../chatSessions';

const T0 = 1_700_000_000_000;
const LATER = T0 + 60_000;

function row(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p',
    workspaceId: 'ws',
    title: id,
    status: 'idle',
    updatedAt: T0,
    ...extra,
  };
}

function baseState(sessions: ChatSession[], hostBound: string[] = []): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions,
    messages: {},
    activeSessionId: sessions[0]?.id ?? null,
    recentSessionIds: [],
    pendingPermissions: [],
    pendingQuestions: [],
    hostBoundSessionIds: hostBound,
    unreadSessionIds: [],
    runtimeReady: true,
    lastError: null,
    historyErrors: {},
    selectSession: () => {},
    sendMessage: async () => {},
    stopActiveSession: async () => {},
    respondQuestion: async () => false,
    closePlanReview: async () => {},
    initRuntime: () => () => {},
  };
}

let seq = 0;
function event(sessionId: string, type: RuntimeEvent['type'], payload?: unknown): RuntimeEvent {
  seq += 1;
  return { type, seq, sessionId, timestamp: seq, payload } as RuntimeEvent;
}

function run(state: ChatSessionsState, events: RuntimeEvent[]): ChatSessionsState {
  return { ...state, ...applyRuntimeEvents(state, events) };
}

function updatedAt(state: ChatSessionsState, id: string): number | undefined {
  return state.sessions.find((session) => session.id === id)?.updatedAt;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(LATER);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('status writes are not activity', () => {
  it('[ACT-01] a capacity reclaim leaves the reclaimed chat where it was', () => {
    const after = run(baseState([row('a')], ['a']), [
      event('a', 'session.status', {
        status: 'disconnected',
        disconnectReason: 'capacity_reclaimed',
      }),
    ]);
    expect(after.sessions[0]?.status).toBe('disconnected');
    expect(updatedAt(after, 'a')).toBe(T0);
  });

  it('[ACT-02] an engine restart (resume + idle) leaves every reopened chat where it was', () => {
    const after = run(baseState([row('a'), row('b')], ['a', 'b']), [
      event('a', 'session.status', {
        status: 'disconnected',
        disconnectReason: 'engine_restarted',
      }),
      event('b', 'session.status', {
        status: 'disconnected',
        disconnectReason: 'engine_restarted',
      }),
      event('a', 'session.resumed', { runtimeIdentity: '/a.dsh.json' }),
      event('b', 'session.resumed', { runtimeIdentity: '/b.dsh.json' }),
      event('a', 'session.status', { status: 'idle' }),
      event('b', 'session.status', { status: 'idle' }),
    ]);
    expect(updatedAt(after, 'a')).toBe(T0);
    expect(updatedAt(after, 'b')).toBe(T0);
    // The binding is back — the "Active now" section reads that, not the time.
    expect(after.hostBoundSessionIds).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('[ACT-03] running / waiting statuses do not move the row either', () => {
    const after = run(baseState([row('a')], ['a']), [
      event('a', 'session.status', { status: 'running' }),
      event('a', 'permission.requested', { permissionId: 'p1', toolName: 'bash' }),
    ]);
    expect(after.sessions[0]?.status).toBe('waiting_permission');
    expect(updatedAt(after, 'a')).toBe(T0);
  });

  it('[ACT-04] the idle that settles a failure does not move it again', () => {
    const failed = run(baseState([row('a', { status: 'running' })], ['a']), [
      event('a', 'session.failed', { error: 'boom' }),
    ]);
    vi.setSystemTime(LATER + 5_000);
    const settled = run(failed, [event('a', 'session.status', { status: 'idle' })]);
    expect(settled.sessions[0]?.failureSettled).toBe(true);
    expect(updatedAt(settled, 'a')).toBe(LATER);
  });
});

describe('real activity moves it', () => {
  it('[ACT-05] a turn starting (the user message) and ending', () => {
    const started = run(baseState([row('a')], ['a']), [
      event('a', 'message.started', { messageId: 'u1', role: 'user' }),
    ]);
    expect(updatedAt(started, 'a')).toBe(LATER);

    vi.setSystemTime(LATER + 30_000);
    const ended = run(started, [event('a', 'session.completed', {})]);
    expect(updatedAt(ended, 'a')).toBe(LATER + 30_000);
  });

  it('[ACT-06] a failed or stopped turn ends a turn too', () => {
    const failed = run(baseState([row('a', { status: 'running' })], ['a']), [
      event('a', 'session.failed', { error: 'boom' }),
    ]);
    expect(updatedAt(failed, 'a')).toBe(LATER);

    const stopped = run(baseState([row('b', { status: 'running' })], ['b']), [
      event('b', 'session.stopped', { stopCause: 'user_stop' }),
    ]);
    expect(updatedAt(stopped, 'b')).toBe(LATER);
  });

  it('[ACT-07] a Stop that found no turn running is not a turn ending', () => {
    const after = run(baseState([row('a', { status: 'stopping' })], ['a']), [
      event('a', 'session.stopped', { stopCause: 'no_active_turn' }),
    ]);
    expect(after.sessions[0]?.status).toBe('idle');
    expect(updatedAt(after, 'a')).toBe(T0);
  });

  it('[ACT-08] the first send creates the engine session — that is activity', () => {
    const after = run(baseState([row('a')]), [
      event('a', 'session.created', { runtimeIdentity: '/a.dsh.json' }),
    ]);
    expect(updatedAt(after, 'a')).toBe(LATER);
  });

  it('[ACT-09] an assistant message alone does not stamp (the turn end will)', () => {
    const state = baseState([row('a', { status: 'running' })], ['a']);
    const patch = applyRuntimeEvents(state, [
      event('a', 'message.started', { messageId: 'm1', role: 'assistant' }),
    ]);
    expect(patch.sessions).toBeUndefined();
  });

  it('[ACT-10] never moves a row backwards', () => {
    const future = LATER + 999_000;
    const after = run(baseState([row('a', { updatedAt: future })], ['a']), [
      event('a', 'session.completed', {}),
    ]);
    expect(updatedAt(after, 'a')).toBe(future);
  });
});
