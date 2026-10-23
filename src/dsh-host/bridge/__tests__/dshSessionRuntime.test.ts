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
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { INTERRUPTED_TURN_NOTICE_KEY } from '../../../shared/dshHistory/projection.ts';
import { DSH_RETRY_CONTINUATION_TEXT, type DshLogEvent } from '../../../shared/dshHistory/types.ts';
import { readPiUsagePayload } from '../../../shared/piUsage.ts';
import {
  isWorkerBootstrapResult,
  isWorkerHistoryResult,
  isWorkerTreeResult,
  WORKER_RETRY_UNAVAILABLE,
  WORKER_RPC_PROTOCOL_VERSION,
} from '../../../shared/types/workerRpc.ts';
import { gatewaySessionUuid } from '../../lib/sessionMetadata.ts';
import { BridgeRpcServer, type BridgeSessionRuntimeOptions } from '../bridgeRpcServer.ts';
import {
  type DshBridgeContext,
  type DshBridgeDeps,
  type DshModelSelectionRef,
  DshSessionRuntime,
  dshSessionIdFor,
  INITIAL_HISTORY_LIMIT,
  type SessionStub,
  stubPathFor,
} from '../dshSessionRuntime.ts';
import type { DshBridgeModelPlan } from '../modelRoute.ts';
import { testPermissionHost } from './permissionTestHost.ts';
import { TEST_PLAN } from './testPlan.ts';

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
  /** Decision 198: other sessions' logs (subagents), by id; `events` for any other id. */
  logs?: Record<string, { events: DshLogEvent[]; inheritedEventCount?: number }>;
  observeError?: unknown;
  /** P1-4c2: what `attachments.admitPromptContent` throws. */
  admitError?: unknown;
  /** P1-4c2: holds `admitPromptContent` until the test releases it. */
  admitGate?: Promise<void>;
}

/** dsh-attachment's error shape: routed on `code`, recognised by `isAttachmentError`. */
function attachmentError(code: string, message = `${code} refused`): Error {
  return Object.assign(new Error(message), { name: 'AttachmentError', code });
}

/**
 * `ctx.attachments` (P1-4c2): images admitted as references named after the
 * upload, files stored as references named after the file; every call kept.
 */
function fakeAttachmentStore(options: FakeOptions) {
  const admitted: unknown[][] = [];
  const saved: Array<{ text: string; name?: string }> = [];
  const store = {
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    admitPromptContent: vi.fn(async (parts: Array<Record<string, unknown>>) => {
      admitted.push(parts);
      await options.admitGate;
      if (options.admitError) throw options.admitError;
      return parts.map((part) =>
        part.type === 'image'
          ? {
              type: 'image',
              attachment: {
                attachmentId: `sha256:image-${String(part.name)}`,
                mediaType: part.mediaType,
                bytes: 4,
                width: 1,
                height: 1,
                ...(part.name ? { name: part.name } : {}),
              },
            }
          : part
      );
    }),
    saveFile: vi.fn(async (input: { data: Uint8Array; name?: string }) => {
      saved.push({
        text: Buffer.from(input.data).toString('utf8'),
        ...(input.name ? { name: input.name } : {}),
      });
      return {
        attachmentId: `sha256:file-${input.name ?? 'file'}`,
        name: input.name ?? 'file',
        bytes: input.data.byteLength,
      };
    }),
    validateImage: vi.fn(async () => undefined),
    isAttachmentError: (error: unknown) =>
      (error as { name?: unknown })?.name === 'AttachmentError',
  };
  return { store, admitted, saved };
}

/** A Cordis context narrowed to what the bridge reads, recording the order of calls. */
function fakeDsh(options: FakeOptions = {}) {
  const calls: string[] = [];
  const disposed: string[] = [];
  const followups: unknown[] = [];
  const attachments = fakeAttachmentStore(options);
  /** P1-4c1: what the bridge steered, and how it cancelled. */
  const steers: unknown[] = [];
  const cancels: unknown[][] = [];
  /**
   * Issue #8: the steered messages still in DSH's inbox, by id. A step claims
   * one (`claim`) before its `user/message`; `inbox.remove` takes one back.
   */
  const inbox = new Set<string>();
  const removes: string[] = [];
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const stubFile = stubPathFor(home, DSH_ID);
  const handle = (id: string, cwd: string | undefined) => ({
    agent: {
      id,
      status: 'idle',
      session: { header: { cwd } },
      followup: (message: unknown) => followups.push(message),
      steer: (message: unknown) => {
        steers.push(message);
        inbox.add((message as { id: string }).id);
      },
      inbox: {
        remove: (messageId: string) => {
          removes.push(messageId);
          return inbox.delete(messageId);
        },
      },
      cancel: (...args: unknown[]) => cancels.push(args),
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
      observeSession: vi.fn(async (sessionId: string) => {
        if (options.observeError) throw options.observeError;
        const other = options.logs?.[sessionId];
        const events = other?.events ?? options.events ?? [];
        return {
          events,
          cursor: events.at(-1)?.seq ?? -1,
          ...(other?.inheritedEventCount !== undefined
            ? { inheritedEventCount: other.inheritedEventCount }
            : {}),
          [Symbol.dispose]: () => undefined,
        };
      }),
    },
    aiclientPermissions: testPermissionHost().api,
    attachments: attachments.store,
  } as unknown as DshBridgeContext;
  /** One durable event of this session, as DSH's `session/event` delivers it. */
  const append = (event: DshLogEvent) => listeners.get('session/event')?.({ id: DSH_ID }, event);
  /** Decision 198: one durable event of another session (a subagent's). */
  const appendTo = (sessionId: string, event: DshLogEvent) =>
    listeners.get('session/event')?.({ id: sessionId }, event);
  /** P1-4d3: one `user-questions/request` down the row's waterfall, as dsh-user-questions sends it. */
  const ask = (request: Record<string, unknown>, next: () => Promise<unknown>) =>
    listeners.get('user-questions/request')?.(request, next) as Promise<unknown> | undefined;
  /** Issue #8: the next step takes a steered message out of the inbox (its echo comes after). */
  const claim = (messageId: string) => inbox.delete(messageId);
  return {
    ctx,
    calls,
    disposed,
    followups,
    steers,
    cancels,
    removes,
    claim,
    stubFile,
    append,
    appendTo,
    ask,
    attachments,
  };
}

const deps: DshBridgeDeps = {
  createUserMessage: vi.fn(() => ({ id: 'user-message-1' })),
  now: () => 1_700_000_000_000,
  modelPlan: () => TEST_PLAN,
};

function runtime(
  ctx: DshBridgeContext,
  extra: Partial<BridgeSessionRuntimeOptions> = {},
  depsOverride: Partial<DshBridgeDeps> = {}
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
    { ...deps, home, ...depsOverride }
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
    // Version 2 (P1-4b): the lineage starts with the session itself.
    expect(stub).toEqual({
      engine: 'dsh',
      version: 2,
      dshSessionId: 'aiclient-session-1',
      logicalSessionId: LOGICAL,
      cwd: CWD,
      createdAt: 1_700_000_000_000,
      lineage: [{ dshSessionId: 'aiclient-session-1', reason: 'create', at: 1_700_000_000_000 }],
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

describe('DshSessionRuntime — sends and their attachments (P1-4c2, decisions 096 and 097)', () => {
  async function ready(options: FakeOptions = {}) {
    const dsh = fakeDsh(options);
    const emitted: Array<{ type: string }> = [];
    const createUserMessage = vi.fn(() => ({ id: 'user-message-1' }));
    const bridge = runtime(
      dsh.ctx,
      { emit: (event) => emitted.push(event as { type: string }) },
      { createUserMessage }
    );
    await bridge.bootstrap();
    return { dsh, bridge, emitted, createUserMessage };
  }

  const send = {
    logicalSessionId: LOGICAL,
    requestId: 'turn-1',
    attemptId: 'attempt-1',
    text: 'hi',
  };
  const image = (name: string) => ({
    kind: 'image' as const,
    mediaType: 'image/png',
    data: 'AAAA',
    name,
  });
  const textFile = (name: string, data: string) => ({
    kind: 'text' as const,
    mediaType: 'text/plain',
    data,
    name,
  });

  it('sends plain text through the injected message factory, the store untouched', async () => {
    const { dsh, bridge, createUserMessage } = await ready();
    await expect(bridge.startSend(send)).resolves.toEqual({ accepted: true, requestId: 'turn-1' });
    expect(createUserMessage).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    });
    expect(dsh.followups).toEqual([{ id: 'user-message-1' }]);
    expect(dsh.attachments.store.admitPromptContent).not.toHaveBeenCalled();
    expect(dsh.attachments.store.saveFile).not.toHaveBeenCalled();
  });

  it('[c2-send-admit] admits images and stores text files through the engine, in the order picked', async () => {
    const { dsh, bridge, emitted, createUserMessage } = await ready();
    await expect(
      bridge.startSend({
        ...send,
        attachments: [image('a.png'), textFile('notes.txt', 'line one\n'), image('b.png')],
      })
    ).resolves.toEqual({ accepted: true, requestId: 'turn-1' });
    // Decision 097: the text file is stored verbatim, as UTF-8 bytes.
    expect(dsh.attachments.saved).toEqual([{ text: 'line one\n', name: 'notes.txt' }]);
    const fileRef = { attachmentId: 'sha256:file-notes.txt', name: 'notes.txt', bytes: 9 };
    // Decision 096: one admission for the whole message; no 5 MiB check of our own.
    expect(dsh.attachments.admitted).toEqual([
      [
        { type: 'text', text: 'hi' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'a.png' },
        { type: 'file', attachment: fileRef },
        { type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'b.png' },
      ],
    ]);
    expect(createUserMessage).toHaveBeenCalledWith({
      content: [
        { type: 'text', text: 'hi' },
        {
          type: 'image',
          attachment: expect.objectContaining({ attachmentId: 'sha256:image-a.png' }),
        },
        { type: 'file', attachment: fileRef },
        {
          type: 'image',
          attachment: expect.objectContaining({ attachmentId: 'sha256:image-b.png' }),
        },
      ],
      source: { kind: 'user' },
    });
    expect(dsh.followups).toEqual([{ id: 'user-message-1' }]);
    expect(emitted.map((event) => event.type)).toEqual(['session.status']);
  });

  it('[c2-send-admit] a message may be attachments alone: no empty text block', async () => {
    const { dsh, bridge } = await ready();
    await bridge.startSend({ ...send, text: '', attachments: [image('only.png')] });
    expect(dsh.attachments.admitted).toEqual([
      [{ type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'only.png' }],
    ]);
  });

  it('[c2-send-reject] refuses before any event, naming the DSH code and the file', async () => {
    const { dsh, bridge, emitted, createUserMessage } = await ready({
      admitError: attachmentError(
        'IMAGE_DIMENSION_TOO_LARGE',
        'Image exceeds the configured per-side pixel limit.'
      ),
    });
    const error = await refusal(bridge.startSend({ ...send, attachments: [image('wide.png')] }));
    expect(error).toMatchObject({
      code: 'WORKER_ATTACHMENT_REJECTED',
      message:
        'IMAGE_DIMENSION_TOO_LARGE "wide.png": Image exceeds the configured per-side pixel limit.',
    });
    expect(createUserMessage).not.toHaveBeenCalled();
    expect(dsh.followups).toEqual([]);
    expect(emitted).toEqual([]);
    // Nothing was held: the next send goes.
    await expect(bridge.startSend({ ...send, requestId: 'turn-2' })).resolves.toEqual({
      accepted: true,
      requestId: 'turn-2',
    });
  });

  it('[c2-send-busy] a send that won while the store admitted another makes it busy', async () => {
    let release: () => void = () => undefined;
    const { dsh, bridge } = await ready({
      admitGate: new Promise<void>((done) => {
        release = done;
      }),
    });
    const withImage = bridge.startSend({ ...send, attachments: [image('slow.png')] });
    await vi.waitFor(() => expect(dsh.attachments.admitted).toHaveLength(1));
    await bridge.startSend({ ...send, requestId: 'turn-2' });
    release();
    expect((await refusal(withImage)).code).toBe('WORKER_SESSION_BUSY');
    expect(dsh.followups).toEqual([{ id: 'user-message-1' }]);
  });

  // Fork, accept and discard are bridged since P1-4b: rewindFork.test.ts.
});

describe('DshSessionRuntime — turn semantics (P1-4c1, decisions 093-095)', () => {
  type Emitted = { type: string; requestId?: string; payload?: Record<string, unknown> };
  const at = (seq: number, type: string, data: unknown): DshLogEvent => ({
    type,
    seq,
    time: seq,
    data,
  });
  const userMessage = (seq: number, id: string, text: string, kind = 'user') =>
    at(seq, 'user/message', {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind },
    });
  const ended = (kind: string) => [
    at(0, 'turn/start', { turn: 1 }),
    userMessage(1, 'u1', 'run it'),
    at(2, 'turn/end', { turn: 1, reason: { kind } }),
  ];

  /** A bridge whose message factory mints `m1`, `m2`, …, and whose events are kept. */
  async function opened(events?: DshLogEvent[], fake: FakeOptions = {}) {
    const dsh = fakeDsh(events ? { ...fake, events } : fake);
    const emitted: Emitted[] = [];
    let minted = 0;
    const createUserMessage = vi.fn(() => {
      minted += 1;
      return { id: `m${minted}` };
    });
    const bridge = runtime(
      dsh.ctx,
      { emit: (event) => emitted.push(event as Emitted) },
      { createUserMessage }
    );
    await bridge.bootstrap();
    return { dsh, bridge, emitted, createUserMessage };
  }

  const send = (requestId: string, attemptId: string, text: string) => ({
    logicalSessionId: LOGICAL,
    requestId,
    attemptId,
    text,
  });
  const retry = { ...send('turn-retry', 'attempt-retry', ''), mode: 'retry' as const };
  const interject = (attemptId: string, text: string) => ({
    logicalSessionId: LOGICAL,
    attemptId,
    text,
  });
  /** The user echoes that went out, as `[messageId, attemptId, text]`. */
  const echoes = (emitted: Emitted[]) =>
    emitted
      .filter((event) => event.type === 'message.started' && event.payload?.role === 'user')
      .map((event) => {
        const messageId = event.payload?.messageId;
        const delta = emitted.find(
          (other) => other.type === 'message.delta' && other.payload?.messageId === messageId
        );
        return [messageId, event.payload?.attemptId, delta?.payload?.text];
      });

  // ---- decision 095: the failure card's Continue ----------------------------------

  for (const kind of ['error', 'interrupted', 'aborted']) {
    it(`[c1-retry-accept] takes a retry after a turn that ended ${kind}`, async () => {
      const { dsh, bridge, emitted, createUserMessage } = await opened(ended(kind));

      await expect(bridge.startSend(retry)).resolves.toEqual({
        accepted: true,
        requestId: 'turn-retry',
      });

      // One hidden continuation, followed up; not the user's, so nothing echoes.
      expect(createUserMessage).toHaveBeenCalledWith({
        content: [{ type: 'text', text: DSH_RETRY_CONTINUATION_TEXT }],
        source: { kind: 'aiclient-retry', form: 'notice', summary: 'Retry after a failed request' },
      });
      expect(dsh.followups).toEqual([{ id: 'm1' }]);
      expect(dsh.steers).toEqual([]);
      expect(emitted).toEqual([
        {
          sessionId: LOGICAL,
          requestId: 'turn-retry',
          type: 'session.status',
          payload: { status: 'running' },
        },
      ]);
      // When DSH takes it in, the continuation stays out of the timeline.
      dsh.append(at(3, 'turn/start', { turn: 2 }));
      dsh.append(userMessage(4, 'm1', DSH_RETRY_CONTINUATION_TEXT, 'aiclient-retry'));
      expect(echoes(emitted)).toEqual([]);
      expect(emitted.some((event) => event.type === 'custom.message')).toBe(false);
    });
  }

  for (const kind of ['completed', 'blocked', 'max-tokens']) {
    it(`[c1-retry-refuse] refuses a retry after a turn that ended ${kind}, before any event`, async () => {
      const { dsh, bridge, emitted, createUserMessage } = await opened(ended(kind));
      const error = await refusal(bridge.startSend(retry));
      expect(error.code).toBe(WORKER_RETRY_UNAVAILABLE);
      expect(error.message).toContain(kind);
      expect(createUserMessage).not.toHaveBeenCalled();
      expect(dsh.followups).toEqual([]);
      expect(emitted).toEqual([]);
    });
  }

  it('[c1-retry-refuse] refuses a retry when no turn ever ended', async () => {
    const { dsh, bridge, emitted } = await opened();
    const error = await refusal(bridge.startSend(retry));
    expect(error.code).toBe(WORKER_RETRY_UNAVAILABLE);
    expect(dsh.followups).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('[c1-retry-refuse] refuses a retry while a turn runs', async () => {
    const { dsh, bridge, emitted } = await opened(ended('error'));
    await bridge.startSend(send('turn-1', 'attempt-1', 'go'));
    emitted.length = 0;
    const error = await refusal(bridge.startSend(retry));
    expect(error.code).toBe(WORKER_RETRY_UNAVAILABLE);
    expect(dsh.followups).toHaveLength(1);
    expect(emitted).toEqual([]);
  });

  it('[c1-retry-live] reads the ending of a turn that just failed live', async () => {
    const { dsh, bridge } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'go'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    dsh.append(userMessage(1, 'm1', 'go'));
    dsh.append(
      at(2, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER' } } })
    );
    await expect(bridge.startSend(retry)).resolves.toEqual({
      accepted: true,
      requestId: 'turn-retry',
    });
    expect(dsh.followups).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  // ---- decision 094: Stop keeps the inbox ------------------------------------------

  it("[c1-stop] Stop is DSH's stop button: cancel as the user, keeping the inbox", async () => {
    const { dsh, bridge, emitted } = await opened();
    await expect(bridge.stop({ logicalSessionId: LOGICAL, reason: 'user' })).resolves.toEqual({
      stopped: false,
    });
    expect(dsh.cancels).toEqual([]);

    await bridge.startSend(send('turn-1', 'attempt-1', 'go'));
    await expect(bridge.stop({ logicalSessionId: LOGICAL, reason: 'user' })).resolves.toEqual({
      stopped: true,
    });
    expect(dsh.cancels).toEqual([[{ kind: 'user' }, { keepInbox: true }]]);
    expect(emitted.at(-1)).toMatchObject({
      type: 'session.status',
      requestId: 'turn-1',
      payload: { status: 'stopping' },
    });
  });

  // ---- decision 093: Ctrl+Enter steers the running turn ------------------------------

  it('[c1-interject] steers the running turn and echoes the message once DSH takes it in', async () => {
    const { dsh, bridge, emitted, createUserMessage } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'list the files'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    dsh.append(userMessage(1, 'm1', 'list the files'));
    emitted.length = 0;

    expect(bridge.interject(interject('interject-1', 'also count them'))).toEqual({
      interjected: true,
      turnActive: true,
    });
    expect(createUserMessage).toHaveBeenLastCalledWith({
      content: [{ type: 'text', text: 'also count them' }],
      source: { kind: 'user' },
    });
    expect(dsh.steers).toEqual([{ id: 'm2' }]);
    expect(dsh.followups).toEqual([{ id: 'm1' }]);
    // Nothing is said until the turn takes it in: the renderer shows it awaiting delivery.
    expect(emitted).toEqual([]);

    dsh.append(at(2, 'step/end', { turn: 1, step: 1 }));
    dsh.append(userMessage(3, 'm2', 'also count them'));
    expect(echoes(emitted)).toEqual([['dsh-user-3', 'interject-1', 'also count them']]);
    expect(emitted.every((event) => event.requestId === 'turn-1')).toBe(true);

    // The turn goes on and ends as itself: no `interjected` stop cause.
    dsh.append(at(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
    expect(emitted.find((event) => event.type === 'session.completed')).toMatchObject({
      payload: {},
    });
    expect(JSON.stringify(emitted)).not.toContain('interjected');
  });

  it('[c1-interject-idle] with no turn running sends nothing and says so', async () => {
    const { dsh, bridge, emitted, createUserMessage } = await opened();
    expect(bridge.interject(interject('interject-1', 'hello?'))).toEqual({
      interjected: false,
      turnActive: false,
    });
    expect(createUserMessage).not.toHaveBeenCalled();
    expect(dsh.steers).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('[c1-interject-idle] a turn that already ended is no turn', async () => {
    const { dsh, bridge } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'go'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    dsh.append(at(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
    expect(bridge.interject(interject('interject-1', 'late'))).toEqual({
      interjected: false,
      turnActive: false,
    });
    expect(dsh.steers).toEqual([]);
  });

  it('[c1-interject-synthetic] a turn DSH started itself counts as running', async () => {
    const { dsh, bridge, emitted } = await opened();
    // A goal round or a job notice: DSH opens the turn, the bridge names it.
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    expect(bridge.interject(interject('interject-1', 'and this'))).toEqual({
      interjected: true,
      turnActive: true,
    });
    expect(dsh.steers).toEqual([{ id: 'm1' }]);
    dsh.append(userMessage(1, 'm1', 'and this'));
    expect(echoes(emitted)).toEqual([['dsh-user-1', 'interject-1', 'and this']]);
    expect(emitted.at(-1)?.requestId).toBe(`dsh-turn-${DSH_ID}-1`);
  });

  it('[c1-interject-stop] a message Stop left in the inbox goes out with the next turn', async () => {
    const { dsh, bridge, emitted } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'long job'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    dsh.append(userMessage(1, 'm1', 'long job'));
    bridge.interject(interject('interject-1', 'then this'));
    await bridge.stop({ logicalSessionId: LOGICAL, reason: 'user' });
    dsh.append(
      at(2, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    );
    expect(emitted.some((event) => event.type === 'session.stopped')).toBe(true);
    emitted.length = 0;

    // The next send: DSH takes the waiting message in first, then the prompt.
    await bridge.startSend(send('turn-2', 'attempt-2', 'next thing'));
    dsh.append(at(3, 'turn/start', { turn: 2 }));
    dsh.append(userMessage(4, 'm2', 'then this'));
    dsh.append(userMessage(5, 'm3', 'next thing'));
    expect(echoes(emitted)).toEqual([
      ['dsh-user-4', 'interject-1', 'then this'],
      ['dsh-user-5', 'attempt-2', 'next thing'],
    ]);
  });

  it('[c1-interject-refuse] refuses a foreign session, steering nothing', async () => {
    const { dsh, bridge } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'go'));
    let code: string | undefined;
    try {
      bridge.interject({ ...interject('interject-1', 'x'), logicalSessionId: 'other' });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('WORKER_SESSION_MISMATCH');
    expect(dsh.steers).toEqual([]);
  });

  // ---- issue #8 (decision 172 §4): an interjection taken back ------------------------

  const withdraw = (attemptId: string) => ({ logicalSessionId: LOGICAL, attemptId });

  it('[I8-withdraw] takes a waiting interjection out of the inbox; it never echoes', async () => {
    const { dsh, bridge, emitted } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'list the files'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    dsh.append(userMessage(1, 'm1', 'list the files'));
    bridge.interject(interject('interject-1', 'also count them'));
    emitted.length = 0;

    expect(bridge.withdrawInterjection(withdraw('interject-1'))).toEqual({ outcome: 'withdrawn' });
    expect(dsh.removes).toEqual(['m2']);
    // Nothing is said: it was never in the conversation.
    expect(emitted).toEqual([]);
    // Asked again, it is no longer there to take back.
    expect(bridge.withdrawInterjection(withdraw('interject-1'))).toEqual({
      outcome: 'not_found',
    });
    // The turn goes on and ends as itself, with no trace of the message.
    dsh.append(at(2, 'step/end', { turn: 1, step: 1 }));
    dsh.append(at(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
    expect(echoes(emitted)).toEqual([]);
  });

  it('[I8-withdraw-claimed] a step that claimed it first wins; its echo still carries the attempt', async () => {
    const { dsh, bridge, emitted } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'list the files'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    dsh.append(userMessage(1, 'm1', 'list the files'));
    bridge.interject(interject('interject-1', 'also count them'));
    emitted.length = 0;
    // The next step took it in; its `user/message` is not written yet.
    dsh.claim('m2');

    expect(bridge.withdrawInterjection(withdraw('interject-1'))).toEqual({ outcome: 'delivered' });
    dsh.append(at(2, 'step/end', { turn: 1, step: 1 }));
    dsh.append(userMessage(3, 'm2', 'also count them'));
    expect(echoes(emitted)).toEqual([['dsh-user-3', 'interject-1', 'also count them']]);
    // Once echoed, a late withdrawal is still told it was delivered.
    expect(bridge.withdrawInterjection(withdraw('interject-1'))).toEqual({ outcome: 'delivered' });
  });

  it('[I8-withdraw-stop] one a Stop left in the inbox can be taken back too (decision 094)', async () => {
    const { dsh, bridge, emitted } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'long job'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    dsh.append(userMessage(1, 'm1', 'long job'));
    bridge.interject(interject('interject-1', 'then this'));
    await bridge.stop({ logicalSessionId: LOGICAL, reason: 'user' });
    dsh.append(
      at(2, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    );
    expect(dsh.cancels).toEqual([[{ kind: 'user' }, { keepInbox: true }]]);

    expect(bridge.withdrawInterjection(withdraw('interject-1'))).toEqual({ outcome: 'withdrawn' });
    emitted.length = 0;
    // The next turn takes in its own prompt only.
    await bridge.startSend(send('turn-2', 'attempt-2', 'next thing'));
    dsh.append(at(3, 'turn/start', { turn: 2 }));
    dsh.append(userMessage(4, 'm3', 'next thing'));
    expect(echoes(emitted)).toEqual([['dsh-user-4', 'attempt-2', 'next thing']]);
  });

  it('[I8-withdraw-unknown] an attempt this runtime never steered is not found; a foreign session is refused', async () => {
    const { dsh, bridge } = await opened();
    expect(bridge.withdrawInterjection(withdraw('interject-elsewhere'))).toEqual({
      outcome: 'not_found',
    });
    expect(dsh.removes).toEqual([]);
    let code: string | undefined;
    try {
      bridge.withdrawInterjection({ ...withdraw('interject-1'), logicalSessionId: 'other' });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('WORKER_SESSION_MISMATCH');
  });

  // ---- P1-4c2: an interjection's attachments, through a send's admission ---------------

  const picture = { kind: 'image' as const, mediaType: 'image/png', data: 'AAAA', name: 'a.png' };

  it('[c2-interject-attach] admits the attachments as a send does, then steers the message', async () => {
    const { dsh, bridge, emitted, createUserMessage } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'go'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    dsh.append(userMessage(1, 'm1', 'go'));
    emitted.length = 0;

    await expect(
      bridge.interject({
        ...interject('interject-1', 'see this'),
        attachments: [picture, { kind: 'text', mediaType: 'text/plain', data: 'x', name: 'n.txt' }],
      })
    ).resolves.toEqual({ interjected: true, turnActive: true });
    expect(dsh.attachments.admitted).toHaveLength(1);
    expect(dsh.attachments.saved).toEqual([{ text: 'x', name: 'n.txt' }]);
    expect(createUserMessage).toHaveBeenLastCalledWith({
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image', attachment: expect.objectContaining({ name: 'a.png' }) },
        { type: 'file', attachment: expect.objectContaining({ name: 'n.txt' }) },
      ],
      source: { kind: 'user' },
    });
    expect(dsh.steers).toEqual([{ id: 'm2' }]);
    expect(emitted).toEqual([]);
  });

  it('[c2-interject-reject] a refused attachment steers nothing', async () => {
    const { dsh, bridge, emitted } = await opened(undefined, {
      admitError: attachmentError('IMAGE_TYPE_MISMATCH', 'Declared image type does not match.'),
    });
    await bridge.startSend(send('turn-1', 'attempt-1', 'go'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    emitted.length = 0;
    const error = await refusal(
      Promise.resolve(
        bridge.interject({ ...interject('interject-1', 'see this'), attachments: [picture] })
      )
    );
    expect(error).toMatchObject({
      code: 'WORKER_ATTACHMENT_REJECTED',
      message: 'IMAGE_TYPE_MISMATCH "a.png": Declared image type does not match.',
    });
    expect(dsh.steers).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('[c2-interject-late] a turn that ended while the engine admitted them is no turn', async () => {
    let release: () => void = () => undefined;
    const { dsh, bridge } = await opened(undefined, {
      admitGate: new Promise<void>((done) => {
        release = done;
      }),
    });
    await bridge.startSend(send('turn-1', 'attempt-1', 'go'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    const answer = bridge.interject({ ...interject('interject-1', 'x'), attachments: [picture] });
    dsh.append(at(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
    release();
    await expect(answer).resolves.toEqual({ interjected: false, turnActive: false });
    expect(dsh.steers).toEqual([]);
  });

  it('[c2-echo] the user echo carries the chips of its image and file blocks', async () => {
    const { dsh, bridge, emitted } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'look'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    dsh.append(
      at(1, 'user/message', {
        id: 'm1',
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image',
            attachment: { attachmentId: 'sha256:i', mediaType: 'image/jpeg', name: 'a.png' },
          },
          { type: 'file', attachment: { attachmentId: 'sha256:f', name: 'n.txt', bytes: 1 } },
        ],
        source: { kind: 'user' },
      })
    );
    expect(echoes(emitted)).toEqual([['dsh-user-1', 'attempt-1', 'look']]);
    expect(emitted.find((event) => event.type === 'message.started')?.payload?.attachments).toEqual(
      [
        // The stored (normalized) type, as the history projection reads it.
        // Issue #26 item 6: with its store reference, for the bubble's thumbnail.
        { kind: 'image', mediaType: 'image/jpeg', name: 'a.png', attachmentId: 'sha256:i' },
        { kind: 'text', mediaType: 'text/plain', name: 'n.txt' },
      ]
    );
  });

  it('[c1-interject-echo] echoes what the user typed even without an attempt id', async () => {
    const { dsh, bridge, emitted } = await opened();
    await bridge.startSend(send('turn-1', 'attempt-1', 'go'));
    dsh.append(at(0, 'turn/start', { turn: 1 }));
    // A message the engine kept across a restart: its attempt id is gone.
    dsh.append(userMessage(1, 'kept-from-before', 'from before the restart'));
    dsh.append(userMessage(2, 'm1', 'go'));
    expect(echoes(emitted)).toEqual([
      ['dsh-user-1', undefined, 'from before the restart'],
      ['dsh-user-2', 'attempt-1', 'go'],
    ]);
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

describe('DshSessionRuntime — model and effort per turn (P1-5a, decisions 033, 035, 040)', () => {
  type Ref = DshModelSelectionRef;

  /** A bridge on the test plan, whose agent's setup ran: `ref()` is what the agent routes by. */
  async function routed(extra: Partial<BridgeSessionRuntimeOptions> = {}, plan = true) {
    const dsh = fakeDsh();
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const log = vi.fn();
    let selection: Ref | undefined;
    const installModelSelection = vi.fn((_agentCtx: unknown, ref: Ref) => {
      selection = ref;
      return () => undefined;
    });
    const bridge = new DshSessionRuntime(
      dsh.ctx,
      {
        logicalSessionId: LOGICAL,
        cwd: CWD,
        projectTrusted: true,
        emit: (event) => events.push(event as (typeof events)[number]),
        log,
        ...extra,
      },
      {
        ...deps,
        home,
        installModelSelection,
        modelPlan: () => (plan ? TEST_PLAN : undefined),
      }
    );
    await bridge.bootstrap();
    const created = vi.mocked(dsh.ctx.agents.create).mock.calls[0]?.[0] as {
      agentOptions: unknown;
      setup?: (agentCtx: unknown) => void;
    };
    created.setup?.('agent-scope');
    return { dsh, bridge, events, log, created, installModelSelection, ref: () => selection };
  }

  const turn = (requestId: string, extra: Record<string, unknown> = {}) => ({
    logicalSessionId: LOGICAL,
    requestId,
    attemptId: `attempt-${requestId}`,
    text: 'hi',
    ...extra,
  });

  it('[route-open] opens the agent on the session model and couples its selection', async () => {
    const opened = await routed({ model: 'thinker/deep-1' });
    expect(opened.created.agentOptions).toEqual({ provider: 'thinker~2', model: 'deep-1' });
    expect(opened.installModelSelection).toHaveBeenCalledWith('agent-scope', expect.any(Object));
    // No effort chosen: a session sends medium when the model offers it (decision 040).
    expect(opened.ref()?.current).toEqual({
      provider: 'thinker~2',
      model: 'deep-1',
      reasoningEffort: 'medium',
    });
  });

  it('[route-open] a new session with no model opens on the plan default', async () => {
    const opened = await routed();
    expect(opened.created.agentOptions).toEqual({ provider: 'aiclient-gateway', model: 'fake-1' });
    expect(opened.ref()?.current).toEqual({ provider: 'aiclient-gateway', model: 'fake-1' });
  });

  it('[route-turn] each turn routes its own model and effort before the prompt goes out', async () => {
    const opened = await routed();
    await opened.bridge.startSend(turn('t1', { model: 'thinker/deep-1', effort: 'high' }));
    expect(opened.ref()?.current).toEqual({
      provider: 'thinker~2',
      model: 'deep-1',
      reasoningEffort: 'high',
    });
    expect(opened.dsh.followups).toHaveLength(1);
  });

  it('[route-turn] a turn that names no model keeps the current one; no effort means medium', async () => {
    const opened = await routed();
    await opened.bridge.startSend(turn('t1', { model: 'thinker/deep-1', effort: 'low' }));
    opened.dsh.append({
      type: 'turn/end',
      seq: 1,
      time: 1,
      data: { turn: 1, reason: { kind: 'completed' } },
    });
    await opened.bridge.startSend(turn('t2'));
    expect(opened.ref()?.current).toEqual({
      provider: 'thinker~2',
      model: 'deep-1',
      reasoningEffort: 'medium',
    });
  });

  it('[route-turn] an effort the model does not offer is dropped and logged, never sent', async () => {
    const opened = await routed();
    await opened.bridge.startSend(turn('t1', { model: 'thinker/deep-1', effort: 'xhigh' }));
    expect(opened.ref()?.current).toEqual({ provider: 'thinker~2', model: 'deep-1' });
    expect(opened.log).toHaveBeenCalledWith(
      '[dsh-bridge] thinker/deep-1 does not offer effort xhigh; sending none'
    );
  });

  it('[route-turn] message.started reports our model id, not the DSH route', async () => {
    const opened = await routed();
    await opened.bridge.startSend(turn('t1', { model: 'thinker/deep-1' }));
    opened.dsh.append({ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } });
    opened.dsh.append({
      type: 'step/end',
      seq: 2,
      time: 2,
      data: { turn: 1, step: 1 },
    });
    opened.dsh.append({
      type: 'tool/call',
      seq: 3,
      time: 3,
      data: { turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: '{}' },
    });
    const started = opened.events.find(
      (event) => event.type === 'message.started' && event.payload?.role === 'assistant'
    );
    expect(started?.payload?.model).toBe('thinker/deep-1');
  });

  it('[route-refuse] a model the plan cannot serve refuses the send before anything goes out', async () => {
    const opened = await routed();
    const error = await refusal(opened.bridge.startSend(turn('t1', { model: 'gone/model-9' })));
    expect(error.code).toBe('MODEL_NOT_CONFIGURED');
    expect(opened.dsh.followups).toEqual([]);
    expect(opened.bridge.busy).toBe(false);
    expect(opened.events.map((event) => event.type)).not.toContain('session.status');
  });

  it('[route-refuse] a host without a plan opens the session but refuses every send', async () => {
    const opened = await routed({}, false);
    expect(opened.created.agentOptions).toEqual({ provider: 'aiclient-gateway', model: 'fake-1' });
    const error = await refusal(opened.bridge.startSend(turn('t1')));
    expect(error.code).toBe('MODEL_NOT_CONFIGURED');
    expect(opened.dsh.followups).toEqual([]);
  });

  it('[route-failure-code] a turn DSH ends in error carries our failure code (design 03 §5)', async () => {
    const opened = await routed();
    const end = (seq: number, code: string) =>
      opened.dsh.append({
        type: 'turn/end',
        seq,
        time: seq,
        data: { turn: seq, reason: { kind: 'error', error: { code, message: `${code} failed` } } },
      });
    end(1, 'MISSING_CREDENTIAL');
    end(2, 'SERVER');
    end(3, 'SOMETHING_NEW');
    const failed = opened.events.filter((event) => event.type === 'session.failed');
    expect(failed.map((event) => event.payload?.errorCode)).toEqual([
      'CREDENTIALS_UNAVAILABLE',
      'PROVIDER_ERROR',
      undefined,
    ]);
    expect(String(failed[0]?.payload?.error)).toContain('MISSING_CREDENTIAL');
  });
});

describe('DshSessionRuntime — live usage from dsh-token-meter (P1-4d1, decision 099 rule 1)', () => {
  it('[D1-USAGE-RUNTIME] reads the occupancy and the running total off the session projections', async () => {
    const dsh = fakeDsh();
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const snapshot = vi.fn((_session: unknown, keys?: readonly string[]) => ({
      values: {
        tokenUsage: {
          uncachedInputTokens: 30,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        contextPressure: { pressureTokens: 30, projectedTokens: 40, contextWindow: 200 },
        keys,
      },
    }));
    (dsh.ctx as { get?: unknown }).get = (name: string) =>
      name === 'sessionProjections' ? { snapshot } : undefined;
    const bridge = runtime(dsh.ctx, {
      emit: (event) => events.push(event as (typeof events)[number]),
    });
    await bridge.bootstrap();
    dsh.append({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } });
    dsh.append({
      type: 'assistant/message',
      seq: 1,
      time: 2,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        usage: { inputTokens: 30, outputTokens: 7 },
      },
    });
    expect(snapshot).toHaveBeenCalledWith(expect.anything(), ['tokenUsage', 'contextPressure']);
    const usage = events.find((event) => event.type === 'usage.updated')?.payload;
    expect(usage).toMatchObject({
      input: 30,
      output: 7,
      costUsd: 0,
      context: { tokens: 40, contextWindow: 200, percent: 20 },
      // One reported step so far, counted by the history fold the event reached first.
      session: { turns: 1, input: 30, output: 7, totalTokens: 37, costUsd: 0 },
    });
  });
});

describe('DshSessionRuntime — what its subagents spent (decision 198)', () => {
  const TOKEN_USAGE = {
    uncachedInputTokens: 30,
    outputTokens: 7,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const step = (seq: number, turn: number, stepNo: number, input: number, output: number) =>
    ({
      type: 'assistant/message',
      seq,
      time: 2,
      data: {
        turn,
        step: stepNo,
        message: { id: `m${seq}`, role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        usage: { inputTokens: input, outputTokens: output },
      },
    }) as DshLogEvent;
  const catalog = (seq: number, childId: string) =>
    ({
      type: 'subagent/catalog',
      seq,
      time: 1,
      data: { version: 0, childId, childCreatedAt: 1, mode: 'one-shot', label: childId },
    }) as DshLogEvent;
  /** The parent's own log: one step that delegated to `child-1`. */
  const parentLog = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as DshLogEvent,
    catalog(1, 'child-1'),
    step(2, 1, 1, 30, 7),
  ];

  function opened(options: { switchedOn?: boolean; log?: DshLogEvent[] } = {}) {
    const dsh = fakeDsh({
      events: options.log ?? parentLog,
      logs: {
        // A fork: its first two events are the parent's, already counted there.
        'child-1': {
          events: [step(0, 1, 1, 30, 7), catalog(1, 'not-mine'), step(2, 1, 1, 200, 20)],
          inheritedEventCount: 2,
        },
        'child-2': { events: [step(0, 1, 1, 5, 1)] },
        'not-mine': { events: [step(0, 1, 1, 9_999, 9_999)] },
      },
    });
    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const snapshot = vi.fn(() => ({
      values: {
        tokenUsage: TOKEN_USAGE,
        contextPressure: { pressureTokens: 30, projectedTokens: 40, contextWindow: 200 },
      },
    }));
    (dsh.ctx as { get?: unknown }).get = (name: string) =>
      name === 'sessionProjections' ? { snapshot } : undefined;
    const bridge = runtime(
      dsh.ctx,
      { emit: (event) => events.push(event as (typeof events)[number]) },
      options.switchedOn === false ? {} : { delegatedUsage: true }
    );
    const observe = (dsh.ctx as unknown as { sessionQuery: { observeSession: Mock } }).sessionQuery
      .observeSession;
    const settled = () =>
      readPiUsagePayload(events.filter((event) => event.type === 'usage.updated').at(-1)?.payload);
    return { dsh, bridge, observe, settled };
  }

  /** The reads queued by the bridge land (the fake answers at once). */
  const landed = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('[D198-RUNTIME-1] counts the children its log names, from their own logs, live and on reopen', async () => {
    const h = opened();
    await h.bridge.bootstrap();
    await landed();
    expect(h.observe).toHaveBeenCalledWith('child-1', { projectionMode: 'none' });
    h.dsh.append({ type: 'turn/start', seq: 3, time: 1, data: { turn: 2 } });
    h.dsh.append(step(4, 2, 1, 1, 1));
    // The parent's own step and total, the fork's own step only, one delegate.
    expect(h.settled()).toMatchObject({
      input: 1,
      output: 1,
      session: { turns: 2, toolResults: 1, input: 230, output: 27, totalTokens: 257 },
      delegated: { input: 200, output: 20, totalTokens: 220, costUsd: 0 },
    });
    expect(h.observe).not.toHaveBeenCalledWith('not-mine', expect.anything());

    // The child steps on live; a second child appears in the parent's catalog.
    h.dsh.appendTo('child-1', step(3, 1, 2, 10, 2));
    h.dsh.append(catalog(5, 'child-2'));
    await landed();
    h.dsh.append(step(6, 2, 2, 1, 1));
    expect(h.settled()).toMatchObject({
      session: { toolResults: 2, input: 245, output: 30 },
      delegated: { input: 215, output: 23, totalTokens: 238 },
    });
    await h.bridge.dispose();

    // Reopened (a host restart): the same figure, read from the logs alone.
    const reopened = opened();
    await reopened.bridge.bootstrap();
    await landed();
    reopened.dsh.append({ type: 'turn/start', seq: 3, time: 1, data: { turn: 2 } });
    reopened.dsh.append(step(4, 2, 1, 1, 1));
    expect(reopened.settled()).toMatchObject({
      session: { toolResults: 1, input: 230 },
      delegated: { input: 200, output: 20 },
    });
  });

  it('[D198-RUNTIME-3] follows a child whose catalog event a gap lost, once the history is read again', async () => {
    const log = [...parentLog];
    const h = opened({ log });
    await h.bridge.bootstrap();
    await landed();
    // The log goes on; the bridge hears only the step after the catalog entry.
    log.push(
      { type: 'turn/start', seq: 3, time: 1, data: { turn: 2 } } as DshLogEvent,
      catalog(4, 'child-2'),
      step(5, 2, 1, 1, 1)
    );
    h.dsh.append(step(5, 2, 1, 1, 1));
    expect(h.settled()).toMatchObject({ session: { toolResults: 1 } });
    // A history read starts over from the log, which names child-2.
    await h.bridge.history({ logicalSessionId: LOGICAL });
    h.dsh.append(step(6, 2, 2, 1, 1));
    await landed();
    h.dsh.append(step(7, 2, 3, 1, 1));
    expect(h.settled()).toMatchObject({
      session: { toolResults: 2 },
      delegated: { input: 205, output: 21 },
    });
  });

  it('[D198-RUNTIME-2] switched off, reads no child log and sends the session’s own total', async () => {
    const h = opened({ switchedOn: false });
    await h.bridge.bootstrap();
    await landed();
    h.dsh.append({ type: 'turn/start', seq: 3, time: 1, data: { turn: 2 } });
    h.dsh.append(step(4, 2, 1, 1, 1));
    expect(h.observe.mock.calls.map((call) => call[0])).toEqual([DSH_ID]);
    const payload = h.settled();
    expect(payload).not.toHaveProperty('delegated');
    expect(payload?.session).toMatchObject({ toolResults: 0, input: 30, output: 7 });
  });
});

describe('DshSessionRuntime behind BridgeRpcServer', () => {
  it('carries the bridge codes to Main in the RPC error payload', async () => {
    const stubFile = writeStub();
    const dsh = fakeDsh({ resumeError: named('SessionAlreadyOwnedError') });
    const sent: Array<Record<string, unknown>> = [];
    const server = new BridgeRpcServer({
      port: { postMessage: (message) => sent.push(message as Record<string, unknown>) },
      generation: 1,
      projectTrusted: true,
      createRuntime: (options) => new DshSessionRuntime(dsh.ctx, options, { ...deps, home }),
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

describe('DshSessionRuntime — busy (P1-3d, decision 025)', () => {
  it('stays busy while a background job of its own session runs after the turn', async () => {
    const dsh = fakeDsh();
    const jobs: Array<{ owner?: string; status: string }> = [];
    const list = vi.fn((caller?: string) => {
      expect(caller).toBe(DSH_ID);
      return jobs;
    });
    (dsh.ctx as { get?: unknown }).get = (name: string) => (name === 'jobs' ? { list } : undefined);
    const session = runtime(dsh.ctx);
    // Nothing bootstrapped yet: no session to own a job.
    expect(session.busy).toBe(false);
    expect(list).not.toHaveBeenCalled();
    await session.bootstrap();
    expect(session.busy).toBe(false);
    // An unowned job, or one of another session, is not this session's work.
    jobs.push({ status: 'running' }, { owner: 'aiclient-other', status: 'running' });
    expect(session.busy).toBe(false);
    jobs.push({ owner: DSH_ID, status: 'completed' });
    expect(session.busy).toBe(false);
    jobs.push({ owner: DSH_ID, status: 'stopping' });
    expect(session.busy).toBe(true);
    await session.dispose();
    expect(session.busy).toBe(false);
  });

  it('reads not busy when the host has no jobs service, or it throws', async () => {
    const dsh = fakeDsh();
    const session = runtime(dsh.ctx);
    await session.bootstrap();
    expect(session.busy).toBe(false);
    (dsh.ctx as { get?: unknown }).get = () => ({
      list: () => {
        throw new Error('jobs disposed');
      },
    });
    expect(session.busy).toBe(false);
  });
});

describe('DshSessionRuntime — questions (P1-4d3, decisions 098 and 114)', () => {
  const QUESTION = {
    id: 'pick',
    question: 'Which one?',
    options: [{ label: 'A' }, { label: 'B' }],
  };
  type Event = { type: string; payload?: Record<string, unknown> };

  async function opened() {
    const dsh = fakeDsh();
    const events: Event[] = [];
    const session = runtime(dsh.ctx, { emit: (event) => events.push(event as Event) });
    await session.bootstrap();
    const next = vi.fn(async () => ({ answers: [] }));
    const cards = () => events.filter((event) => event.type.startsWith('question.'));
    return { dsh, session, next, cards };
  }

  it("answers its own root agent's request on the card, and passes every other one on", async () => {
    const { dsh, session, next, cards } = await opened();
    // Another chat's agent (or a delegate), and an agentless request: not this card.
    await dsh.ask({ questions: [QUESTION], agent: { id: 'aiclient-other' } }, next);
    await dsh.ask({ questions: [QUESTION] }, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(cards()).toEqual([]);

    const asked = dsh.ask(
      { questions: [QUESTION], agent: { id: DSH_ID }, signal: new AbortController().signal },
      next
    );
    expect(cards()).toHaveLength(1);
    const card = cards()[0] as Event;
    expect(card.payload).toMatchObject({
      questions: [
        { id: 'pick', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    });
    const questionId = String(card.payload?.questionId);
    expect(questionId).toMatch(/^dsh-question-[0-9a-f-]{36}$/);
    expect(session.respondQuestion({ questionId, answers: { pick: 'B' } })).toBe(true);
    await expect(asked).resolves.toEqual({ answers: [{ id: 'pick', selected: ['B'] }] });
    expect(next).toHaveBeenCalledTimes(2);
    expect(cards()[1]).toMatchObject({
      type: 'question.resolved',
      payload: { questionId, outcome: 'answered', answers: { pick: 'B' } },
    });
    expect(session.respondQuestion({ questionId, cancel: true })).toBe(false);
  });

  it('takes the card down when the asker aborts (a Stop), and when the session closes', async () => {
    const { dsh, session, next, cards } = await opened();
    const controller = new AbortController();
    const stopped = dsh.ask(
      { questions: [QUESTION], agent: { id: DSH_ID }, signal: controller.signal },
      next
    );
    controller.abort();
    await expect(stopped).rejects.toThrow('aborted');
    const closing = dsh.ask({ questions: [QUESTION], agent: { id: DSH_ID } }, next);
    await session.dispose();
    await expect(closing).rejects.toThrow('closed before the user answered');
    // Decision 144: both are `stopped`, which tells them apart from a Skip.
    expect(
      cards().map((event) => [event.type, event.payload?.outcome, event.payload?.stopped])
    ).toEqual([
      ['question.requested', undefined, undefined],
      ['question.resolved', 'cancelled', true],
      ['question.requested', undefined, undefined],
      ['question.resolved', 'cancelled', true],
    ]);
    expect(next).not.toHaveBeenCalled();
  });

  it('takes worker.question.respond through the RPC server, Skip included', async () => {
    const dsh = fakeDsh();
    const sent: Array<Record<string, unknown>> = [];
    const server = new BridgeRpcServer({
      port: { postMessage: (message) => sent.push(message as Record<string, unknown>) },
      generation: 1,
      projectTrusted: true,
      createRuntime: (options) => new DshSessionRuntime(dsh.ctx, options, { ...deps, home }),
    });
    const request = (requestId: string, type: string, payload: Record<string, unknown>) =>
      server.receive({
        protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
        kind: 'request',
        generation: 1,
        requestId,
        type,
        payload,
      });
    const responseOf = (requestId: string) =>
      sent.find((message) => message.kind === 'response' && message.requestId === requestId);
    request('r1', 'worker.bootstrap', { logicalSessionId: LOGICAL, cwd: CWD });
    await vi.waitFor(() => expect(responseOf('r1')).toMatchObject({ ok: true }));

    const asked = dsh.ask({ questions: [QUESTION], agent: { id: DSH_ID } }, async () => ({
      answers: [],
    }));
    const card = JSON.stringify(sent).match(/dsh-question-[0-9a-f-]{36}/)?.[0];
    expect(card).toBeDefined();
    request('r2', 'worker.question.respond', {
      logicalSessionId: LOGICAL,
      questionId: card,
      cancel: true,
    });
    await vi.waitFor(() =>
      expect(responseOf('r2')).toMatchObject({ ok: true, result: { handled: true } })
    );
    await expect(asked).resolves.toEqual({ answers: [{ id: 'pick', selected: [] }] });
    request('r3', 'worker.question.respond', {
      logicalSessionId: LOGICAL,
      questionId: card,
      answers: { pick: 'A' },
    });
    await vi.waitFor(() =>
      expect(responseOf('r3')).toMatchObject({ ok: true, result: { handled: false } })
    );
  });
});

describe('DshSessionRuntime — the prompt cache of each step (decision 173 B2)', () => {
  type Emitted = { type: string; payload?: Record<string, unknown> };
  const T0 = 1_790_000_000_000;
  /** The test plan, with its routes as the host provides them: the gateway on anthropic-messages. */
  const ROUTED: DshBridgeModelPlan = {
    ...TEST_PLAN,
    routes: {
      'aiclient-gateway': { api: 'anthropic-messages', cacheRetention: 'long' },
      'thinker~2': { api: 'openai-completions', cacheRetention: 'long' },
    },
  };
  const at = (seq: number, type: string, data: unknown): DshLogEvent => ({
    type,
    seq,
    time: T0 + seq,
    data,
  });
  function step(seq: number, index: number, provider: string, write: number): DshLogEvent[] {
    return [
      at(seq, 'step/start', { turn: 1, step: index }),
      at(seq + 1, 'assistant/message', {
        turn: 1,
        step: index,
        message: {
          id: `a${seq + 1}`,
          role: 'assistant',
          source: { kind: 'model', provider, model: 'fake-1' },
          content: [{ type: 'text', text: 'ok' }],
        },
        usage: { inputTokens: 2, outputTokens: 10, cacheWriteTokens: write },
      }),
      at(seq + 2, 'step/end', { turn: 1, step: index }),
    ];
  }
  /** One turn on `provider`: a cold step, then one that reads none of it back. */
  const rebuilt = (provider = 'aiclient-gateway') => [
    at(0, 'turn/start', { turn: 1 }),
    ...step(1, 1, provider, 10_000),
    ...step(4, 2, provider, 12_000),
  ];
  /** What the host's request scope says of step 2's request. */
  const STEP_2_REQUEST = { verdict: { kind: 'append', added: 2 }, requestSeq: 2, at: T0 + 4 };

  /** A new session on a context that also offers the request scope; its emitted events and log lines. */
  async function opened(depsOverride: Partial<DshBridgeDeps>) {
    const dsh = fakeDsh();
    const evidenceFor = vi.fn(() => STEP_2_REQUEST);
    const ctx = {
      ...dsh.ctx,
      get: (name: string) => (name === 'aiclientRequestScope' ? { evidenceFor } : undefined),
    } as unknown as DshBridgeContext;
    const emitted: Emitted[] = [];
    const lines: string[] = [];
    const bridge = runtime(
      ctx,
      {
        emit: (event) => emitted.push(event as Emitted),
        log: (...args) => {
          if (typeof args[0] === 'string' && args[0].startsWith('cache-chain:'))
            lines.push(args[0]);
        },
      },
      depsOverride
    );
    await bridge.bootstrap();
    const settled = () =>
      emitted
        .filter((event) => event.type === 'usage.updated')
        .map((event) => event.payload?.cache);
    return { dsh, evidenceFor, settled, lines };
  }

  it('[D173-RT-1] sends and logs the rebuild of a followed route, with its request’s evidence', async () => {
    const { dsh, evidenceFor, settled, lines } = await opened({
      cacheChain: true,
      modelPlan: () => ROUTED,
    });
    for (const event of rebuilt()) dsh.append(event);
    expect(evidenceFor).toHaveBeenCalledWith(DSH_ID);
    expect(settled()).toEqual([
      // The first write: no step before it to read from.
      {
        turn: 1,
        step: 1,
        kind: 'cold',
        explained: false,
        prompt: 10_002,
        read: 0,
        write: 10_000,
        session: {
          unexplained: 0,
          unexplainedLostTokens: 0,
          unexplainedRebuilds: 0,
          unexplainedRewriteTokens: 0,
        },
      },
      {
        turn: 1,
        step: 2,
        kind: 'rebuild',
        explained: false,
        lost: 10_002,
        rewrite: 10_002,
        prompt: 12_002,
        read: 0,
        write: 12_000,
        prevPrompt: 10_002,
        prefix: 'append',
        session: {
          unexplained: 1,
          unexplainedLostTokens: 10_002,
          unexplainedRebuilds: 1,
          unexplainedRewriteTokens: 10_002,
        },
      },
    ]);
    expect(lines).toEqual([
      `cache-chain: upstream cache inconsistency session=${DSH_ID} step=t1s2 kind=rebuild prompt=12002 prev=10002 read=0 write=12000 lost=10002 matched=- prefix=append`,
    ]);
  });

  it('[D173-RT-3] names the chat’s gateway session while the host names one', async () => {
    const { dsh, settled } = await opened({
      cacheChain: true,
      sessionMetadata: true,
      modelPlan: () => ROUTED,
    });
    for (const event of rebuilt()) dsh.append(event);
    const named = settled().map(
      (cache) =>
        (cache as { session?: { gatewaySession?: string } } | undefined)?.session?.gatewaySession
    );
    // The UUID the request tap puts in `metadata.user_id`, never the DSH id itself.
    expect(named).toEqual([gatewaySessionUuid(DSH_ID), gatewaySessionUuid(DSH_ID)]);
    expect(named[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it.each([
    ['switched off', { modelPlan: () => ROUTED }, 'aiclient-gateway'],
    ['on a route of another protocol', { cacheChain: true, modelPlan: () => ROUTED }, 'thinker~2'],
    ['with a plan that names no route', { cacheChain: true }, 'aiclient-gateway'],
  ])('[D173-RT-2] says nothing %s', async (_label, depsOverride, provider) => {
    const { dsh, evidenceFor, settled, lines } = await opened(depsOverride);
    for (const event of rebuilt(provider)) dsh.append(event);
    expect(settled()).toEqual([undefined, undefined]);
    expect(lines).toEqual([]);
    if (!('cacheChain' in depsOverride)) expect(evidenceFor).not.toHaveBeenCalled();
  });
});

describe('DshSessionRuntime — a side question reads the model surface (layout 5f)', () => {
  function captureLlm(seen: Array<{ messages: Array<{ content: Array<{ text?: string }> }> }>) {
    return {
      stream(options: never) {
        seen.push(options);
        return (async function* () {
          yield { type: 'text-delta', text: 'answer' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    };
  }
  const promptOf = (seen: Array<{ messages: Array<{ content: Array<{ text?: string }> }> }>) =>
    seen[0]?.messages[0]?.content[0]?.text ?? '';

  it('quotes `sessionQuery.readSurface` of its own DSH session', async () => {
    const dsh = fakeDsh();
    const readSurface = vi.fn(async (_id: string) => ({
      events: [
        {
          type: 'user/message',
          data: {
            role: 'user',
            source: { kind: 'compact-checkpoint' },
            content: [{ type: 'text', text: 'SUMMARY OF EARLIER WORK' }],
          },
        },
      ],
    }));
    Object.assign(dsh.ctx.sessionQuery, { readSurface });
    const seen: Array<{ messages: Array<{ content: Array<{ text?: string }> }> }> = [];
    const rt = runtime(dsh.ctx, {}, { sideQuestionLlm: () => captureLlm(seen) as never });
    await rt.bootstrap();

    const result = await rt.sideQuestion(
      { logicalSessionId: LOGICAL, questionId: 'q1', question: 'what was done?' },
      new AbortController().signal
    );
    expect(result).toEqual({ text: 'answer' });
    expect(readSurface).toHaveBeenCalledWith(DSH_ID);
    expect(promptOf(seen)).toContain('[Context summary]\nSUMMARY OF EARLIER WORK');
  });

  it('falls back to the projected history when the surface cannot be read', async () => {
    const dsh = fakeDsh();
    const log = vi.fn();
    Object.assign(dsh.ctx.sessionQuery, {
      readSurface: vi.fn(async () => {
        throw new Error('surface invalid');
      }),
    });
    const seen: Array<{ messages: Array<{ content: Array<{ text?: string }> }> }> = [];
    const rt = runtime(dsh.ctx, { log }, { sideQuestionLlm: () => captureLlm(seen) as never });
    await rt.bootstrap();

    await rt.sideQuestion(
      { logicalSessionId: LOGICAL, questionId: 'q1', question: 'anything?' },
      new AbortController().signal
    );
    expect(promptOf(seen)).toContain('<conversation>');
    expect(promptOf(seen)).not.toContain('Context summary');
    expect(log).toHaveBeenCalledWith(
      '[dsh-bridge] side question: surface unreadable, using the history',
      expect.any(Error)
    );
  });
});
