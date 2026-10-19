import { describe, expect, it } from 'vitest';
import { jobKindOf, TaskBoard } from '../taskBoard.ts';

// S-6 feedback 4: a delegated subagent and a background command showed only as text in
// the reply; the jobs window and the subagents window stayed empty on the SDK engine.
let clock = 1000;
const board = () => {
  clock = 1000;
  return new TaskBoard(() => clock);
};

describe('TaskBoard', () => {
  it('lists a background command as a bash job, and settles it from its notification', () => {
    const b = board();
    const started = b.ingestSystem({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bojk2g2dd',
      task_type: 'local_bash',
      description: 'Wait 30 seconds',
      tool_use_id: 'toolu_1',
    });
    expect(started).toEqual({ jobs: true, catalog: false, activity: [] });
    expect(b.jobs()).toEqual([
      {
        id: 'bojk2g2dd',
        kind: 'bash',
        label: 'Wait 30 seconds',
        status: 'running',
        startedAt: 1000,
      },
    ]);
    clock = 31_000;
    b.ingestSystem({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bojk2g2dd',
      status: 'completed',
      output_file: 'C:/tmp/claude/x/s/tasks/bojk2g2dd.output',
      summary: 'Background command "Wait 30 seconds" completed (exit code 0)',
    });
    expect(b.jobs()[0]).toMatchObject({ status: 'completed', finishedAt: 31_000 });
    expect(b.jobs()[0]?.detail).toContain('exit code 0');
    expect(b.outputFile('bojk2g2dd')).toBe('C:/tmp/claude/x/s/tasks/bojk2g2dd.output');
  });

  it('a background subagent is a job, a catalog entry and a lane', () => {
    const b = board();
    const change = b.ingestSystem({
      type: 'system',
      subtype: 'task_started',
      task_id: 'a1177cb24333f91f1',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'Test Explore agent',
      tool_use_id: 'toolu_agent',
      is_backgrounded: true,
    });
    expect(change.jobs).toBe(true);
    expect(change.catalog).toBe(true);
    expect(change.activity).toEqual([
      {
        kind: 'started',
        parentToolCallId: 'toolu_agent',
        agentId: 'a1177cb24333f91f1',
        agentType: 'Explore',
        description: 'Test Explore agent',
        taskType: 'local_agent',
      },
    ]);
    expect(b.jobs()[0]?.kind).toBe('subagent');
    expect(b.subagentCatalog()).toEqual([
      { id: 'a1177cb24333f91f1', createdAt: 1000, mode: 'one-shot', label: 'Test Explore agent' },
    ]);
    const progress = b.ingestSystem({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'a1177cb24333f91f1',
      description: 'Test Explore agent',
      last_tool_name: 'Grep',
      usage: { total_tokens: 1200, tool_uses: 2, duration_ms: 900 },
    });
    expect(progress.activity[0]).toMatchObject({
      kind: 'progress',
      lastToolName: 'Grep',
      usage: { totalTokens: 1200, toolUses: 2, durationMs: 900 },
    });
    clock = 5000;
    const done = b.ingestSystem({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a1177cb24333f91f1',
      status: 'completed',
      summary: 'Agent "Test Explore agent" finished',
      output_file: '/tmp/a.output',
    });
    expect(done.activity[0]).toMatchObject({ kind: 'status', status: 'completed', endedAt: 5000 });
  });

  it('a foreground subagent has a lane and a catalog entry but is not a background job', () => {
    const b = board();
    const change = b.ingestSystem({
      type: 'system',
      subtype: 'task_started',
      task_id: 'afg',
      task_type: 'local_agent',
      description: 'inline',
      tool_use_id: 'toolu_fg',
      is_backgrounded: false,
    });
    expect(change.jobs).toBe(false);
    expect(b.jobs()).toEqual([]);
    expect(b.subagentCatalog().map((e) => e.id)).toEqual(['afg']);
  });

  it('a foreground subagent moved to the background becomes a job (decision 203)', () => {
    const start = (b: TaskBoard) =>
      b.ingestSystem({
        type: 'system',
        subtype: 'task_started',
        task_id: 'afg',
        task_type: 'local_agent',
        description: 'inline',
        tool_use_id: 'toolu_fg',
        is_backgrounded: false,
      });
    // Its own patch says so.
    const patched = board();
    start(patched);
    const change = patched.ingestSystem({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'afg',
      patch: { is_backgrounded: true },
    });
    expect(change.jobs).toBe(true);
    expect(patched.jobs().map((job) => [job.id, job.kind, job.status])).toEqual([
      ['afg', 'subagent', 'running'],
    ]);
    // Or the live set lists it.
    const listed = board();
    start(listed);
    expect(
      listed.ingestSystem({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'afg', task_type: 'local_agent' }],
      }).jobs
    ).toBe(true);
    expect(listed.jobs().map((job) => job.id)).toEqual(['afg']);
    // Another patch changes nothing.
    expect(
      listed.ingestSystem({ type: 'system', subtype: 'task_updated', task_id: 'afg', patch: {} })
        .jobs
    ).toBe(false);
  });

  it('leaves ambient housekeeping out', () => {
    const b = board();
    const change = b.ingestSystem({
      type: 'system',
      subtype: 'task_started',
      task_id: 'w1',
      task_type: 'monitor',
      description: 'watch',
      ambient: true,
    });
    expect(change).toEqual({ jobs: false, catalog: false, activity: [] });
    expect(b.jobs()).toEqual([]);
  });

  it('a stop the user asked for shows as stopping, then as killed once the CLI says stopped', () => {
    const b = board();
    b.ingestSystem({
      type: 'system',
      subtype: 'task_started',
      task_id: 't',
      task_type: 'local_bash',
      description: 'sleep',
    });
    expect(b.markStopping('t')).toBe(true);
    expect(b.jobs()[0]?.status).toBe('stopping');
    expect(b.isRunning('t')).toBe(true);
    b.ingestSystem({
      type: 'system',
      subtype: 'task_notification',
      task_id: 't',
      status: 'stopped',
      summary: 'stopped',
    });
    expect(b.jobs()[0]?.status).toBe('killed');
    expect(b.isRunning('t')).toBe(false);
    expect(b.markStopping('t')).toBe(false);
  });

  it("maps a subagent's own thread to its lane: text, tool calls, failures", () => {
    const b = board();
    b.ingestSystem({
      type: 'system',
      subtype: 'task_started',
      task_id: 'a1',
      task_type: 'local_agent',
      description: 'look',
      tool_use_id: 'toolu_agent',
    });
    const said = b.ingestSubagentMessage({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent',
      uuid: 'm1',
      message: {
        content: [
          { type: 'text', text: 'Searching.' },
          {
            type: 'tool_use',
            id: 'toolu_g',
            name: 'Grep',
            input: { pattern: 'x', content: 'never shown' },
          },
        ],
      },
    });
    expect(said).toEqual([
      {
        parentToolCallId: 'toolu_agent',
        agentId: 'a1',
        kind: 'text',
        id: 'm1',
        text: 'Searching.',
      },
      {
        parentToolCallId: 'toolu_agent',
        agentId: 'a1',
        kind: 'tool.started',
        toolCallId: 'toolu_g',
        name: 'Grep',
        input: { pattern: 'x' },
      },
    ]);
    const result = b.ingestSubagentMessage({
      type: 'user',
      parent_tool_use_id: 'toolu_agent',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'toolu_g', is_error: true, content: 'boom' }],
      },
    });
    expect(result).toEqual([
      {
        parentToolCallId: 'toolu_agent',
        agentId: 'a1',
        kind: 'tool.completed',
        toolCallId: 'toolu_g',
        ok: false,
        errorText: 'boom',
      },
    ]);
  });

  it('the CLI going away settles whatever it was running', () => {
    const b = board();
    b.ingestSystem({
      type: 'system',
      subtype: 'task_started',
      task_id: 't',
      task_type: 'local_bash',
      description: 'sleep',
    });
    expect(b.settleAll()).toBe(true);
    expect(b.jobs()[0]?.status).toBe('killed');
    expect(b.settleAll()).toBe(false);
  });

  it('names job kinds as the jobs window knows them', () => {
    expect(jobKindOf('local_bash', false)).toBe('bash');
    expect(jobKindOf('local_agent', true)).toBe('subagent');
    expect(jobKindOf('local_workflow', false)).toBe('workflow');
    expect(jobKindOf('monitor', false)).toBe('monitor');
    expect(jobKindOf(undefined, false)).toBe('task');
  });
});
