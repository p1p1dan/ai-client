import type { DshJobSummary } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { SessionPanels } from '../sessionPanelsModel';
import type { SubagentLane } from '../subagentActivityModel';
import {
  clampSubwindowPosition,
  deriveJobsWindowView,
  deriveStoppableSubagentRows,
  deriveSubagentsWindowView,
  formatElapsed,
  formatTokens,
  SUBWINDOW_MAX_HEIGHT_PX,
  SUBWINDOW_MIN_HEIGHT_PX,
  stoppableRowFor,
  subwindowMaxHeight,
} from '../subwindowsModel';

/**
 * dsh-rebase P1-7b (decisions 069, 109, 119; prototype scenes C–E): the pure
 * half of the background jobs and subagents windows.
 */

const SESSION = 's1';

function jobSummary(extra: Partial<DshJobSummary> & { id: string }): DshJobSummary {
  return {
    kind: 'bash',
    label: 'npm run dev',
    status: 'running',
    startedAt: 1_000,
    ...extra,
  };
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

describe('deriveJobsWindowView — the background jobs window (prototype scene C)', () => {
  it('[P7B-JW-ROWS] commands, a promoted one, a failed one and a workflow; subagents live in the subagents window', () => {
    const input = {
      panels: panels({
        jobs: [
          jobSummary({ id: 'bash-2' }),
          jobSummary({ id: 'bash-6', label: 'npm run build', promoted: true }),
          jobSummary({
            id: 'bash-4',
            label: 'npm run lint',
            status: 'failed',
            detail: 'exit code: 1',
            finishedAt: 1_018,
          }),
          jobSummary({ id: 'subagent-1', kind: 'subagent', label: 'Research' }),
          jobSummary({ id: 'workflow-1', kind: 'workflow', label: 'Release checks' }),
        ],
        subagentCatalog: [
          { id: 'kid-1', createdAt: 1, mode: 'continuable', label: 'Probe' },
          { id: 'kid-2', createdAt: 2, mode: 'one-shot', label: 'Fork' },
        ],
      }),
      lanes: [
        lane({ parentToolCallId: 'call-1', agentId: 'kid-1', description: 'Probe' }),
        // A running one-shot child is its own call's (foreground) or a job: not listed twice.
        lane({ parentToolCallId: 'call-2', agentId: 'kid-2', description: 'Fork' }),
      ],
      hidden: [],
    };
    const view = deriveJobsWindowView(input);
    expect(
      view.rows.map((row) => [row.key, row.kind, row.status, row.stop, row.expand, row.removable])
    ).toEqual([
      ['bash-2', 'command', 'running', 'stop', 'output', false],
      ['bash-6', 'command', 'running', 'stop', 'output', false],
      ['bash-4', 'command', 'failed', null, 'output', true],
      ['workflow-1', 'workflow', 'running', 'stop', 'stages', false],
    ]);
    expect(view.rows[1]?.promoted).toBe(true);
    expect(view.rows[2]?.exitCode).toBe(1);
    expect(view).toMatchObject({ running: 3, ended: 1, canStopAll: true });
    // User, 2026-10-19: the background subagent and the running continuable
    // child are stopped from the subagents window instead.
    const stoppable = deriveStoppableSubagentRows(input);
    expect(stoppable.map((row) => [row.key, row.stop])).toEqual([
      ['subagent-1', 'stop'],
      ['subagent:kid-1', 'interrupt'],
    ]);
    expect(stoppable[1]).toMatchObject({ childId: 'kid-1', label: 'Probe', startedAt: 2_000 });
    // The SDK names a background subagent's lane and job by the same task id.
    expect(stoppableRowFor(stoppable, 'subagent-1')?.jobId).toBe('subagent-1');
    expect(stoppableRowFor(stoppable, 'kid-1')?.key).toBe('subagent:kid-1');
    expect(stoppableRowFor(stoppable, null)).toBeUndefined();
  });

  it('[P7B-JW-LOST] a session with no live worker: running items read as ended with the engine, nothing to stop', () => {
    const view = deriveJobsWindowView({
      panels: panels({ live: false, jobs: [jobSummary({ id: 'bash-2' })] }),
      lanes: [],
      hidden: [],
    });
    expect(view.rows[0]).toMatchObject({ status: 'lost', stop: null, removable: true });
    expect(view).toMatchObject({ running: 0, ended: 1, canStopAll: false });
  });

  it('[P7B-JW-HIDE] a put-away job is gone from this window; one stoppable row offers no 「全部停止」', () => {
    const view = deriveJobsWindowView({
      panels: panels({
        jobs: [
          jobSummary({ id: 'bash-1', status: 'completed', finishedAt: 2 }),
          jobSummary({ id: 'bash-2' }),
        ],
      }),
      lanes: [],
      hidden: ['bash-1'],
    });
    expect(view.rows.map((row) => row.key)).toEqual(['bash-2']);
    expect(view.canStopAll).toBe(false);
    expect(deriveJobsWindowView({ panels: undefined, lanes: [], hidden: [] })).toEqual({
      rows: [],
      running: 0,
      ended: 0,
      canStopAll: false,
    });
  });

  it('[P7E-JW-FORMER] rows of a worker that went away stay after the next worker’s list, first, until removed (P1-7e problem 17)', () => {
    const next = panels({
      workerEpoch: 1,
      formerJobs: [
        { ...jobSummary({ id: 'bash-2' }), epoch: 0 },
        { ...jobSummary({ id: 'bash-4', status: 'killed', finishedAt: 5 }), epoch: 0 },
      ],
      // The new worker numbers its own jobs again.
      jobs: [jobSummary({ id: 'bash-2', label: 'npm test' })],
    });
    const view = deriveJobsWindowView({ panels: next, lanes: [], hidden: [] });
    expect(
      view.rows.map((row) => [
        row.key,
        row.status,
        row.stop,
        row.removable,
        row.hideKey,
        row.former,
      ])
    ).toEqual([
      ['former:0:bash-2', 'lost', null, true, 'bash-2', true],
      ['former:0:bash-4', 'killed', null, true, 'bash-4', true],
      ['bash-2', 'running', 'stop', false, '1:bash-2', undefined],
    ]);
    expect(view).toMatchObject({ running: 1, ended: 2, canStopAll: false });
    // Removing the former bash-2 hides it and not the new worker's bash-2, and back.
    const hiddenFormer = deriveJobsWindowView({ panels: next, lanes: [], hidden: ['bash-2'] });
    expect(hiddenFormer.rows.map((row) => row.key)).toEqual(['former:0:bash-4', 'bash-2']);
    const hiddenCurrent = deriveJobsWindowView({ panels: next, lanes: [], hidden: ['1:bash-2'] });
    expect(hiddenCurrent.rows.map((row) => row.key)).toEqual([
      'former:0:bash-2',
      'former:0:bash-4',
    ]);
  });
});

describe('deriveSubagentsWindowView — the subagents window (prototype scene D)', () => {
  it('[P7B-SW-ROWS] only running children, named by their tool (decision 090); ended and never-seen ones are left out (2026-10-19)', () => {
    const view = deriveSubagentsWindowView({
      panels: panels({
        subagentCatalog: [
          { id: 'kid-1', createdAt: 1, mode: 'continuable', label: 'Probe' },
          { id: 'kid-2', createdAt: 2, mode: 'one-shot', label: 'Review' },
          { id: 'kid-9', createdAt: 3, mode: 'continuable', label: 'From before' },
        ],
      }),
      lanes: [
        lane({
          parentToolCallId: 'call-2',
          agentId: 'kid-2',
          description: 'Review',
          taskType: 'subagent_fork',
          status: 'completed',
          endedAt: 50_000,
          ordinal: 1,
          usage: { totalTokens: 12_000, toolUses: 5 },
        }),
        lane({
          parentToolCallId: 'call-1',
          agentId: 'kid-1',
          description: 'Probe',
          ordinal: 0,
          usage: { totalTokens: 45_000, toolUses: 12 },
        }),
      ],
    });
    expect(view.rows.map((row) => [row.name, row.description, row.status])).toEqual([
      ['subagent', 'Probe', 'running'],
    ]);
    expect(view.rows[0]).toMatchObject({
      interruptible: true,
      locatable: true,
      parentToolCallId: 'call-1',
      tokens: 45_000,
      toolUses: 12,
      endedAt: null,
    });
    expect(view.running).toBe(1);
  });

  it('[P7B-SW-ENDED] a child that ended leaves the list; no live worker, no interrupt', () => {
    const view = deriveSubagentsWindowView({
      panels: panels({
        live: false,
        subagentCatalog: [{ id: 'kid-1', createdAt: 1, mode: 'continuable' }],
      }),
      lanes: [
        lane({
          parentToolCallId: 'call-1',
          agentId: 'kid-1',
          status: 'failed',
          report: { status: 'failed', stopReason: 'refusal' },
        }),
        lane({ parentToolCallId: 'call-2', agentId: 'kid-1', status: 'running', ordinal: 1 }),
      ],
    });
    expect(view.rows.map((row) => row.parentToolCallId)).toEqual(['call-2']);
    expect(view.rows[0]?.interruptible).toBe(false);
  });
});

describe('the windows’ small formats and geometry', () => {
  it('formats elapsed time and token counts as the prototype does', () => {
    expect(formatElapsed(0, 151_000)).toBe('2:31');
    expect(formatElapsed(0, 3_723_000)).toBe('1:02:03');
    expect(formatElapsed(null, 5)).toBeNull();
    expect(formatElapsed(10, 5)).toBeNull();
    expect(formatTokens(45_000)).toBe('45k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(999)).toBe('999');
  });

  it('[P7B-GEOMETRY] two open windows share the room, each within the prototype’s bounds', () => {
    expect(subwindowMaxHeight(600, 1)).toBe(SUBWINDOW_MAX_HEIGHT_PX);
    expect(subwindowMaxHeight(600, 2)).toBe(296);
    expect(subwindowMaxHeight(100, 2)).toBe(SUBWINDOW_MIN_HEIGHT_PX);
    expect(
      clampSubwindowPosition(
        { left: -20, top: 900 },
        { width: 340, height: 300 },
        { width: 700, height: 500 }
      )
    ).toEqual({ left: 0, top: 460 });
    expect(
      clampSubwindowPosition(
        { left: 600, top: 10 },
        { width: 340, height: 300 },
        { width: 700, height: 500 }
      )
    ).toEqual({ left: 360, top: 10 });
  });
});
