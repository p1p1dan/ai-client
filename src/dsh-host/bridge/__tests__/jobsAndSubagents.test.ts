import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DshJobSummary,
  SubagentActivityPayload,
} from '../../../shared/types/runtimeEvents.ts';
import { WORKER_JOB_UNKNOWN, WORKER_JOBS_UNAVAILABLE } from '../../../shared/types/workerRpc.ts';
import {
  type DshJobChunk,
  type DshJobEvent,
  DshJobsTracker,
  type DshJobView,
  JOBS_PROJECTION_INTERVAL_MS,
  JOBS_SETTLED_KEPT,
  ringText,
  TOOL_OUTPUT_INTERVAL_MS,
} from '../jobs.ts';
import {
  childToolInput,
  clampText,
  DshSubagentsTracker,
  laneStatusOf,
  SUBAGENT_INPUT_FIELD_CHARS,
} from '../subagents.ts';

/**
 * dsh-rebase P1-7b (decisions 069, 072 rules 5-7, 099 rule 15, 119) — the
 * bridge's jobs and subagents modules against fake DSH services: the `jobs`
 * projection and its throttle, which job a foreground call runs as, the live
 * tail (`tool.output`), `worker.job.read` / `kill`, Stop's reach (069), and
 * the child sessions' lanes (`subagent.activity`): pairing, held activity,
 * resumption, stop reasons. The real engine runs under tools/bridge-record.ts
 * (`jobs-kill`, `sub-cont`) and tools/bridge-smoke.ts.
 */

const OWNER = 'aiclient-session-1';

/** The code of what `run` throws. */
function thrownCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error('expected a throw');
}

// ---- a fake dsh-jobs registry ----------------------------------------------------------

interface FakeJob {
  id: string;
  kind: string;
  label: string;
  owner?: string;
  status: string;
  progress?: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  chunks: DshJobChunk[];
  earliest: number;
}

function fakeRegistry() {
  const jobs = new Map<string, FakeJob>();
  let listener: ((event: DshJobEvent) => void) | undefined;
  let minted = 0;
  const view = (job: FakeJob): DshJobView => {
    const last = job.chunks.at(-1);
    const total = last ? last.at + Buffer.byteLength(last.text, 'utf8') : 0;
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...(job.owner ? { owner: job.owner } : {}),
      status: job.status,
      ...(job.progress ? { progress: job.progress } : {}),
      ...(job.detail ? { detail: job.detail } : {}),
      startedAt: job.startedAt,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      output: { total, earliest: job.earliest },
    };
  };
  const own = (id: string, caller?: string) => {
    const job = jobs.get(id);
    if (!job || job.owner !== caller) throw new Error(`unknown job ${id}`);
    return job;
  };
  const registry = {
    events: {
      subscribe: vi.fn((_filter: { owner: string }, next: (event: DshJobEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
    },
    list: vi.fn((caller?: string) =>
      [...jobs.values()].filter((job) => job.owner === caller || !job.owner).map(view)
    ),
    get: vi.fn((id: string, caller?: string) => view(own(id, caller))),
    readAt: vi.fn((id: string, from: number, caller?: string) => {
      const job = own(id, caller);
      const total = view(job).output?.total ?? 0;
      return {
        chunks: job.chunks.filter((chunk) => chunk.at + Buffer.byteLength(chunk.text) > from),
        next: total,
        lossy: from < job.earliest,
      };
    }),
    kill: vi.fn((id: string, caller?: string, _reason?: string) => {
      const job = own(id, caller);
      return job.status === 'running' ? ('requested' as const) : ('already-finished' as const);
    }),
  };
  return {
    registry,
    /** Registers a job and announces it, as `JobRegistry.start` does, synchronously. */
    start(kind: string, label: string, owner = OWNER, at = 1_000): string {
      minted += 1;
      const id = `${kind}-${minted}`;
      const job: FakeJob = {
        id,
        kind,
        label,
        owner,
        status: 'running',
        startedAt: at,
        chunks: [],
        earliest: 0,
      };
      jobs.set(id, job);
      listener?.({ type: 'registered', job: view(job) });
      return id;
    },
    append(id: string, text: string) {
      const job = jobs.get(id) as FakeJob;
      const total = view(job).output?.total ?? 0;
      job.chunks.push({ at: total, text });
      listener?.({ type: 'output', id, owner: job.owner, total: total + Buffer.byteLength(text) });
    },
    settle(id: string, status: string, detail?: string, at = 2_000) {
      const job = jobs.get(id) as FakeJob;
      job.status = status;
      job.finishedAt = at;
      if (detail) job.detail = detail;
      listener?.({ type: 'settled', job: view(job), cause: 'producer' });
    },
    remove(id: string) {
      const job = jobs.get(id) as FakeJob;
      jobs.delete(id);
      listener?.({ type: 'removed', job: view(job) });
    },
    fire(event: DshJobEvent) {
      listener?.(event);
    },
    jobs,
  };
}

function tracker(
  registry: ReturnType<typeof fakeRegistry>['registry'] | undefined,
  clock = { now: 10_000 }
) {
  const projected: DshJobSummary[][] = [];
  const outputs: Array<{
    toolCallId: string;
    jobId: string;
    tail: string;
    omittedBytes: number;
    totalBytes: number;
  }> = [];
  const jobs = new DshJobsTracker({
    owner: () => OWNER,
    registry: () => registry,
    projectJobs: (list) => projected.push(list),
    emitOutput: (output) => outputs.push(output),
    now: () => clock.now,
  });
  jobs.follow();
  return { jobs, projected, outputs, clock };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DshJobsTracker — the jobs projection (P1-7b, decisions 072 rule 1, 119)', () => {
  it('[P7B-JOBS-BG] lists a background command at once, and its settlement a window later', () => {
    const fake = fakeRegistry();
    const { projected, clock } = tracker(fake.registry);
    // A background call is not waited on: its job is listed from the start.
    const id = fake.start('bash', 'npm run dev');
    expect(projected).toEqual([
      [{ id, kind: 'bash', label: 'npm run dev', status: 'running', startedAt: 1_000 }],
    ]);
    // Inside the window: held, then sent once with whatever is current.
    clock.now += 100;
    fake.fire({ type: 'progress', job: { ...fake.registry.get(id, OWNER), progress: 'x' } });
    fake.settle(id, 'completed', 'exit code: 0');
    expect(projected).toHaveLength(1);
    clock.now += JOBS_PROJECTION_INTERVAL_MS;
    vi.advanceTimersByTime(JOBS_PROJECTION_INTERVAL_MS);
    expect(projected).toHaveLength(2);
    expect(projected[1]).toEqual([
      {
        id,
        kind: 'bash',
        label: 'npm run dev',
        status: 'completed',
        detail: 'exit code: 0',
        startedAt: 1_000,
        finishedAt: 2_000,
      },
    ]);
  });

  it('[P7B-JOBS-OWNER] hears only its own session’s jobs; an unchanged list goes out once', () => {
    const fake = fakeRegistry();
    const { projected, clock } = tracker(fake.registry);
    fake.start('bash', 'other', 'aiclient-other');
    expect(projected).toEqual([]);
    fake.start('bash', 'mine');
    clock.now += JOBS_PROJECTION_INTERVAL_MS * 2;
    fake.fire({ type: 'stopping', job: fake.registry.get('bash-2', OWNER) });
    // `stopping` with the status unchanged in the fake: the same list, not sent again.
    expect(projected).toHaveLength(1);
  });

  it(`[P7B-JOBS-KEEP] keeps the newest ${JOBS_SETTLED_KEPT} settled jobs`, () => {
    const fake = fakeRegistry();
    const { jobs } = tracker(fake.registry);
    for (let index = 0; index < JOBS_SETTLED_KEPT + 3; index += 1) {
      const id = fake.start('bash', `job ${index}`);
      fake.settle(id, 'completed', undefined, 2_000 + index);
    }
    const running = fake.start('bash', 'still running');
    const current = jobs.current();
    expect(current).toHaveLength(JOBS_SETTLED_KEPT + 1);
    expect(current.map((job) => job.label)).not.toContain('job 0');
    expect(current.at(-1)?.id).toBe(running);
  });
});

describe('DshJobsTracker — a foreground command and its live output (P1-7b, decisions 072 rule 5, 099 rule 15)', () => {
  it('[P7B-FG-ATTACH] the job a shell call registers inside `tools/execute` is that call’s: not listed, its output on the row', () => {
    const fake = fakeRegistry();
    const { jobs, projected, outputs, clock } = tracker(fake.registry);
    jobs.beginCall('call-1', 'bash', { command: 'npm test', description: 'Run tests' });
    const id = fake.start('bash', 'npm test');
    expect(projected).toEqual([]);
    expect(jobs.current()).toEqual([]);

    fake.append(id, 'line 1\n');
    expect(outputs).toEqual([
      { toolCallId: 'call-1', jobId: id, tail: 'line 1\n', omittedBytes: 0, totalBytes: 7 },
    ]);
    // Throttled: the next ones within the window become one, the newest tail.
    clock.now += 50;
    fake.append(id, 'line 2\n');
    fake.append(id, 'line 3\n');
    expect(outputs).toHaveLength(1);
    clock.now += TOOL_OUTPUT_INTERVAL_MS;
    vi.advanceTimersByTime(TOOL_OUTPUT_INTERVAL_MS);
    expect(outputs).toHaveLength(2);
    expect(outputs[1]?.tail).toBe('line 1\nline 2\nline 3\n');

    // The call collects its job: DSH removes it; nothing was ever listed.
    fake.settle(id, 'completed', 'exit code: 0');
    fake.remove(id);
    jobs.endCall('call-1', { kind: 'foreground', exitCode: 0 });
    clock.now += JOBS_PROJECTION_INTERVAL_MS;
    vi.advanceTimersByTime(JOBS_PROJECTION_INTERVAL_MS);
    expect(projected).toEqual([]);
  });

  it('[P7B-FG-PROMOTE] a command its timeout moved to the background is listed, marked promoted', () => {
    const fake = fakeRegistry();
    const { jobs, projected, outputs } = tracker(fake.registry);
    jobs.beginCall('call-1', 'bash', { command: 'npm run build', description: 'Build' });
    const id = fake.start('bash', 'npm run build');
    jobs.endCall('call-1', { kind: 'promoted', jobId: id, timeoutMs: 120_000, output: '' });
    expect(projected).toEqual([
      [
        {
          id,
          kind: 'bash',
          label: 'npm run build',
          status: 'running',
          startedAt: 1_000,
          promoted: true,
        },
      ],
    ]);
    // Its output no longer goes to the row that returned.
    fake.append(id, 'more\n');
    expect(outputs).toEqual([]);
  });

  it('[P7B-FG-BG-ARG] a call asking for the background is not waited on; a pwsh call matches pwsh jobs only', () => {
    const fake = fakeRegistry();
    const { jobs } = tracker(fake.registry);
    jobs.beginCall('call-bg', 'bash', { command: 'sleep 5', run_in_background: true });
    fake.start('bash', 'sleep 5');
    jobs.beginCall('call-ps', 'pwsh', { command: 'Get-ChildItem' });
    fake.start('bash', 'Get-ChildItem');
    fake.start('pwsh', 'Get-ChildItem');
    expect(jobs.current().map((job) => `${job.kind}:${job.label}`)).toEqual([
      'bash:sleep 5',
      'bash:Get-ChildItem',
    ]);
  });
});

describe('DshJobsTracker — the window’s read and kill, and Stop (P1-7b, decisions 069, 119)', () => {
  it('[P7B-READ] the tail by default, then what came after `from`; never the model cursor', () => {
    const fake = fakeRegistry();
    const { jobs } = tracker(fake.registry);
    const id = fake.start('bash', 'npm run dev');
    fake.append(id, 'aaaa');
    fake.append(id, 'bbbb');
    fake.append(id, 'cccc');
    expect(jobs.read(id, undefined, 6)).toEqual({
      text: 'bbcccc',
      from: 6,
      next: 12,
      omittedBytes: 6,
      lossy: false,
    });
    fake.append(id, 'dd');
    expect(jobs.read(id, 12)).toEqual({
      text: 'dd',
      from: 12,
      next: 14,
      omittedBytes: 0,
      lossy: false,
    });
  });

  it('[P7B-READ-UTF8] a cut inside a character drops the character, never garbles it', () => {
    expect(ringText([{ at: 0, text: '你好ab' }], 1)).toEqual({ text: '好ab', at: 3 });
    expect(
      ringText(
        [
          { at: 0, text: 'xy' },
          { at: 2, text: 'z' },
        ],
        1
      )
    ).toEqual({ text: 'yz', at: 1 });
  });

  it('[P7B-KILL] DSH’s own kill with the session as caller; a job it does not know is refused', () => {
    const fake = fakeRegistry();
    const { jobs } = tracker(fake.registry);
    const id = fake.start('bash', 'npm run dev');
    expect(jobs.kill(id)).toEqual({ outcome: 'requested' });
    expect(fake.registry.kill).toHaveBeenCalledWith(id, OWNER, 'stopped by the user from the app');
    expect(thrownCode(() => jobs.kill('bash-99'))).toBe(WORKER_JOB_UNKNOWN);
    expect(thrownCode(() => jobs.read('bash-99', undefined))).toBe(WORKER_JOB_UNKNOWN);
  });

  it('[P7B-KILL-NONE] a host without a job registry says so', () => {
    const { jobs } = tracker(undefined);
    expect(thrownCode(() => jobs.kill('bash-1'))).toBe(WORKER_JOBS_UNAVAILABLE);
    expect(jobs.current()).toEqual([]);
  });

  it('[P7B-STOP-JOBS] Stop ends the running one-shot subagent jobs, never a command (069 rule 1)', () => {
    const fake = fakeRegistry();
    const { jobs } = tracker(fake.registry);
    const command = fake.start('bash', 'npm run dev');
    const child = fake.start('subagent', 'Research the API');
    const done = fake.start('subagent', 'Earlier');
    fake.settle(done, 'completed');
    expect(jobs.stopSubagentJobs('the user pressed Stop')).toEqual([child]);
    expect(fake.registry.kill).toHaveBeenCalledTimes(1);
    expect(fake.registry.kill).not.toHaveBeenCalledWith(
      command,
      expect.anything(),
      expect.anything()
    );
  });
});

// ---- subagents ---------------------------------------------------------------------------

function children(subagents?: { interrupt: ReturnType<typeof vi.fn> }) {
  const activity: SubagentActivityPayload[] = [];
  const tracker = new DshSubagentsTracker({
    owner: () => OWNER,
    subagents: () => subagents,
    emitActivity: (payload) => activity.push(payload),
    now: () => 5_000,
  });
  const catalog = (childId: string, label: string, mode = 'continuable', seq = 1) =>
    tracker.onParentEvent({ type: 'subagent/catalog', seq, data: { childId, label, mode } });
  const child = (childId: string, type: string, data: Record<string, unknown>, seq = 1) =>
    tracker.onChildEvent(childId, { type, seq, data });
  const kinds = () => activity.map((payload) => `${payload.kind}@${payload.parentToolCallId}`);
  return { tracker, activity, catalog, child, kinds };
}

describe('DshSubagentsTracker — lanes of the session’s children (P1-7b, decisions 072 rules 6-7, 119)', () => {
  it('[P7B-SUB-LANE] a continuable child: paired by its catalog entry, its run and rows on the call’s lane', () => {
    const h = children();
    h.tracker.beginCall('call-1', 'subagent', { description: 'Probe the API', prompt: 'go' });
    h.catalog('child-1', 'Probe the API');
    h.tracker.onRunStart({ runId: 'run-1', id: 'child-1' });
    h.child('child-1', 'tool/call', {
      callId: 'c-1',
      name: 'read',
      arguments: '{"file_path":"/a.ts"}',
    });
    h.child('child-1', 'tool/result', {
      message: { toolCallId: 'c-1', isError: false, content: [] },
    });
    h.child(
      'child-1',
      'assistant/message',
      {
        message: {
          content: [
            { type: 'reasoning', text: 'Look first.' },
            { type: 'text', text: 'Done reading.' },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      7
    );
    h.tracker.endCall('call-1', { kind: 'continuable', subagentId: 'child-1' });
    h.tracker.onRunEnd({ runId: 'run-1', id: 'child-1', stopReason: 'completed' });

    expect(h.kinds()).toEqual([
      'started@call-1',
      'status@call-1',
      'tool.started@call-1',
      'tool.completed@call-1',
      'thinking@call-1',
      'text@call-1',
      'progress@call-1',
      'status@call-1',
      'report@call-1',
    ]);
    expect(h.activity[0]).toEqual({
      parentToolCallId: 'call-1',
      agentId: 'child-1',
      kind: 'started',
      description: 'Probe the API',
      taskType: 'subagent',
    });
    expect(h.activity[2]).toMatchObject({
      kind: 'tool.started',
      name: 'read',
      input: { file_path: '/a.ts', path: '/a.ts' },
    });
    expect(h.activity[7]).toEqual({
      parentToolCallId: 'call-1',
      agentId: 'child-1',
      kind: 'status',
      status: 'completed',
      endedAt: 5_000,
      usage: { totalTokens: 120, toolUses: 1 },
    });
    expect(h.tracker.hasRunning()).toBe(false);
  });

  it('[P7B-SUB-HELD] activity before the pairing is held and sent once paired, in order', () => {
    const h = children();
    // The start and the first rows arrive before the catalog entry.
    h.tracker.onRunStart({ runId: 'run-1', id: 'child-1' });
    h.tracker.beginCall('call-1', 'subagent_fork', { description: 'Review' });
    h.catalog('child-1', 'Review', 'one-shot');
    h.child('child-1', 'tool/call', { callId: 'c-1', name: 'bash', arguments: { command: 'ls' } });
    expect(h.kinds()).toEqual(['started@call-1', 'status@call-1', 'tool.started@call-1']);
    expect(h.activity[0]).toMatchObject({ taskType: 'subagent_fork' });
  });

  it('[P7B-SUB-RESUME] a second run of a continuable child is `resumed` on the same lane', () => {
    const h = children();
    h.tracker.beginCall('call-1', 'subagent', { description: 'Probe' });
    h.catalog('child-1', 'Probe');
    h.tracker.endCall('call-1', { kind: 'continuable', subagentId: 'child-1' });
    h.tracker.onRunStart({ runId: 'run-1', id: 'child-1' });
    h.tracker.onRunEnd({ runId: 'run-1', id: 'child-1', stopReason: 'completed' });
    h.tracker.onRunStart({ runId: 'run-2', id: 'child-1' });
    expect(h.activity.at(-1)).toEqual({
      parentToolCallId: 'call-1',
      agentId: 'child-1',
      kind: 'resumed',
      at: 5_000,
    });
    expect(h.tracker.hasRunning()).toBe(true);
  });

  it('[P7B-SUB-STATUS] DSH’s stop reasons in the lane’s words; a refusal keeps its reason', () => {
    expect(
      ['completed', 'aborted', 'error', 'max-tokens', 'refusal', 'new'].map(laneStatusOf)
    ).toEqual(['completed', 'stopped', 'failed', 'truncated', 'failed', 'failed']);
    const h = children();
    h.tracker.beginCall('call-1', 'subagent', { description: 'Hard task' });
    h.catalog('child-1', 'Hard task');
    h.tracker.onRunStart({ runId: 'run-1', id: 'child-1' });
    h.tracker.onRunEnd({ runId: 'run-1', id: 'child-1', stopReason: 'refusal' });
    expect(h.activity.at(-1)).toMatchObject({
      kind: 'report',
      report: { status: 'failed', stopReason: 'refusal' },
    });
  });

  it('[P7B-SUB-BG] a one-shot background child established after its call returned still finds the call', () => {
    const h = children();
    h.tracker.beginCall('call-1', 'subagent_fork', { description: 'Later' });
    h.tracker.endCall('call-1', { kind: 'background', jobId: 'subagent-1' });
    h.catalog('child-1', 'Later', 'one-shot');
    expect(h.kinds()).toEqual(['started@call-1']);
  });

  it('[P7B-SUB-SAME-LABEL] two calls with one description pair in order; the result corrects a wrong guess', () => {
    const h = children();
    h.tracker.beginCall('call-1', 'subagent', { description: 'Same' });
    h.tracker.beginCall('call-2', 'subagent', { description: 'Same' });
    // DSH established call-2's child first: the label guess gives it to call-1.
    h.catalog('child-b', 'Same');
    h.catalog('child-a', 'Same', 'continuable', 2);
    // The results name the truth: each child moves to its own lane.
    h.tracker.endCall('call-2', { kind: 'continuable', subagentId: 'child-b' });
    h.tracker.endCall('call-1', { kind: 'continuable', subagentId: 'child-a' });
    h.child('child-a', 'tool/call', { callId: 'x', name: 'grep', arguments: {} });
    h.child('child-b', 'tool/call', { callId: 'y', name: 'grep', arguments: {} });
    expect(h.activity.slice(-2).map((payload) => payload.parentToolCallId)).toEqual([
      'call-1',
      'call-2',
    ]);
  });

  it('[P7B-SUB-OTHERS] another session’s children and a delegate’s own calls are not this session’s lanes', () => {
    const h = children();
    h.child('child-x', 'tool/call', { callId: 'x', name: 'grep', arguments: {} });
    h.tracker.onRunStart({ runId: 'run-x', id: 'child-x' });
    h.tracker.onRunEnd({ runId: 'run-x', id: 'child-x', stopReason: 'completed' });
    expect(h.activity).toEqual([]);
  });

  it('[P7B-SUB-INTERRUPT] interrupts as the human parent; Stop reaches only running continuable children (069)', () => {
    const interrupt = vi.fn();
    const h = children({ interrupt });
    h.tracker.beginCall('call-1', 'subagent', { description: 'A' });
    h.catalog('child-a', 'A');
    h.tracker.onRunStart({ runId: 'run-a', id: 'child-a' });
    h.tracker.beginCall('call-2', 'subagent_fork', { description: 'B' });
    h.catalog('child-b', 'B', 'one-shot', 2);
    h.tracker.onRunStart({ runId: 'run-b', id: 'child-b' });

    expect(h.tracker.interrupt('child-a')).toEqual({ interrupted: true });
    expect(interrupt).toHaveBeenCalledWith('child-a', { kind: 'user', parentSessionId: OWNER });
    interrupt.mockClear();
    expect(h.tracker.interruptAll()).toEqual(['child-a']);
    expect(interrupt).toHaveBeenCalledTimes(1);

    interrupt.mockImplementation(() => {
      throw new Error('belongs to another parent session');
    });
    expect(thrownCode(() => h.tracker.interrupt('child-z'))).toBe('WORKER_SUBAGENT_UNAUTHORIZED');
    expect(thrownCode(() => children().tracker.interrupt('child-a'))).toBe(WORKER_JOBS_UNAVAILABLE);
  });

  it('[P7B-SUB-INPUT] a child tool’s input: the fields its lane shows, each clamped', () => {
    const long = 'x'.repeat(SUBAGENT_INPUT_FIELD_CHARS + 50);
    expect(childToolInput('bash', { command: long, description: 'hidden' })).toEqual({
      command: clampText(long, SUBAGENT_INPUT_FIELD_CHARS),
    });
    expect(childToolInput('unknown_tool', { a: 1 })).toBeUndefined();
    expect(childToolInput('read', 'not json')).toBeUndefined();
    expect(clampText('😀😀', 2)).toBe('…');
  });
});
