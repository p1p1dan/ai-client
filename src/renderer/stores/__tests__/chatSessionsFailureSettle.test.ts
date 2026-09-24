/**
 * D1 (2026-09-24 devbox point-check) — the failure card never survived the
 * run's own closing `idle`.
 *
 * Measured order (runtime `subagentLoopGuard.test.ts`, form B, last two events
 * of the run): `session.failed {error, errorCode: 'tool_call_repetition'}`
 * followed by `session.status {status: 'idle'}`. Every run that ends in failure
 * closes with the same pair (`RunProjection.finish`, the loop's thrown path,
 * the native index adapter), and the store used to let the idle overwrite the
 * failed status one event later — the card is gated on `status === 'failed'`,
 * so it never rendered on any path.
 *
 * The fix keeps `failed` across that idle and records that the run is at rest
 * (`failureSettled`), so the gates that ask "may the next turn start" still see
 * what the runtime reported (`statusForNextTurn`).
 */
import { zhTranslations } from '@shared/i18n';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { decideQueueRelease } from '@/components/chat/queueRelease';
import { deriveSessionFailure } from '@/components/chat/sessionFailure';
import {
  acknowledgeFailedStatus,
  applyRuntimeEvents,
  type ChatSession,
  type ChatSessionsState,
  statusForNextTurn,
} from '../chatSessions';

const SESSION_ID = 'session-d1';

/** Verbatim from `data/21-d1b.json` (store.runtimeError). */
const REPETITION_ERROR =
  'The model wrote the same subagent tool call 3 times in one reply (TaskList {}), with 47 tool calls in that reply so far. The app interrupted the reply and ran none of its tool calls. (run send-1790255805207-33)';

function baseState(overrides: Partial<ChatSessionsState> = {}): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: [
      {
        id: SESSION_ID,
        projectId: 'project-demo',
        workspaceId: 'ws-main',
        title: 'formB',
        status: 'running',
        updatedAt: 1,
      },
    ],
    messages: {},
    activeSessionId: SESSION_ID,
    recentSessionIds: [],
    pendingPermissions: [],
    pendingQuestions: [],
    hostBoundSessionIds: [SESSION_ID],
    unreadSessionIds: [],
    runtimeReady: true,
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

let seq = 0;
function event(type: RuntimeEvent['type'], payload?: unknown): RuntimeEvent {
  seq += 1;
  return { type, seq, sessionId: SESSION_ID, timestamp: seq, payload } as RuntimeEvent;
}

const failed = (error: string, errorCode?: string) =>
  event('session.failed', { error, ...(errorCode ? { errorCode } : {}) });
const status = (value: string, extra: Record<string, unknown> = {}) =>
  event('session.status', { status: value, ...extra });

/** Apply a batch and return the state it leaves behind. */
function run(state: ChatSessionsState, events: RuntimeEvent[]): ChatSessionsState {
  return { ...state, ...applyRuntimeEvents(state, events) };
}

function session(state: ChatSessionsState): ChatSession {
  const found = state.sessions.find((item) => item.id === SESSION_ID);
  if (!found) throw new Error('session row missing');
  return found;
}

describe('D1 — a failed run keeps its failure past its own closing idle', () => {
  it('[FS-01] the runtime closing pair leaves the session failed, with its sentence and code', () => {
    const after = run(baseState(), [
      failed(REPETITION_ERROR, 'tool_call_repetition'),
      status('idle'),
    ]);
    expect(session(after).status).toBe('failed');
    expect(session(after).runtimeErrorCode).toBe('tool_call_repetition');
    expect(session(after).runtimeError).toBe(REPETITION_ERROR);
    expect(after.lastError).toBe(REPETITION_ERROR);
  });

  it('[FS-02] what the card then draws is the Chinese repetition title, not the raw sentence', () => {
    const after = run(baseState(), [
      failed(REPETITION_ERROR, 'tool_call_repetition'),
      status('idle'),
    ]);
    // `MessageTimeline` renders the card iff `status === 'failed'` and titles
    // it from `deriveSessionFailure` over the stored code.
    const cardShown = session(after).status === 'failed';
    const view = deriveSessionFailure({
      error: session(after).runtimeError,
      errorCode: session(after).runtimeErrorCode,
    });
    expect(cardShown && zhTranslations[view.title]).toBe('模型输出出现重复调用，已中断');
    expect(view.action).toBe('continue');
  });

  it('[FS-03] every failure path that closes with the same pair keeps its card', () => {
    const paths: Array<{ name: string; events: RuntimeEvent[]; code?: string }> = [
      // RunProjection.finish — a provider stream that died mid-reply.
      {
        name: 'stop_error',
        events: [failed('terminated', 'stop_error'), status('idle')],
        code: 'stop_error',
      },
      {
        name: 'no_assistant_message',
        events: [
          failed('the loop ended without an assistant turn', 'no_assistant_message'),
          status('idle'),
        ],
        code: 'no_assistant_message',
      },
      {
        name: 'context_too_large',
        events: [failed('prompt too large', 'context_too_large'), status('idle')],
        code: 'context_too_large',
      },
      // agent-loop `run()` catch — thrown runs carry the code inside the text.
      {
        name: 'thrown',
        events: [failed('model_not_in_catalog: no model "x/y" in the catalog'), status('idle')],
      },
      // Main's crash path: disconnected, failed, and the restart's idle later.
      {
        name: 'worker crash',
        events: [status('disconnected'), failed('worker exited with code 1'), status('idle')],
      },
    ];
    for (const path of paths) {
      const after = run(baseState(), path.events);
      expect({ name: path.name, status: session(after).status }).toEqual({
        name: path.name,
        status: 'failed',
      });
      expect(session(after).runtimeErrorCode).toBe(path.code);
    }
  });

  it('[FS-04] the next run takes the card down and clears the stale sentence', () => {
    const failedState = run(baseState(), [
      failed(REPETITION_ERROR, 'tool_call_repetition'),
      status('idle'),
    ]);
    const next = run(failedState, [status('starting')]);
    expect(session(next).status).toBe('starting');
    expect(session(next).runtimeError).toBeUndefined();
    expect(session(next).runtimeErrorCode).toBeUndefined();
    expect(session(next).failureSettled).toBeUndefined();
  });

  it('[FS-05] only the runtime idle is absorbed — a completion or a stop still lands on idle', () => {
    const failedState = run(baseState(), [failed('boom', 'stop_error'), status('idle')]);
    expect(session(run(failedState, [event('session.completed')])).status).toBe('idle');
    expect(session(run(failedState, [event('session.stopped')])).status).toBe('idle');
  });
});

describe('D1 — the next-turn gates still see a settled failure as idle', () => {
  const release = (state: ChatSessionsState) =>
    decideQueueRelease({
      sessionId: SESSION_ID,
      entries: [{ id: 'q-1' }],
      paused: null,
      hasTarget: true,
      disabled: false,
      sending: false,
      inFlight: false,
      status: statusForNextTurn(session(state)) ?? 'idle',
    });

  it('[FS-06] a queued message releases once the failed run has closed, exactly as before', () => {
    const settled = run(baseState(), [failed('boom', 'stop_error'), status('idle')]);
    expect(release(settled)).toEqual({ type: 'release', entryId: 'q-1' });
  });

  it('[FS-07] but not while the runtime has not closed the run (worker crash, restart pending)', () => {
    const crashed = run(baseState(), [status('disconnected'), failed('worker exited')]);
    expect(session(crashed).status).toBe('failed');
    expect(release(crashed)).toEqual({ type: 'hold', reason: 'not-idle' });
  });

  it('[FS-08] a background delegate asking after a settled failure does not park the session', () => {
    const settled = run(baseState(), [failed('boom', 'stop_error'), status('idle')]);
    const asked = run(settled, [
      event('permission.requested', {
        permissionId: 'perm-bg',
        toolName: 'Bash',
        agentId: 'delegation-1',
      }),
    ]);
    expect(asked.pendingPermissions).toHaveLength(1);
    expect(session(asked).status).toBe('failed');
  });

  it('[FS-09] a new send acknowledges the failure: failed goes back to idle, anything else is untouched', () => {
    const settled = run(baseState(), [failed('boom', 'stop_error'), status('idle')]);
    const acknowledged = acknowledgeFailedStatus(settled.sessions, SESSION_ID);
    expect(acknowledged.find((item) => item.id === SESSION_ID)?.status).toBe('idle');
    expect(acknowledged.find((item) => item.id === SESSION_ID)?.failureSettled).toBeUndefined();
    // Same array back when there is nothing to acknowledge, so a send on a
    // healthy session does not rebuild every row.
    const healthy = baseState().sessions;
    expect(acknowledgeFailedStatus(healthy, SESSION_ID)).toBe(healthy);
  });
});
