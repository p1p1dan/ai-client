import { translate } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import type { SessionPanels } from '@/components/chat/sessionPanelsModel';
import type { SubagentLane } from '@/components/chat/subagentActivityModel';
import { deriveSubagentsCardView } from '../sessionRail/subagentsCardModel';

/** Decision 207 §8 item 3, §14 E: the session rail's 「子代理」 card. */

const SESSION = 's1';
const NOW = 100_000;

function lane(extra: Partial<SubagentLane> & { parentToolCallId: string }): SubagentLane {
  return {
    sessionId: SESSION,
    agentId: null,
    agentType: null,
    description: null,
    status: 'running',
    taskType: 'subagent',
    startedAt: 2_000,
    endedAt: null,
    rows: [],
    droppedRows: 0,
    progress: null,
    usage: null,
    report: null,
    pendingPermission: null,
    capped: false,
    ordinal: 0,
    ...extra,
  };
}

function panels(extra: Partial<SessionPanels> = {}): SessionPanels {
  return { live: true, seq: {}, ...extra };
}

describe('deriveSubagentsCardView', () => {
  it('no card while the session never started a subagent', () => {
    expect(deriveSubagentsCardView({ panels: panels(), lanes: [], now: NOW })).toBeNull();
    // A lane with no status yet has not started (the tasks pane's rule).
    expect(
      deriveSubagentsCardView({
        panels: panels(),
        lanes: [lane({ parentToolCallId: 'c1', status: null })],
        now: NOW,
      })
    ).toBeNull();
  });

  it('names a row by its description, then catalog label, type, id', () => {
    const view = deriveSubagentsCardView({
      panels: panels({
        subagentCatalog: [
          { id: 'kid-2', createdAt: 1, mode: 'continuable', label: 'From catalog' },
        ],
      }),
      lanes: [
        lane({ parentToolCallId: 'c1', agentId: 'kid-1', description: 'Research pay', ordinal: 0 }),
        lane({ parentToolCallId: 'c2', agentId: 'kid-2', agentType: 'explorer', ordinal: 1 }),
        lane({ parentToolCallId: 'c3', agentId: 'kid-3', agentType: 'explorer', ordinal: 2 }),
        lane({ parentToolCallId: 'c4', agentId: 'kid-4', ordinal: 3 }),
      ],
      now: NOW,
    });
    expect(view?.live.map((row) => row.name)).toEqual([
      'Research pay',
      'From catalog',
      'explorer',
      'kid-4',
    ]);
  });

  it('maps each lane status to the card status', () => {
    const view = deriveSubagentsCardView({
      panels: panels(),
      lanes: [
        lane({ parentToolCallId: 'run', ordinal: 0 }),
        lane({ parentToolCallId: 'wait', ordinal: 1, pendingPermission: { toolName: 'bash' } }),
        lane({ parentToolCallId: 'ok', status: 'completed', endedAt: 9_000 }),
        lane({ parentToolCallId: 'bad', status: 'failed', endedAt: 8_000 }),
        lane({ parentToolCallId: 'cut', status: 'truncated', endedAt: 7_000 }),
        lane({ parentToolCallId: 'stop', status: 'stopped', endedAt: 6_000 }),
        lane({ parentToolCallId: 'cancel', status: 'cancelled', endedAt: 5_000 }),
      ],
      now: NOW,
    });
    const status = Object.fromEntries(
      [...(view?.live ?? []), ...(view?.ended ?? [])].map((row) => [row.key, row.status])
    );
    expect(status).toEqual({
      'lane:run': 'running',
      'lane:wait': 'waiting',
      'lane:ok': 'completed',
      'lane:bad': 'failed',
      'lane:cut': 'failed',
      'lane:stop': 'interrupted',
      'lane:cancel': 'interrupted',
    });
  });

  it('second line: 「分叉」 or the type, then the model when known', () => {
    const view = deriveSubagentsCardView({
      panels: panels(),
      lanes: [
        lane({ parentToolCallId: 'c1', agentType: 'explorer', ordinal: 0 }),
        lane({ parentToolCallId: 'c2', taskType: 'subagent_fork', agentType: 'x', ordinal: 1 }),
        lane({
          parentToolCallId: 'c3',
          agentType: 'explorer',
          report: { resolvedModel: 'fake-1' },
          ordinal: 2,
        }),
        lane({ parentToolCallId: 'c4', ordinal: 3 }),
      ],
      now: NOW,
      t: (key, params) => translate('zh', key, params),
    });
    expect(view?.live.map((row) => row.kind)).toEqual([
      'explorer',
      '分叉',
      'explorer · fake-1',
      null,
    ]);
  });

  it('third line while running: the latest tool call and the live duration', () => {
    const view = deriveSubagentsCardView({
      panels: panels(),
      lanes: [
        lane({
          parentToolCallId: 'c1',
          ordinal: 0,
          rows: [
            { kind: 'tool', toolCallId: 't1', name: 'grep', input: { pattern: 'x' }, status: 'ok' },
            {
              kind: 'tool',
              toolCallId: 't2',
              name: 'read',
              input: { path: 'src/pay/charge.ts' },
              status: 'running',
            },
            { kind: 'text', id: 'x1', text: 'Looking at the charge path' },
          ],
        }),
        lane({
          parentToolCallId: 'c2',
          ordinal: 1,
          progress: { description: 'Reading the auth module', lastToolName: 'read' },
        }),
      ],
      now: NOW,
    });
    const [first, second] = view?.live ?? [];
    // A running call reads as its timeline row does (the progressive verb).
    expect(first?.detail).toMatch(/^Reading .*charge\.ts$/);
    expect(first?.duration).toBe('1:38');
    expect(second?.detail).toBe('Reading the auth module');
  });

  it('third line while waiting: the tool awaiting approval', () => {
    const view = deriveSubagentsCardView({
      panels: panels(),
      lanes: [lane({ parentToolCallId: 'c1', pendingPermission: { toolName: 'bash' } })],
      now: NOW,
      t: (key, params) => translate('zh', key, params),
    });
    expect(view?.live[0]?.detail).toMatch(/^等你确认：/);
    expect(view?.live[0]?.duration).toBe('1:38');
  });

  it('third line once ended: time, tokens, tool count; missing parts left out', () => {
    const view = deriveSubagentsCardView({
      panels: panels(),
      lanes: [
        lane({
          parentToolCallId: 'c1',
          status: 'completed',
          startedAt: 2_000,
          endedAt: 102_000,
          report: { totalTokens: 24_000, totalToolUseCount: 12 },
        }),
        lane({
          parentToolCallId: 'c2',
          status: 'failed',
          startedAt: null,
          endedAt: 50_000,
          usage: { toolUses: 1 },
        }),
      ],
      now: NOW,
    });
    const byKey = Object.fromEntries((view?.ended ?? []).map((row) => [row.key, row]));
    expect(byKey['lane:c1']).toMatchObject({
      detail: 'Took 1:40 · 24k tokens · 12 tool calls',
      duration: null,
    });
    expect(byKey['lane:c2']?.detail).toBe('1 tool call');
  });

  it('live oldest first, ended newest first; the header counts', () => {
    const view = deriveSubagentsCardView({
      panels: panels(),
      lanes: [
        lane({ parentToolCallId: 'b', ordinal: 2 }),
        lane({ parentToolCallId: 'a', ordinal: 1, pendingPermission: { toolName: 'bash' } }),
        lane({ parentToolCallId: 'c', ordinal: 3 }),
        lane({ parentToolCallId: 'old', status: 'completed', endedAt: 10_000 }),
        lane({ parentToolCallId: 'new', status: 'completed', endedAt: 20_000 }),
      ],
      now: NOW,
    });
    expect(view?.live.map((row) => row.key)).toEqual(['lane:a', 'lane:b', 'lane:c']);
    expect(view?.ended.map((row) => row.key)).toEqual(['lane:new', 'lane:old']);
    expect(view).toMatchObject({ running: 2, waiting: 1 });

    const allEnded = deriveSubagentsCardView({
      panels: panels(),
      lanes: [lane({ parentToolCallId: 'x', status: 'completed', endedAt: 1 })],
      now: NOW,
    });
    expect(allEnded).toMatchObject({ running: 0, waiting: 0, live: [] });
    expect(allEnded?.ended).toHaveLength(1);
  });

  it('actions: a conversation for any child with an id; interrupt only a running continuable one on a live worker', () => {
    const catalog = [
      { id: 'kid-1', createdAt: 1, mode: 'continuable' as const },
      { id: 'kid-2', createdAt: 1, mode: 'continuable' as const },
    ];
    const lanes = [
      lane({ parentToolCallId: 'c1', agentId: 'kid-1', ordinal: 0 }),
      lane({ parentToolCallId: 'c2', agentId: 'kid-2', status: 'completed', endedAt: 9_000 }),
      lane({ parentToolCallId: 'c3', ordinal: 1 }),
    ];
    const view = deriveSubagentsCardView({
      panels: panels({ subagentCatalog: catalog }),
      lanes,
      now: NOW,
    });
    const byKey = Object.fromEntries(
      [...(view?.live ?? []), ...(view?.ended ?? [])].map((row) => [row.key, row])
    );
    expect(byKey['lane:c1']).toMatchObject({
      conversation: true,
      interrupt: { type: 'interrupt', childId: 'kid-1' },
    });
    expect(byKey['lane:c2']).toMatchObject({ conversation: true, interrupt: null });
    expect(byKey['lane:c3']).toMatchObject({ conversation: false, interrupt: null });

    // The worker is gone: nothing to interrupt.
    const dead = deriveSubagentsCardView({
      panels: panels({ live: false, subagentCatalog: catalog }),
      lanes,
      now: NOW,
    });
    expect(dead?.live[0]?.interrupt).toBeNull();
  });
});
