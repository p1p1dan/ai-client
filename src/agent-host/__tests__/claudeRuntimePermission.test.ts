import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_AGENT } from '../../shared/types/agentWire.ts';
import { ClaudeRuntime, resolveCompensationStatus } from '../claudeRuntime.ts';
import type { HostSession } from '../sessionRegistry.ts';
import { SessionRegistry } from '../sessionRegistry.ts';

/**
 * Round-2 P0 FIX 2 (permission flow hardening): `respondPermission`'s `!ok`
 * branch (the id was not actually pending — e.g. renderer/Host queue drift
 * after a Host restart, or a stale double-click) must ALSO emit
 * `permission.resolved`, not just `host.error`. Without it, chatSessions.ts's
 * `pendingPermissions` head stays permanently parked: the store only
 * dequeues on `permission.resolved`, and `host.error{code:'permission_not_pending'}`
 * has no reducer case at all (see chatSessionsCore.test.ts default: return {}).
 *
 * F7/F8 (round-2 review fix batch) extended the same branch: the compensating
 * `permission.resolved` must echo the `allow` value the USER actually chose
 * (never hardcode `false` — see the first describe block below), and must be
 * followed by a status-convergence `session.status` so the renderer is never
 * left pinned on `waiting_permission` with no card to answer (see the second
 * describe block).
 *
 * `permissionBridge.test.ts` already covers the request/respond happy path
 * (ok:true), where `PermissionBridge.respond` itself emits
 * `permission.resolved` via `entry.settle()` — untouched here.
 */

function makeRuntime(
  emitted: Record<string, unknown>[],
  registry = new SessionRegistry()
): ClaudeRuntime {
  return new ClaudeRuntime({
    driver: 'agent-sdk',
    cliPath: 'unused-in-fake',
    env: {},
    emit: (e) => emitted.push(e),
    log: () => undefined,
    registry,
  });
}

describe('claudeRuntime.respondPermission — FIX 2 (round-2 P0 hardening) + F7 echo semantics', () => {
  it('echoes the allow value the user actually chose in the compensating permission.resolved (F7: not hardcoded false)', () => {
    const emitted: Record<string, unknown>[] = [];
    const rt = makeRuntime(emitted);
    rt.createSession({ sessionId: 's1', workspacePath: process.cwd() });

    emitted.length = 0;
    rt.respondPermission({ sessionId: 's1', permissionId: 'perm-stale', allow: true });

    expect(emitted.map((e) => e.type)).toEqual([
      'host.error',
      'permission.resolved',
      'session.status',
    ]);
    expect(emitted[0]).toMatchObject({
      type: 'host.error',
      sessionId: 's1',
      payload: { code: 'permission_not_pending' },
    });
    // A user-approved card must never flip to "Denied" — the compensating
    // event echoes what the user actually clicked, even though the Host had
    // nothing pending to grant.
    expect(emitted[1]).toMatchObject({
      type: 'permission.resolved',
      sessionId: 's1',
      payload: { permissionId: 'perm-stale', allow: true },
    });
  });

  it('echoes allow:false just as faithfully (not just allow:true)', () => {
    const emitted: Record<string, unknown>[] = [];
    const rt = makeRuntime(emitted);
    rt.createSession({ sessionId: 's1b', workspacePath: process.cwd() });

    emitted.length = 0;
    rt.respondPermission({ sessionId: 's1b', permissionId: 'perm-stale-2', allow: false });

    expect(emitted[1]).toMatchObject({
      type: 'permission.resolved',
      sessionId: 's1b',
      payload: { permissionId: 'perm-stale-2', allow: false },
    });
  });

  it('emits host.error, a payload-echoing permission.resolved, AND a status-convergence event for an unknown session too', () => {
    const emitted: Record<string, unknown>[] = [];
    const rt = makeRuntime(emitted);

    rt.respondPermission({ sessionId: 'no-such-session', permissionId: 'perm-1', allow: false });

    // No session lookup happens in respondPermission (it goes straight to
    // permissions.respond, which is session-agnostic keyed by permissionId),
    // so this still hits the same !ok branch and emits all three events.
    expect(emitted.map((e) => e.type)).toEqual([
      'host.error',
      'permission.resolved',
      'session.status',
    ]);
    expect(emitted[1]).toMatchObject({
      type: 'permission.resolved',
      sessionId: 'no-such-session',
      payload: { permissionId: 'perm-1', allow: false },
    });
    // No registry entry at all for this session — 'idle' is the safe default.
    expect(emitted[2]).toMatchObject({
      type: 'session.status',
      sessionId: 'no-such-session',
      payload: { status: 'idle' },
    });
  });
});

describe('claudeRuntime.respondPermission — F8 status convergence', () => {
  it('reports idle when the session exists but has no turn running', () => {
    const emitted: Record<string, unknown>[] = [];
    const rt = makeRuntime(emitted);
    rt.createSession({ sessionId: 's2', workspacePath: process.cwd() });

    emitted.length = 0;
    rt.respondPermission({ sessionId: 's2', permissionId: 'perm-stale', allow: true });

    expect(emitted[2]).toMatchObject({ type: 'session.status', payload: { status: 'idle' } });
  });

  it('reports running when the registry still has an active turn for this session', () => {
    const emitted: Record<string, unknown>[] = [];
    const registry = new SessionRegistry();
    const rt = makeRuntime(emitted, registry);
    rt.createSession({ sessionId: 's3', workspacePath: process.cwd() });
    // Simulate a turn actively running (mirrors what `send()` sets before its
    // query() loop starts) without spinning up a fake SDK stream.
    const session = registry.get('s3');
    if (session) session.running = true;

    emitted.length = 0;
    rt.respondPermission({ sessionId: 's3', permissionId: 'perm-stale', allow: true });

    expect(emitted[2]).toMatchObject({ type: 'session.status', payload: { status: 'running' } });
  });

  it('never re-emits a stuck waiting_permission/waiting_question status even if the registry still reads one', () => {
    const emitted: Record<string, unknown>[] = [];
    const registry = new SessionRegistry();
    const rt = makeRuntime(emitted, registry);
    rt.createSession({ sessionId: 's4', workspacePath: process.cwd() });
    // Defensive case: registry status lagging behind (not running, but still
    // reads waiting_permission) — this compensation event must not echo the
    // exact stuck status it exists to clear.
    registry.setStatus('s4', 'waiting_permission');

    emitted.length = 0;
    rt.respondPermission({ sessionId: 's4', permissionId: 'perm-stale', allow: true });

    expect(emitted[2]).toMatchObject({ type: 'session.status', payload: { status: 'idle' } });
  });
});

/**
 * `resolveCompensationStatus` reads only `status`/`running`, but its parameter
 * is a whole `HostSession`, which S2 (b) gave a REQUIRED `agent` — every
 * registry entry is created by a runtime that names itself, so "no agent" is
 * not a representable state and the type says so. Built here so these cases
 * stay about the status formula, and so the next required field is one edit
 * instead of eight.
 */
function hostSession(fields: Pick<HostSession, 'status' | 'running'>): HostSession {
  return { sessionId: 's', workspacePath: '/tmp', agent: CLAUDE_CODE_AGENT, ...fields };
}

describe('resolveCompensationStatus (pure)', () => {
  it('returns idle for an undefined session', () => {
    expect(resolveCompensationStatus(undefined)).toBe('idle');
  });

  it('returns running whenever the session is running, regardless of its stored status', () => {
    expect(resolveCompensationStatus(hostSession({ status: 'idle', running: true }))).toBe(
      'running'
    );
  });

  it('passes through a non-waiting terminal status unchanged', () => {
    expect(resolveCompensationStatus(hostSession({ status: 'failed', running: false }))).toBe(
      'failed'
    );
  });

  it('normalizes waiting_permission/waiting_question to idle when not running', () => {
    expect(
      resolveCompensationStatus(hostSession({ status: 'waiting_permission', running: false }))
    ).toBe('idle');
    expect(
      resolveCompensationStatus(hostSession({ status: 'waiting_question', running: false }))
    ).toBe('idle');
  });
});

describe('resolveCompensationStatus — R14 bridge-pending override (round-2 iteration-2 review)', () => {
  // `HostSession` structurally cannot represent waiting_permission/
  // waiting_question — neither bridge ever writes into the registry, only
  // `emit()`s the status directly (see the function's own doc comment). The
  // `pending` bag is how the call site (respondPermission) supplies that
  // otherwise-invisible bridge state.
  it('reports waiting_permission when a permission is pending, even on an idle/non-running session', () => {
    expect(
      resolveCompensationStatus(hostSession({ status: 'idle', running: false }), {
        permission: true,
      })
    ).toBe('waiting_permission');
  });

  it('reports waiting_question when a question is pending', () => {
    expect(
      resolveCompensationStatus(hostSession({ status: 'idle', running: false }), { question: true })
    ).toBe('waiting_question');
  });

  it('a pending permission wins even while the session is ALSO running (a turn stays running host-side while canUseTool awaits the user)', () => {
    expect(
      resolveCompensationStatus(hostSession({ status: 'running', running: true }), {
        permission: true,
      })
    ).toBe('waiting_permission');
  });

  it('falls back to the running/status formula when nothing is pending (no `pending` arg at all)', () => {
    expect(resolveCompensationStatus(hostSession({ status: 'idle', running: true }))).toBe(
      'running'
    );
  });
});

describe('claudeRuntime.respondPermission — R14 integration (a genuinely pending sibling permission)', () => {
  it('reports waiting_permission — not running — when a DIFFERENT permission is still parked on this same session', async () => {
    const emitted: Record<string, unknown>[] = [];
    const queryFn = (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const canUseTool = params.options?.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; toolUseID: string }
      ) => Promise<{ behavior?: string }>;
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        await canUseTool('Bash', {}, { signal: abort.signal, toolUseID: 'toolu_2' });
        yield { type: 'result', result: 'done' };
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
    const registry = new SessionRegistry();
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => emitted.push(e),
      log: () => undefined,
      registry,
      queryFn,
    });
    rt.createSession({ sessionId: 's5', workspacePath: process.cwd() });
    const sendPromise = rt.send({ sessionId: 's5', text: 'hi' });
    // Let the fake stream reach canUseTool and genuinely park on toolu_2.
    await new Promise((resolve) => setTimeout(resolve, 20));

    emitted.length = 0;
    // A STALE/desynced id for the SAME session — unrelated to the real
    // toolu_2 pending above (mirrors the FIX 2 desync scenario).
    rt.respondPermission({ sessionId: 's5', permissionId: 'toolu_1', allow: true });

    expect(emitted.map((e) => e.type)).toEqual([
      'host.error',
      'permission.resolved',
      'session.status',
    ]);
    expect(emitted[2]).toMatchObject({
      type: 'session.status',
      payload: { status: 'waiting_permission' },
    });

    // Clean up: answer the real parked permission so send() resolves.
    rt.respondPermission({ sessionId: 's5', permissionId: 'toolu_2', allow: true });
    await sendPromise;
  });
});

/**
 * S8 (round-2 iteration-3 review): the real `claudeRuntime.ts` wiring — not
 * just the pure `resolveCompensationStatus` formula the R14 tests above
 * cover — for the settle() paths on BOTH bridges. A turn whose model emits
 * parallel tool_use (an ordinary tool call AND an AskUserQuestion in the
 * same turn) parks one prompt on each bridge; answering EITHER one first
 * must report `waiting_*` for whichever bridge still holds the other, not
 * `running`. Tests for both orderings.
 */
describe('claudeRuntime — cross-bridge peer pending on settle() (S8, round-2 iteration-3 review)', () => {
  function makeParallelToolUseRuntime(emitted: Record<string, unknown>[]) {
    const queryFn = (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const canUseTool = params.options?.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; toolUseID: string }
      ) => Promise<{ behavior?: string }>;
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        // Both parked without awaiting one before the other — mirrors a
        // model emitting parallel tool_use blocks in one turn.
        const permPromise = canUseTool('Bash', {}, { signal: abort.signal, toolUseID: 'toolu_p' });
        const questionPromise = canUseTool(
          'AskUserQuestion',
          { questions: [{ question: 'Continue?', options: [{ label: 'yes' }] }] },
          { signal: abort.signal, toolUseID: 'toolu_q' }
        );
        await Promise.all([permPromise, questionPromise]);
        yield { type: 'result', result: 'done' };
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
    const registry = new SessionRegistry();
    return new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => emitted.push(e),
      log: () => undefined,
      registry,
      queryFn,
    });
  }

  it('ordering 1: answering the permission first reports waiting_question — not running — while the question is still parked', async () => {
    const emitted: Record<string, unknown>[] = [];
    const rt = makeParallelToolUseRuntime(emitted);
    rt.createSession({ sessionId: 's6', workspacePath: process.cwd() });
    const sendPromise = rt.send({ sessionId: 's6', text: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    emitted.length = 0;
    rt.respondPermission({ sessionId: 's6', permissionId: 'toolu_p', allow: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const statusEvents = emitted.filter((e) => e.type === 'session.status');
    expect(statusEvents.at(-1)).toMatchObject({ payload: { status: 'waiting_question' } });
    expect(statusEvents.some((e) => (e.payload as { status?: string }).status === 'running')).toBe(
      false
    );

    // Clean up: answer the still-parked question so send() resolves.
    rt.respondQuestion({ sessionId: 's6', questionId: 'toolu_q', answers: { Continue: 'yes' } });
    await sendPromise;
  });

  it('ordering 2: answering the question first reports waiting_permission — not running — while the permission is still parked', async () => {
    const emitted: Record<string, unknown>[] = [];
    const rt = makeParallelToolUseRuntime(emitted);
    rt.createSession({ sessionId: 's7', workspacePath: process.cwd() });
    const sendPromise = rt.send({ sessionId: 's7', text: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    emitted.length = 0;
    rt.respondQuestion({ sessionId: 's7', questionId: 'toolu_q', answers: { Continue: 'yes' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const statusEvents = emitted.filter((e) => e.type === 'session.status');
    expect(statusEvents.at(-1)).toMatchObject({ payload: { status: 'waiting_permission' } });
    expect(statusEvents.some((e) => (e.payload as { status?: string }).status === 'running')).toBe(
      false
    );

    // Clean up: answer the still-parked permission so send() resolves.
    rt.respondPermission({ sessionId: 's7', permissionId: 'toolu_p', allow: true });
    await sendPromise;
  });

  it('once BOTH prompts are answered, the second respond reports running', async () => {
    const emitted: Record<string, unknown>[] = [];
    const rt = makeParallelToolUseRuntime(emitted);
    rt.createSession({ sessionId: 's8', workspacePath: process.cwd() });
    const sendPromise = rt.send({ sessionId: 's8', text: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    rt.respondPermission({ sessionId: 's8', permissionId: 'toolu_p', allow: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    emitted.length = 0;
    // Checked SYNCHRONOUSLY, right after the call: `settle()` emits
    // synchronously, but resolving the `Promise.all([...])` the fake
    // queryFn awaits only resumes the generator (and its subsequent
    // `result` event, which would itself drive a LATER status transition)
    // as a microtask — after this line, not during it.
    rt.respondQuestion({ sessionId: 's8', questionId: 'toolu_q', answers: { Continue: 'yes' } });

    const statusEvents = emitted.filter((e) => e.type === 'session.status');
    expect(statusEvents.at(-1)).toMatchObject({ payload: { status: 'running' } });

    await sendPromise;
  });
});
