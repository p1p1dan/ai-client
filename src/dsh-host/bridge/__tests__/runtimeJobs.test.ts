import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DshBridgeContext,
  type DshBridgeDeps,
  DshSessionRuntime,
  dshSessionIdFor,
} from '../dshSessionRuntime.ts';
import type { DshJobEvent, DshJobView } from '../jobs.ts';
import { testPermissionHost } from './permissionTestHost.ts';
import { TEST_PLAN } from './testPlan.ts';

/**
 * dsh-rebase P1-7b (decisions 069, 099 rule 15, 119) — the runtime's wiring
 * of the jobs and subagents modules against a fake Cordis context: the
 * `tools/execute` stamp, the `jobs` key in the baseline and `worker.panels`,
 * the three window RPCs, Stop's reach, `busy`, and a child's events on its
 * lane. The modules' own rules are `jobsAndSubagents.test.ts`'s.
 */

const CWD = '/repo';
const LOGICAL = 'session-1';
const DSH_ID = dshSessionIdFor(LOGICAL);

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-bridge-7b-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Emitted {
  type: string;
  requestId?: string;
  payload?: Record<string, unknown>;
}

function fakeHost() {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const agent = {
    id: DSH_ID,
    status: 'idle',
    session: { header: { cwd: CWD } },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    runMaintenance: vi.fn(),
  };
  const handle = { agent, dispose: async () => undefined };
  const services: Record<string, unknown> = {};
  let seq = 0;
  const event = (type: string, data: Record<string, unknown>) => {
    const next = { type, seq, time: 1_790_000_000_000 + seq, data };
    seq += 1;
    return next;
  };
  const ctx = {
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    agents: { create: vi.fn(async () => handle), resume: vi.fn(async () => handle) },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'aiclient-gateway', model: 'fake-1' }),
    },
    sessions: { flush: vi.fn(async () => true) },
    sessionQuery: {
      observeSession: vi.fn(async () => ({
        events: [],
        cursor: -1,
        [Symbol.dispose]: () => undefined,
      })),
    },
    aiclientPermissions: testPermissionHost().api,
    attachments: {
      admitPromptContent: vi.fn(async (parts: unknown[]) => parts),
      saveFile: vi.fn(),
      isAttachmentError: () => false,
    },
    get: (name: string) => services[name],
  } as unknown as DshBridgeContext;
  const fire = (name: string, ...args: unknown[]) => listeners.get(name)?.(...args);
  /** One durable event of `session` (this one by default). */
  const append = (type: string, data: Record<string, unknown>, session = DSH_ID) =>
    fire('session/event', { id: session }, event(type, data));
  return { ctx, agent, services, fire, append };
}

/** A registry with a job list and an event feed the test drives. */
function fakeJobs(jobs: DshJobView[] = []) {
  let listener: ((event: DshJobEvent) => void) | undefined;
  const registry = {
    events: {
      subscribe: vi.fn((_filter: unknown, next: (event: DshJobEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
    },
    list: vi.fn(() => jobs),
    get: vi.fn((id: string) => {
      const job = jobs.find((entry) => entry.id === id);
      if (!job) throw new Error(`unknown job ${id}`);
      return job;
    }),
    readAt: vi.fn(() => ({ chunks: [{ at: 0, text: 'hello\n' }], next: 6, lossy: false })),
    kill: vi.fn(() => 'requested' as const),
  };
  return { registry, jobs, fire: (event: DshJobEvent) => listener?.(event) };
}

function job(id: string, kind: string, status = 'running'): DshJobView {
  return {
    id,
    kind,
    label: `${kind} work`,
    owner: DSH_ID,
    status,
    startedAt: 1_000,
    output: { total: 6, earliest: 0 },
  };
}

const deps: DshBridgeDeps = {
  createUserMessage: vi.fn(() => ({ id: 'user-message-1' })),
  now: () => 1_700_000_000_000,
  modelPlan: () => TEST_PLAN,
};

function runtime(ctx: DshBridgeContext, emitted: Emitted[]): DshSessionRuntime {
  return new DshSessionRuntime(
    ctx,
    {
      logicalSessionId: LOGICAL,
      cwd: CWD,
      projectTrusted: true,
      emit: (event) => emitted.push(event as Emitted),
    },
    { ...deps, home }
  );
}

const send = (requestId: string, text: string) => ({
  logicalSessionId: LOGICAL,
  requestId,
  attemptId: `attempt-${requestId}`,
  text,
});

async function refusalCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error('expected a refusal');
}

describe('DshSessionRuntime — P1-7b wiring (decisions 069, 099 rule 15, 119)', () => {
  it('[P7B-EXEC] stamps `execStartedAt` on its own agent’s call as it enters `tools/execute`; others pass untouched', async () => {
    const host = fakeHost();
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'run it'));
    host.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'bash',
      arguments: '{"command":"ls"}',
    });
    const outcome = { isError: false, value: { kind: 'foreground' }, content: [] };
    const next = vi.fn(async () => outcome);
    const result = await host.fire(
      'tools/execute',
      { callId: 'call-1', name: 'bash', arguments: { command: 'ls' }, agent: { id: DSH_ID } },
      next
    );
    expect(result).toBe(outcome);
    const stamps = emitted.filter(
      (event) => event.type === 'tool.updated' && event.payload?.execStartedAt !== undefined
    );
    expect(stamps).toEqual([
      {
        sessionId: LOGICAL,
        requestId: 'turn-1',
        type: 'tool.updated',
        payload: {
          messageId: `dsh-${DSH_ID}-t1-s1`,
          toolCallId: 'call-1',
          execStartedAt: 1_700_000_000_000,
        },
      },
    ]);

    const before = emitted.length;
    // A delegate's call and a program's sub-dispatch are not this row's.
    await host.fire(
      'tools/execute',
      { callId: 'c-x', name: 'bash', arguments: {}, agent: { id: 'aiclient-child' } },
      next
    );
    await host.fire(
      'tools/execute',
      { callId: 'c-y', name: 'bash', arguments: {}, agent: { id: DSH_ID }, parent: Symbol('p') },
      next
    );
    expect(emitted.length).toBe(before);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('[P7B-BASELINE] `jobs` joins the bootstrap snapshot only while the session has one; `worker.panels` always', async () => {
    const empty = fakeHost();
    empty.services.jobs = fakeJobs().registry;
    const emptyEmitted: Emitted[] = [];
    const emptyBridge = runtime(empty.ctx, emptyEmitted);
    await emptyBridge.bootstrap();
    await emptyBridge.startSend(send('turn-1', 'hello'));
    expect(emptyEmitted.some((event) => event.payload?.key === 'jobs')).toBe(false);
    expect(await emptyBridge.panels({ logicalSessionId: LOGICAL })).toEqual({
      projections: [{ key: 'jobs', view: [] }],
    });

    const busy = fakeHost();
    busy.services.jobs = fakeJobs([job('bash-1', 'bash')]).registry;
    const emitted: Emitted[] = [];
    const bridge = runtime(busy.ctx, emitted);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'hello'));
    expect(emitted[0]).toMatchObject({
      type: 'session.projection',
      payload: {
        key: 'jobs',
        view: [
          { id: 'bash-1', kind: 'bash', label: 'bash work', status: 'running', startedAt: 1_000 },
        ],
      },
    });
  });

  it('[P7B-LIVE-JOBS] a job event after the bootstrap goes out as `session.projection`', async () => {
    const host = fakeHost();
    const jobs = fakeJobs();
    host.services.jobs = jobs.registry;
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'hello'));
    jobs.jobs.push(job('bash-2', 'bash'));
    jobs.fire({ type: 'registered', job: job('bash-2', 'bash') });
    expect(emitted.at(-1)).toMatchObject({
      type: 'session.projection',
      requestId: 'turn-1',
      payload: { key: 'jobs', view: [{ id: 'bash-2' }] },
    });
  });

  it('[P7B-RPC] the window RPCs need an open session, then reach the modules', async () => {
    const host = fakeHost();
    const jobs = fakeJobs([job('bash-1', 'bash')]);
    host.services.jobs = jobs.registry;
    const interrupt = vi.fn();
    host.services.subagents = { interrupt };
    const bridge = runtime(host.ctx, []);
    expect(await refusalCode(bridge.killJob({ logicalSessionId: LOGICAL, jobId: 'bash-1' }))).toBe(
      'WORKER_NOT_BOOTSTRAPPED'
    );
    await bridge.bootstrap();
    expect(await bridge.killJob({ logicalSessionId: LOGICAL, jobId: 'bash-1' })).toEqual({
      outcome: 'requested',
    });
    expect(await bridge.readJob({ logicalSessionId: LOGICAL, jobId: 'bash-1' })).toEqual({
      text: 'hello\n',
      from: 0,
      next: 6,
      omittedBytes: 0,
      lossy: false,
    });
    expect(
      await bridge.interruptSubagent({ logicalSessionId: LOGICAL, childId: 'aiclient-child' })
    ).toEqual({ interrupted: true });
    expect(interrupt).toHaveBeenCalledWith('aiclient-child', {
      kind: 'user',
      parentSessionId: DSH_ID,
    });
    expect(await refusalCode(bridge.readJob({ logicalSessionId: 'other', jobId: 'bash-1' }))).toBe(
      'WORKER_SESSION_MISMATCH'
    );
  });

  it('[P7B-STOP] Stop interrupts running continuable children and kills one-shot subagent jobs, never commands (069)', async () => {
    const host = fakeHost();
    const jobs = fakeJobs([job('bash-1', 'bash'), job('subagent-1', 'subagent')]);
    host.services.jobs = jobs.registry;
    const interrupt = vi.fn();
    host.services.subagents = { interrupt };
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'delegate'));
    host.append('subagent/catalog', {
      childId: 'aiclient-kid',
      label: 'Probe',
      mode: 'continuable',
    });
    host.fire('subagent/start', { runId: 'run-1', id: 'aiclient-kid' });
    expect(bridge.busy).toBe(true);

    expect(await bridge.stop({ logicalSessionId: LOGICAL, reason: 'user' } as never)).toEqual({
      stopped: true,
    });
    expect(interrupt).toHaveBeenCalledWith('aiclient-kid', {
      kind: 'user',
      parentSessionId: DSH_ID,
    });
    expect(jobs.registry.kill).toHaveBeenCalledTimes(1);
    expect(jobs.registry.kill).toHaveBeenCalledWith('subagent-1', DSH_ID, 'the user pressed Stop');
    expect(host.agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true });
  });

  it('[P7B-BUSY-CHILD] a child’s run keeps the session busy after its turn; its end frees it', async () => {
    const host = fakeHost();
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();
    host.append('subagent/catalog', {
      childId: 'aiclient-kid',
      label: 'Probe',
      mode: 'continuable',
    });
    host.fire('subagent/start', { runId: 'run-1', id: 'aiclient-kid' });
    expect(bridge.busy).toBe(true);
    host.fire('subagent/end', { runId: 'run-1', id: 'aiclient-kid', stopReason: 'completed' });
    expect(bridge.busy).toBe(false);
  });

  it('[P7B-CHILD-LANE] a delegation call’s child reports on its lane through `subagent.activity`', async () => {
    const host = fakeHost();
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'delegate'));
    let release: (value: unknown) => void = () => undefined;
    const pending = host.fire(
      'tools/execute',
      {
        callId: 'call-sub',
        name: 'subagent',
        arguments: { description: 'Probe', prompt: 'go' },
        agent: { id: DSH_ID },
      },
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    host.append('subagent/catalog', {
      childId: 'aiclient-kid',
      label: 'Probe',
      mode: 'continuable',
    });
    host.append(
      'tool/call',
      { turn: 1, step: 1, callId: 'k-1', name: 'grep', arguments: '{"pattern":"x"}' },
      'aiclient-kid'
    );
    release({ isError: false, value: { kind: 'continuable', subagentId: 'aiclient-kid' } });
    await pending;
    const lane = emitted.filter((event) => event.type === 'subagent.activity');
    expect(lane.map((event) => event.payload?.kind)).toEqual(['started', 'tool.started']);
    expect(lane[1]?.payload).toMatchObject({
      parentToolCallId: 'call-sub',
      agentId: 'aiclient-kid',
      toolCallId: 'k-1',
      name: 'grep',
      input: { pattern: 'x' },
    });
  });
});
