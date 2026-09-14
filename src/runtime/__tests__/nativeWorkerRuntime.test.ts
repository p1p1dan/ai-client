import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import type { RuntimeBootstrapOptions, RuntimeHandle } from '../bootstrap.ts';
import type { RuntimeHostConfig, RuntimeRunRequest, RuntimeRunResult } from '../contracts.ts';
import { NativeWorkerRuntime } from '../worker/nativeWorkerRuntime.ts';

/**
 * P4-1 — the native engine behind the existing worker RPC surface.
 *
 * The Cordis graph is injected rather than built: what needs pinning here is the
 * RPC contract (what `worker.bootstrap` answers, that `worker.send` returns
 * before the turn finishes so `worker.stop` can still be dispatched, which
 * events reach the port), not the plugins, which have their own tests.
 */

const HOST: RuntimeHostConfig = {
  carrier: 'electron-utility',
  tsdReadFallback: 'disabled',
  exec: { mode: 'pipe' },
  childEnv: {},
  cleanupTimeoutMs: 2000,
};
// `sessionFilePath` joins this, so the expectation has to as well: the same
// session file reads `\agent\sessions\logical-1.jsonl` on Windows.
const SESSION_FILE = join('/agent', 'sessions', 'logical-1.jsonl');

interface Fake {
  handle: RuntimeHandle;
  options: RuntimeBootstrapOptions | null;
  runs: RuntimeRunRequest[];
  emit(event: RuntimeEventDraft): void;
  settle(result?: Partial<RuntimeRunResult>): void;
  cancelled: string[];
  disposed: number;
  configured: unknown[];
}

/** What `handle.skills` offers, when P5-1 discovery ran. */
const SKILLS_SERVICE_FAKE = {
  skills: [
    {
      name: 'pdf',
      description: 'Extract text',
      filePath: '/agent/skills/pdf/SKILL.md',
      scope: 'user',
    },
  ],
  templates: [
    {
      name: 'review',
      description: 'Review staged changes',
      filePath: '/agent/prompts/review.md',
      scope: 'user',
    },
  ],
  diagnostics: [],
  segment: () => undefined,
  expand: async (text: string) =>
    text === '/review HEAD'
      ? {
          expanded: true as const,
          text: 'Review HEAD.',
          invocation: { kind: 'template' as const, name: 'review', args: 'HEAD' },
        }
      : { expanded: false as const },
};

/** What `handle.context` answers, when a test exercises `/compact`. */
type FakePrepareTurn = (request: {
  signal?: AbortSignal;
}) => Promise<{ compaction?: unknown; skipped?: { code: string; message: string } }>;

function fakeRuntime(
  overrides: {
    history?: unknown[];
    entries?: unknown[];
    file?: string;
    sourceFile?: string;
    skills?: unknown;
    /** Make the graph fail to tear down, which bootstrap really can do. */
    disposeFails?: boolean;
    /** Present = this graph has compaction; absent = it was built without it. */
    prepareTurn?: FakePrepareTurn;
  } = {}
): Fake {
  let listener: ((event: RuntimeEventDraft) => void) | undefined;
  let resolveRun: ((result: RuntimeRunResult) => void) | undefined;
  const fake: Fake = {
    options: null,
    runs: [],
    cancelled: [],
    disposed: 0,
    configured: [],
    emit: (event) => listener?.(event),
    settle: (result) =>
      resolveRun?.({
        runId: 'r1',
        success: true,
        text: '',
        stopReason: 'stop',
        usage: null,
        latencyMs: 1,
        turns: 1,
        trace: {} as RuntimeRunResult['trace'],
        ...result,
      }),
    handle: {} as RuntimeHandle,
  };
  fake.handle = {
    events: {
      subscribe(next: (event: RuntimeEventDraft) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
    session: {
      file: overrides.file ?? SESSION_FILE,
      metadata: () => ({
        id: 'native-session-1',
        file: overrides.file ?? SESSION_FILE,
        cwd: '/repo',
        title: '',
        model: 'anthropic/claude-opus-5',
        createdAt: 1,
        ...(overrides.sourceFile ? { sourceFile: overrides.sourceFile } : {}),
        leaf: { activeEntryId: 'e2', fileTailEntryId: 'e2' },
      }),
      history: () => overrides.history ?? [],
      flush: async () => undefined,
      // P5-2-6: the history answer now also carries delegation summaries, which
      // are folded out of the branch entries. A fake with no entries reports no
      // delegations, which is what a session that never delegated looks like.
      snapshot: () => ({ entries: overrides.entries ?? [], messages: [] }),
      tree: (id: string) => ({ logicalSessionId: id }),
    },
    permissions: {
      configure: (settings: unknown) => fake.configured.push(settings),
    },
    ...(overrides.skills === undefined ? {} : { skills: overrides.skills }),
    ...(overrides.prepareTurn
      ? {
          context: {
            enabled: true,
            beginRun: () => undefined,
            prepareTurn: overrides.prepareTurn,
          },
          model: {
            defaultRef: () => ({ provider: 'faux', id: 'faux-1' }),
            resolve: () => ({ model: {}, models: {} }),
          },
        }
      : {}),
    approval: { bridge: { cancelAll: (reason: string) => fake.cancelled.push(reason) } },
    run: (request: RuntimeRunRequest) => {
      fake.runs.push(request);
      return new Promise<RuntimeRunResult>((resolve) => {
        resolveRun = resolve;
      });
    },
    dispose: async () => {
      fake.disposed += 1;
      if (overrides.disposeFails) throw new Error('graph tear-down failed');
    },
  } as unknown as RuntimeHandle;
  return fake;
}

function build(fake: Fake, overrides: Record<string, unknown> = {}) {
  const events: RuntimeEventDraft[] = [];
  const runtime = new NativeWorkerRuntime({
    logicalSessionId: 'logical-1',
    cwd: '/repo',
    host: HOST,
    projectTrusted: true,
    agentDir: '/agent',
    emit: (event) => events.push(event),
    create: (async (options: RuntimeBootstrapOptions) => {
      fake.options = options;
      return fake.handle;
    }) as unknown as typeof import('../bootstrap.ts').createRuntime,
    ...overrides,
  } as ConstructorParameters<typeof NativeWorkerRuntime>[0]);
  return { runtime, events };
}

let live: NativeWorkerRuntime | undefined;
afterEach(async () => {
  await live?.dispose();
  live = undefined;
});

describe('NativeWorkerRuntime bootstrap', () => {
  it('answers the RPC bootstrap shape from session metadata', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    const result = await runtime.bootstrap();
    expect(result).toMatchObject({
      bootstrapped: true,
      logicalSessionId: 'logical-1',
      piSessionId: 'native-session-1',
      cwd: '/repo',
      agentDir: '/agent',
      sessionFile: SESSION_FILE,
      leaf: { activeEntryId: 'e2', fileTailEntryId: 'e2' },
      model: 'anthropic/claude-opus-5',
      projectTrusted: true,
      permissionGate: 'bundled',
    });
    // A fresh session has nothing to replay; only a resume carries history.
    expect(result.initialHistory).toBeUndefined();
    expect(fake.options?.session).toEqual({
      file: SESSION_FILE,
      cwd: '/repo',
      mode: 'create',
    });
  });

  it('resumes the exact file it was handed and replays its history', async () => {
    const fake = fakeRuntime({ history: [] });
    const { runtime } = build(fake, { sessionFile: '/elsewhere/old.jsonl' });
    live = runtime;
    const result = await runtime.bootstrap();
    expect(fake.options?.session).toEqual({
      file: '/elsewhere/old.jsonl',
      cwd: '/repo',
      mode: 'resume',
    });
    expect(result.initialHistory).toMatchObject({
      logicalSessionId: 'logical-1',
      workspacePath: '/repo',
    });
  });

  it('names the legacy source when it opened a converted copy instead', async () => {
    // A pre-v4 file is converted on resume, so the file that ends up open is
    // not the one Main asked for. Main accepts that only against a declared
    // source, and then moves the indexed identity onto the copy.
    const fake = fakeRuntime({
      history: [],
      file: '/elsewhere/old.jsonl.native-v4.jsonl',
      sourceFile: '/elsewhere/old.jsonl',
    });
    const { runtime } = build(fake, { sessionFile: '/elsewhere/old.jsonl' });
    live = runtime;
    const result = await runtime.bootstrap();
    expect(result.sessionFile).toBe('/elsewhere/old.jsonl.native-v4.jsonl');
    expect(result.sessionSourceFile).toBe('/elsewhere/old.jsonl');
  });

  it('is idempotent and does not build a second Cordis graph', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    const first = await runtime.bootstrap();
    expect(await runtime.bootstrap()).toBe(first);
  });

  it('does not cache a failed bootstrap', async () => {
    const fake = fakeRuntime();
    let attempts = 0;
    const { runtime } = build(fake, {
      create: async (options: RuntimeBootstrapOptions) => {
        attempts += 1;
        if (attempts === 1) throw new Error('catalog missing');
        fake.options = options;
        return fake.handle;
      },
    });
    live = runtime;
    await expect(runtime.bootstrap()).rejects.toThrow('catalog missing');
    // Main retries by resending worker.bootstrap; a cached rejection would make
    // every retry fail with the first error instead of the current one.
    await expect(runtime.bootstrap()).resolves.toMatchObject({ bootstrapped: true });
    expect(attempts).toBe(2);
  });

  it('carries the seeded permission axes and trust into the graph', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake, {
      permissions: { mode: 'plan', gear: 'accept-edits' },
      projectTrusted: false,
    });
    live = runtime;
    await runtime.bootstrap();
    expect(fake.options?.permissions).toMatchObject({
      mode: 'plan',
      gear: 'accept-edits',
      projectTrusted: false,
    });
    // The gate itself is handed in with the axes: without it the graph falls
    // back to the extension UI bridge and the renderer's permission card never
    // receives a `permission.requested` to draw.
    expect(typeof fake.options?.permissions?.approve).toBe('function');
  });

  it('offers delegation when the host said nothing about it (P5-2-5)', async () => {
    // An install with no prior preference gets the builtin catalog. The legacy
    // plugin's opt-in defaults to OFF for its own prompt-cost reasons, and
    // reading that as a decision about native delegation would leave every new
    // install without delegates nobody chose to remove.
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    expect(fake.options?.subagents).toBeDefined();
    expect(fake.options?.subagents?.disabled).toBeUndefined();
  });

  it('registers no delegation at all when the host explicitly disabled it (P5-2-5)', async () => {
    // Not "an empty catalog": no `subagents` key at all, so no `Task*` tool
    // schemas ride in a request the user does not want to pay for.
    const fake = fakeRuntime();
    const { runtime } = build(fake, { subagents: { enabled: false } });
    live = runtime;
    await runtime.bootstrap();
    expect(fake.options?.subagents).toBeUndefined();
  });

  it('carries the per-install disabled list into the graph (P5-2-5)', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake, { subagents: { enabled: true, disabled: ['fixer'] } });
    live = runtime;
    await runtime.bootstrap();
    expect(fake.options?.subagents?.disabled).toEqual(['fixer']);
  });

  it('names the missing variable when no agent dir is configured', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake, { agentDir: undefined, env: {} });
    live = runtime;
    await expect(runtime.bootstrap()).rejects.toThrow(/AICLIENT_RUNTIME_AGENT_DIR/);
  });
});

describe('NativeWorkerRuntime turns', () => {
  it('admits a send without waiting for the turn, then forwards its events', async () => {
    const fake = fakeRuntime();
    const { runtime, events } = build(fake);
    live = runtime;
    const accepted = await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: 'hello',
    });
    // Returning here while the run is still pending is the whole point: the RPC
    // chain is serialized, so a startSend that awaited the prompt would make
    // worker.stop undeliverable for the length of the turn.
    expect(accepted).toEqual({ accepted: true, requestId: 'turn-1' });
    expect(fake.runs[0]).toMatchObject({
      prompt: 'hello',
      runId: 'turn-1',
      logicalSessionId: 'logical-1',
    });
    fake.emit({ type: 'session.status', sessionId: 'logical-1', payload: { status: 'running' } });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'session.status', sessionId: 'logical-1' })
    );
    fake.settle();
  });

  it('rejects a second concurrent turn as retryable', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    const send = {
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: 'hello',
    };
    await runtime.startSend(send);
    await expect(runtime.startSend({ ...send, requestId: 'turn-2' })).rejects.toMatchObject({
      code: 'WORKER_SESSION_BUSY',
      retryable: true,
    });
    fake.settle();
  });

  it('parses the model reference the renderer sends', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: 'hi',
      model: 'anthropic/claude-opus-5',
    });
    expect(fake.runs[0]?.model).toEqual({ provider: 'anthropic', id: 'claude-opus-5' });
    fake.settle();
  });

  it('carries the effort the composer picked into the run as its thinking level', async () => {
    // EFFORT-1: the field pass picked `medium` and the trace still recorded
    // `thinking_level: off`, because the send never reached the loop's request.
    const fake = fakeRuntime();
    const { runtime } = build(fake, { effort: 'low' });
    live = runtime;
    await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: 'hi',
      effort: 'medium',
    });
    expect(fake.runs[0]?.thinkingLevel).toBe('medium');
    fake.settle();
  });

  it('falls back to the effort the session bootstrapped with', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake, { effort: 'high' });
    live = runtime;
    await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: 'hi',
    });
    expect(fake.runs[0]?.thinkingLevel).toBe('high');
    fake.settle();
  });

  it('stop aborts the run and settles parked approval dialogs', async () => {
    const fake = fakeRuntime();
    const { runtime, events } = build(fake);
    live = runtime;
    await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: 'hello',
    });
    const aborted = new Promise<void>((resolve) => {
      fake.runs[0]?.signal?.addEventListener('abort', () => resolve());
    });
    const stopping = runtime.stop({ logicalSessionId: 'logical-1', reason: 'user' });
    await aborted;
    // Aborting only unblocks the model loop; a tool waiting on a permission
    // answer is waiting on the bridge, which has to be settled separately.
    expect(fake.cancelled).toEqual(['aborted']);
    fake.settle({ success: false, stopReason: 'aborted' });
    await expect(stopping).resolves.toEqual({ stopped: true });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'session.status', payload: { status: 'stopping' } })
    );
  });

  it('stop with no active turn reports that it stopped nothing', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    await expect(runtime.stop({ logicalSessionId: 'logical-1', reason: 'user' })).resolves.toEqual({
      stopped: false,
    });
  });
});

describe('NativeWorkerRuntime session reads and lifecycle', () => {
  it('paginates history and reports the file it actually opened', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    const page = await runtime.history({ logicalSessionId: 'logical-1', offset: 0, limit: 10 });
    expect(page).toMatchObject({
      logicalSessionId: 'logical-1',
      sessionFile: SESSION_FILE,
      workspacePath: '/repo',
    });
    expect(page.page.messages).toEqual([]);
  });

  /**
   * P5-2-6 — the history answer carries the delegations this branch recorded,
   * so a reopened session can put their panels back.
   *
   * A reopened session gets no `subagent.activity` events: those are live, and
   * this conversation already happened. Without this the `Task` rows came back
   * with empty panels under them, which reads as "nothing happened" rather than
   * as "this ran last week".
   */
  it('reports the delegations recorded on the branch alongside the history page', async () => {
    const fake = fakeRuntime({
      entries: [
        {
          type: 'custom',
          customType: 'aiclient.subagent',
          data: {
            kind: 'started',
            delegationId: 'd1',
            agentName: 'explorer',
            parentToolCallId: 'toolu_1',
            runId: 'run-1',
            task: 'look around',
            model: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
            startedAt: 1000,
          },
        },
        {
          type: 'custom',
          customType: 'aiclient.subagent',
          data: {
            kind: 'settled',
            delegationId: 'd1',
            agentName: 'explorer',
            parentToolCallId: 'toolu_1',
            runId: 'run-1',
            status: 'completed',
            turns: 3,
            toolCalls: 5,
            report: 'Three config files.',
            completedAt: 4000,
          },
        },
      ],
    });
    const { runtime } = build(fake);
    live = runtime;
    const page = await runtime.history({ logicalSessionId: 'logical-1' });
    expect(page.subagents).toEqual([
      {
        delegationId: 'd1',
        parentToolCallId: 'toolu_1',
        agentName: 'explorer',
        status: 'completed',
        startedAt: 1000,
        completedAt: 4000,
        turns: 3,
        toolCalls: 5,
        report: 'Three config files.',
        model: 'anthropic/claude-sonnet-5',
      },
    ]);
  });

  it('leaves the key off entirely for a session that never delegated', async () => {
    // Absent means "nothing to report", which is what lets the renderer tell it
    // apart from a backend that cannot report delegations at all.
    const { runtime } = build(fakeRuntime());
    live = runtime;
    expect(await runtime.history({ logicalSessionId: 'logical-1' })).not.toHaveProperty(
      'subagents'
    );
  });

  it('refuses requests addressed to another logical session', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    await expect(runtime.history({ logicalSessionId: 'someone-else' })).rejects.toMatchObject({
      code: 'WORKER_SESSION_MISMATCH',
    });
  });

  it('applies a permission change and refuses one mid-turn', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    runtime.setPermissions({ mode: 'agent', gear: 'auto' });
    expect(fake.configured).toEqual([{ mode: 'agent', gear: 'auto' }]);
    await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: 'hi',
    });
    expect(() => runtime.setPermissions({ mode: 'plan', gear: 'ask' })).toThrow(/active/);
    fake.settle();
  });

  it('dispose aborts the turn, unsubscribes, and disposes the graph once', async () => {
    const fake = fakeRuntime();
    const { runtime, events } = build(fake);
    live = runtime;
    await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: 'hello',
    });
    const disposing = runtime.dispose();
    fake.settle({ success: false, stopReason: 'aborted' });
    await disposing;
    live = undefined;
    expect(fake.disposed).toBe(1);
    const before = events.length;
    fake.emit({ type: 'session.status', sessionId: 'logical-1', payload: { status: 'idle' } });
    // A disposed worker must not keep writing to a port Main has moved on from.
    expect(events.length).toBe(before);
    await runtime.dispose();
    expect(fake.disposed).toBe(1);
  });

  it('finishes disposing even when the graph tear-down rejects', async () => {
    const fake = fakeRuntime({ disposeFails: true });
    const logged: string[] = [];
    const { runtime } = build(fake, { log: (...args: unknown[]) => logged.push(String(args[0])) });
    await runtime.bootstrap();
    // The worker process exits on the back of this call, so a graph that fails
    // to shut down must not take the exit path with it. The failure is logged,
    // not swallowed silently.
    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(fake.disposed).toBe(1);
    expect(logged.join(' ')).toContain('graph dispose failed');
    // And the slot is really finished: idempotent, and closed for new work.
    await runtime.dispose();
    expect(fake.disposed).toBe(1);
    await expect(
      runtime.startSend({
        logicalSessionId: 'logical-1',
        requestId: 'turn-1',
        attemptId: 'a1',
        text: 'hello',
      })
    ).rejects.toMatchObject({ code: 'WORKER_SESSION_DISPOSED' });
  });

  it('a reload whose tear-down fails leaves the slot refusing reads, not answering from a dead graph', async () => {
    const fake = fakeRuntime({ disposeFails: true });
    const { runtime } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    await expect(
      runtime.reload({ logicalSessionId: 'logical-1', sessionFile: SESSION_FILE })
    ).rejects.toThrow(/graph tear-down failed/);
    // Main retires the slot on any reload failure; what must not happen is this
    // worker going on to answer history out of the graph it just tore down.
    await expect(runtime.history({ logicalSessionId: 'logical-1' })).rejects.toMatchObject({
      code: 'WORKER_NOT_BOOTSTRAPPED',
    });
  });
});

/**
 * R02-c — `/compact` holds the serialized RPC chain for one provider request,
 * so its clock is part of its contract: Main waits on a budget of its own, and
 * a worker that outlived that budget would write a summary the user had already
 * been told had failed.
 */
describe('NativeWorkerRuntime compaction', () => {
  const compactInput = { logicalSessionId: 'logical-1' };

  it('carries an abort signal into the summary and gives up on its own clock', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const fake = fakeRuntime({
      prepareTurn: async (request) => {
        seen.push(request.signal);
        // Stands in for a provider that is still thinking: it answers only when
        // the request is cancelled, which is what the signal is for.
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener('abort', () => resolve());
        });
        return {};
      },
    });
    const { runtime } = build(fake, { compactTimeoutMs: 20 });
    live = runtime;
    await runtime.bootstrap();
    await expect(runtime.compact(compactInput)).rejects.toMatchObject({
      code: 'WORKER_COMPACT_TIMEOUT',
      retryable: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
  });

  it('still reports an empty conversation as nothing to compact, not as a timeout', async () => {
    const fake = fakeRuntime({
      prepareTurn: async () => ({
        skipped: { code: 'compaction_empty_range', message: 'there is nothing to compact yet' },
      }),
    });
    const { runtime } = build(fake, { compactTimeoutMs: 5_000 });
    live = runtime;
    await runtime.bootstrap();
    await expect(runtime.compact(compactInput)).rejects.toMatchObject({
      code: 'WORKER_COMPACT_UNAVAILABLE',
      message: 'there is nothing to compact yet',
    });
  });

  it('reports a compaction that finished inside the budget', async () => {
    const fake = fakeRuntime({ prepareTurn: async () => ({ compaction: { reason: 'user' } }) });
    const { runtime } = build(fake, { compactTimeoutMs: 5_000 });
    live = runtime;
    await runtime.bootstrap();
    await expect(runtime.compact(compactInput)).resolves.toEqual({ compacted: true });
  });

  it('says so when the graph was built without compaction at all', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    await expect(runtime.compact(compactInput)).rejects.toMatchObject({
      code: 'WORKER_COMPACT_UNAVAILABLE',
    });
  });
});

describe('NativeWorkerRuntime slash commands (P5-1)', () => {
  it('turns discovery on when it builds the graph', async () => {
    const fake = fakeRuntime({ skills: SKILLS_SERVICE_FAKE });
    const { runtime } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    // Empty, not populated: every root is derived inside `skillRoots()`, and a
    // second copy here is how the worker and the loader start disagreeing about
    // where a project skill lives.
    expect(fake.options?.skills).toEqual({});
  });

  it('lists templates then skills, keeping the skill: prefix that makes them work', async () => {
    const fake = fakeRuntime({ skills: SKILLS_SERVICE_FAKE });
    const { runtime } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    await expect(runtime.commands({ logicalSessionId: 'logical-1' })).resolves.toEqual({
      truncated: false,
      commands: [
        {
          name: 'review',
          description: 'Review staged changes',
          source: 'prompt',
          path: '/agent/prompts/review.md',
          scope: 'user',
        },
        {
          name: 'skill:pdf',
          description: 'Extract text',
          source: 'skill',
          path: '/agent/skills/pdf/SKILL.md',
          scope: 'user',
        },
      ],
    });
  });

  it('answers an empty list when the graph has no skills service', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    await expect(runtime.commands({ logicalSessionId: 'logical-1' })).resolves.toEqual({
      commands: [],
      truncated: false,
    });
  });

  it('sends the expansion, not what was typed', async () => {
    const fake = fakeRuntime({ skills: SKILLS_SERVICE_FAKE });
    const { runtime } = build(fake);
    live = runtime;
    await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: '/review HEAD',
    });
    expect(fake.runs[0].prompt).toBe('Review HEAD.');
    fake.settle();
  });

  it('sends an unknown command through untouched', async () => {
    const fake = fakeRuntime({ skills: SKILLS_SERVICE_FAKE });
    const { runtime } = build(fake);
    live = runtime;
    await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: '/nothing here',
    });
    expect(fake.runs[0].prompt).toBe('/nothing here');
    fake.settle();
  });

  it('still sends the turn when expansion throws', async () => {
    const fake = fakeRuntime({
      skills: {
        ...SKILLS_SERVICE_FAKE,
        expand: async () => {
          throw new Error('skill file vanished');
        },
      },
    });
    const { runtime } = build(fake);
    live = runtime;
    await runtime.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'a1',
      text: '/review HEAD',
    });
    // A convenience that broke must not cost the user their message.
    expect(fake.runs[0].prompt).toBe('/review HEAD');
    fake.settle();
  });
});

describe('NativeWorkerRuntime questions (F5)', () => {
  it('gives the graph an ask callback, and answers what that callback parks', async () => {
    const fake = fakeRuntime();
    const { runtime, events } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    const ask = fake.options?.tools?.ask;
    // Without this the `ask` tool is never registered and the model has no way
    // to reach the user at all — the exact state F5 describes.
    expect(typeof ask).toBe('function');

    const parked = ask?.(
      {
        questionId: 'call-1',
        questions: [{ id: 'call-1-0', question: 'Which?', options: [{ label: 'A' }] }],
      },
      undefined
    );
    expect(events.at(-1)).toMatchObject({
      type: 'question.requested',
      sessionId: 'logical-1',
      payload: { questionId: 'call-1' },
    });
    expect(runtime.respondQuestion({ questionId: 'call-1', answers: { 'call-1-0': 'A' } })).toBe(
      true
    );
    await expect(parked).resolves.toEqual({ outcome: 'answered', answers: { 'call-1-0': 'A' } });
    expect(events.at(-1)).toMatchObject({ type: 'question.resolved' });
  });

  it('reports false for a question nobody is waiting on', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    expect(runtime.respondQuestion({ questionId: 'ghost', cancel: true })).toBe(false);
  });

  it('dispose settles a parked question instead of stranding the tool call', async () => {
    const fake = fakeRuntime();
    const { runtime } = build(fake);
    live = runtime;
    await runtime.bootstrap();
    const parked = fake.options?.tools?.ask?.(
      {
        questionId: 'call-1',
        questions: [{ id: 'call-1-0', question: 'Which?', options: [{ label: 'A' }] }],
      },
      undefined
    );
    await runtime.dispose();
    live = undefined;
    await expect(parked).resolves.toEqual({ outcome: 'cancelled' });
  });
});
