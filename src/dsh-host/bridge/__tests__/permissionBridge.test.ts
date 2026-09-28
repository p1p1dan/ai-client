import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiWorkerRuntimeOptions } from '../../../agent-host/piWorkerRpcServer.ts';
import type { RuntimeEventDraft } from '../../../shared/types/runtimeEvents.ts';
import type { DshPreToolDecision, DshToolCall } from '../../permissions/dshTypes.ts';
import {
  type DshBridgeContext,
  DshSessionRuntime,
  dshSessionIdFor,
  stubPathFor,
  WORKER_PERMISSIONS_UNAVAILABLE,
} from '../dshSessionRuntime.ts';
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

function fakeDsh(options: { permissions?: boolean } = {}) {
  const calls: string[] = [];
  const permissions = testPermissionHost();
  const attach = vi.spyOn(permissions.api, 'attachGate');
  const handle = (id: string) => ({
    agent: {
      id,
      status: 'idle',
      session: { header: { cwd: ws } },
      followup: () => undefined,
      cancel: () => undefined,
    },
    dispose: async () => {
      calls.push(`dispose ${id}`);
    },
  });
  const ctx = {
    on: () => () => true,
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
  return { ctx, calls, host: permissions.host, attach };
}

function runtime(ctx: DshBridgeContext, extra: Partial<PiWorkerRuntimeOptions> = {}) {
  const events: Event[] = [];
  const bridge = new DshSessionRuntime(
    ctx,
    {
      logicalSessionId: LOGICAL,
      cwd: ws,
      projectTrusted: true,
      emit: (event) => events.push(event as Event),
      ...extra,
    },
    {
      createUserMessage: () => ({ id: 'user-message-1' }),
      now: () => 1_700_000_000_000,
      modelPlan: () => TEST_PLAN,
      home,
    }
  );
  return { bridge, events };
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
