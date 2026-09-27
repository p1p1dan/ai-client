import type { WorkerRpcRequest } from '@shared/types/workerRpc';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  DSH_CHANNEL_CLOSED,
  type DshChannelLink,
  DshChannelTransport,
} from '../DshChannelTransport';
import { WorkerSlot, type WorkerSlotLifecycleEvent } from '../WorkerSlot';
import {
  createFakeHostHarness,
  FAKE_PID,
  flushMicrotasks,
  installKillTripwire,
  settlement,
  startReadyHost,
} from './fakeDshHost';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo' },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('real spawn is forbidden in these tests');
  }),
}));
vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => '/fake/state' }));

const request = (requestId = 'rpc-1', type = 'worker.send'): WorkerRpcRequest => ({
  protocolVersion: 1,
  kind: 'request',
  generation: 1,
  requestId,
  type,
  payload: {},
});

function fakeLink(): DshChannelLink & {
  sent: Array<{ ch: string; rpc: WorkerRpcRequest }>;
  closes: string[];
  failLastSend: (error: Error) => void;
} {
  let lastOnError: ((error: Error) => void) | null = null;
  const sent: Array<{ ch: string; rpc: WorkerRpcRequest }> = [];
  const closes: string[] = [];
  return {
    sent,
    closes,
    send: (ch, rpc, onError) => {
      sent.push({ ch, rpc });
      lastOnError = onError;
    },
    close: (ch) => {
      closes.push(ch);
    },
    failLastSend: (error) => lastOnError?.(error),
  };
}

let processKill: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
  processKill = installKillTripwire();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  expect(processKill).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DshChannelTransport', () => {
  it('[CT-02] kill() asks the host to close once and exits only when the host confirms', () => {
    const link = fakeLink();
    const channel = new DshChannelTransport('c1-1', FAKE_PID, link);
    const exits = vi.fn();
    channel.onExit(exits);
    expect(channel.kill()).toBe(true);
    expect(channel.kill()).toBe(true);
    expect(link.closes).toEqual(['c1-1']);
    expect(exits).not.toHaveBeenCalled();
    channel.dispatchExit({ code: 0, signal: null, cause: 'channel-closed' });
    expect(exits).toHaveBeenCalledTimes(1);
    expect(exits).toHaveBeenCalledWith({ code: 0, signal: null, cause: 'channel-closed' });
    channel.dispatchExit({ code: null, signal: 'SIGKILL', cause: 'host-exit' });
    expect(exits).toHaveBeenCalledTimes(1);
    expect(channel.kill()).toBe(true);
    expect(link.closes).toEqual(['c1-1']);
  });

  it('[CT-03] drops every listener at exit, ignores late traffic and replays the exit to late subscribers', async () => {
    const channel = new DshChannelTransport('c1-1', FAKE_PID, fakeLink());
    const messages = vi.fn();
    const errors = vi.fn();
    channel.onMessage(messages);
    channel.onError(errors);
    channel.dispatchMessage({ early: true });
    channel.dispatchExit({ code: null, signal: 'SIGKILL', cause: 'host-exit' });
    channel.dispatchMessage({ late: true });
    channel.dispatchError(new Error('late'));
    expect(messages).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    const late = vi.fn();
    const unsubscribed = vi.fn();
    channel.onExit(late);
    channel.onExit(unsubscribed)();
    expect(late).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(late).toHaveBeenCalledWith({ code: null, signal: 'SIGKILL', cause: 'host-exit' });
    expect(unsubscribed).not.toHaveBeenCalled();
  });

  it('refuses to send once closing or closed', () => {
    const link = fakeLink();
    const channel = new DshChannelTransport('c1-1', FAKE_PID, link);
    channel.postMessage(request());
    expect(link.sent).toEqual([{ ch: 'c1-1', rpc: request() }]);
    channel.kill();
    expect(() => channel.postMessage(request('rpc-2'))).toThrow(DSH_CHANNEL_CLOSED);
    channel.dispatchExit({ code: 0, signal: null, cause: 'channel-closed' });
    expect(() => channel.postMessage(request('rpc-3'))).toThrow(/is closed/);
    expect(link.sent).toHaveLength(1);
  });

  it('reports an asynchronous send failure as a transport error, and never emits stderr', () => {
    const link = fakeLink();
    const channel = new DshChannelTransport('c1-1', FAKE_PID, link);
    const errors = vi.fn();
    const stderr = vi.fn();
    channel.onError(errors);
    channel.onStderr(stderr);
    channel.postMessage(request());
    link.failLastSend(new Error('channel closed'));
    expect(errors).toHaveBeenCalledWith(new Error('channel closed'));
    expect(stderr).not.toHaveBeenCalled();
    expect(channel.pid).toBe(FAKE_PID);
  });

  it('keeps notifying the other listeners when one throws', () => {
    const channel = new DshChannelTransport('c1-1', FAKE_PID, fakeLink());
    const after = vi.fn();
    channel.onExit(() => {
      throw new Error('listener bug');
    });
    channel.onExit(after);
    channel.dispatchExit({ code: 1, signal: null, cause: 'host-exit' });
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('DshChannelTransport on the supervisor', () => {
  it('[CT-01] each channel sends and receives only its own envelopes', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const a = await h.supervisor.openChannel();
    const b = await h.supervisor.openChannel();
    expect([a.ch, b.ch]).toEqual(['c1-1', 'c1-2']);
    const toA = vi.fn();
    const toB = vi.fn();
    a.onMessage(toA);
    b.onMessage(toB);
    b.postMessage(request('rpc-b'));
    expect(child.sent.at(-1)).toEqual({ ch: 'c1-2', rpc: request('rpc-b') });
    child.post({ ch: 'c1-1', rpc: { for: 'a' } });
    child.post({ ch: 'c1-2', rpc: { for: 'b' } });
    child.post({ ch: 'c9-9', rpc: { for: 'nobody' } });
    expect(toA.mock.calls).toEqual([[{ for: 'a' }]]);
    expect(toB.mock.calls).toEqual([[{ for: 'b' }]]);
  });

  it('[CT-02] kill() sends {host:close} for its own channel only', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const a = await h.supervisor.openChannel();
    await h.supervisor.openChannel();
    a.kill();
    a.kill();
    expect(child.controls()).toEqual([{ host: 'close', ch: 'c1-1' }]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('a WorkerSlot round-trips RPC and disposes through close/closed, leaving the host up', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const channel = await h.supervisor.openChannel();
    const slot = new WorkerSlot({ slotKey: 's1', cwd: '/repo', transport: channel });

    const reply = slot.request<{ ok: string }>('worker.status', {});
    const sent = child.sent.at(-1) as { ch: string; rpc: WorkerRpcRequest };
    expect(sent.ch).toBe(channel.ch);
    child.post({
      ch: channel.ch,
      rpc: {
        protocolVersion: 1,
        kind: 'response',
        generation: 1,
        requestId: sent.rpc.requestId,
        ok: true,
        result: { ok: 'yes' },
      },
    });
    await expect(reply).resolves.toEqual({ ok: 'yes' });

    const disposing = slot.dispose('slot-dispose');
    const disposeRequest = child.sent.at(-1) as { ch: string; rpc: WorkerRpcRequest };
    expect(disposeRequest.rpc.type).toBe('worker.dispose');
    child.post({
      ch: channel.ch,
      rpc: {
        protocolVersion: 1,
        kind: 'response',
        generation: 1,
        requestId: disposeRequest.rpc.requestId,
        ok: true,
        result: { disposed: true },
      },
    });
    await flushMicrotasks();
    expect(child.controls()).toEqual([{ host: 'close', ch: channel.ch }]);
    child.post({ host: 'closed', ch: channel.ch });
    await expect(disposing).resolves.toBeUndefined();
    expect(slot.state).toBe('disposed');
    expect(child.kill).not.toHaveBeenCalled();
    expect(h.supervisor.status()).toMatchObject({ state: 'ready', channels: 0 });
  });

  it('a host crash crashes every slot through the existing path, with cause host-exit', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const lifecycle: WorkerSlotLifecycleEvent[] = [];
    const slots = await Promise.all(
      ['s1', 's2'].map(async (slotKey) => {
        const transport = await h.supervisor.openChannel();
        return new WorkerSlot({
          slotKey,
          cwd: '/repo',
          transport,
          onLifecycle: (event) => lifecycle.push(event),
        });
      })
    );
    const inFlight = slots[0].request('worker.send', {});
    const failed = settlement(inFlight);
    child.die(null, 'SIGKILL');
    await flushMicrotasks();
    expect(failed.settled()).toBe(true);
    await expect(inFlight).rejects.toMatchObject({ code: 'WORKER_EXITED' });
    expect(slots.map((slot) => slot.state)).toEqual(['crashed', 'crashed']);
    expect(lifecycle).toEqual([
      expect.objectContaining({
        type: 'crashed',
        slotKey: 's1',
        exit: { code: null, signal: 'SIGKILL', cause: 'host-exit' },
      }),
      expect.objectContaining({
        type: 'crashed',
        slotKey: 's2',
        exit: { code: null, signal: 'SIGKILL', cause: 'host-exit' },
      }),
    ]);
    // Replacing a crashed slot resolves at once: its channel's exit is already known.
    await expect(slots[0].dispose('slot-replace')).resolves.toBeUndefined();
    expect(child.controls()).toEqual([]);
  });

  it('a close the host never confirms leaves the slot dispose-failed for P1-3c to escalate', async () => {
    const h = createFakeHostHarness();
    await startReadyHost(h);
    const channel = await h.supervisor.openChannel();
    const slot = new WorkerSlot({
      slotKey: 's1',
      cwd: '/repo',
      transport: channel,
      disposeTimeoutMs: 100,
      exitTimeoutMs: 100,
    });
    const disposing = slot.dispose('slot-dispose');
    const outcome = settlement(disposing);
    await vi.advanceTimersByTimeAsync(200);
    expect(outcome.settled()).toBe(true);
    await expect(disposing).rejects.toMatchObject({ code: 'WORKER_EXIT_TIMEOUT' });
    expect(slot.state).toBe('dispose-failed');
    expect(h.supervisor.status()).toMatchObject({ state: 'ready', channels: 1 });
  });
});
