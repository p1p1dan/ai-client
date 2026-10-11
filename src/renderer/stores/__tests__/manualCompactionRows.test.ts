/**
 * dsh-rebase decision 180 — the rows of a `/compact` the user ran, in the
 * store: the composer's own rows renamed in place by the bridge's
 * `session.compaction`, the summary or the note in the running row's place,
 * the composer's settle where the bridge has not settled it, and no turn's
 * end taking a `/compact`'s row for its own.
 */
import { DSH_COMPACT_CANCELLED_KEY, DSH_COMPACTION_RUNNING_KEY } from '@shared/dshHistory/types';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { applyRuntimeEvent, type ChatMessage, type ChatSessionsState } from '../chatSessions';
import {
  compactCommandRow,
  compactRunningRow,
  compactRunRowIds,
  isManualCompactionRow,
  withCompactRunSettled,
} from '../manualCompactionRows';

const prompt: ChatMessage = {
  id: 'u1',
  sessionId: 's1',
  role: 'user',
  blocks: [{ id: 'u1:t', type: 'text', text: 'go' }],
};

function state(rows: ChatMessage[]): ChatSessionsState {
  return {
    activeSessionId: 's1',
    sessions: [
      { id: 's1', projectId: 'p', workspaceId: 'w', title: 's1', status: 'idle', updatedAt: 0 },
    ],
    messages: { s1: rows },
    pendingPermissions: [],
    pendingQuestions: [],
    hostBoundSessionIds: ['s1'],
    recentSessionIds: [],
    unreadSessionIds: [],
    historyErrors: {},
    lastError: null,
  } as unknown as ChatSessionsState;
}

function apply(
  current: ChatSessionsState,
  payload: Record<string, unknown>,
  type = 'session.compaction'
) {
  return {
    ...current,
    ...applyRuntimeEvent(current, {
      type,
      sessionId: 's1',
      seq: 1,
      timestamp: 1,
      payload,
    } as unknown as RuntimeEvent),
  } as ChatSessionsState;
}

const shape = (current: ChatSessionsState) =>
  (current.messages.s1 ?? []).map((row) => [
    row.id,
    row.blocks.map((block) => block.id.split(':').slice(1).join(':')),
  ]);

describe('a /compact’s rows (decision 180)', () => {
  const ids = compactRunRowIds('r1');
  const placeholders = [
    prompt,
    compactCommandRow('s1', ids.command, '/compact keep it'),
    compactRunningRow('s1', ids.status, DSH_COMPACTION_RUNNING_KEY),
  ];

  it('[180-S-1] started: the composer’s rows take the live ids in place', () => {
    const started = apply(state(placeholders), {
      messageId: 'dsh-compaction-k1',
      phase: 'started',
      trigger: 'manual',
      commandMessageId: 'dsh-compact-command-k1',
      command: '/compact keep it',
    });
    expect(shape(started)).toEqual([
      ['u1', ['t']],
      ['dsh-compact-command-k1', ['compact-command:0']],
      ['dsh-compaction-k1', ['compaction-running:0']],
    ]);
    // Another window's, or after a reload: both rows at the end.
    const elsewhere = apply(state([prompt]), {
      messageId: 'dsh-compaction-k1',
      phase: 'started',
      trigger: 'manual',
      commandMessageId: 'dsh-compact-command-k1',
      command: '/compact',
    });
    expect(shape(elsewhere).map(([id]) => id)).toEqual([
      'u1',
      'dsh-compact-command-k1',
      'dsh-compaction-k1',
    ]);
    // A late `started` never reopens a settled row.
    const settled = apply(started, {
      messageId: 'dsh-compaction-k1',
      phase: 'failed',
      trigger: 'manual',
      note: { key: DSH_COMPACT_CANCELLED_KEY },
    });
    expect(
      shape(apply(settled, { messageId: 'dsh-compaction-k1', phase: 'started', trigger: 'manual' }))
    ).toEqual(shape(settled));
  });

  it('[180-S-2] completed: the summary, with its line; failed: the note, with its reason', () => {
    const started = apply(state(placeholders), {
      messageId: 'dsh-compaction-k1',
      phase: 'started',
      trigger: 'manual',
      commandMessageId: 'dsh-compact-command-k1',
    });
    const completed = apply(started, {
      messageId: 'dsh-compaction-k1',
      phase: 'completed',
      trigger: 'manual',
      summary: 'Context summary\n\n- x',
      instructions: 'keep it',
    });
    expect(shape(completed).at(-1)).toEqual([
      'dsh-compaction-k1',
      ['summary:0', 'compact-instructions:0'],
    ]);
    const failed = apply(started, {
      messageId: 'dsh-compaction-k1',
      phase: 'failed',
      trigger: 'manual',
      note: {
        key: 'The compaction did not succeed, and nothing was compacted: {{reason}}',
        params: { reason: 'x' },
      },
    });
    expect(failed.messages.s1?.at(-1)?.blocks[0]).toMatchObject({
      text: 'The compaction did not succeed, and nothing was compacted: x',
      notice: { params: { reason: 'x' } },
    });
  });

  it('[180-S-3] a turn’s end settles an automatic row, never a /compact’s', () => {
    const rows = [
      prompt,
      compactCommandRow('s1', 'dsh-compact-command-k1', '/compact'),
      compactRunningRow('s1', 'dsh-compaction-k1', DSH_COMPACTION_RUNNING_KEY),
      compactRunningRow('s1', 'dsh-compaction-auto', DSH_COMPACTION_RUNNING_KEY),
    ];
    const bucket = rows;
    expect(isManualCompactionRow(bucket, rows[2] as ChatMessage)).toBe(true);
    expect(isManualCompactionRow(bucket, rows[3] as ChatMessage)).toBe(false);
    const ended = apply(state(rows), { stopCause: 'forced' }, 'session.stopped');
    expect(shape(ended).slice(2)).toEqual([
      ['dsh-compaction-k1', ['compaction-running:0']],
      ['dsh-compaction-auto', ['compaction-failed:0']],
    ]);
  });

  it('[180-S-4] the composer’s settle: where the bridge has not settled it, by the ids it has', () => {
    // Its own rows, never named: the note goes in the running row.
    const noted = withCompactRunSettled(placeholders, 's1', 'r1', {
      kind: 'note',
      note: { key: DSH_COMPACT_CANCELLED_KEY },
    });
    expect(noted.at(-1)?.blocks[0]).toMatchObject({ notice: { key: DSH_COMPACT_CANCELLED_KEY } });
    // The bridge said it first: the composer leaves it.
    const bridged = [
      prompt,
      compactCommandRow('s1', 'dsh-compact-command-k1', '/compact'),
      {
        ...compactRunningRow('s1', 'dsh-compaction-k1', 'x'),
        blocks: [
          { id: 'dsh-compaction-k1:compaction-failed:0', type: 'text' as const, text: 'bridge' },
        ],
      },
    ];
    expect(
      withCompactRunSettled(bridged, 's1', 'r1', { kind: 'note', note: { key: 'composer' } })
    ).toEqual(bridged);
    // Nothing ran: only its own rows go.
    expect(withCompactRunSettled(placeholders, 's1', 'r1', { kind: 'remove' })).toEqual([prompt]);
    expect(withCompactRunSettled(bridged, 's1', 'r1', { kind: 'remove' })).toEqual(bridged);
    // The summary the answer carried: in the running row's place, the command
    // line named after its compaction.
    const summary: ChatMessage = {
      id: 'h:cp1',
      sessionId: 's1',
      role: 'system',
      liveMessageId: 'dsh-compaction-k1',
      blocks: [{ id: 'h:cp1:summary:0', type: 'text', text: 'Context summary' }],
    };
    expect(
      withCompactRunSettled(placeholders, 's1', 'r1', {
        kind: 'summary',
        summary,
        liveMessageId: 'dsh-compaction-k1',
      }).map((row) => row.id)
    ).toEqual(['u1', 'dsh-compact-command-k1', 'h:cp1']);
    // The bridge's live summary: replaced in place by the history's own row.
    const live = [
      prompt,
      compactCommandRow('s1', 'dsh-compact-command-k1', '/compact'),
      { ...summary, id: 'dsh-compaction-k1', liveMessageId: undefined },
      { id: 'later', sessionId: 's1', role: 'user' as const, blocks: [] },
    ];
    expect(
      withCompactRunSettled(live, 's1', 'r1', {
        kind: 'summary',
        summary,
        liveMessageId: 'dsh-compaction-k1',
      }).map((row) => row.id)
    ).toEqual(['u1', 'dsh-compact-command-k1', 'h:cp1', 'later']);
  });
});
