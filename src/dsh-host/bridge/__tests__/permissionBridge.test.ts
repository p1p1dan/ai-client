import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { opendir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PiWorkerRpcServer,
  type PiWorkerRuntimeOptions,
} from '../../../agent-host/piWorkerRpcServer.ts';
import { encodeGrants, type PermissionGrant } from '../../../shared/permissions/grants.ts';
import type { PermissionFileSystem } from '../../../shared/permissions/shellPaths.ts';
import type { RuntimeEventDraft } from '../../../shared/types/runtimeEvents.ts';
import { WORKER_RPC_PROTOCOL_VERSION } from '../../../shared/types/workerRpc.ts';
import type { DshPreToolDecision, DshToolCall } from '../../permissions/dshTypes.ts';
import {
  type DshBridgeContext,
  type DshBridgeDeps,
  DshSessionRuntime,
  dshSessionIdFor,
  stubPathFor,
  WORKER_PERMISSIONS_UNAVAILABLE,
} from '../dshSessionRuntime.ts';
import { dshSandboxModeFor } from '../sandboxMode.ts';
import { grantsSidecarFor } from '../stub.ts';
import { testPermissionHost } from './permissionTestHost.ts';
import { TEST_PLAN } from './testPlan.ts';

/**
 * dsh-rebase P1-6b part 2 — the bridge's half of the permission gate: each
 * session builds a `PermissionGate` at bootstrap, attaches it to the
 * aiclient-permissions row before its agent opens, and carries the gate's
 * cards to Main and the answers back (decision 042 rule 5). Against the real
 * `PermissionHost` and a real workspace; the DSH side is a fake context.
 */

const LOGICAL = 'perm-session';
const DSH_ID = dshSessionIdFor(LOGICAL);

let home = '';
let ws = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-bridge-perm-home-'));
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-bridge-perm-ws-')));
  writeFileSync(join(ws, 'notes.txt'), 'notes\n');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

type Event = RuntimeEventDraft & { requestId?: string; payload: Record<string, unknown> };

function fakeDsh(options: { permissions?: boolean; fs?: PermissionFileSystem } = {}) {
  const calls: string[] = [];
  const permissions = testPermissionHost(options.fs ? { fs: options.fs } : {});
  const attach = vi.spyOn(permissions.api, 'attachGate');
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  /** What `agent.status` reads: DSH marks a goal round or a job notice running before its turn/start. */
  const agentState = { status: 'idle' as 'idle' | 'running' };
  const handle = (id: string) => ({
    agent: {
      id,
      get status() {
        return agentState.status;
      },
      session: { header: { cwd: ws } },
      followup: () => undefined,
      cancel: () => undefined,
    },
    dispose: async () => {
      calls.push(`dispose ${id}`);
    },
  });
  let seq = 100;
  /** One durable event of the session, as DSH's `session/event` delivers it. */
  const emitEvent = (type: string, data: Record<string, unknown> = {}) => {
    seq += 1;
    listeners.get('session/event')?.({ id: DSH_ID }, { type, seq, time: seq, data });
  };
  const ctx = {
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    agents: {
      create: vi.fn(async (input: { sessionId: string }) => {
        calls.push(`create ${input.sessionId} attached=${attach.mock.calls.length}`);
        return handle(input.sessionId);
      }),
      resume: vi.fn(async (input: { resumeSessionId: string }) => {
        calls.push(`resume ${input.resumeSessionId} attached=${attach.mock.calls.length}`);
        return handle(input.resumeSessionId);
      }),
    },
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
    ...(options.permissions === false ? {} : { aiclientPermissions: permissions.api }),
  } as unknown as DshBridgeContext;
  return {
    ctx,
    calls,
    host: permissions.host,
    api: permissions.api,
    attach,
    agentState,
    emitEvent,
  };
}

function runtime(
  ctx: DshBridgeContext,
  extra: Partial<PiWorkerRuntimeOptions> = {},
  deps: Partial<DshBridgeDeps> = {}
) {
  const events: Event[] = [];
  const log = vi.fn();
  const bridge = new DshSessionRuntime(
    ctx,
    {
      logicalSessionId: LOGICAL,
      cwd: ws,
      projectTrusted: true,
      emit: (event) => events.push(event as Event),
      log,
      ...extra,
    },
    {
      createUserMessage: () => ({ id: 'user-message-1' }),
      now: () => 1_700_000_000_000,
      modelPlan: () => TEST_PLAN,
      home,
      permissionAgentDir: null,
      ...deps,
    }
  );
  return { bridge, events, log };
}

/** One DSH tool call of `agentId`, as `tools/pre-execute` sees it. */
function call(
  name: string,
  args: Record<string, unknown>,
  options: { callId?: string; agentId?: string; signal?: AbortSignal } = {}
): DshToolCall {
  const id = options.agentId ?? DSH_ID;
  return {
    callId: options.callId ?? 'call-1',
    name,
    arguments: Object.freeze({ ...args }),
    agent: { id, session: { header: { id, cwd: ws } } },
    signal: options.signal ?? new AbortController().signal,
  };
}

const allowNext = async (): Promise<DshPreToolDecision> => ({ kind: 'allow' });

/** Resolves once `predicate` holds over `events`, polling. */
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((done) => setTimeout(done, 5));
  }
}

const cards = (events: Event[]) => events.filter((e) => e.type === 'permission.requested');
const answers = (events: Event[]) => events.filter((e) => e.type === 'permission.resolved');

describe('the session gate is attached before the agent opens (decision 042)', () => {
  it('[perm-attach] attaches under the new session id, then creates the agent', async () => {
    const dsh = fakeDsh();
    const { bridge } = runtime(dsh.ctx);
    const result = await bridge.bootstrap();
    expect(dsh.calls[0]).toBe(`create ${DSH_ID} attached=1`);
    expect(dsh.attach.mock.calls[0]?.[1]).toMatchObject({ dshSessionId: DSH_ID, cwd: ws });
    // True now: the bootstrap only gets here with the gate attached.
    expect(result.permissionGate).toBe('bundled');
  });

  it('[perm-attach-resume] a resume attaches under the id its stub names, before it opens', async () => {
    const stubFile = stubPathFor(home, DSH_ID);
    mkdirSync(join(home, 'aiclient-sessions'), { recursive: true });
    writeFileSync(
      stubFile,
      JSON.stringify({
        engine: 'dsh',
        version: 1,
        dshSessionId: DSH_ID,
        logicalSessionId: LOGICAL,
        cwd: ws,
        createdAt: 1,
      })
    );
    const dsh = fakeDsh();
    await runtime(dsh.ctx, { sessionFile: stubFile }).bridge.bootstrap();
    expect(dsh.calls[0]).toBe(`resume ${DSH_ID} attached=1`);
  });

  it('[perm-unavailable] refuses to bootstrap on a host without the permission row', async () => {
    const dsh = fakeDsh({ permissions: false });
    await expect(runtime(dsh.ctx).bridge.bootstrap()).rejects.toMatchObject({
      code: WORKER_PERMISSIONS_UNAVAILABLE,
    });
    expect(dsh.ctx.agents.create).not.toHaveBeenCalled();
  });

  it('[perm-locked] a session another channel of this host holds is refused as locked', async () => {
    const dsh = fakeDsh();
    await runtime(dsh.ctx).bridge.bootstrap();
    await expect(runtime(dsh.ctx).bridge.bootstrap()).rejects.toMatchObject({
      code: 'session_locked',
    });
  });
});

describe('cards round trip (decision 042 rule 5; P1-6 design 4.3)', () => {
  it('[perm-card-allow] a write in ask raises the 1.0.x card, inside the turn, and allow runs it', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx);
    await bridge.bootstrap();
    await bridge.startSend({
      logicalSessionId: LOGICAL,
      requestId: 'req-1',
      attemptId: 'attempt-1',
      text: 'write it',
    });
    const next = vi.fn(allowNext);
    const decision = dsh.host.preExecute(
      call('write', { file_path: 'out.txt', content: 'hello' }, { callId: 'call-w1' }),
      next
    );
    await until(() => cards(events).length === 1);
    const card = cards(events)[0];
    expect(card).toMatchObject({
      type: 'permission.requested',
      sessionId: LOGICAL,
      requestId: 'req-1',
      payload: {
        permissionId: 'call-w1',
        toolName: 'write',
        action: 'write_file',
        kind: 'file_change',
        decisions: ['allow', 'allow_session', 'deny'],
        timeoutMs: 120_000,
        queuePosition: 1,
        queueDepth: 1,
        input: { path: join(ws, 'out.txt'), content: 'hello', contentLabel: 'Content' },
        sessionGrantScope: { kind: 'path', value: 'out.txt' },
      },
    });
    expect(bridge.respondPermission({ permissionId: 'call-w1', decision: 'allow' })).toBe(true);
    expect(await decision).toEqual({ kind: 'allow' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(answers(events).map((e) => e.payload)).toEqual([
      { permissionId: 'call-w1', allow: true, decision: 'allow' },
    ]);
    // Settled: a second answer finds nothing waiting.
    expect(bridge.respondPermission({ permissionId: 'call-w1', decision: 'allow' })).toBe(false);
  });

  it('[perm-card-deny] deny refuses the call with 1.0.x wording, and the tool never runs', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx);
    await bridge.bootstrap();
    const next = vi.fn(allowNext);
    const decision = dsh.host.preExecute(
      call('write', { file_path: 'out.txt', content: 'x' }, { callId: 'call-d1' }),
      next
    );
    await until(() => cards(events).length === 1);
    bridge.respondPermission({ permissionId: 'call-d1', decision: 'deny' });
    expect(await decision).toEqual({
      kind: 'deny',
      reason: 'permission denied',
      info: { name: 'PermissionDenial', code: 'tool_denied', reason: 'user-denied' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(answers(events)[0]?.payload).toEqual({
      permissionId: 'call-d1',
      allow: false,
      decision: 'deny',
    });
    expect(existsSync(join(ws, 'out.txt'))).toBe(false);
  });

  it('[perm-card-session] allow_session covers the same file for the rest of the session', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx);
    await bridge.bootstrap();
    const first = dsh.host.preExecute(
      call('write', { file_path: 'out.txt', content: 'a' }, { callId: 'call-s1' }),
      allowNext
    );
    await until(() => cards(events).length === 1);
    bridge.respondPermission({ permissionId: 'call-s1', decision: 'allow_session' });
    expect((await first).kind).toBe('allow');
    const again = await dsh.host.preExecute(
      call('write', { file_path: 'out.txt', content: 'b' }, { callId: 'call-s2' }),
      allowNext
    );
    expect(again.kind).toBe('allow');
    expect(cards(events)).toHaveLength(1);
  });

  it('[perm-stop] Stop while a card is up takes it down as aborted, and the call is cancelled', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx);
    await bridge.bootstrap();
    const stop = new AbortController();
    const decision = dsh.host.preExecute(
      call(
        'write',
        { file_path: 'out.txt', content: 'x' },
        { callId: 'call-t1', signal: stop.signal }
      ),
      allowNext
    );
    await until(() => cards(events).length === 1);
    // What Stop does to the turn: DSH aborts the call's signal (P1-6b experiment E5).
    stop.abort();
    expect(await decision).toEqual({ kind: 'cancel' });
    expect(answers(events).map((e) => e.payload)).toEqual([
      { permissionId: 'call-t1', allow: false, decision: 'deny', autoReason: 'aborted' },
    ]);
  });

  /**
   * P1-4d1 (decision 088's handoff, decision 099 rule 5): the row the renderer
   * draws for such a call. DSH records the decision's `info` as the result's
   * error identity (`appendToolResult`), a cancel as ABORTED_BEFORE_DISPATCH.
   */
  it('[perm-row-flags] a refused call reads as refused; one whose card Stop took down, as not run', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx);
    await bridge.bootstrap();
    const denied = dsh.host.preExecute(
      call('write', { file_path: 'out.txt', content: 'x' }, { callId: 'call-f1' }),
      allowNext
    );
    await until(() => cards(events).length === 1);
    bridge.respondPermission({ permissionId: 'call-f1', decision: 'deny' });
    const deny = await denied;
    const stop = new AbortController();
    const cancelled = dsh.host.preExecute(
      call(
        'write',
        { file_path: 'out.txt', content: 'x' },
        { callId: 'call-f2', signal: stop.signal }
      ),
      allowNext
    );
    await until(() => cards(events).length === 2);
    stop.abort();
    expect(await cancelled).toEqual({ kind: 'cancel' });
    const result = (callId: string, error: unknown, text: string) =>
      dsh.emitEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: `r-${callId}`,
          role: 'tool',
          toolCallId: callId,
          isError: true,
          content: [{ type: 'text', text }],
        },
        error,
      });
    for (const callId of ['call-f1', 'call-f2']) {
      dsh.emitEvent('tool/call', { turn: 1, step: 1, callId, name: 'write', arguments: '{}' });
    }
    result('call-f1', deny.kind === 'deny' ? deny.info : undefined, 'Error: permission denied');
    result(
      'call-f2',
      { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
      'Error: tool call aborted before dispatch'
    );
    const rows = events
      .filter((event) => event.type === 'tool.completed')
      .map((event) => [event.payload.toolCallId, event.payload.output]);
    expect(rows).toEqual([
      [
        'call-f1',
        {
          content: [{ type: 'text', text: 'Error: permission denied' }],
          details: { refused: true },
        },
      ],
      [
        'call-f2',
        {
          content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
          details: { notStarted: true },
        },
      ],
    ]);
  });

  it('[perm-dispose] closing the session takes the card down and detaches the gate', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx);
    await bridge.bootstrap();
    const pending = dsh.host.preExecute(
      call('write', { file_path: 'out.txt', content: 'x' }, { callId: 'call-c1' }),
      allowNext
    );
    await until(() => cards(events).length === 1);
    await bridge.dispose();
    // The gate goes with the session, so the call ends as never started.
    expect((await pending).kind).toBe('cancel');
    expect(answers(events).map((e) => e.payload)).toEqual([
      { permissionId: 'call-c1', allow: false, decision: 'deny', autoReason: 'session_closed' },
    ]);
    expect(
      await dsh.host.preExecute(call('read', { file_path: 'notes.txt' }), allowNext)
    ).toMatchObject({ kind: 'deny', reason: 'permission gate not attached' });
  });
});

describe('the gate starts on the posture Main sent (bootstrap payload)', () => {
  it('[perm-seed-bypass] bypass asks nothing, and a secret is still refused', async () => {
    const dsh = fakeDsh();
    writeFileSync(join(ws, '.env'), 'SECRET=1\n');
    const { bridge, events } = runtime(dsh.ctx, {
      permissions: { mode: 'agent', gear: 'bypass' },
    });
    await bridge.bootstrap();
    expect(
      await dsh.host.preExecute(call('write', { file_path: 'out.txt', content: 'x' }), allowNext)
    ).toEqual({ kind: 'allow' });
    expect(
      await dsh.host.preExecute(
        call('read', { file_path: '.env' }, { callId: 'call-e' }),
        allowNext
      )
    ).toMatchObject({ kind: 'deny', info: { code: 'tool_denied' } });
    expect(cards(events)).toHaveLength(0);
  });

  it('[perm-seed-plan] plan mode refuses a write without a card and lets a read through', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx, { permissions: { mode: 'plan', gear: 'ask' } });
    await bridge.bootstrap();
    expect(
      await dsh.host.preExecute(call('write', { file_path: 'out.txt', content: 'x' }), allowNext)
    ).toMatchObject({
      kind: 'deny',
      reason: `access denied: write ${join(ws, 'out.txt')}`,
      info: { name: 'PermissionDenial', code: 'tool_denied', reason: 'policy-deny' },
    });
    expect(
      await dsh.host.preExecute(
        call('read', { file_path: 'notes.txt' }, { callId: 'c-r' }),
        allowNext
      )
    ).toEqual({ kind: 'allow' });
    expect(cards(events)).toHaveLength(0);
  });

  it('[perm-seed-tier] a legacy tier is migrated (fullopen -> agent / auto)', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx, { tier: 'fullopen' });
    await bridge.bootstrap();
    expect(
      await dsh.host.preExecute(call('write', { file_path: 'out.txt', content: 'x' }), allowNext)
    ).toEqual({ kind: 'allow' });
    expect(cards(events)).toHaveLength(0);
  });
});

// ---- P1-6c ---------------------------------------------------------------------

const stubFile = () => stubPathFor(home, DSH_ID);
const sidecar = () => grantsSidecarFor(stubFile());
const readSidecar = () => JSON.parse(readFileSync(sidecar(), 'utf8')) as unknown;
const writeGrant = (file: string): PermissionGrant => ({
  kind: 'path',
  tool: 'write',
  path: join(ws, file),
});

/** The stub a resume or a crash restart opens. */
function writeStubFile(): string {
  mkdirSync(join(home, 'aiclient-sessions'), { recursive: true });
  writeFileSync(
    stubFile(),
    JSON.stringify({
      engine: 'dsh',
      version: 1,
      dshSessionId: DSH_ID,
      logicalSessionId: LOGICAL,
      cwd: ws,
      createdAt: 1,
    })
  );
  return stubFile();
}

function writeSidecar(body: string): void {
  mkdirSync(join(home, 'aiclient-sessions'), { recursive: true });
  writeFileSync(sidecar(), body);
}

type Fake = ReturnType<typeof fakeDsh>;
const write = (file: string, callId: string) =>
  call('write', { file_path: file, content: 'x' }, { callId });

/** A write of `file` whose card is answered `decision`; the call's own decision. */
async function answeredWrite(
  dsh: Fake,
  opened: { bridge: DshSessionRuntime; events: Event[] },
  file: string,
  callId: string,
  decision: 'allow' | 'allow_session' | 'deny'
): Promise<DshPreToolDecision> {
  const before = cards(opened.events).length;
  const pending = dsh.host.preExecute(write(file, callId), allowNext);
  await until(() => cards(opened.events).length === before + 1);
  expect(opened.bridge.respondPermission({ permissionId: callId, decision })).toBe(true);
  return pending;
}

function thrown(action: () => unknown): { code?: string; retryable?: boolean; message?: string } {
  try {
    action();
  } catch (error) {
    return error as { code?: string; retryable?: boolean; message?: string };
  }
  throw new Error('expected a refusal');
}

describe('the grant sidecar (P1-6c, decision 043)', () => {
  it('[grants-write] allow_session writes the whole set beside the stub; allow once writes nothing', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    expect(existsSync(sidecar())).toBe(false);
    expect((await answeredWrite(dsh, opened, 'a.txt', 'c-a', 'allow_session')).kind).toBe('allow');
    expect(readSidecar()).toEqual({ version: 2, grants: [writeGrant('a.txt')] });
    expect((await answeredWrite(dsh, opened, 'b.txt', 'c-b', 'allow_session')).kind).toBe('allow');
    expect(readSidecar()).toEqual({
      version: 2,
      grants: [writeGrant('a.txt'), writeGrant('b.txt')],
    });
    expect((await answeredWrite(dsh, opened, 'c.txt', 'c-c', 'allow')).kind).toBe('allow');
    expect(readSidecar()).toEqual({
      version: 2,
      grants: [writeGrant('a.txt'), writeGrant('b.txt')],
    });
  });

  it('[grants-reopen] a resumed session (or a crash restart) starts on the grants the sidecar kept', async () => {
    writeStubFile();
    writeSidecar(JSON.stringify(encodeGrants([writeGrant('out.txt')])));
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx, { sessionFile: stubFile() });
    await opened.bridge.bootstrap();
    expect(await dsh.host.preExecute(write('out.txt', 'c-1'), allowNext)).toEqual({
      kind: 'allow',
    });
    expect(cards(opened.events)).toHaveLength(0);
    // Exactly that file: another one is still asked.
    expect((await answeredWrite(dsh, opened, 'other.txt', 'c-2', 'deny')).kind).toBe('deny');
  });

  it('[grants-host-restart] a grant outlives its host: the next host resumes the stub and asks nothing', async () => {
    const first = fakeDsh();
    const before = runtime(first.ctx);
    await before.bridge.bootstrap();
    await answeredWrite(first, before, 'out.txt', 'c-1', 'allow_session');
    // The host dies: nothing is disposed; Main reopens the stub in a new host.
    const second = fakeDsh();
    const after = runtime(second.ctx, { sessionFile: stubFile() });
    await after.bridge.bootstrap();
    expect(await second.host.preExecute(write('out.txt', 'c-2'), allowNext)).toEqual({
      kind: 'allow',
    });
    expect(cards(after.events)).toHaveLength(0);
    // Closing a session keeps its grants for the next open.
    await after.bridge.dispose();
    expect(readSidecar()).toEqual({ version: 2, grants: [writeGrant('out.txt')] });
  });

  it('[grants-create-reopen] a create that finds its own session on disk reopens it with its grants', async () => {
    writeSidecar(JSON.stringify(encodeGrants([writeGrant('out.txt')])));
    const dsh = fakeDsh();
    dsh.ctx.agents.create = vi.fn(async () => {
      throw Object.assign(new Error('exists'), { name: 'SessionAlreadyExistsError' });
    }) as never;
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    expect(dsh.calls).toEqual([`resume ${DSH_ID} attached=1`]);
    expect(await dsh.host.preExecute(write('out.txt', 'c-1'), allowNext)).toEqual({
      kind: 'allow',
    });
    expect(cards(opened.events)).toHaveLength(0);
  });

  it('[grants-corrupt] an unreadable sidecar is no grants: the session opens, says so, and asks', async () => {
    writeStubFile();
    writeSidecar('{"version":2,"grants":[{"kind":"path"');
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx, { sessionFile: stubFile() });
    await expect(opened.bridge.bootstrap()).resolves.toMatchObject({ bootstrapped: true });
    expect(opened.log).toHaveBeenCalledWith('[dsh-bridge] grants ignored: not JSON', sidecar());
    expect((await answeredWrite(dsh, opened, 'out.txt', 'c-1', 'allow_session')).kind).toBe(
      'allow'
    );
    // The next change writes a set this build reads again.
    expect(readSidecar()).toEqual({ version: 2, grants: [writeGrant('out.txt')] });
  });

  it('[grants-configure] a posture change forgets the grants and writes the empty set (1.0.x configure)', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    await answeredWrite(dsh, opened, 'out.txt', 'c-1', 'allow_session');
    opened.bridge.setPermissions({ mode: 'plan', gear: 'ask' });
    expect(readSidecar()).toEqual({ version: 2, grants: [] });
    opened.bridge.setPermissions({ mode: 'agent', gear: 'ask' });
    // Forgotten in memory as well: the same write asks again.
    expect((await answeredWrite(dsh, opened, 'out.txt', 'c-2', 'deny')).kind).toBe('deny');
    // And a session reopened on the stub starts with none.
    const again = fakeDsh();
    const reopened = runtime(again.ctx, { sessionFile: stubFile() });
    await reopened.bridge.bootstrap();
    expect((await answeredWrite(again, reopened, 'out.txt', 'c-3', 'deny')).kind).toBe('deny');
  });

  it('[grants-gear] sliding the gear keeps the grants, in memory and on disk', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    await answeredWrite(dsh, opened, 'out.txt', 'c-1', 'allow_session');
    opened.bridge.setPermissionGear('accept-edits');
    opened.bridge.setPermissionGear('ask');
    expect(readSidecar()).toEqual({ version: 2, grants: [writeGrant('out.txt')] });
    expect(await dsh.host.preExecute(write('out.txt', 'c-2'), allowNext)).toEqual({
      kind: 'allow',
    });
    expect(cards(opened.events)).toHaveLength(1);
  });
});

describe('the setters act on the gate (P1-6c)', () => {
  it('[setter-mode] setPermissions moves the mode and the gear', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    opened.bridge.setPermissions({ mode: 'plan', gear: 'ask' });
    expect(await dsh.host.preExecute(write('out.txt', 'c-1'), allowNext)).toMatchObject({
      kind: 'deny',
      info: { reason: 'policy-deny' },
    });
    opened.bridge.setPermissions({ mode: 'agent', gear: 'bypass' });
    expect(await dsh.host.preExecute(write('out.txt', 'c-2'), allowNext)).toEqual({
      kind: 'allow',
    });
    expect(cards(opened.events)).toHaveLength(0);
  });

  it('[setter-gear-widen] widening the gear answers the card on screen, which it would not have asked', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    const pending = dsh.host.preExecute(write('out.txt', 'c-1'), allowNext);
    await until(() => cards(opened.events).length === 1);
    opened.bridge.setPermissionGear('auto');
    expect(await pending).toEqual({ kind: 'allow' });
    expect(answers(opened.events).map((event) => event.payload)).toEqual([
      { permissionId: 'c-1', allow: true, decision: 'allow' },
    ]);
  });

  it('[setter-tier] a legacy tier is migrated, then set as a posture', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    opened.bridge.setPermissionTier('fullopen');
    expect(await dsh.host.preExecute(write('out.txt', 'c-1'), allowNext)).toEqual({
      kind: 'allow',
    });
    opened.bridge.setPermissionTier('readonly');
    expect(await dsh.host.preExecute(write('out.txt', 'c-2'), allowNext)).toMatchObject({
      kind: 'deny',
      info: { reason: 'policy-deny' },
    });
    expect(cards(opened.events)).toHaveLength(0);
  });

  it('[setter-busy-dsh-turn] a turn DSH started itself: a new mode is busy, the gear still moves and keeps the grants', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    await answeredWrite(dsh, opened, 'out.txt', 'c-1', 'allow_session');
    // A goal round: no worker.send, DSH opens the turn.
    dsh.emitEvent('turn/start', { turn: 7 });
    expect(thrown(() => opened.bridge.setPermissions({ mode: 'plan', gear: 'ask' }))).toMatchObject(
      { code: 'WORKER_SESSION_BUSY', retryable: true }
    );
    expect(thrown(() => opened.bridge.setPermissionTier('readonly'))).toMatchObject({
      code: 'WORKER_SESSION_BUSY',
    });
    // Main cannot see this turn and asks for the broad change: the gear is what moves.
    opened.bridge.setPermissions({ mode: 'agent', gear: 'auto' });
    expect(await dsh.host.preExecute(write('other.txt', 'c-2'), allowNext)).toEqual({
      kind: 'allow',
    });
    expect(readSidecar()).toEqual({ version: 2, grants: [writeGrant('out.txt')] });
    // Its turn over, the broad change is a configure again.
    dsh.emitEvent('turn/end', { turn: 7, reason: { kind: 'completed' } });
    opened.bridge.setPermissions({ mode: 'plan', gear: 'ask' });
    expect(readSidecar()).toEqual({ version: 2, grants: [] });
  });

  it('[setter-busy-running] an agent DSH marked running before any turn/start is busy too', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    dsh.agentState.status = 'running';
    expect(thrown(() => opened.bridge.setPermissions({ mode: 'plan', gear: 'ask' }))).toMatchObject(
      { code: 'WORKER_SESSION_BUSY' }
    );
    dsh.agentState.status = 'idle';
    opened.bridge.setPermissions({ mode: 'plan', gear: 'ask' });
    expect(await dsh.host.preExecute(write('out.txt', 'c-1'), allowNext)).toMatchObject({
      kind: 'deny',
    });
  });

  it('[setter-unavailable] with no gate attached, every setter says so', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    const setters = [
      () => opened.bridge.setPermissions({ mode: 'agent', gear: 'ask' }),
      () => opened.bridge.setPermissionGear('auto'),
      () => opened.bridge.setPermissionTier('fullopen'),
    ];
    for (const set of setters) {
      expect(thrown(set)).toMatchObject({ code: WORKER_PERMISSIONS_UNAVAILABLE });
    }
    await opened.bridge.bootstrap();
    opened.bridge.setPermissionGear('auto');
    await opened.bridge.dispose();
    for (const set of setters) {
      expect(thrown(set)).toMatchObject({ code: WORKER_PERMISSIONS_UNAVAILABLE });
    }
  });

  it("[setter-rpc] Main's three RPCs reach the gate through PiWorkerRpcServer", async () => {
    const dsh = fakeDsh();
    const sent: Array<Record<string, unknown>> = [];
    const server = new PiWorkerRpcServer({
      port: { postMessage: (message) => sent.push(message as Record<string, unknown>) },
      generation: 1,
      projectTrusted: true,
      createRuntime: (options) =>
        new DshSessionRuntime(dsh.ctx, options, {
          createUserMessage: () => ({ id: 'user-message-1' }),
          modelPlan: () => TEST_PLAN,
          home,
          permissionAgentDir: null,
        }),
      createImportWriter: () => {
        throw new Error('not in this test');
      },
      createUtilityRuntime: () => {
        throw new Error('not in this test');
      },
    });
    const rpc = async (requestId: string, type: string, payload: Record<string, unknown>) => {
      server.receive({
        protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
        kind: 'request',
        generation: 1,
        requestId,
        type,
        payload: { logicalSessionId: LOGICAL, ...payload },
      });
      await vi.waitFor(() =>
        expect(sent.some((m) => m.kind === 'response' && m.requestId === requestId)).toBe(true)
      );
      return sent.find((m) => m.kind === 'response' && m.requestId === requestId);
    };
    expect(await rpc('r1', 'worker.bootstrap', { cwd: ws })).toMatchObject({
      ok: true,
      result: { permissionGate: 'bundled' },
    });
    expect(
      await rpc('r2', 'worker.setPermissions', { permissions: { mode: 'plan', gear: 'ask' } })
    ).toMatchObject({ ok: true, result: { applied: true } });
    expect(await dsh.host.preExecute(write('out.txt', 'c-1'), allowNext)).toMatchObject({
      kind: 'deny',
      info: { reason: 'policy-deny' },
    });
    expect(await rpc('r3', 'worker.setPermissionTier', { tier: 'fullopen' })).toMatchObject({
      ok: true,
      result: { applied: true },
    });
    expect(await dsh.host.preExecute(write('out.txt', 'c-2'), allowNext)).toEqual({
      kind: 'allow',
    });
    expect(await rpc('r4', 'worker.setPermissionGear', { gear: 'bypass' })).toMatchObject({
      ok: true,
      result: { applied: true },
    });
    dsh.emitEvent('turn/start', { turn: 3 });
    expect(
      await rpc('r5', 'worker.setPermissions', { permissions: { mode: 'plan', gear: 'ask' } })
    ).toMatchObject({ ok: false, error: { code: 'WORKER_SESSION_BUSY', retryable: true } });
  });
});

describe('permissionGate is reported as the session has it (P1-6c)', () => {
  it('[gate-report] a bootstrap whose gate the row does not route is refused, and closes what it opened', async () => {
    const dsh = fakeDsh();
    vi.spyOn(dsh.api, 'isAttached').mockReturnValue(false);
    await expect(runtime(dsh.ctx).bridge.bootstrap()).rejects.toMatchObject({
      code: WORKER_PERMISSIONS_UNAVAILABLE,
    });
    expect(dsh.calls).toEqual([`create ${DSH_ID} attached=1`, `dispose ${DSH_ID}`]);
  });
});

describe('policy layers (P1-6c; 1.0.x decision 008)', () => {
  const BYPASS = { permissions: { mode: 'agent', gear: 'bypass' } } as const;
  const DENY_WRITES = '// written by the settings page\n{"permission": {"write": "deny"}}\n';
  let agentDir = '';

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-perm-agent-'));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("[policy-user] the user layer under the app's pi-agent directory is read, and outranks the gear", async () => {
    for (const file of [
      'pi-permissions.jsonc',
      join('extensions', 'pi-permission-system', 'config.json'),
    ]) {
      mkdirSync(join(agentDir, file, '..'), { recursive: true });
      writeFileSync(join(agentDir, file), DENY_WRITES);
      const dsh = fakeDsh();
      await runtime(dsh.ctx, BYPASS, { permissionAgentDir: agentDir }).bridge.bootstrap();
      expect(await dsh.host.preExecute(write('out.txt', 'c-1'), allowNext), file).toMatchObject({
        kind: 'deny',
        info: { reason: 'policy-deny' },
      });
      rmSync(join(agentDir, file));
    }
    // No directory from Main: no user layer.
    writeFileSync(join(agentDir, 'pi-permissions.jsonc'), DENY_WRITES);
    const dsh = fakeDsh();
    await runtime(dsh.ctx, BYPASS).bridge.bootstrap();
    expect(await dsh.host.preExecute(write('out.txt', 'c-2'), allowNext)).toEqual({
      kind: 'allow',
    });
  });

  it('[policy-project] the project layer counts in a trusted workspace only', async () => {
    mkdirSync(join(ws, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(ws, '.pi', 'agent', 'pi-permissions.jsonc'), DENY_WRITES);
    const trusted = fakeDsh();
    await runtime(trusted.ctx, BYPASS).bridge.bootstrap();
    expect(await trusted.host.preExecute(write('out.txt', 'c-1'), allowNext)).toMatchObject({
      kind: 'deny',
    });
    // An unbound (scratch) session: the RPC server resolves it untrusted.
    const scratch = fakeDsh();
    await runtime(scratch.ctx, { ...BYPASS, projectTrusted: false }).bridge.bootstrap();
    expect(await scratch.host.preExecute(write('out.txt', 'c-2'), allowNext)).toEqual({
      kind: 'allow',
    });
  });

  it('[policy-invalid] a layer that is not valid policy fails the bootstrap before any agent opens', async () => {
    writeFileSync(join(agentDir, 'pi-permissions.jsonc'), '{"permission": {"write": "maybe"}}');
    const dsh = fakeDsh();
    await expect(
      runtime(dsh.ctx, {}, { permissionAgentDir: agentDir }).bridge.bootstrap()
    ).rejects.toMatchObject({ code: 'permission_policy_invalid' });
    expect(dsh.ctx.agents.create).not.toHaveBeenCalled();
  });
});

describe("DSH's own asks (P1-6b remainder: escalate_sandbox)", () => {
  const ask = (reason: string, callId: string) => ({
    agent: { id: DSH_ID, session: { header: { id: DSH_ID, cwd: ws } } },
    toolName: 'bash',
    callId,
    reason,
    displayReason: { en: `Shown: ${reason}` },
    signal: new AbortController().signal,
  });

  it('[perm-escalate] an escalation asks once: allow / deny, worded escalate_sandbox, nothing remembered', async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    const outcome = dsh.host.answerApproval(
      ask('escalate sandbox to danger-full-access: needs the network', 'call-x1'),
      async () => 'unavailable'
    );
    await until(() => cards(opened.events).length === 1);
    const card = cards(opened.events)[0]?.payload;
    expect(card).toMatchObject({
      permissionId: 'call-x1',
      toolName: 'bash',
      action: 'escalate_sandbox',
      decisions: ['allow', 'deny'],
      input: {
        contentLabel: 'Reason',
        content: 'Shown: escalate sandbox to danger-full-access: needs the network',
      },
    });
    expect(card).not.toHaveProperty('sessionGrantScope');
    // An answer the card never offered counts as once.
    opened.bridge.respondPermission({ permissionId: 'call-x1', decision: 'allow_session' });
    expect(await outcome).toBe('allowed-once');
    expect(answers(opened.events).map((event) => event.payload)).toEqual([
      { permissionId: 'call-x1', allow: true, decision: 'allow' },
    ]);
    expect(existsSync(sidecar())).toBe(false);
  });

  it("[perm-host-ask] another ask of DSH's (a plugin's) is not worded as an escalation", async () => {
    const dsh = fakeDsh();
    const opened = runtime(dsh.ctx);
    await opened.bridge.bootstrap();
    const outcome = dsh.host.answerApproval(
      ask('publish the draft', 'call-p1'),
      async () => 'unavailable'
    );
    await until(() => cards(opened.events).length === 1);
    const card = cards(opened.events)[0]?.payload;
    expect(card).toMatchObject({ permissionId: 'call-p1', decisions: ['allow', 'deny'] });
    expect(card?.action).not.toBe('escalate_sandbox');
    opened.bridge.respondPermission({ permissionId: 'call-p1', decision: 'deny' });
    expect(await outcome).toBe('rejected');
  });
});

describe('the sandbox mapping hook (decision 044; P1-6e fills it in)', () => {
  it('maps the posture: plan reads only, bypass is unconfined, every other gear writes the workspace', () => {
    expect(dshSandboxModeFor({ mode: 'plan', gear: 'bypass' })).toBe('read-only');
    expect(dshSandboxModeFor({ mode: 'plan', gear: 'ask' })).toBe('read-only');
    expect(dshSandboxModeFor({ mode: 'agent', gear: 'bypass' })).toBe('danger-full-access');
    for (const gear of ['ask', 'accept-edits', 'auto'] as const) {
      expect(dshSandboxModeFor({ mode: 'agent', gear }), gear).toBe('workspace-write');
    }
  });

  it('[sandbox-hook] hands every posture to the writer when there is one', async () => {
    const applied: string[] = [];
    const dsh = fakeDsh();
    const opened = runtime(
      dsh.ctx,
      {},
      { applySandboxMode: (id, mode) => applied.push(`${id} ${mode}`) }
    );
    await opened.bridge.bootstrap();
    opened.bridge.setPermissions({ mode: 'plan', gear: 'ask' });
    opened.bridge.setPermissionGear('bypass');
    opened.bridge.setPermissions({ mode: 'agent', gear: 'bypass' });
    expect(applied).toEqual([
      `${DSH_ID} workspace-write`,
      `${DSH_ID} read-only`,
      `${DSH_ID} read-only`,
      `${DSH_ID} danger-full-access`,
    ]);
  });
});

/**
 * Decision 134: the gate judges the workspace by the spelling targets are
 * canonicalized in (the native realpath) and by the one the session was opened
 * with. Windows CI asked for every read in a workspace under the 8.3 `%TEMP%`
 * (`C:\Users\RUNNER~1`): the gate had canonicalized its cwd with the
 * JavaScript realpath, which keeps short names, and the row its targets with
 * the native one, which expands them. The symlink case is the same defect on
 * POSIX for shell operands written against the opened spelling.
 */
describe('the workspace by every spelling (decision 134)', () => {
  let base = '';

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-bridge-perm-spell-')));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** One DSH tool call from a session whose header names `cwd`. */
  const callIn = (
    cwd: string,
    name: string,
    args: Record<string, unknown>,
    callId: string
  ): DshToolCall => ({
    ...call(name, args, { callId }),
    agent: { id: DSH_ID, session: { header: { id: DSH_ID, cwd } } },
  });

  /** The decision, or `'card'` as soon as the call raised one (so a regression fails fast). */
  const decided = async (
    events: Event[],
    pending: Promise<DshPreToolDecision>
  ): Promise<DshPreToolDecision | 'card'> => {
    const before = cards(events).length;
    let settled = false;
    const decision = pending.finally(() => {
      settled = true;
    });
    const card = until(() => settled || cards(events).length > before).then(
      (): Promise<DshPreToolDecision | 'card'> | 'card' => (settled ? decision : 'card')
    );
    return Promise.race<DshPreToolDecision | 'card'>([decision, card]);
  };

  it.skipIf(process.platform === 'win32')(
    '[perm-ws-symlink] a workspace opened through a symlink: reads, and accept-edits shell calls written against the link, ask nothing',
    async () => {
      const link = join(base, 'ws-link');
      symlinkSync(ws, link);
      const dsh = fakeDsh();
      const { bridge, events } = runtime(dsh.ctx, {
        cwd: link,
        permissions: { mode: 'agent', gear: 'accept-edits' },
      });
      await bridge.bootstrap();
      const run = (name: string, args: Record<string, unknown>, callId: string) =>
        dsh.host.preExecute(callIn(link, name, args, callId), allowNext);

      expect(await decided(events, run('read', { file_path: 'notes.txt' }, 'c-read'))).toEqual({
        kind: 'allow',
      });
      expect(
        await decided(events, run('read', { file_path: join(link, 'notes.txt') }, 'c-read-abs'))
      ).toEqual({ kind: 'allow' });
      expect(
        await decided(
          events,
          run(
            'pwsh',
            { command: `Get-Content ${join(link, 'notes.txt')}; Set-Content out.txt x` },
            'c-pwsh'
          )
        )
      ).toEqual({ kind: 'allow' });
      expect(cards(events)).toHaveLength(0);

      // Out of the workspace by either spelling: still a card.
      const outside = run('pwsh', { command: `Get-Content ${join(base, 'far.txt')}` }, 'c-out');
      await until(() => cards(events).length === 1);
      bridge.respondPermission({ permissionId: 'c-out', decision: 'deny' });
      expect(await outside).toMatchObject({ kind: 'deny' });
    }
  );

  it('[perm-ws-8dot3] a workspace under an 8.3 path: the gate canonicalizes it as the row does its targets', async () => {
    // Stands in for Windows: `RUNNER~1` exists on disk, and the native resolver
    // spells it `runneradmin` (the JavaScript one would keep `RUNNER~1`).
    const shortRoot = join(base, 'RUNNER~1');
    const longRoot = join(base, 'runneradmin');
    const short = join(shortRoot, 'ws');
    mkdirSync(short, { recursive: true });
    writeFileSync(join(short, 'notes.txt'), 'notes\n');
    const expand = (path: string) =>
      path === shortRoot || path.startsWith(`${shortRoot}${sep}`)
        ? `${longRoot}${path.slice(shortRoot.length)}`
        : path;
    const fs: PermissionFileSystem = {
      realpath: async (path) => expand(await realpath(path)),
      readDirectory: (path) =>
        (async function* () {
          yield* await opendir(path);
        })(),
    };
    const dsh = fakeDsh({ fs });
    const { bridge, events } = runtime(
      dsh.ctx,
      { cwd: short },
      { realpathSync: (path) => expand(realpathSync(path)) }
    );
    await bridge.bootstrap();
    const run = (name: string, args: Record<string, unknown>, callId: string) =>
      dsh.host.preExecute(callIn(short, name, args, callId), allowNext);

    expect(await decided(events, run('read', { file_path: 'notes.txt' }, 'c-read'))).toEqual({
      kind: 'allow',
    });
    expect(await decided(events, run('glob', { pattern: '*.txt' }, 'c-glob'))).toEqual({
      kind: 'allow',
    });
    expect(await decided(events, run('grep', { pattern: 'notes', path: short }, 'c-grep'))).toEqual(
      { kind: 'allow' }
    );
    expect(cards(events)).toHaveLength(0);

    // A write in ask still raises its card, naming the canonical file.
    const write = run('write', { file_path: 'out.txt', content: 'x' }, 'c-write');
    await until(() => cards(events).length === 1);
    expect(cards(events)[0]?.payload).toMatchObject({
      toolName: 'write',
      input: { path: join(longRoot, 'ws', 'out.txt') },
    });
    bridge.respondPermission({ permissionId: 'c-write', decision: 'allow' });
    expect(await write).toEqual({ kind: 'allow' });
  });
});
