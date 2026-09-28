import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DshLogEvent } from '../../../shared/dshHistory/types.ts';
import type { PermissionGate } from '../../../shared/permissions/gate.ts';
import {
  isWorkerForkPayload,
  isWorkerForkResult,
  isWorkerRewindResult,
  WORKER_REWIND_JOBS_RUNNING,
} from '../../../shared/types/workerRpc.ts';
import type { DshPermissionHost } from '../../permissions/permissionHost.ts';
import {
  type DshBridgeContext,
  DshSessionRuntime,
  dshSessionIdFor,
  type SessionStub,
  stubPathFor,
} from '../dshSessionRuntime.ts';
import { grantsSidecarFor, writeStubAtomically } from '../stub.ts';
import { testPermissionHost } from './permissionTestHost.ts';
import { TEST_PLAN } from './testPlan.ts';

/**
 * dsh-rebase P1-4b — rewind and fork through seeded child sessions (decision
 * 027), against a fake Cordis context that keeps one log per DSH session and
 * records the order of every step. Crash windows are failures injected at a
 * step (plan P1-4 shard 03 §4): the stub is the truth a restart reads, so
 * each window is checked by opening a fresh runtime on it.
 */

const CWD = '/repo';
const LOGICAL = 'session-1';
const ROOT = dshSessionIdFor(LOGICAL);
const T = 1_790_000_000_000;

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-rewind-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const at = (seq: number, type: string, data: unknown = {}): DshLogEvent => ({
  type,
  seq,
  time: T + seq,
  data,
});

/** One queued prompt, its turn, one text step. */
function turn(
  start: number,
  n: number,
  prompt: string,
  answer: string,
  text: string
): DshLogEvent[] {
  return [
    at(start, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: prompt }] }),
    at(start + 1, 'turn/start', { turn: n }),
    at(start + 2, 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      removedCount: 1,
      inserted: [],
    }),
    at(start + 3, 'step/start', { turn: n, step: 1 }),
    at(start + 4, 'user/message', {
      id: prompt,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    }),
    at(start + 5, 'assistant/message', {
      turn: n,
      step: 1,
      message: { id: answer, role: 'assistant', content: [{ type: 'text', text: `re ${text}` }] },
    }),
    at(start + 6, 'step/end', { turn: n, step: 1 }),
    at(start + 7, 'turn/end', { turn: n, reason: { kind: 'completed' } }),
  ];
}

/** Two turns: u1 -> a1, u2 -> a2. Seqs 0..16. */
const TWO_TURNS: DshLogEvent[] = [
  at(0, 'permission/preset', { preset: 'workspace-write' }),
  ...turn(1, 1, 'u1', 'a1', 'first'),
  ...turn(9, 2, 'u2', 'a2', 'second'),
];

interface Faults {
  /** `agents.create` throws for these ids. */
  createErrors?: Record<string, Error>;
  flushError?: Error;
  /** The stub writer throws when it would point the stub at this id. */
  stubErrorFor?: string;
  /** This id's dispose never settles. */
  hangingDispose?: string;
  /** `runMaintenance` throws synchronously. */
  notIdle?: boolean;
}

/** A Cordis context over one log per DSH session, recording every step in order. */
function fakeDsh(initial: Record<string, DshLogEvent[]>, faults: Faults = {}) {
  const logs = new Map(Object.entries(initial).map(([id, events]) => [id, [...events]]));
  const calls: string[] = [];
  const creates: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const jobs: Array<{ owner?: string; status: string }> = [];
  const handle = (id: string) => ({
    agent: {
      id,
      status: 'idle',
      session: { id, header: { cwd: CWD } },
      followup: () => calls.push(`followup ${id}`),
      cancel: (cause: { kind: string }, options?: { keepInbox?: boolean }) =>
        calls.push(`cancel ${id} ${cause.kind}${options?.keepInbox ? ' keepInbox' : ''}`),
      runMaintenance: <R>(task: (signal: AbortSignal) => Promise<R>): Promise<R> => {
        if (faults.notIdle) throw new Error(`agent "${id}" already has active work`);
        calls.push(`maintenance ${id}`);
        return task(new AbortController().signal).finally(() =>
          calls.push(`maintenance end ${id}`)
        );
      },
    },
    dispose: () => {
      calls.push(`dispose ${id}`);
      return id === faults.hangingDispose ? new Promise<void>(() => undefined) : Promise.resolve();
    },
  });
  const ctx = {
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    agents: {
      create: vi.fn(async (input: Record<string, unknown>) => {
        const id = String(input.sessionId);
        calls.push(`create ${id}`);
        creates.push(input);
        const error = faults.createErrors?.[id];
        if (error) throw error;
        // The factory takes the seed as the log's start (the constructor's marker is in it).
        logs.set(id, [...((input.seed as DshLogEvent[] | undefined) ?? [])]);
        return handle(id);
      }),
      resume: vi.fn(async (input: { resumeSessionId: string }) => {
        calls.push(`resume ${input.resumeSessionId}`);
        if (!logs.has(input.resumeSessionId)) {
          throw Object.assign(new Error('gone'), { name: 'SessionPersistenceNotFoundError' });
        }
        return handle(input.resumeSessionId);
      }),
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'aiclient-gateway', model: 'fake-1' }),
    },
    sessions: {
      flush: vi.fn(async (session: { id: string }) => {
        calls.push(`flush ${session.id}`);
        if (faults.flushError) throw faults.flushError;
        return true;
      }),
    },
    sessionQuery: {
      observeSession: vi.fn(async (id: string) => {
        const events = logs.get(id);
        if (!events)
          throw Object.assign(new Error(id), { name: 'SessionPersistenceNotFoundError' });
        return { events: [...events], cursor: events.at(-1)?.seq ?? -1 };
      }),
    },
    get: (name: string) => (name === 'jobs' ? { list: () => jobs } : undefined),
    aiclientPermissions: testPermissionHost().api,
  } as unknown as DshBridgeContext;
  /** A durable event of `id`, as `session/event` delivers it (and the log keeps it). */
  const append = (id: string, event: DshLogEvent) => {
    logs.get(id)?.push(event);
    listeners.get('session/event')?.({ id }, event);
  };
  const writeStub = (file: string, stub: SessionStub) => {
    calls.push(`stub ${stub.dshSessionId}`);
    if (faults.stubErrorFor === stub.dshSessionId) throw new Error('disk full');
    writeStubAtomically(file, stub);
  };
  return { ctx, calls, creates, logs, jobs, append, writeStub };
}

type Fake = ReturnType<typeof fakeDsh>;

function writeRootStub(stub: Partial<SessionStub> = {}): string {
  const file = stubPathFor(home, ROOT);
  mkdirSync(join(home, 'aiclient-sessions'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      engine: 'dsh',
      version: 1,
      dshSessionId: ROOT,
      logicalSessionId: LOGICAL,
      cwd: CWD,
      createdAt: 1,
      ...stub,
    })
  );
  return file;
}

function readStubFile(file: string): SessionStub {
  return JSON.parse(readFileSync(file, 'utf8')) as SessionStub;
}

async function open(
  dsh: Fake,
  sessionFile: string,
  extra: { logicalSessionId?: string; log?: (...args: unknown[]) => void } = {}
) {
  const runtime = new DshSessionRuntime(
    dsh.ctx,
    {
      logicalSessionId: extra.logicalSessionId ?? LOGICAL,
      cwd: CWD,
      projectTrusted: true,
      sessionFile,
      emit: () => undefined,
      ...(extra.log ? { log: extra.log } : {}),
    },
    {
      createUserMessage: () => ({ id: 'user-message-1' }),
      now: () => T + 1_000,
      home,
      writeStub: dsh.writeStub,
      disposeTimeoutMs: 50,
      modelPlan: () => TEST_PLAN,
    }
  );
  await runtime.bootstrap();
  dsh.calls.length = 0;
  return runtime;
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
}

const rewind = (runtime: DshSessionRuntime, targetEntryId: string) =>
  runtime.rewind({ logicalSessionId: LOGICAL, targetEntryId, confirmed: true });

describe('rewind — a seeded child and a repointed stub (decision 027)', () => {
  it('[rewind-order] holds the old agent, creates and flushes the child, repoints the stub, then lets go', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);

    const result = await rewind(runtime, 'u2');

    const child = `${ROOT}.r2`;
    expect(dsh.calls).toEqual([
      `maintenance ${ROOT}`,
      `create ${child}`,
      `flush ${child}`,
      `stub ${child}`,
      `cancel ${ROOT} disposed keepInbox`,
      `maintenance end ${ROOT}`,
      `dispose ${ROOT}`,
    ]);
    // Cut after the first turn: the queued second prompt stays out.
    const created = dsh.creates[0] as { seed: DshLogEvent[]; inheritedEventCount: number };
    expect(created).toMatchObject({
      sessionId: child,
      meta: { cwd: CWD, parentSession: ROOT, isSeeded: true },
      inheritedEventCount: 9,
      agentOptions: { provider: 'aiclient-gateway', model: 'fake-1' },
    });
    expect(created.seed.slice(-2).map((event) => event.type)).toEqual([
      'turn/end',
      'session/end-seed',
    ]);
    expect(readStubFile(stubFile)).toEqual({
      engine: 'dsh',
      version: 2,
      dshSessionId: child,
      logicalSessionId: LOGICAL,
      cwd: CWD,
      createdAt: 1,
      lineage: [
        { dshSessionId: ROOT, reason: 'create', at: 1 },
        {
          dshSessionId: child,
          reason: 'rewind',
          parentDshSessionId: ROOT,
          cutSeq: 8,
          at: T + 1_000,
        },
      ],
    });
    expect(isWorkerRewindResult(result)).toBe(true);
    expect(result).toMatchObject({
      logicalSessionId: LOGICAL,
      sessionFile: stubFile,
      targetEntryId: 'u2',
      editorText: 'second',
      leaf: { activeEntryId: 'a1', fileTailEntryId: `${child}#9` },
    });
    expect(result.history.page.messages.map((message) => message.id)).toEqual(['h:u1', 'h:a1']);
    // What the rewind left is still in the tree, as the branch no longer active.
    expect(
      result.tree.snapshot.nodes.map((node) => [node.id, node.parentId, node.active, node.leaf])
    ).toEqual([
      ['u1', null, true, false],
      ['a1', 'u1', true, true],
      ['u2', 'a1', false, false],
      ['a2', 'u2', false, false],
    ]);
  });

  it('[rewind-follow] follows the child from then on, and nothing of the retired session', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    await rewind(runtime, 'u2');
    const child = `${ROOT}.r2`;
    const observe = vi.mocked(dsh.ctx.sessionQuery.observeSession);
    const readsOfRoot = () => observe.mock.calls.filter(([id]) => id === ROOT).length;
    const rootReads = readsOfRoot();

    dsh.append(ROOT, at(17, 'user/message', { id: 'late', source: { kind: 'user' }, content: [] }));
    for (const event of turn(10, 2, 'u3', 'a3', 'instead')) dsh.append(child, event);

    const history = await runtime.history({ logicalSessionId: LOGICAL });
    expect(history.page.messages.map((message) => message.id)).toEqual([
      'h:u1',
      'h:a1',
      'h:u3',
      'h:a3',
    ]);
    const tree = await runtime.tree();
    expect(tree.snapshot.leaf).toEqual({ activeEntryId: 'a3', fileTailEntryId: `${child}#17` });
    expect(tree.snapshot.nodes.map((node) => [node.id, node.parentId, node.active])).toEqual([
      ['u1', null, true],
      ['a1', 'u1', true],
      ['u2', 'a1', false],
      ['a2', 'u2', false],
      ['u3', 'a1', true],
      ['a3', 'u3', true],
    ]);
    // The retired timeline is the fold the rewind had: never read again.
    expect(readsOfRoot()).toBe(rootReads);
    // A send goes to the child's agent.
    await runtime.startSend({
      logicalSessionId: LOGICAL,
      requestId: 'r1',
      attemptId: 'a1',
      text: 'next',
    });
    expect(dsh.calls.at(-1)).toBe(`followup ${child}`);
  });

  it("[rewind-projections] sends the child's projections at once, and none of the retired session's (P1-4d2)", async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const child = `${ROOT}.r2`;
    const todosOf: Record<string, unknown> = {
      [ROOT]: [{ content: 'root plan', status: 'pending' }],
      [child]: null,
    };
    let listener: ((session: { id: string }, key: string, value: unknown) => void) | undefined;
    const jobs = dsh.ctx.get;
    (dsh.ctx as { get?: unknown }).get = (name: string) =>
      name === 'sessionProjections'
        ? {
            snapshot: (session: { id: string }) => ({ values: { todos: todosOf[session.id] } }),
            onChanged: (next: typeof listener) => {
              listener = next;
              return () => undefined;
            },
          }
        : jobs?.(name as 'jobs');
    const emitted: Array<{ type: string; payload?: unknown }> = [];
    const runtime = new DshSessionRuntime(
      dsh.ctx,
      {
        logicalSessionId: LOGICAL,
        cwd: CWD,
        projectTrusted: true,
        sessionFile: stubFile,
        emit: (event) => emitted.push(event),
      },
      {
        createUserMessage: () => ({ id: 'user-message-1' }),
        now: () => T + 1_000,
        home,
        writeStub: dsh.writeStub,
        disposeTimeoutMs: 50,
        modelPlan: () => TEST_PLAN,
      }
    );
    await runtime.bootstrap();
    // The bootstrap's baseline waits for the slot's first event.
    expect(emitted).toEqual([]);

    await rewind(runtime, 'u2');

    // The child's values went out during the rewind; the root's never did.
    expect(emitted.map((event) => [event.type, event.payload])).toEqual([
      ['session.projection', { key: 'todos', view: null }],
    ]);
    listener?.({ id: ROOT }, 'todos', []);
    listener?.({ id: child }, 'todos', [{ content: 'child plan', status: 'pending' }]);
    expect(emitted.map((event) => event.payload)).toEqual([
      { key: 'todos', view: null },
      { key: 'todos', view: [{ content: 'child plan', status: 'pending' }] },
    ]);
  });

  it('[rewind-step] keeps a model step and returns no prompt', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    const result = await rewind(runtime, 'a2');
    expect(result).not.toHaveProperty('editorText');
    expect(dsh.creates[0]).toMatchObject({ inheritedEventCount: 17 });
    expect(result.history.page.messages.map((message) => message.id)).toEqual([
      'h:u1',
      'h:a1',
      'h:u2',
      'h:a2',
    ]);
  });

  it('[rewind-first] starts an empty child for the first prompt, still naming its parent', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    const result = await rewind(runtime, 'u1');
    expect(dsh.creates[0]).toEqual({
      sessionId: `${ROOT}.r2`,
      meta: { cwd: CWD, parentSession: ROOT },
      agentOptions: { provider: 'aiclient-gateway', model: 'fake-1' },
      // P1-5a: the child routes by the session's selection too.
      setup: expect.any(Function),
    });
    expect(result.editorText).toBe('first');
    expect(result.history.page.messages).toEqual([]);
    expect(readStubFile(stubFile).lineage?.at(-1)).toEqual({
      dshSessionId: `${ROOT}.r2`,
      reason: 'rewind',
      parentDshSessionId: ROOT,
      at: T + 1_000,
    });
  });

  it('[rewind-retired] rewinds into a branch only a retired session holds, reading it cold', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    await rewind(runtime, 'u2');
    dsh.calls.length = 0;

    // a2 exists only in the retired root session now.
    const result = await rewind(runtime, 'a2');

    const second = `${ROOT}.r3`;
    expect(dsh.calls).toEqual([
      `maintenance ${ROOT}.r2`,
      `create ${second}`,
      `flush ${second}`,
      `stub ${second}`,
      `cancel ${ROOT}.r2 disposed keepInbox`,
      `maintenance end ${ROOT}.r2`,
      `dispose ${ROOT}.r2`,
    ]);
    expect(dsh.creates[1]).toMatchObject({
      meta: { parentSession: ROOT },
      inheritedEventCount: 17,
    });
    expect(dsh.ctx.sessionQuery.observeSession).toHaveBeenCalledWith(ROOT, expect.anything());
    expect(readStubFile(stubFile).lineage?.map((entry) => entry.dshSessionId)).toEqual([
      ROOT,
      `${ROOT}.r2`,
      second,
    ]);
    expect(result.tree.snapshot.nodes.map((node) => [node.id, node.active, node.leaf])).toEqual([
      ['u1', true, false],
      ['a1', true, false],
      ['u2', true, false],
      ['a2', true, true],
    ]);
  });

  it('[rewind-id-taken] moves past a child id an earlier, failed rewind left on disk', async () => {
    const stubFile = writeRootStub();
    const taken = Object.assign(new Error('exists'), { name: 'SessionAlreadyExistsError' });
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS }, { createErrors: { [`${ROOT}.r2`]: taken } });
    const runtime = await open(dsh, stubFile);
    await rewind(runtime, 'u2');
    expect(dsh.calls.slice(0, 3)).toEqual([
      `maintenance ${ROOT}`,
      `create ${ROOT}.r2`,
      `create ${ROOT}.r3`,
    ]);
    expect(readStubFile(stubFile).dshSessionId).toBe(`${ROOT}.r3`);
  });

  it('[rewind-v1] reads a version 1 stub as a lineage of one, and writes version 2', async () => {
    const stubFile = writeRootStub({ createdAt: 42 });
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    expect((await runtime.tree()).snapshot.totalNodes).toBe(4);
    await rewind(runtime, 'a1');
    expect(readStubFile(stubFile)).toMatchObject({
      version: 2,
      createdAt: 42,
      lineage: [
        { dshSessionId: ROOT, reason: 'create', at: 42 },
        { dshSessionId: `${ROOT}.r2`, reason: 'rewind' },
      ],
    });
  });
});

describe('rewind — refusals and crash windows (plan P1-4 shard 03 §4)', () => {
  it('refuses while a turn runs, while a job of the session runs, or when the agent is not idle', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);

    dsh.jobs.push({ owner: ROOT, status: 'running' });
    const jobs = await refusal(rewind(runtime, 'u2'));
    expect(jobs.code).toBe(WORKER_REWIND_JOBS_RUNNING);
    dsh.jobs.length = 0;

    await runtime.startSend({
      logicalSessionId: LOGICAL,
      requestId: 'r1',
      attemptId: 'x',
      text: 'hi',
    });
    expect((await refusal(rewind(runtime, 'u2'))).code).toBe('WORKER_SESSION_BUSY');
    expect(dsh.ctx.agents.create).not.toHaveBeenCalled();

    const other = fakeDsh({ [ROOT]: TWO_TURNS }, { notIdle: true });
    const held = await open(other, stubFile);
    expect((await refusal(rewind(held, 'u2'))).code).toBe('WORKER_SESSION_BUSY');
    expect(other.ctx.agents.create).not.toHaveBeenCalled();
  });

  it('answers session_entry_not_found for a node no session of the lineage has', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    expect((await refusal(rewind(runtime, 'nowhere'))).code).toBe('session_entry_not_found');
    expect(dsh.calls).toEqual([]);
  });

  it.each([
    ['the flush', { flushError: new Error('disk full') }],
    ['the stub write', { stubErrorFor: `${ROOT}.r2` }],
  ] as const)('[rewind-crash-before-switch] a failure at %s leaves the old session current', async (_label, faults) => {
    const stubFile = writeRootStub();
    const before = readFileSync(stubFile, 'utf8');
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS }, faults);
    const runtime = await open(dsh, stubFile);

    await expect(rewind(runtime, 'u2')).rejects.toThrow('disk full');

    // The child is released, the old agent is not cancelled, the stub is as it was.
    expect(dsh.calls).toContain(`dispose ${ROOT}.r2`);
    expect(dsh.calls).not.toContain(`cancel ${ROOT} disposed keepInbox`);
    expect(dsh.calls.at(-1)).toBe(`maintenance end ${ROOT}`);
    expect(readFileSync(stubFile, 'utf8')).toBe(before);
    expect((await runtime.tree()).snapshot.leaf.fileTailEntryId).toBe(`${ROOT}#16`);
    await runtime.startSend({
      logicalSessionId: LOGICAL,
      requestId: 'r',
      attemptId: 'x',
      text: 'hi',
    });
    expect(dsh.calls.at(-1)).toBe(`followup ${ROOT}`);
    // A restart reads the stub: the old session.
    const restart = fakeDsh(Object.fromEntries(dsh.logs));
    await open(restart, stubFile);
    expect(restart.ctx.agents.resume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: ROOT })
    );
  });

  it('[rewind-crash-after-switch] an old agent that will not dispose does not hold the rewind; a restart opens the child', async () => {
    const stubFile = writeRootStub();
    const log = vi.fn();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS }, { hangingDispose: ROOT });
    const runtime = await open(dsh, stubFile, { log });

    const result = await rewind(runtime, 'u2');

    expect(result.leaf.fileTailEntryId).toBe(`${ROOT}.r2#9`);
    expect(log).toHaveBeenCalledWith('[dsh-bridge] retired agent did not dispose in time', ROOT);
    // The host dies here: the stub already names the child, whose log is on disk.
    const restart = fakeDsh(Object.fromEntries(dsh.logs));
    const reopened = await open(restart, stubFile);
    expect(restart.ctx.agents.resume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: `${ROOT}.r2` })
    );
    const tree = (await reopened.tree()).snapshot;
    expect(tree.nodes.map((node) => [node.id, node.active])).toEqual([
      ['u1', true],
      ['a1', true],
      ['u2', false],
      ['a2', false],
    ]);
  });
});

describe('rewind keeps the grants (P1-6c, decision 043)', () => {
  it('[rewind-grants] re-points the same gate, grants and all, and leaves the sidecar beside the stub alone', async () => {
    const stubFile = writeRootStub();
    const grant = { kind: 'command', prefix: 'npm test', root: CWD } as const;
    writeFileSync(grantsSidecarFor(stubFile), JSON.stringify({ version: 2, grants: [grant] }));
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const attach = vi.spyOn(
      (dsh.ctx as { aiclientPermissions: DshPermissionHost }).aiclientPermissions,
      'attachGate'
    );
    const runtime = await open(dsh, stubFile);
    const before = readFileSync(grantsSidecarFor(stubFile), 'utf8');

    await rewind(runtime, 'u2');

    expect(readFileSync(grantsSidecarFor(stubFile), 'utf8')).toBe(before);
    expect(attach.mock.calls.map(([, options]) => options.dshSessionId)).toEqual([
      ROOT,
      `${ROOT}.r2`,
    ]);
    const [first, second] = attach.mock.calls.map(([, options]) => options.gate);
    expect(second).toBe(first);
    const shell = (command: string) => ({
      tool: 'bash',
      toolCallId: 'call-1',
      path: CWD,
      command,
      commands: [command],
    });
    expect((second as PermissionGate).evaluate(shell('npm test'))).toBe('allow');
    expect((second as PermissionGate).evaluate(shell('npm publish'))).toBe('ask');
  });
});

describe('fork — a child for the id Main minted (decision 027 rule 4)', () => {
  const TARGET = 'session-fork-7';
  const CHILD = dshSessionIdFor(TARGET);
  /** `target: null` asks without the minted id. */
  const fork = (runtime: DshSessionRuntime, entryId: string, target: string | null = TARGET) =>
    runtime.fork({
      logicalSessionId: LOGICAL,
      entryId,
      ...(target !== null ? { targetLogicalSessionId: target } : {}),
    });

  it('[fork] stages the child, writes its stub, copies the grants, and releases it for the next slot', async () => {
    const stubFile = writeRootStub();
    writeFileSync(grantsSidecarFor(stubFile), '{"version":2,"grants":[]}');
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    const childStub = stubPathFor(home, CHILD);
    let markerAtCreate = false;
    dsh.ctx.agents.create = vi.fn(async (input: Record<string, unknown>) => {
      markerAtCreate = existsSync(`${childStub}.staged`);
      dsh.creates.push(input);
      dsh.logs.set(String(input.sessionId), [...(input.seed as DshLogEvent[])]);
      dsh.calls.push(`create ${String(input.sessionId)}`);
      return {
        agent: { id: CHILD, status: 'idle', session: { id: CHILD } },
        dispose: async () => {
          dsh.calls.push(`dispose ${CHILD}`);
        },
      };
    }) as never;

    const result = await fork(runtime, 'a1');

    expect(markerAtCreate).toBe(true);
    expect(dsh.calls).toEqual([
      `create ${CHILD}`,
      `flush ${CHILD}`,
      `stub ${CHILD}`,
      `dispose ${CHILD}`,
    ]);
    expect(dsh.creates[0]).toMatchObject({
      sessionId: CHILD,
      meta: { cwd: CWD, parentSession: ROOT, isSeeded: true },
      inheritedEventCount: 9,
    });
    expect(readStubFile(childStub)).toEqual({
      engine: 'dsh',
      version: 2,
      dshSessionId: CHILD,
      logicalSessionId: TARGET,
      cwd: CWD,
      createdAt: T + 1_000,
      lineage: [
        { dshSessionId: CHILD, reason: 'fork', parentDshSessionId: ROOT, cutSeq: 8, at: T + 1_000 },
      ],
    });
    expect(readFileSync(grantsSidecarFor(childStub), 'utf8')).toBe('{"version":2,"grants":[]}');
    expect(isWorkerForkResult(result)).toBe(true);
    expect(result).toMatchObject({
      logicalSessionId: LOGICAL,
      sourceSessionFile: stubFile,
      sessionFile: childStub,
      piSessionId: CHILD,
      workspacePath: CWD,
      leaf: { activeEntryId: 'a1', fileTailEntryId: `${CHILD}#9` },
    });
    expect(result.history.page.messages.map((message) => message.id)).toEqual(['h:u1', 'h:a1']);
    // The source is untouched and still current.
    expect(readStubFile(stubFile).dshSessionId).toBe(ROOT);

    const accept = { logicalSessionId: LOGICAL, sessionFile: childStub };
    expect(await runtime.acceptFork(accept)).toEqual({ accepted: true });
    expect(existsSync(`${childStub}.staged`)).toBe(false);
    expect(existsSync(childStub)).toBe(true);
    expect(await runtime.acceptFork(accept)).toEqual({ accepted: false });
    // Adopted: no longer the source's to discard.
    expect(await runtime.discardFork(accept)).toEqual({ discarded: false });
    expect(existsSync(childStub)).toBe(true);
  });

  it('[fork-grants-unreadable] a fork whose grants cannot be copied still forks, with none, and says so', async () => {
    const stubFile = writeRootStub();
    // A directory where the grants would be: neither readable nor copyable.
    mkdirSync(grantsSidecarFor(stubFile));
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const log = vi.fn();
    const runtime = await open(dsh, stubFile, { log });
    const result = await fork(runtime, 'a1');
    expect(existsSync(result.sessionFile)).toBe(true);
    expect(existsSync(grantsSidecarFor(result.sessionFile))).toBe(false);
    expect(log).toHaveBeenCalledWith(
      '[dsh-bridge] grants not copied',
      grantsSidecarFor(stubFile),
      grantsSidecarFor(result.sessionFile),
      expect.anything()
    );
  });

  it('[fork-discard] discarding a staged fork removes its stub, grants and marker', async () => {
    const stubFile = writeRootStub();
    writeFileSync(grantsSidecarFor(stubFile), '{}');
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    const result = await fork(runtime, 'a2');
    expect(
      await runtime.discardFork({ logicalSessionId: LOGICAL, sessionFile: 'elsewhere' })
    ).toEqual({
      discarded: false,
    });
    expect(
      await runtime.discardFork({ logicalSessionId: LOGICAL, sessionFile: result.sessionFile })
    ).toEqual({ discarded: true });
    expect(readdirSync(join(home, 'aiclient-sessions')).sort()).toEqual(
      [`${ROOT}.dsh.grants.json`, `${ROOT}.dsh.json`].sort()
    );
  });

  it('[fork-target] the slot opened on the fork resumes it, and discarding its own stub ends it', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const source = await open(dsh, stubFile);
    const staged = await fork(source, 'a1');

    const target = await open(dsh, staged.sessionFile, { logicalSessionId: TARGET });
    expect(dsh.ctx.agents.resume).toHaveBeenLastCalledWith(
      expect.objectContaining({ resumeSessionId: CHILD })
    );
    expect((await target.tree()).snapshot.nodes.map((node) => node.id)).toEqual(['u1', 'a1']);
    expect(
      await target.discardFork({ logicalSessionId: TARGET, sessionFile: staged.sessionFile })
    ).toEqual({ discarded: true });
    expect(dsh.calls).toContain(`dispose ${CHILD}`);
    expect(existsSync(staged.sessionFile)).toBe(false);
    expect(existsSync(`${staged.sessionFile}.staged`)).toBe(false);
    // A chat of its own is never discarded as a fork.
    const own = await open(fakeDsh({ [ROOT]: TWO_TURNS }), stubFile);
    expect(await own.discardFork({ logicalSessionId: LOGICAL, sessionFile: stubFile })).toEqual({
      discarded: false,
    });
    expect(existsSync(stubFile)).toBe(true);
  });

  it('[fork-unmaterialized] refuses a path with no model answer, leaving nothing behind', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    expect((await refusal(fork(runtime, 'u1'))).code).toBe('session_fork_unmaterialized');
    expect(dsh.ctx.agents.create).not.toHaveBeenCalled();
    expect(readdirSync(join(home, 'aiclient-sessions'))).toEqual([`${ROOT}.dsh.json`]);
  });

  it('[fork-no-target] needs the id Main minted', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    expect((await refusal(fork(runtime, 'a1', null))).code).toBe('WORKER_INVALID_PAYLOAD');
    expect((await refusal(fork(runtime, 'a1', '../x'))).code).toBe('WORKER_INVALID_PAYLOAD');
    expect(dsh.ctx.agents.create).not.toHaveBeenCalled();
  });

  it('[fork-failure] a failed flush releases the child and leaves no stub or marker', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS }, { flushError: new Error('disk full') });
    const runtime = await open(dsh, stubFile);
    await expect(fork(runtime, 'a1')).rejects.toThrow('disk full');
    expect(dsh.calls).toEqual([`create ${CHILD}`, `flush ${CHILD}`, `dispose ${CHILD}`]);
    expect(readdirSync(join(home, 'aiclient-sessions'))).toEqual([`${ROOT}.dsh.json`]);
  });

  it('forks from a branch only a retired session holds', async () => {
    const stubFile = writeRootStub();
    const dsh = fakeDsh({ [ROOT]: TWO_TURNS });
    const runtime = await open(dsh, stubFile);
    await rewind(runtime, 'u2');
    const result = await fork(runtime, 'a2');
    expect(dsh.creates.at(-1)).toMatchObject({
      sessionId: CHILD,
      meta: { parentSession: ROOT },
      inheritedEventCount: 17,
    });
    expect(result.history.page.messages.map((message) => message.id)).toEqual([
      'h:u1',
      'h:a1',
      'h:u2',
      'h:a2',
    ]);
  });

  it('accepts the fork payload with and without the minted id, never an empty one', () => {
    const base = { logicalSessionId: LOGICAL, entryId: 'a1' };
    expect(isWorkerForkPayload(base)).toBe(true);
    expect(isWorkerForkPayload({ ...base, targetLogicalSessionId: TARGET })).toBe(true);
    expect(isWorkerForkPayload({ ...base, targetLogicalSessionId: ' ' })).toBe(false);
    expect(isWorkerForkPayload({ ...base, targetLogicalSessionId: 7 })).toBe(false);
  });
});
