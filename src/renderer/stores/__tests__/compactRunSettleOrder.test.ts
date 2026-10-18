/**
 * dsh-rebase decision 180, found in the dev app on 2026-10-18: a `/compact`'s
 * answer settles the run at once, while the bridge's `session.compaction`
 * events of the same compaction — sent before the answer — still wait in
 * `initRuntime`'s batch (16 ms, a second in a hidden window). One `/compact`
 * showed two command lines and two summaries. The settle applies the batch
 * first, so the events land in the order they were sent.
 */

import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleCompactRun, showCompactRun } from '../chatSessionActions';
import { type ChatMessage, useChatSessionsStore } from '../chatSessions';
import { resetRuntimeEventBus } from '../runtimeEventBus';

const SESSION_ID = 'c1';

let captured: ((event: RuntimeEvent) => void) | null = null;
let cleanup: (() => void) | null = null;

function compaction(seq: number, payload: Record<string, unknown>): RuntimeEvent {
  return {
    type: 'session.compaction',
    seq,
    sessionId: SESSION_ID,
    timestamp: seq,
    payload: { messageId: 'dsh-compaction-k1', trigger: 'manual', ...payload },
  } as RuntimeEvent;
}

const started = compaction(1, {
  phase: 'started',
  commandMessageId: 'dsh-compact-command-k1',
  command: '/compact',
});

/** One entry a row: `<id> <part>`, the part being the first block's kind. */
function rows(): string[] {
  return (useChatSessionsStore.getState().messages[SESSION_ID] ?? []).map((row: ChatMessage) => {
    const part = row.blocks[0]?.id.slice(row.id.length + 1).split(':')[0];
    return `${row.id} ${part}`;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  captured = null;
  resetRuntimeEventBus();
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      chat: {
        onRuntimeEvent: (callback: (event: RuntimeEvent) => void) => {
          captured = callback;
          return () => undefined;
        },
        ensureHost: () => Promise.resolve(),
      },
    },
  } as unknown as typeof globalThis.window;
  useChatSessionsStore.setState({
    runtimeReady: false,
    messages: {},
    sessions: [
      {
        id: SESSION_ID,
        projectId: 'p1',
        workspaceId: 'w1',
        title: 'c1',
        status: 'idle',
        updatedAt: 0,
      },
    ],
    activeSessionId: SESSION_ID,
    pendingPermissions: [],
    pendingQuestions: [],
    hostBoundSessionIds: [SESSION_ID],
    lastError: null,
    historyErrors: {},
  });
  cleanup = useChatSessionsStore.getState().initRuntime();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, 'window');
});

describe('/compact settles after the events sent before its answer', () => {
  it('[180-ORD-1] a note: the queued started and failed land first, no second pair', () => {
    showCompactRun(SESSION_ID, 'r1', '/compact', 'Compacting the context…');
    captured?.(started);
    captured?.(
      compaction(2, {
        phase: 'failed',
        note: { key: 'Compaction cancelled. Nothing was compacted.' },
      })
    );
    // The answer comes before the batch's timer.
    settleCompactRun(SESSION_ID, 'r1', {
      kind: 'note',
      note: { key: 'Compaction cancelled. Nothing was compacted.' },
    });
    vi.advanceTimersByTime(1_000);
    expect(rows()).toEqual([
      'dsh-compact-command-k1 compact-command',
      'dsh-compaction-k1 compaction-failed',
    ]);
  });

  it('[180-ORD-2] a summary: the queued started and completed land first, then the answer’s own row', () => {
    showCompactRun(SESSION_ID, 'r1', '/compact', 'Compacting the context…');
    captured?.(started);
    captured?.(compaction(2, { phase: 'completed', summary: 'Context summary\n\n- x' }));
    settleCompactRun(SESSION_ID, 'r1', {
      kind: 'summary',
      summary: {
        id: 'h:cp1',
        entryId: 'cp1',
        role: 'system',
        liveMessageId: 'dsh-compaction-k1',
        blocks: [{ id: 'h:cp1:summary:0', type: 'text', text: 'Context summary\n\n- x' }],
      },
    });
    vi.advanceTimersByTime(1_000);
    expect(rows()).toEqual(['dsh-compact-command-k1 compact-command', 'h:cp1 summary']);
  });

  it('[180-ORD-3] with nothing queued the flush is a no-op, and later events still batch', () => {
    showCompactRun(SESSION_ID, 'r1', '/compact', 'Compacting the context…');
    settleCompactRun(SESSION_ID, 'r1', { kind: 'remove' });
    expect(rows()).toEqual([]);
    captured?.(started);
    expect(rows()).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(rows()).toEqual([
      'dsh-compact-command-k1 compact-command',
      'dsh-compaction-k1 compaction-running',
    ]);
  });
});
