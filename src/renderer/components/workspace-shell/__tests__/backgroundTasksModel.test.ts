import type { DshJobSummary } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { SessionPanels } from '@/components/chat/sessionPanelsModel';
import type { SubagentLane } from '@/components/chat/subagentActivityModel';
import { deriveBackgroundTasksView, laneHideKey } from '../panes/backgroundTasksModel';

/** Layout 5d: the background-tasks pane's rows. */

const SESSION = 's1';
const NOW = 100_000;

function job(extra: Partial<DshJobSummary> & { id: string }): DshJobSummary {
  return { kind: 'bash', label: 'npm run dev', status: 'running', startedAt: 1_000, ...extra };
}

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

describe('deriveBackgroundTasksView (layout 5d)', () => {
  it('splits running from finished: running oldest first, finished newest first', () => {
    const view = deriveBackgroundTasksView({
      panels: panels({
        jobs: [
          job({ id: 'bash-2', startedAt: 5_000 }),
          job({ id: 'bash-1', startedAt: 1_000 }),
          job({ id: 'bash-3', status: 'completed', finishedAt: 9_000 }),
          job({ id: 'bash-4', status: 'failed', finishedAt: 20_000 }),
        ],
      }),
      lanes: [
        lane({ parentToolCallId: 'c1', agentId: 'kid-1', startedAt: 3_000 }),
        lane({ parentToolCallId: 'c2', status: 'completed', endedAt: 15_000 }),
        // Not started yet: no row.
        lane({ parentToolCallId: 'c3', status: null }),
      ],
      hidden: [],
      now: NOW,
    });
    expect(view.running.map((row) => row.key)).toEqual(['job:bash-1', 'lane:c1', 'job:bash-2']);
    expect(view.finished.map((row) => row.key)).toEqual(['job:bash-4', 'lane:c2', 'job:bash-3']);
    expect(view.finishedCount).toBe(3);
    expect(view.running[0]).toMatchObject({ running: true, status: 'running', duration: '1:39' });
    expect(view.finished[0]).toMatchObject({ running: false, status: 'failed' });
  });

  it('a subagent row names its model and tokens on the second line', () => {
    const view = deriveBackgroundTasksView({
      panels: panels(),
      lanes: [
        lane({
          parentToolCallId: 'c1',
          agentId: 'kid-1',
          description: 'Research the API',
          report: { resolvedModel: 'Opus 5.5', totalTokens: 161_200 },
          status: 'completed',
          endedAt: 9_000,
        }),
        lane({ parentToolCallId: 'c2', usage: { totalTokens: 0 } }),
      ],
      hidden: [],
      now: NOW,
    });
    expect(view.finished[0]).toMatchObject({
      kind: 'subagent',
      title: 'Research the API',
      meta: { model: 'Opus 5.5', tokens: '161k' },
      duration: '0:07',
      children: [],
    });
    expect(view.running[0]?.meta).toBeNull();
  });

  it('maps stop and open: jobs stop and show output, subagents interrupt or stop and show their conversation', () => {
    const view = deriveBackgroundTasksView({
      panels: panels({
        jobs: [
          job({ id: 'bash-1' }),
          job({ id: 'workflow-1', kind: 'workflow', label: 'Release' }),
          job({ id: 'subagent-1', kind: 'subagent', label: 'One-shot' }),
        ],
        formerJobs: [{ ...job({ id: 'bash-9', status: 'completed', finishedAt: 50 }), epoch: 0 }],
        workerEpoch: 1,
        subagentCatalog: [{ id: 'kid-1', createdAt: 1, mode: 'continuable', label: 'Probe' }],
      }),
      lanes: [
        lane({ parentToolCallId: 'c1', agentId: 'kid-1' }),
        // The SDK names a background subagent's lane and job by the same id.
        lane({ parentToolCallId: 'c2', agentId: 'subagent-1', description: 'One-shot' }),
      ],
      hidden: [],
      now: NOW,
    });
    const byKey = Object.fromEntries(
      [...view.running, ...view.finished].map((row) => [row.key, row])
    );
    // The subagent job is listed once, as its lane.
    expect(byKey['job:subagent-1']).toBeUndefined();
    expect(byKey['job:bash-1']).toMatchObject({
      stop: { type: 'stop', jobId: 'bash-1' },
      open: { type: 'output', jobId: 'bash-1', stages: false },
    });
    expect(byKey['job:workflow-1']?.open).toEqual({
      type: 'output',
      jobId: 'workflow-1',
      stages: true,
    });
    expect(byKey['lane:c1']).toMatchObject({
      title: 'Probe',
      stop: { type: 'interrupt', childId: 'kid-1' },
      open: { type: 'conversation', childId: 'kid-1' },
    });
    expect(byKey['lane:c2']?.stop).toEqual({ type: 'stop', jobId: 'subagent-1' });
    // A former worker's job: nothing to stop, no output left to read.
    expect(byKey['job:former:0:bash-9']).toMatchObject({ stop: null, open: null, running: false });
  });

  it('hidden rows stay away and 「清除已完成」 names every finished row', () => {
    const input = {
      panels: panels({
        jobs: [
          job({ id: 'bash-1', status: 'completed', finishedAt: 2_000 }),
          job({ id: 'bash-2', status: 'killed', finishedAt: 3_000 }),
          job({ id: 'bash-3' }),
        ],
      }),
      lanes: [
        lane({ parentToolCallId: 'c1', status: 'stopped', endedAt: 4_000 }),
        lane({ parentToolCallId: 'c2' }),
      ],
      now: NOW,
    };
    const view = deriveBackgroundTasksView({ ...input, hidden: [] });
    expect(view.clearableHideKeys.sort()).toEqual(['bash-1', 'bash-2', 'lane:c1']);
    expect(view.running.every((row) => row.hideKey === undefined)).toBe(true);

    const cleared = deriveBackgroundTasksView({ ...input, hidden: view.clearableHideKeys });
    expect(cleared.finished).toEqual([]);
    expect(cleared.clearableHideKeys).toEqual([]);
    expect(cleared.running.map((row) => row.key)).toEqual(['job:bash-3', 'lane:c2']);
    expect(laneHideKey(lane({ parentToolCallId: 'c9' }))).toBe('lane:c9');
  });

  it('a session with nothing has nothing', () => {
    expect(
      deriveBackgroundTasksView({ panels: undefined, lanes: [], hidden: [], now: NOW })
    ).toEqual({ running: [], finished: [], finishedCount: 0, clearableHideKeys: [] });
  });
});
