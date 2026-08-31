import { WORKER_RPC_PROTOCOL_VERSION, type WorkerRpcEvent } from '@shared/types/workerRpc';
import { describe, expect, it, vi } from 'vitest';
import { PiSingleSlotRuntime } from '../PiSingleSlotRuntime';

function harness() {
  const events: Array<Record<string, unknown>> = [];
  const requests: Array<{ type: string; payload: unknown }> = [];
  let onEvent: ((event: WorkerRpcEvent) => void) | undefined;
  let onLifecycle: ((event: unknown) => void) | undefined;
  const slot = {
    pid: 4242,
    request: vi.fn(async (type: string, payload: unknown) => {
      requests.push({ type, payload });
      if (type === 'worker.send') {
        return { accepted: true, requestId: (payload as { requestId: string }).requestId };
      }
      if (type === 'worker.stop') return { stopped: true };
      if (type === 'worker.extensionUi.respond') return { handled: true };
      throw new Error(`unexpected request ${type}`);
    }),
    dispose: vi.fn(async () => undefined),
    forceKillNow: vi.fn(() => true),
  };
  const createSlot = vi.fn(async (options: Record<string, unknown>) => {
    onEvent = options.onEvent as (event: WorkerRpcEvent) => void;
    onLifecycle = options.onLifecycle as (event: unknown) => void;
    return {
      slot,
      bootstrap: {
        bootstrapped: true,
        logicalSessionId: options.logicalSessionId,
        piSessionId: 'pi-1',
        cwd: options.cwd,
        agentDir: '/agent',
        sessionFile: '/agent/sessions/one.jsonl',
        projectTrusted: false,
        permissionGate: 'bundled',
      },
    };
  });
  const runtime = new PiSingleSlotRuntime({
    createSlot: createSlot as never,
    onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
  });
  return {
    runtime,
    events,
    requests,
    slot,
    createSlot,
    emitRuntime(event: Record<string, unknown>) {
      onEvent?.({
        protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
        kind: 'event',
        generation: 1,
        type: 'runtime.event',
        payload: event,
      });
    },
    crash(message = 'worker crashed') {
      onLifecycle?.({
        type: 'crashed',
        slotKey: 'workspace:/repo',
        generation: 1,
        error: new Error(message),
      });
    },
  };
}

describe('PiSingleSlotRuntime', () => {
  it('creates one slot, exposes session-file identity, and forwards worker events', async () => {
    const h = harness();
    const requestId = await h.runtime.createSession({
      sessionId: 'logical-1',
      workspacePath: '/repo',
      model: 'glm/glm-5',
      effort: 'high',
    });
    expect(h.createSlot).toHaveBeenCalledTimes(1);
    expect(h.events[0]).toMatchObject({
      type: 'session.created',
      sessionId: 'logical-1',
      requestId,
      payload: { agent: 'pi', runtimeIdentity: '/agent/sessions/one.jsonl' },
    });

    h.emitRuntime({
      type: 'message.delta',
      sessionId: 'logical-1',
      requestId: 'turn-1',
      seq: 99,
      timestamp: 1,
      payload: { messageId: 'm1', blockId: 'b1', text: 'hello' },
    });
    expect(h.events.at(-1)).toMatchObject({ type: 'message.delta', requestId: 'turn-1' });
  });

  it('routes send and stop to the authoritative slot without creating a stop-only worker', async () => {
    const h = harness();
    await expect(h.runtime.stop('missing')).resolves.toMatch(/^stop-/);
    expect(h.createSlot).not.toHaveBeenCalled();

    await h.runtime.createSession({ sessionId: 'logical-1', workspacePath: '/repo' });
    const turnId = await h.runtime.send({ sessionId: 'logical-1', text: 'hello' });
    await h.runtime.stop('logical-1');
    expect(h.requests).toEqual([
      {
        type: 'worker.send',
        payload: expect.objectContaining({
          logicalSessionId: 'logical-1',
          requestId: turnId,
          text: 'hello',
        }),
      },
      {
        type: 'worker.stop',
        payload: { logicalSessionId: 'logical-1', reason: 'user' },
      },
    ]);
  });

  it('rejects a concurrent send without losing active-turn crash ownership', async () => {
    const h = harness();
    await h.runtime.createSession({ sessionId: 'logical-1', workspacePath: '/repo' });
    let admitFirst: (value: { accepted: true; requestId: string }) => void = () => undefined;
    h.slot.request.mockImplementationOnce(
      (_type: string, payload: unknown) =>
        new Promise((resolve) => {
          admitFirst = resolve;
          h.requests.push({ type: 'worker.send', payload });
        })
    );

    const firstSend = h.runtime.send({ sessionId: 'logical-1', text: 'first' });
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const firstTurnId = (h.requests[0].payload as { requestId: string }).requestId;
    await expect(h.runtime.send({ sessionId: 'logical-1', text: 'second' })).rejects.toThrow(
      /session_busy/
    );
    h.crash('boom while first is active');
    expect(h.events.at(-1)).toMatchObject({
      type: 'session.failed',
      requestId: firstTurnId,
      payload: { error: 'boom while first is active' },
    });
    admitFirst({ accepted: true, requestId: firstTurnId });
    await expect(firstSend).resolves.toBe(firstTurnId);
  });

  it('disposes on close and force-kills synchronously on signal cleanup', async () => {
    const h = harness();
    await h.runtime.createSession({ sessionId: 'logical-1', workspacePath: '/repo' });
    await h.runtime.closeSession('logical-1');
    expect(h.slot.dispose).toHaveBeenCalledWith('slot-dispose');

    await h.runtime.createSession({ sessionId: 'logical-2', workspacePath: '/repo' });
    h.runtime.forceKillAllNow();
    expect(h.slot.forceKillNow).toHaveBeenCalledTimes(1);
    expect(h.runtime.getStatus().state).toBe('stopped');
  });

  it('retains disposing-slot ownership so the global deadline can force-kill it', async () => {
    const h = harness();
    await h.runtime.createSession({ sessionId: 'logical-1', workspacePath: '/repo' });
    let finishDispose: () => void = () => undefined;
    h.slot.dispose.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishDispose = () => resolve(undefined);
        })
    );

    const disposing = h.runtime.disposeAll('app-shutdown');
    await vi.waitFor(() => expect(h.slot.dispose).toHaveBeenCalledWith('app-shutdown'));
    h.runtime.forceKillAllNow();
    expect(h.slot.forceKillNow).toHaveBeenCalledTimes(1);
    finishDispose();
    await expect(disposing).resolves.toBeUndefined();
    expect(h.runtime.getStatus().state).toBe('stopped');
  });

  it('synthesizes one failed terminal when an active worker crashes', async () => {
    const h = harness();
    await h.runtime.createSession({ sessionId: 'logical-1', workspacePath: '/repo' });
    const turnId = await h.runtime.send({ sessionId: 'logical-1', text: 'hello' });
    h.crash('boom');
    expect(h.events.slice(-2)).toEqual([
      expect.objectContaining({
        type: 'session.status',
        requestId: turnId,
        payload: { status: 'disconnected' },
      }),
      expect.objectContaining({
        type: 'session.failed',
        requestId: turnId,
        payload: { error: 'boom' },
      }),
    ]);
  });
});
