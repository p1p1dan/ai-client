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
import { testPermissionHost } from './permissionTestHost.ts';
import { TEST_PLAN } from './testPlan.ts';

/**
 * Decision 202 — a send that lands while DSH runs a turn of its own (a
 * subagent's settlement notice, a background job's wake-up, a goal round).
 *
 * Before: Main's busy gate only knows its own sends and the bridge only
 * refused a second send of its own, so the send took `this.turn` over and
 * queued a followup. The synthetic turn's `turn/end` then settled under the
 * user's requestId (Main dropped its latch early), and the user's real turn
 * came back as a new `dsh-turn-*` whose echo had lost its attempt id.
 *
 * After: the send joins the running turn as a steer — its echo carries the
 * attempt id, and the synthetic turn settles under its own id.
 */

const CWD = '/repo';
const LOGICAL = 'session-1';
const DSH_ID = dshSessionIdFor(LOGICAL);
const SYNTHETIC = `dsh-turn-${DSH_ID}-1`;

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-bridge-202-'));
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
  let seq = 0;
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
    get: () => undefined,
  } as unknown as DshBridgeContext;
  const append = (type: string, data: Record<string, unknown>) => {
    const event = { type, seq, time: 1_790_000_000_000 + seq, data };
    seq += 1;
    listeners.get('session/event')?.({ id: DSH_ID }, event);
    return event;
  };
  return { ctx, agent, append };
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

const settled = (emitted: Emitted[]) =>
  emitted.filter((event) => event.type === 'session.completed').map((event) => event.requestId);

describe('DshSessionRuntime — a send during a turn DSH started (decision 202)', () => {
  it('[202-SYNTH-SEND] joins the running turn as a steer; the turn settles under its own id', async () => {
    const host = fakeHost();
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    // A subagent's settlement notice wakes the session.
    host.agent.status = 'running';
    host.append('turn/start', { turn: 1 });
    host.append('user/message', {
      id: 'notice-1',
      role: 'user',
      content: [{ type: 'text', text: 'subagent finished' }],
      source: { kind: 'subagent-result' },
    });

    expect(await bridge.startSend(send('turn-USER', 'and also this'))).toEqual({
      accepted: true,
      requestId: 'turn-USER',
    });
    expect(host.agent.followup).not.toHaveBeenCalled();
    expect(host.agent.steer).toHaveBeenCalledWith({ id: 'user-message-1' });

    // The turn takes the message in: the echo pairs with the composer's attempt.
    host.append('user/message', {
      id: 'user-message-1',
      role: 'user',
      content: [{ type: 'text', text: 'and also this' }],
      source: { kind: 'user' },
    });
    const echo = emitted.find(
      (event) => event.type === 'message.started' && event.payload?.role === 'user'
    );
    expect(echo).toMatchObject({
      requestId: SYNTHETIC,
      payload: { attemptId: 'attempt-turn-USER' },
    });

    host.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    host.agent.status = 'idle';
    expect(settled(emitted)).toEqual([SYNTHETIC]);
    expect(emitted.some((event) => event.requestId === 'turn-USER')).toBe(false);

    // The session is free again: the next send is an ordinary turn of its own.
    await bridge.startSend(send('turn-NEXT', 'next'));
    expect(host.agent.followup).toHaveBeenCalledTimes(1);
  });

  it('[202-PRE-START] a send between DSH marking the agent running and its `turn/start` steers too', async () => {
    const host = fakeHost();
    const emitted: Emitted[] = [];
    const bridge = runtime(host.ctx, emitted);
    await bridge.bootstrap();

    host.agent.status = 'running';
    await bridge.startSend(send('turn-USER', 'hello'));
    expect(host.agent.followup).not.toHaveBeenCalled();
    expect(host.agent.steer).toHaveBeenCalledTimes(1);

    // The wake-up's turn opens as DSH's own, not under the user's requestId.
    host.append('turn/start', { turn: 1 });
    host.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(settled(emitted)).toEqual([SYNTHETIC]);
  });

  it('[202-OWN-TURN] a second send during a turn this bridge sent is still busy', async () => {
    const host = fakeHost();
    const bridge = runtime(host.ctx, []);
    await bridge.bootstrap();
    await bridge.startSend(send('turn-1', 'first'));
    host.agent.status = 'running';
    await expect(bridge.startSend(send('turn-2', 'second'))).rejects.toMatchObject({
      code: 'WORKER_SESSION_BUSY',
    });
    expect(host.agent.steer).not.toHaveBeenCalled();
  });
});
