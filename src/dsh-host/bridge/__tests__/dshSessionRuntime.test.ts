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
import {
  PiWorkerRpcServer,
  type PiWorkerRuntimeOptions,
} from '../../../agent-host/piWorkerRpcServer.ts';
import { INTERRUPTED_TURN_NOTICE_KEY } from '../../../shared/dshHistory/projection.ts';
import type { DshLogEvent } from '../../../shared/dshHistory/types.ts';
import {
  isWorkerBootstrapResult,
  isWorkerHistoryResult,
  isWorkerTreeResult,
  WORKER_RETRY_UNAVAILABLE,
  WORKER_RPC_PROTOCOL_VERSION,
} from '../../../shared/types/workerRpc.ts';
import {
  type DshBridgeContext,
  type DshBridgeDeps,
  DshSessionRuntime,
  dshSessionIdFor,
  INITIAL_HISTORY_LIMIT,
  type SessionStub,
  stubPathFor,
} from '../dshSessionRuntime.ts';

/**
 * dsh-rebase P1-1 — the bridge half of the engine cutover (decisions 006, 007
 * and 010), against a fake Cordis context: no DSH package is loaded, which is
 * why `createUserMessage` is injected. The real engine is exercised by
 * `tools/bridge-smoke.ts`.
 */

const CWD = '/repo';
const LOGICAL = 'session-1';
const DSH_ID = dshSessionIdFor(LOGICAL);

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function named(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

interface FakeOptions {
  createError?: unknown;
  flushError?: unknown;
  resumeError?: unknown;
  /** The cwd a resumed session's header carries. */
  headerCwd?: string;
  /** The log `sessionQuery.observeSession` answers with. */
  events?: DshLogEvent[];
  observeError?: unknown;
}

/** A Cordis context narrowed to what the bridge reads, recording the order of calls. */
function fakeDsh(options: FakeOptions = {}) {
  const calls: string[] = [];
  const disposed: string[] = [];
  const followups: unknown[] = [];
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const stubFile = stubPathFor(home, DSH_ID);
  const handle = (id: string, cwd: string | undefined) => ({
    agent: {
      id,
      status: 'idle',
      session: { header: { cwd } },
      followup: (message: unknown) => followups.push(message),
      cancel: () => undefined,
    },
    dispose: async () => {
      disposed.push(id);
    },
  });
  const ctx = {
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    agents: {
      create: vi.fn(async (input: { sessionId: string; meta: { cwd: string } }) => {
        calls.push(`create ${input.sessionId} stub=${existsSync(stubFile)}`);
        if (options.createError) throw options.createError;
        return handle(input.sessionId, input.meta.cwd);
      }),
      resume: vi.fn(async (input: { resumeSessionId: string }) => {
        calls.push(`resume ${input.resumeSessionId}`);
        if (options.resumeError) throw options.resumeError;
        return handle(input.resumeSessionId, options.headerCwd ?? CWD);
      }),
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'aiclient-gateway', model: 'fake-1' }),
    },
    sessions: {
      flush: vi.fn(async () => {
        calls.push(`flush stub=${existsSync(stubFile)}`);
        if (options.flushError) throw options.flushError;
        return true;
      }),
    },
    sessionQuery: {
      observeSession: vi.fn(async () => {
        if (options.observeError) throw options.observeError;
        const events = options.events ?? [];
        return { events, cursor: events.at(-1)?.seq ?? -1, [Symbol.dispose]: () => undefined };
      }),
    },
  } as unknown as DshBridgeContext;
  /** One durable event of this session, as DSH's `session/event` delivers it. */
  const append = (event: DshLogEvent) => listeners.get('session/event')?.({ id: DSH_ID }, event);
  return { ctx, calls, disposed, followups, stubFile, append };
}

const deps: DshBridgeDeps = {
  createUserMessage: vi.fn(() => ({ id: 'user-message-1' })),
  now: () => 1_700_000_000_000,
};

function runtime(
  ctx: DshBridgeContext,
  extra: Partial<PiWorkerRuntimeOptions> = {}
): DshSessionRuntime {
  return new DshSessionRuntime(
    ctx,
    {
      logicalSessionId: LOGICAL,
      cwd: CWD,
      projectTrusted: true,
      emit: () => undefined,
      ...extra,
    },
    { ...deps, home }
  );
}

function writeStub(stub: Partial<SessionStub> = {}): string {
  const file = stubPathFor(home, DSH_ID);
  mkdirSync(join(home, 'aiclient-sessions'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      engine: 'dsh',
      version: 1,
      dshSessionId: DSH_ID,
      logicalSessionId: LOGICAL,
      cwd: CWD,
      createdAt: 1,
      ...stub,
    })
  );
  return file;
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
}

describe('DshSessionRuntime — a new session (decisions 006, 007)', () => {
  it('[bridge-new] flushes the DSH session to disk before it writes the stub', async () => {
    const dsh = fakeDsh();

    const result = await runtime(dsh.ctx).bootstrap();

    expect(dsh.calls).toEqual([`create ${DSH_ID} stub=false`, 'flush stub=false']);
    expect(dsh.ctx.sessions.flush).toHaveBeenCalledTimes(1);
    const stub = JSON.parse(readFileSync(dsh.stubFile, 'utf8')) as SessionStub;
    expect(stub).toEqual({
      engine: 'dsh',
      version: 1,
      dshSessionId: 'aiclient-session-1',
      logicalSessionId: LOGICAL,
      cwd: CWD,
      createdAt: 1_700_000_000_000,
    });
    // Atomic: the temp file was renamed into place, nothing left beside it.
    expect(readdirSync(join(home, 'aiclient-sessions'))).toEqual(['aiclient-session-1.dsh.json']);
    expect(isWorkerBootstrapResult(result)).toBe(true);
    expect(result).toMatchObject({
      logicalSessionId: LOGICAL,
      piSessionId: DSH_ID,
      cwd: CWD,
      sessionFile: dsh.stubFile,
    });
    // A new session has no history to hand Main.
    expect(result).not.toHaveProperty('initialHistory');
  });

  it('[bridge-new-flush-fails] leaves no stub and releases the session when the flush fails', async () => {
    const dsh = fakeDsh({ flushError: new Error('disk full') });

    await expect(runtime(dsh.ctx).bootstrap()).rejects.toThrow('disk full');

    expect(existsSync(dsh.stubFile)).toBe(false);
    expect(dsh.disposed).toEqual([DSH_ID]);
  });

  it('[bridge-new-exists] reopens a log an earlier create left behind, then writes its stub', async () => {
    // A create that reached the disk but never became Main's identity. The id
    // is deterministic, so refusing here would refuse every retry forever.
    const dsh = fakeDsh({ createError: named('SessionAlreadyExistsError') });

    const result = await runtime(dsh.ctx).bootstrap();

    expect(dsh.calls).toEqual([`create ${DSH_ID} stub=false`, `resume ${DSH_ID}`]);
    expect(existsSync(dsh.stubFile)).toBe(true);
    expect(result.sessionFile).toBe(dsh.stubFile);
  });

  it('[bridge-new-exists-cwd] refuses to adopt a leftover log from another workspace', async () => {
    const dsh = fakeDsh({
      createError: named('SessionAlreadyExistsError'),
      headerCwd: '/elsewhere',
    });

    const error = await refusal(runtime(dsh.ctx).bootstrap());

    expect(error.code).toBe('session_cwd_mismatch');
    expect(existsSync(dsh.stubFile)).toBe(false);
    expect(dsh.disposed).toEqual([DSH_ID]);
  });

  it('refuses a logical id that could not be a file name', async () => {
    const dsh = fakeDsh();
    const error = await refusal(runtime(dsh.ctx, { logicalSessionId: '../escape' }).bootstrap());
    expect(error.code).toBe('WORKER_INVALID_PAYLOAD');
    expect(dsh.ctx.agents.create).not.toHaveBeenCalled();
  });
});

describe('DshSessionRuntime — resume and crash restart (decisions 006, 010)', () => {
  it('[bridge-resume] resumes the session the stub names and returns a legal empty first page', async () => {
    const stubFile = writeStub();
    const before = readFileSync(stubFile, 'utf8');
    const dsh = fakeDsh();

    const result = await runtime(dsh.ctx, { sessionFile: stubFile }).bootstrap();

    expect(dsh.calls).toEqual([`resume ${DSH_ID}`]);
    expect(dsh.ctx.agents.create).not.toHaveBeenCalled();
    expect(isWorkerBootstrapResult(result)).toBe(true);
    expect(result.sessionFile).toBe(stubFile);
    // Main validates exactly these three against the slot it spawned.
    expect(isWorkerHistoryResult(result.initialHistory)).toBe(true);
    expect(result.initialHistory).toEqual({
      logicalSessionId: LOGICAL,
      sessionFile: stubFile,
      workspacePath: CWD,
      page: {
        messages: [],
        offset: 0,
        limit: INITIAL_HISTORY_LIMIT,
        totalCount: 0,
        hasMore: false,
      },
    });
    expect(readFileSync(stubFile, 'utf8')).toBe(before);
  });

  it.each([
    ['SessionPersistenceNotFoundError', 'dsh_session_missing'],
    ['SessionAlreadyOwnedError', 'session_locked'],
  ])('[bridge-resume-errors] maps %s to %s, wrapped or not', async (name, code) => {
    for (const thrown of [named(name), new Error('load failed', { cause: named(name) })]) {
      const stubFile = writeStub();
      const dsh = fakeDsh({ resumeError: thrown });
      const error = await refusal(runtime(dsh.ctx, { sessionFile: stubFile }).bootstrap());
      expect(error.code).toBe(code);
    }
  });

  it('passes an unrelated DSH failure through untouched', async () => {
    const stubFile = writeStub();
    const dsh = fakeDsh({ resumeError: new Error('boom') });
    await expect(runtime(dsh.ctx, { sessionFile: stubFile }).bootstrap()).rejects.toThrow('boom');
  });

  it('answers dsh_session_missing when the stub itself is gone', async () => {
    const dsh = fakeDsh();
    const error = await refusal(
      runtime(dsh.ctx, { sessionFile: stubPathFor(home, DSH_ID) }).bootstrap()
    );
    expect(error.code).toBe('dsh_session_missing');
    expect(dsh.ctx.agents.resume).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['another engine', JSON.stringify({ engine: 'pi', version: 1 })],
    ['a pi transcript', '{"type":"session","version":3}\n{"type":"message"}\n'],
  ])('answers session_invalid for a stub that is %s', async (_label, content) => {
    const file = writeStub();
    writeFileSync(file, content);
    const dsh = fakeDsh();
    const error = await refusal(runtime(dsh.ctx, { sessionFile: file }).bootstrap());
    expect(error.code).toBe('session_invalid');
    expect(dsh.ctx.agents.resume).not.toHaveBeenCalled();
  });

  it('[bridge-resume-cwd] refuses a stub from another workspace before touching DSH', async () => {
    const stubFile = writeStub({ cwd: '/other-repo' });
    const dsh = fakeDsh();
    const error = await refusal(runtime(dsh.ctx, { sessionFile: stubFile }).bootstrap());
    expect(error.code).toBe('session_cwd_mismatch');
    expect(dsh.ctx.agents.resume).not.toHaveBeenCalled();
  });

  it('[bridge-resume-takeover] ignores forceTakeover: the DSH lock is a kernel lock', async () => {
    const stubFile = writeStub();
    const dsh = fakeDsh({ resumeError: named('SessionAlreadyOwnedError') });
    const log = vi.fn();
    const error = await refusal(
      runtime(dsh.ctx, { sessionFile: stubFile, forceTakeover: true, log }).bootstrap()
    );
    expect(error.code).toBe('session_locked');
    expect(dsh.ctx.agents.resume).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('forceTakeover ignored'));
  });
});

describe('DshSessionRuntime — safe refusals until P1-4 (decision 010)', () => {
  async function ready() {
    const dsh = fakeDsh();
    const bridge = runtime(dsh.ctx);
    await bridge.bootstrap();
    return { dsh, bridge };
  }

  const send = {
    logicalSessionId: LOGICAL,
    requestId: 'turn-1',
    attemptId: 'attempt-1',
    text: 'hi',
  };

  it('refuses a retry instead of sending an empty message', async () => {
    const { dsh, bridge } = await ready();
    const error = await refusal(bridge.startSend({ ...send, text: '', mode: 'retry' }));
    expect(error.code).toBe(WORKER_RETRY_UNAVAILABLE);
    expect(dsh.followups).toEqual([]);
  });

  it('refuses attachments instead of dropping them', async () => {
    const { dsh, bridge } = await ready();
    const error = await refusal(
      bridge.startSend({
        ...send,
        attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }],
      })
    );
    expect(error.code).toBe('WORKER_DSH_UNSUPPORTED');
    expect(dsh.followups).toEqual([]);
  });

  it('sends plain text through the injected message factory', async () => {
    const { dsh, bridge } = await ready();
    await expect(bridge.startSend(send)).resolves.toEqual({ accepted: true, requestId: 'turn-1' });
    expect(deps.createUserMessage).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    });
    expect(dsh.followups).toEqual([{ id: 'user-message-1' }]);
  });

  it.each([
    'fork',
    'acceptFork',
    'discardFork',
  ] as const)('keeps %s unsupported, with no native fallback', async (method) => {
    const { bridge } = await ready();
    const error = await refusal((bridge[method] as () => Promise<unknown>)());
    expect(error.code).toBe('WORKER_DSH_UNSUPPORTED');
  });
});

describe('DshSessionRuntime — history, tree and leaf (P1-4a, decision 026)', () => {
  const T = 1_790_000_000_000;
  const at = (seq: number, type: string, data: unknown): DshLogEvent => ({
    type,
    seq,
    time: T + seq,
    data,
  });
  const prompt = (seq: number, id: string, text: string) =>
    at(seq, 'user/message', {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });

  it('[bridge-history-resume] hands Main the projected first page and leaf of a reopened log', async () => {
    const stubFile = writeStub();
    const dsh = fakeDsh({
      events: [
        at(0, 'turn/start', { turn: 1 }),
        prompt(1, 'u1', 'run it'),
        at(2, 'assistant/message', {
          turn: 1,
          step: 1,
          message: {
            id: 'a1',
            role: 'assistant',
            content: [
              { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"sleep 9"}' },
            ],
            source: { kind: 'model', provider: 'aiclient-gateway', model: 'fake-1' },
          },
        }),
        at(3, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
        at(4, 'tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 'interrupted-tool-result-c1-4',
            role: 'tool',
            toolCallId: 'c1',
            isError: true,
            source: { kind: 'tool', callId: 'c1' },
            content: [{ type: 'text', text: 'outcome unknown' }],
          },
          error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
        }),
        at(5, 'step/end', { turn: 1, step: 1 }),
        at(6, 'turn/end', { turn: 1, reason: { kind: 'interrupted' } }),
        at(7, 'session/end-seed', {}),
      ],
    });

    const result = await runtime(dsh.ctx, { sessionFile: stubFile }).bootstrap();

    expect(dsh.ctx.sessionQuery.observeSession).toHaveBeenCalledWith(DSH_ID, {
      projectionMode: 'none',
    });
    expect(isWorkerBootstrapResult(result)).toBe(true);
    expect(result.leaf).toEqual({
      activeEntryId: 'u1:interrupted',
      fileTailEntryId: `${DSH_ID}#7`,
    });
    const page = result.initialHistory?.page;
    expect(page).toMatchObject({
      offset: 0,
      limit: INITIAL_HISTORY_LIMIT,
      totalCount: 3,
      hasMore: false,
    });
    expect(page?.messages.map((message) => message.id)).toEqual([
      'h:u1',
      'h:a1',
      'h:u1:interrupted',
    ]);
    expect(page?.messages[1]?.blocks.at(-1)).toMatchObject({ ok: false, outcomeUnknown: true });
    expect(page?.messages[2]?.blocks[0]).toMatchObject({
      notice: { key: INTERRUPTED_TURN_NOTICE_KEY },
    });
  });

  it('[bridge-history-live] keeps history, tree and leaf current from session/event', async () => {
    const dsh = fakeDsh({ events: [at(0, 'permission/preset', { preset: 'workspace-write' })] });
    const bridge = runtime(dsh.ctx);
    const boot = await bridge.bootstrap();
    expect(boot.leaf).toEqual({ activeEntryId: null, fileTailEntryId: `${DSH_ID}#0` });

    dsh.append(at(1, 'turn/start', { turn: 1 }));
    dsh.append(prompt(2, 'u1', 'hello'));
    dsh.append(
      at(3, 'assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
          source: { kind: 'model', provider: 'aiclient-gateway', model: 'fake-1' },
        },
      })
    );
    dsh.append(at(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));

    const history = await bridge.history({ logicalSessionId: LOGICAL });
    expect(isWorkerHistoryResult(history)).toBe(true);
    expect(history.page.messages.map((message) => message.id)).toEqual(['h:u1', 'h:a1']);
    const tree = await bridge.tree();
    expect(isWorkerTreeResult(tree)).toBe(true);
    expect(tree.snapshot).toMatchObject({
      logicalSessionId: LOGICAL,
      sessionFile: dsh.stubFile,
      workspacePath: CWD,
      leaf: { activeEntryId: 'a1', fileTailEntryId: `${DSH_ID}#4` },
      totalNodes: 2,
    });
    expect(tree.snapshot.nodes.map((node) => [node.id, node.leaf])).toEqual([
      ['u1', false],
      ['a1', true],
    ]);
    // Folded one event at a time: the log was read once, at bootstrap.
    expect(dsh.ctx.sessionQuery.observeSession).toHaveBeenCalledTimes(1);
  });

  it('[bridge-history-read-failure] still opens the session, with a legal page, and reads again later', async () => {
    const stubFile = writeStub();
    const log = vi.fn();
    const options: FakeOptions = { observeError: new Error('query unavailable') };
    const dsh = fakeDsh(options);
    const bridge = runtime(dsh.ctx, { sessionFile: stubFile, log });

    const result = await bridge.bootstrap();

    expect(result.initialHistory?.page).toEqual({
      messages: [],
      offset: 0,
      limit: INITIAL_HISTORY_LIMIT,
      totalCount: 0,
      hasMore: false,
    });
    expect(log).toHaveBeenCalledWith('[dsh-bridge] history read failed', DSH_ID, expect.any(Error));
    options.observeError = undefined;
    options.events = [prompt(0, 'u1', 'still here')];
    const history = await bridge.history({ logicalSessionId: LOGICAL });
    expect(history.page.messages.map((message) => message.id)).toEqual(['h:u1']);
    expect(dsh.ctx.sessionQuery.observeSession).toHaveBeenCalledTimes(2);
  });
});

describe('DshSessionRuntime behind PiWorkerRpcServer', () => {
  it('carries the bridge codes to Main in the RPC error payload', async () => {
    const stubFile = writeStub();
    const dsh = fakeDsh({ resumeError: named('SessionAlreadyOwnedError') });
    const sent: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => sent.push(message as Record<string, unknown>) },
      generation: 1,
      projectTrusted: true,
      createRuntime: (options) => new DshSessionRuntime(dsh.ctx, options, { ...deps, home }),
      createImportWriter: () => {
        throw new Error('not in this test');
      },
      createUtilityRuntime: () => {
        throw new Error('not in this test');
      },
    });
    server.receive({
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'request',
      generation: 1,
      requestId: 'r1',
      type: 'worker.bootstrap',
      payload: { logicalSessionId: LOGICAL, cwd: CWD, sessionFile: stubFile, forceTakeover: true },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      kind: 'response',
      requestId: 'r1',
      ok: false,
      error: { code: 'session_locked' },
    });
  });
});
