import { describe, expect, it, vi } from 'vitest';
import type { PiWorkerRuntimeOptions } from '../../../agent-host/piWorkerRpcServer.ts';
import {
  DSH_COMPLETION_REQUEST_INVALID,
  DSH_COMPLETION_UNAVAILABLE,
  DSH_SEED_REQUEST_INVALID,
  DSH_SEED_UNAVAILABLE,
  type DshHostToMainMessage,
  type DshSeedSessionResult,
  isDshHostCompleted,
  isDshHostPage,
  isDshHostSeeded,
} from '../../../shared/types/dshHostProtocol.ts';
import { WORKER_RPC_PROTOCOL_VERSION } from '../../../shared/types/workerRpc.ts';
import {
  type ChannelRuntime,
  DSH_READ_FAILED,
  DshChannelMux,
  type DshChannelMuxOptions,
} from '../channelMux.ts';

/**
 * dsh-rebase P1-3a — the shared host's bridge multiplexer (BR cases of the
 * P1-3 plan) against fake session runtimes: no DSH package, no process. The
 * real engine is exercised by `tools/bridge-smoke.ts`.
 */

interface FakeRuntime {
  busy: boolean;
  disposed: number;
  options: PiWorkerRuntimeOptions;
}

function harness(options: { hangingDispose?: boolean } = {}) {
  const sent: DshHostToMainMessage[] = [];
  const runtimes: FakeRuntime[] = [];
  const log = vi.fn();
  const mux = new DshChannelMux({
    send: (message) => sent.push(message),
    createRuntime: (runtimeOptions) => {
      const runtime = {
        busy: false,
        disposed: 0,
        options: runtimeOptions,
        async bootstrap() {
          return {
            bootstrapped: true,
            logicalSessionId: runtimeOptions.logicalSessionId,
            piSessionId: `aiclient-${runtimeOptions.logicalSessionId}`,
            cwd: runtimeOptions.cwd,
            agentDir: '/dsh-home',
            sessionFile: `/dsh-home/aiclient-sessions/${runtimeOptions.logicalSessionId}.dsh.json`,
            leaf: { activeEntryId: null, fileTailEntryId: null },
            projectTrusted: true,
            permissionGate: 'bundled',
          };
        },
        async startSend(input: { requestId: string }) {
          runtimeOptions.emit({
            type: 'session.status',
            sessionId: runtimeOptions.logicalSessionId,
            requestId: input.requestId,
            payload: { status: 'running' },
          });
          return { accepted: true, requestId: input.requestId };
        },
        async dispose() {
          runtime.disposed += 1;
          if (options.hangingDispose) await new Promise(() => {});
        },
      };
      runtimes.push(runtime);
      return runtime as unknown as ChannelRuntime;
    },
    sample: () => ({ eldMaxMs: 1.5, rssMb: 180.2 }),
    log,
  });
  return { mux, sent, runtimes, log };
}

function rpc(type: string, payload: unknown, requestId: string, generation = 1) {
  return {
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'request',
    generation,
    requestId,
    type,
    payload,
  };
}

function bootstrap(ch: string, session: string, requestId = `boot-${ch}`, generation = 1) {
  return {
    ch,
    rpc: rpc(
      'worker.bootstrap',
      { logicalSessionId: session, cwd: '/repo' },
      requestId,
      generation
    ),
  };
}

/** Lets each channel's request chain run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));
}

function responses(sent: DshHostToMainMessage[], ch: string) {
  return sent
    .filter((message) => 'ch' in message && 'rpc' in message && message.ch === ch)
    .map((message) => (message as unknown as { rpc: Record<string, unknown> }).rpc)
    .filter((message) => message.kind === 'response');
}

describe('DshChannelMux — opening channels (BR-01)', () => {
  it('opens a channel on worker.bootstrap and answers on that channel', async () => {
    const h = harness();
    expect(h.mux.receive(bootstrap('c1-1', 's1'))).toBe(true);
    await settle();
    expect(responses(h.sent, 'c1-1')).toEqual([
      expect.objectContaining({ requestId: 'boot-c1-1', ok: true, generation: 1 }),
    ]);
    expect(h.mux.status()).toEqual([{ ch: 'c1-1', busy: false }]);
    expect(h.runtimes).toHaveLength(1);
  });

  it('answers any other request for an unknown channel WORKER_CHANNEL_UNKNOWN, with its own generation and id', async () => {
    const h = harness();
    h.mux.receive({ ch: 'c2-9', rpc: rpc('worker.history', { logicalSessionId: 's1' }, 'r-9', 4) });
    await settle();
    expect(h.sent).toEqual([
      {
        ch: 'c2-9',
        rpc: {
          protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
          kind: 'response',
          generation: 4,
          requestId: 'r-9',
          ok: false,
          error: {
            code: 'WORKER_CHANNEL_UNKNOWN',
            message: expect.stringContaining('c2-9'),
            retryable: false,
          },
        },
      },
    ]);
    expect(h.runtimes).toHaveLength(0);
    expect(h.mux.status()).toEqual([]);
  });

  it('drops what cannot be answered: a non-request, or an opening request without a generation', async () => {
    const h = harness();
    h.mux.receive({ ch: 'c1-1', rpc: { kind: 'event', type: 'runtime.event', payload: {} } });
    h.mux.receive(bootstrap('c1-2', 's2', 'boot', 0));
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.runtimes).toHaveLength(0);
    expect(h.log).toHaveBeenCalledTimes(2);
  });

  it('leaves everything that is not the bridge’s to the other listeners', () => {
    const h = harness();
    for (const message of [
      { type: 'shutdown' },
      { type: 'create-session', requestId: 'p1' },
      { p06: 'mem', requestId: 'p2' },
      null,
      'text',
    ]) {
      expect(h.mux.receive(message)).toBe(false);
    }
    expect(h.sent).toEqual([]);
  });

  it('consumes an unknown host control kind with one diagnostic, and a malformed envelope too', () => {
    const h = harness();
    expect(h.mux.receive({ host: 'credential', id: 1 })).toBe(true);
    expect(h.mux.receive({ host: 'credential', id: 2 })).toBe(true);
    expect(h.mux.receive({ ch: 'slot-1', rpc: {} })).toBe(true);
    // A gc without an id cannot be answered: dropped with its own diagnostic.
    expect(h.mux.receive({ host: 'gc', claimed: [] })).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.log).toHaveBeenCalledTimes(3);
    expect(h.log).toHaveBeenLastCalledWith('dropped a malformed gc request');
  });
});

describe('DshChannelMux — gc (P1-3d, decision 024)', () => {
  const outcome = {
    ok: true,
    deleted: ['aiclient-old'],
    stubsDeleted: 1,
    skipped: { claimed: 2 },
    ms: 3,
  };

  it('hands a gc to the collector and answers gc-result with its id', async () => {
    const h = harness();
    const collect = vi.fn(async () => outcome);
    const mux = new DshChannelMux({
      send: (message) => h.sent.push(message),
      createRuntime: () => {
        throw new Error('unused');
      },
      sample: () => ({ eldMaxMs: 0, rssMb: 0 }),
      collectSessions: collect,
      log: h.log,
    });
    expect(mux.receive({ host: 'gc', id: 7, claimed: ['aiclient-s1'], graceMs: 1000 })).toBe(true);
    await settle();
    expect(collect).toHaveBeenCalledWith({ claimed: ['aiclient-s1'], graceMs: 1000 });
    expect(h.sent).toEqual([{ host: 'gc-result', id: 7, ...outcome }]);
  });

  it('runs one pass at a time, in order', async () => {
    const h = harness();
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((done) => {
      release = done;
    });
    const collect = vi.fn(async (request: { graceMs: number }) => {
      order.push(`start ${request.graceMs}`);
      if (request.graceMs === 1) await first;
      order.push(`end ${request.graceMs}`);
      return outcome;
    });
    const mux = new DshChannelMux({
      send: (message) => h.sent.push(message),
      createRuntime: () => {
        throw new Error('unused');
      },
      sample: () => ({ eldMaxMs: 0, rssMb: 0 }),
      collectSessions: collect,
      log: h.log,
    });
    mux.receive({ host: 'gc', id: 1, claimed: [], graceMs: 1 });
    mux.receive({ host: 'gc', id: 2, claimed: [], graceMs: 2 });
    await settle();
    expect(order).toEqual(['start 1']);
    release();
    await settle();
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    expect(h.sent.map((message) => (message as { id?: number }).id)).toEqual([1, 2]);
  });

  it('answers ok: false, never throws, when the collector fails or is missing', async () => {
    const h = harness();
    h.mux.receive({ host: 'gc', id: 1, claimed: [], graceMs: 0 });
    await settle();
    expect(h.sent).toEqual([
      expect.objectContaining({
        host: 'gc-result',
        id: 1,
        ok: false,
        deleted: [],
        stubsDeleted: 0,
      }),
    ]);
    const failing = new DshChannelMux({
      send: (message) => h.sent.push(message),
      createRuntime: () => {
        throw new Error('unused');
      },
      sample: () => ({ eldMaxMs: 0, rssMb: 0 }),
      collectSessions: async () => {
        throw new Error('list failed');
      },
      log: h.log,
    });
    failing.receive({ host: 'gc', id: 2, claimed: [], graceMs: 0 });
    await settle();
    expect(h.sent.at(-1)).toMatchObject({
      host: 'gc-result',
      id: 2,
      ok: false,
      error: 'list failed',
    });
  });
});

describe('DshChannelMux — readPage (P1-4a, decision 030)', () => {
  const page = {
    messages: [
      { id: 'h:u1', role: 'user', blocks: [{ type: 'text', id: 'h:u1:text:0', text: 'hi' }] },
    ],
    offset: 0,
    limit: 80,
    totalCount: 1,
    hasMore: false,
  } as const;
  const request = {
    host: 'readPage',
    id: 5,
    stubFile: '/dsh-home/aiclient-sessions/aiclient-s1.dsh.json',
    logicalSessionId: 's1',
  };

  function reader(readPage: NonNullable<DshChannelMuxOptions['readPage']> | undefined) {
    const sent: DshHostToMainMessage[] = [];
    const log = vi.fn();
    const createRuntime = vi.fn(() => {
      throw new Error('a read opens no channel');
    });
    const mux = new DshChannelMux({
      send: (message) => sent.push(message),
      createRuntime,
      sample: () => ({ eldMaxMs: 0, rssMb: 0 }),
      ...(readPage ? { readPage } : {}),
      log,
    });
    return { mux, sent, log, createRuntime };
  }

  it('hands the read over and answers page with its id, the page and the time it took', async () => {
    const readPage = vi.fn(async () => structuredClone(page) as never);
    const h = reader(readPage);
    expect(h.mux.receive({ ...request, offset: 80, limit: 40 })).toBe(true);
    await settle();
    expect(readPage).toHaveBeenCalledWith({
      stubFile: request.stubFile,
      logicalSessionId: 's1',
      offset: 80,
      limit: 40,
    });
    expect(h.sent).toEqual([{ host: 'page', id: 5, ok: true, page, ms: expect.any(Number) }]);
    expect(isDshHostPage(h.sent[0])).toBe(true);
    // No channel, no runtime: nothing for Main to close afterwards.
    expect(h.createRuntime).not.toHaveBeenCalled();
    expect(h.mux.status()).toEqual([]);
  });

  it('answers ok: false with the failure’s own code, dsh_read_failed without one, and never throws', async () => {
    const readPage = vi
      .fn<NonNullable<DshChannelMuxOptions['readPage']>>()
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'dsh_session_missing' }))
      .mockImplementationOnce(() => {
        throw new Error('sync failure');
      });
    const h = reader(readPage);
    h.mux.receive({ ...request, id: 1 });
    h.mux.receive({ ...request, id: 2 });
    await settle();
    // Side by side: in whichever order they finish.
    const byId = [...h.sent].sort(
      (a, b) => Number((a as { id?: number }).id) - Number((b as { id?: number }).id)
    );
    expect(byId).toEqual([
      {
        host: 'page',
        id: 1,
        ok: false,
        error: { code: 'dsh_session_missing', message: 'gone' },
        ms: expect.any(Number),
      },
      {
        host: 'page',
        id: 2,
        ok: false,
        error: { code: DSH_READ_FAILED, message: 'sync failure' },
        ms: expect.any(Number),
      },
    ]);
    expect(h.sent.every(isDshHostPage)).toBe(true);

    const none = reader(undefined);
    none.mux.receive(request);
    await settle();
    expect(none.sent).toEqual([
      expect.objectContaining({
        host: 'page',
        id: 5,
        ok: false,
        error: expect.objectContaining({ code: DSH_READ_FAILED }),
      }),
    ]);
  });

  it('runs reads side by side: a slow one holds up neither a later read nor a ping', async () => {
    let release!: () => void;
    const slow = new Promise<void>((done) => {
      release = done;
    });
    const readPage = vi.fn(async (input: { logicalSessionId: string }) => {
      if (input.logicalSessionId === 'slow') await slow;
      return structuredClone(page) as never;
    });
    const h = reader(readPage);
    h.mux.receive({ ...request, id: 1, logicalSessionId: 'slow' });
    h.mux.receive({ ...request, id: 2 });
    h.mux.receive({ host: 'ping', id: 3 });
    await settle();
    expect(
      h.sent.map(
        (message) =>
          `${String((message as { host?: string }).host)}:${String((message as { id?: number }).id)}`
      )
    ).toEqual(['pong:3', 'page:2']);
    release();
    await settle();
    expect((h.sent.at(-1) as { id?: number }).id).toBe(1);
  });

  it('drops a readPage it could not answer with one diagnostic', () => {
    const readPage = vi.fn();
    const h = reader(readPage);
    expect(h.mux.receive({ host: 'readPage', stubFile: 'x', logicalSessionId: 's1' })).toBe(true);
    expect(h.mux.receive({ ...request, limit: 501 })).toBe(true);
    expect(readPage).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith('dropped a malformed readPage request');
  });
});

describe('DshChannelMux — seedSession (P1-9c, decision 054)', () => {
  const request = {
    host: 'seedSession',
    id: 7,
    kind: 'pi-file',
    sourceFile: '/profile/pi-agent/sessions/s1.jsonl',
    logicalSessionId: 's1',
    cwd: '/work',
    expect: { bytes: 10, mtimeMs: 1.5 },
  } as const;
  const result: DshSeedSessionResult = {
    stubFile: '/dsh-home/aiclient-sessions/aiclient-s1.dsh.json',
    dshSessionId: 'aiclient-s1',
    reused: false,
    source: { sha256: 'a'.repeat(64), bytes: 10, mtimeMs: 1.5 },
    converted: 'source',
    legacyPermissions: null,
    grants: 0,
    images: { admitted: 0, refused: 0 },
    report: {
      converterVersion: 2,
      source: { kind: 'pi-session', generation: 'native-v4', entries: {} },
    },
  };

  function migrator(seedSession: DshChannelMuxOptions['seedSession']) {
    const sent: DshHostToMainMessage[] = [];
    const log = vi.fn();
    const mux = new DshChannelMux({
      send: (message) => sent.push(message),
      createRuntime: () => {
        throw new Error('a migration opens no channel');
      },
      sample: () => ({ eldMaxMs: 0, rssMb: 0 }),
      ...(seedSession ? { seedSession } : {}),
      log,
    });
    return { mux, sent, log };
  }

  it('hands the fields over and answers seeded with its id and what was made', async () => {
    const seedSession = vi.fn(async () => structuredClone(result));
    const h = migrator(seedSession);
    expect(h.mux.receive(request)).toBe(true);
    await settle();
    const { host: _host, id: _id, ...fields } = request;
    expect(seedSession).toHaveBeenCalledWith(fields);
    expect(h.sent).toEqual([{ host: 'seeded', id: 7, ok: true, result, ms: expect.any(Number) }]);
    expect(isDshHostSeeded(h.sent[0])).toBe(true);
    expect(h.mux.status()).toEqual([]);
  });

  it('hands an import over the same way, and answers with the import’s result (P1-9f)', async () => {
    const imported = {
      kind: 'imported-conversation' as const,
      stubFile: '/dsh-home/aiclient-sessions/aiclient-imp1.dsh.json',
      dshSessionId: 'aiclient-imp1',
      reused: false,
      images: { admitted: 0, refused: 0 },
      report: {
        converterVersion: 2,
        source: { kind: 'imported-conversation' as const, generation: 'codex', entries: {} },
      },
    };
    const seedSession = vi.fn(async () => structuredClone(imported));
    const h = migrator(seedSession);
    const importRequest = {
      host: 'seedSession',
      id: 9,
      kind: 'imported-conversation',
      conversation: { schemaVersion: 1, entries: [{ kind: 'user', text: 'hi' }] },
      logicalSessionId: 'imp1',
      cwd: '/work',
    } as const;
    expect(h.mux.receive(importRequest)).toBe(true);
    await settle();
    const { host: _host, id: _id, ...fields } = importRequest;
    expect(seedSession).toHaveBeenCalledWith(fields);
    expect(h.sent).toEqual([
      { host: 'seeded', id: 9, ok: true, result: imported, ms: expect.any(Number) },
    ]);
    expect(isDshHostSeeded(h.sent[0])).toBe(true);
  });

  it('answers where it stopped: the failure’s stage, code and retryable, or create / seed_failed', async () => {
    const seedSession = vi
      .fn<NonNullable<DshChannelMuxOptions['seedSession']>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('busy'), { stage: 'read', code: 'source_busy', retryable: true })
      )
      .mockRejectedValueOnce(new Error('no idea'));
    const h = migrator(seedSession);
    h.mux.receive({ ...request, id: 1 });
    h.mux.receive({ ...request, id: 2 });
    await settle();
    expect(h.sent).toEqual([
      {
        host: 'seeded',
        id: 1,
        ok: false,
        error: { stage: 'read', code: 'source_busy', message: 'busy', retryable: true },
        ms: expect.any(Number),
      },
      {
        host: 'seeded',
        id: 2,
        ok: false,
        error: { stage: 'create', code: 'seed_failed', message: 'no idea', retryable: false },
        ms: expect.any(Number),
      },
    ]);
    expect(h.sent.every(isDshHostSeeded)).toBe(true);
  });

  it('runs one migration at a time, in arrival order, and a ping is not held behind them', async () => {
    let release!: () => void;
    const slow = new Promise<void>((done) => {
      release = done;
    });
    const started: number[] = [];
    const seedSession = vi.fn(async (fields: { logicalSessionId: string }) => {
      started.push(fields.logicalSessionId === 'slow' ? 1 : 2);
      if (fields.logicalSessionId === 'slow') await slow;
      return structuredClone(result);
    });
    const h = migrator(seedSession);
    h.mux.receive({ ...request, id: 1, logicalSessionId: 'slow' });
    h.mux.receive({ ...request, id: 2 });
    h.mux.receive({ host: 'ping', id: 3 });
    await settle();
    expect(started).toEqual([1]);
    expect(h.sent.map((message) => (message as { host?: string }).host)).toEqual(['pong']);
    release();
    await settle();
    expect(started).toEqual([1, 2]);
    expect(h.sent.map((message) => (message as { id?: number }).id)).toEqual([3, 1, 2]);
  });

  it('answers a request it cannot run, and one whose fields are wrong, instead of dropping it', async () => {
    const none = migrator(undefined);
    none.mux.receive(request);
    await settle();
    expect(none.sent).toEqual([
      expect.objectContaining({
        host: 'seeded',
        id: 7,
        ok: false,
        error: expect.objectContaining({ stage: 'request', code: DSH_SEED_UNAVAILABLE }),
      }),
    ]);
    const seedSession = vi.fn();
    const h = migrator(seedSession);
    expect(h.mux.receive({ ...request, kind: 'imported-conversation' })).toBe(true);
    expect(h.mux.receive({ ...request, id: 8, expect: { bytes: -1, mtimeMs: 0 } })).toBe(true);
    expect(h.mux.receive({ ...request, id: 0, cwd: '' })).toBe(true);
    expect(seedSession).not.toHaveBeenCalled();
    expect(h.sent).toEqual([
      expect.objectContaining({
        id: 7,
        ok: false,
        error: expect.objectContaining({ stage: 'request', code: DSH_SEED_REQUEST_INVALID }),
      }),
      expect.objectContaining({ id: 8, ok: false }),
    ]);
    expect(h.sent.every(isDshHostSeeded)).toBe(true);
    // No usable id: nobody to answer, one diagnostic.
    expect(h.log).toHaveBeenCalledWith('dropped a malformed seedSession request');
  });
});

/**
 * P1-15 (decision 125): a one-shot completion is no channel's. The mux hands
 * it to the completions, which answer it themselves; the mux answers only what
 * they cannot: a host without them, and a request whose fields are wrong.
 */
describe('DshChannelMux — one-shot completions (P1-15, decision 125)', () => {
  const request = {
    host: 'complete',
    id: 5,
    purpose: 'branch-name',
    prompt: 'Name a branch for: add login',
    timeoutMs: 120_000,
  } as const;

  function completer(completions: DshChannelMuxOptions['completions']) {
    const sent: DshHostToMainMessage[] = [];
    const log = vi.fn();
    const mux = new DshChannelMux({
      send: (message) => sent.push(message),
      createRuntime: () => {
        throw new Error('a completion opens no channel');
      },
      sample: () => ({ eldMaxMs: 0, rssMb: 0 }),
      ...(completions ? { completions } : {}),
      log,
    });
    return { mux, sent, log };
  }

  it('hands a request and a cancel to the completions, opening no channel', () => {
    const start = vi.fn();
    const cancel = vi.fn();
    const h = completer({ start, cancel });
    expect(h.mux.receive(request)).toBe(true);
    expect(h.mux.receive({ host: 'complete-cancel', id: 5 })).toBe(true);
    expect(start).toHaveBeenCalledWith(request);
    expect(cancel).toHaveBeenCalledWith(5);
    expect(h.sent).toEqual([]);
    expect(h.mux.status()).toEqual([]);
  });

  it('answers completion_unavailable without completions, or when starting one throws', () => {
    const none = completer(undefined);
    none.mux.receive(request);
    // A cancel for nothing is simply consumed.
    expect(none.mux.receive({ host: 'complete-cancel', id: 5 })).toBe(true);
    expect(none.sent).toEqual([
      {
        host: 'completed',
        id: 5,
        ok: false,
        error: { code: DSH_COMPLETION_UNAVAILABLE, message: expect.any(String) },
        ms: 0,
      },
    ]);
    const broken = completer({
      start: () => {
        throw new Error('bug');
      },
      cancel: vi.fn(),
    });
    broken.mux.receive(request);
    expect(broken.sent).toEqual([
      expect.objectContaining({
        id: 5,
        ok: false,
        error: { code: DSH_COMPLETION_UNAVAILABLE, message: 'bug' },
      }),
    ]);
    expect(none.sent.concat(broken.sent).every(isDshHostCompleted)).toBe(true);
  });

  it('answers a request with a usable id and wrong fields, and drops one without an id', () => {
    const start = vi.fn();
    const h = completer({ start, cancel: vi.fn() });
    expect(h.mux.receive({ ...request, purpose: 'title' })).toBe(true);
    expect(h.mux.receive({ ...request, id: 6, prompt: '' })).toBe(true);
    expect(h.mux.receive({ ...request, id: 0 })).toBe(true);
    expect(h.mux.receive({ host: 'complete-cancel', id: 'x' })).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(h.sent).toEqual([
      expect.objectContaining({
        id: 5,
        ok: false,
        error: expect.objectContaining({ code: DSH_COMPLETION_REQUEST_INVALID }),
      }),
      expect.objectContaining({ id: 6, ok: false }),
    ]);
    expect(h.sent.every(isDshHostCompleted)).toBe(true);
    expect(h.log).toHaveBeenCalledWith('dropped a malformed complete request');
    expect(h.log).toHaveBeenCalledWith('dropped a malformed complete-cancel request');
  });

  it('never lets utility.start open a channel', async () => {
    const h = harness();
    h.mux.receive({
      ch: 'c1-9',
      rpc: rpc(
        'utility.start',
        { operationId: 'op', cwd: '/repo', prompt: 'x', timeoutMs: 1000 },
        'u1'
      ),
    });
    await settle();
    expect(h.runtimes).toEqual([]);
    expect(responses(h.sent, 'c1-9')).toEqual([
      expect.objectContaining({
        requestId: 'u1',
        ok: false,
        error: expect.objectContaining({ code: 'WORKER_CHANNEL_UNKNOWN' }),
      }),
    ]);
  });
});

describe('DshChannelMux — isolation (BR-02)', () => {
  it('keeps each channel’s events, answers and generation to itself', async () => {
    const h = harness();
    h.mux.receive(bootstrap('c1-1', 's1', 'b1', 1));
    h.mux.receive(bootstrap('c1-2', 's2', 'b2', 7));
    await settle();
    h.mux.receive({
      ch: 'c1-1',
      rpc: rpc(
        'worker.send',
        { logicalSessionId: 's1', requestId: 'turn-1', attemptId: 'a1', text: 'hi' },
        'send-1',
        1
      ),
    });
    // The generation belongs to the channel: 1 is stale on c1-2.
    h.mux.receive({
      ch: 'c1-2',
      rpc: rpc(
        'worker.send',
        { logicalSessionId: 's2', requestId: 'turn-2', attemptId: 'a2', text: 'hi' },
        'send-2',
        1
      ),
    });
    await settle();
    const events = (ch: string) =>
      h.sent
        .filter((message) => 'ch' in message && message.ch === ch)
        .map((message) => (message as unknown as { rpc: Record<string, unknown> }).rpc)
        .filter((message) => message.kind === 'event')
        .map((message) => (message.payload as { sessionId: string }).sessionId);
    expect(events('c1-1')).toEqual(['s1']);
    expect(events('c1-2')).toEqual([]);
    expect(responses(h.sent, 'c1-1').map((message) => [message.requestId, message.ok])).toEqual([
      ['b1', true],
      ['send-1', true],
    ]);
    expect(responses(h.sent, 'c1-2').map((message) => [message.requestId, message.ok])).toEqual([
      ['b2', true],
      ['send-2', false],
    ]);
    expect(responses(h.sent, 'c1-2')[1]).toMatchObject({
      generation: 1,
      error: { code: 'WORKER_STALE_GENERATION' },
    });
  });
});

describe('DshChannelMux — closing channels (BR-03, BR-04)', () => {
  it('worker.dispose answers its ACK, then closed; the channel never comes back', async () => {
    const h = harness();
    h.mux.receive(bootstrap('c1-1', 's1'));
    await settle();
    h.mux.receive({ ch: 'c1-1', rpc: rpc('worker.dispose', { reason: 'slot-dispose' }, 'd1') });
    await settle();
    const tail = h.sent.slice(-2);
    expect(tail[0]).toMatchObject({ ch: 'c1-1', rpc: { requestId: 'd1', ok: true } });
    expect(tail[1]).toEqual({ host: 'closed', ch: 'c1-1' });
    expect(h.runtimes[0].disposed).toBe(1);
    expect(h.mux.status()).toEqual([]);
    // A late opening request cannot revive a closed id.
    h.mux.receive(bootstrap('c1-1', 's1', 'again'));
    await settle();
    expect(h.sent.at(-1)).toMatchObject({
      ch: 'c1-1',
      rpc: { requestId: 'again', ok: false, error: { code: 'WORKER_CHANNEL_UNKNOWN' } },
    });
    expect(h.runtimes).toHaveLength(1);
  });

  it('close disposes through the channel’s chain and answers closed, never its internal ACK', async () => {
    const h = harness();
    h.mux.receive(bootstrap('c1-1', 's1'));
    h.mux.receive(bootstrap('c1-2', 's2'));
    await settle();
    const before = h.sent.length;
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    await settle();
    expect(h.sent.slice(before)).toEqual([{ host: 'closed', ch: 'c1-1' }]);
    expect(h.runtimes[0].disposed).toBe(1);
    expect(h.runtimes[1].disposed).toBe(0);
    expect(h.mux.status()).toEqual([{ ch: 'c1-2', busy: false }]);
  });

  it('answers closed at once for a channel it never opened or already closed', async () => {
    const h = harness();
    h.mux.receive({ host: 'close', ch: 'c3-1' });
    expect(h.sent).toEqual([{ host: 'closed', ch: 'c3-1' }]);
    h.mux.receive(bootstrap('c3-2', 's1'));
    await settle();
    h.mux.receive({ ch: 'c3-2', rpc: rpc('worker.dispose', { reason: 'slot-dispose' }, 'd') });
    await settle();
    // The slot's own close can cross the host's `closed` on the wire.
    h.mux.receive({ host: 'close', ch: 'c3-2' });
    expect(h.sent.filter((message) => 'host' in message && message.host === 'closed')).toEqual([
      { host: 'closed', ch: 'c3-1' },
      { host: 'closed', ch: 'c3-2' },
      { host: 'closed', ch: 'c3-2' },
    ]);
  });

  it('never answers closed while the runtime’s disposal hangs (BR-04)', async () => {
    const h = harness({ hangingDispose: true });
    h.mux.receive(bootstrap('c1-1', 's1'));
    await settle();
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    await settle();
    expect(h.sent.some((message) => 'host' in message && message.host === 'closed')).toBe(false);
    expect(h.mux.status()).toEqual([{ ch: 'c1-1', busy: false }]);
    // Main's retry does not queue a second disposal behind the first.
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    await settle();
    expect(h.runtimes[0].disposed).toBe(1);
  });
});

describe('DshChannelMux — heartbeat (BR-05)', () => {
  it('answers ping at once, beside a channel whose chain is stuck, with busy flags', async () => {
    const h = harness({ hangingDispose: true });
    h.mux.receive(bootstrap('c1-1', 's1'));
    h.mux.receive(bootstrap('c1-2', 's2'));
    await settle();
    h.mux.receive({ host: 'close', ch: 'c1-1' });
    h.runtimes[1].busy = true;
    const before = h.sent.length;
    h.mux.receive({ host: 'ping', id: 42 });
    // Synchronous: no session work stands between a ping and its pong.
    expect(h.sent.slice(before)).toEqual([
      {
        host: 'pong',
        id: 42,
        eldMaxMs: 1.5,
        rssMb: 180.2,
        channels: [
          { ch: 'c1-1', busy: false },
          { ch: 'c1-2', busy: true },
        ],
      },
    ]);
  });
});
