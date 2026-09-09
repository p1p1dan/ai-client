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

function fakeRuntime(
  overrides: { history?: unknown[]; file?: string; sourceFile?: string } = {}
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
      tree: (id: string) => ({ logicalSessionId: id }),
    },
    permissions: {
      configure: (settings: unknown) => fake.configured.push(settings),
    },
    approval: { bridge: { cancelAll: (reason: string) => fake.cancelled.push(reason) } },
    run: (request: RuntimeRunRequest) => {
      fake.runs.push(request);
      return new Promise<RuntimeRunResult>((resolve) => {
        resolveRun = resolve;
      });
    },
    dispose: async () => {
      fake.disposed += 1;
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
    expect(fake.options?.permissions).toEqual({
      mode: 'plan',
      gear: 'accept-edits',
      projectTrusted: false,
    });
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
});
