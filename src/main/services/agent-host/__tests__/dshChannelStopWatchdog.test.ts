import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createPiWorkerSlot } from '../createPiWorkerSlot';
import { STOP_WATCHDOG_MS, WorkerManager } from '../WorkerManager';
import {
  createFakeHostHarness,
  type FakeChild,
  type FakeHostHarness,
  flushMicrotasks,
  installKillTripwire,
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

/**
 * dsh-rebase P1-3a — what the Stop watchdog does to a session on the shared
 * host. Real WorkerManager, createPiWorkerSlot, WorkerSlot, DshChannelTransport
 * and DshHostSupervisor; the host process is a scripted fake, so nothing is
 * spawned or signalled.
 *
 * The watchdog's forced stop restarts the entry through the crash path, and
 * the old slot's dispose becomes, on a channel, `worker.dispose` then
 * `{host:'close'}`: it can end that channel, never the host. The full ladder
 * (escalating a channel that never closes to a host restart) is P1-3c.
 */

interface Script {
  /** The host answers a channel's worker.dispose (ACK, then closed). */
  disposes: boolean;
  /** The host answers `{host:'close'}` with closed. */
  closes: boolean;
}

const stubFor = (sessionId: string) => `/dsh-home/aiclient-sessions/aiclient-${sessionId}.dsh.json`;

/** A host that answers like the bridge, per `script`, to whatever Main sends it. */
function scriptHost(child: FakeChild, script: Script): void {
  const respond = (ch: string, rpc: Record<string, unknown>, result: unknown) =>
    child.post({
      ch,
      rpc: {
        protocolVersion: 1,
        kind: 'response',
        generation: rpc.generation,
        requestId: rpc.requestId,
        ok: true,
        result,
      },
    });
  const answer = (message: Record<string, unknown>) => {
    if (message.host === 'ping') {
      child.post({ host: 'pong', id: message.id, eldMaxMs: 0, rssMb: 180, channels: [] });
      return;
    }
    if (message.host === 'close') {
      if (script.closes) child.post({ host: 'closed', ch: message.ch });
      return;
    }
    const ch = message.ch as string | undefined;
    const rpc = message.rpc as Record<string, unknown> | undefined;
    if (!ch || !rpc) return;
    const payload = rpc.payload as Record<string, string>;
    switch (rpc.type) {
      case 'worker.bootstrap': {
        const sessionFile = payload.sessionFile ?? stubFor(payload.logicalSessionId);
        respond(ch, rpc, {
          bootstrapped: true,
          logicalSessionId: payload.logicalSessionId,
          piSessionId: `aiclient-${payload.logicalSessionId}`,
          cwd: payload.cwd,
          agentDir: '/dsh-home',
          sessionFile,
          leaf: { activeEntryId: null, fileTailEntryId: null },
          projectTrusted: true,
          permissionGate: 'bundled',
          ...(payload.sessionFile
            ? {
                initialHistory: {
                  logicalSessionId: payload.logicalSessionId,
                  sessionFile,
                  workspacePath: payload.cwd,
                  page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
                },
              }
            : {}),
        });
        return;
      }
      case 'worker.send':
        respond(ch, rpc, { accepted: true, requestId: payload.requestId });
        child.post({
          ch,
          rpc: {
            protocolVersion: 1,
            kind: 'event',
            generation: rpc.generation,
            type: 'runtime.event',
            payload: {
              type: 'session.status',
              sessionId: payload.logicalSessionId,
              requestId: payload.requestId,
              payload: { status: 'running' },
              seq: 1,
              timestamp: 0,
            },
          },
        });
        return;
      case 'worker.stop':
        // Took the Stop; the turn never ends.
        respond(ch, rpc, { stopped: true });
        return;
      case 'worker.dispose':
        if (!script.disposes) return;
        respond(ch, rpc, { disposed: true });
        child.post({ host: 'closed', ch });
        return;
      default:
        respond(ch, rpc, {});
    }
  };
  child.send.mockImplementation((message: unknown, callback?: (error: Error | null) => void) => {
    child.sent.push(message);
    callback?.(null);
    queueMicrotask(() => answer(message as Record<string, unknown>));
    return true;
  });
}

let processKill: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
  processKill = installKillTripwire();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  expect(processKill).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function twoSessionsOnOneHost(script: Script) {
  const h: FakeHostHarness = createFakeHostHarness();
  const events: RuntimeEvent[] = [];
  const manager = new WorkerManager({
    createSlot: (options) =>
      createPiWorkerSlot({
        ...options,
        createTransport: () =>
          h.supervisor.openChannel({ userInitiated: options.userInitiated === true }),
      }),
    sessionFileExists: async () => true,
    onEvent: (event) => events.push(event),
    capacity: 4,
    idleTimeoutMs: 0,
    idleSweepIntervalMs: 0,
  });
  const first = manager.createSession({
    sessionId: 's1',
    workspacePath: '/repo',
    ownerWebContentsId: 7,
  });
  for (let i = 0; i < 50 && h.spawn.mock.calls.length === 0; i += 1) await flushMicrotasks();
  const child = h.child();
  scriptHost(child, script);
  child.ready();
  await first;
  await manager.createSession({ sessionId: 's2', workspacePath: '/repo', ownerWebContentsId: 8 });
  await manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go', ownerWebContentsId: 7 });
  await flushMicrotasks();
  return { h, child, manager, events };
}

const forS1 = (events: RuntimeEvent[]) =>
  events
    .filter((event) => event.sessionId === 's1')
    .map((event) =>
      event.type === 'session.status'
        ? `status:${(event.payload as { status: string }).status}`
        : event.type === 'session.stopped'
          ? `stopped:${(event.payload as { stopCause?: string }).stopCause}`
          : event.type
    );

const controls = (child: FakeChild) =>
  child.sent.filter(
    (message) => typeof message === 'object' && message !== null && !('rpc' in message)
  ) as Array<Record<string, unknown>>;

describe('Stop watchdog on the shared host (P1-3a)', () => {
  it('a channel the host closes restarts that session on the same host, the other untouched', async () => {
    const { h, child, manager, events } = await twoSessionsOnOneHost({
      disposes: true,
      closes: true,
    });
    await manager.stop('s1');
    const stopAt = events.length;
    await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
    await vi.advanceTimersByTimeAsync(100);

    expect(forS1(events.slice(stopAt))).toEqual([
      'stopped:forced',
      'status:idle',
      'session.resumed',
      'session.history',
      'status:idle',
    ]);
    expect(manager.getSlotSnapshots()).toEqual([
      expect.objectContaining({ logicalSessionId: 's1', state: 'ready', generation: 2 }),
      expect.objectContaining({ logicalSessionId: 's2', state: 'ready', generation: 1 }),
    ]);
    // One host all along: never signalled, never asked to stop, never respawned.
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(controls(child).filter((message) => message.type === 'shutdown')).toEqual([]);
    // s1 reopened on a fresh channel; s2's channel was never closed.
    expect(h.supervisor.status()).toMatchObject({ state: 'ready', channels: 2 });
    expect(controls(child).filter((message) => message.host === 'close')).toEqual([]);
  });

  it('a channel that never closes ends that session in error in bounded time; the host lives on', async () => {
    const { h, child, manager, events } = await twoSessionsOnOneHost({
      disposes: false,
      closes: false,
    });
    await manager.stop('s1');
    const stopAt = events.length;
    await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
    // T144: the Stop is settled for the user at the watchdog, whatever follows.
    expect(forS1(events.slice(stopAt))).toEqual(['stopped:forced', 'status:idle']);

    // worker.dispose (3 s) goes unanswered, then the channel close (3 s).
    await vi.advanceTimersByTimeAsync(3_000 + 3_000 + 100);
    expect(controls(child).filter((message) => message.host === 'close')).toEqual([
      { host: 'close', ch: 'c1-1' },
    ]);
    const s1 = manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === 's1');
    expect(s1).toMatchObject({ state: 'error' });
    expect(s1?.error).toMatch(/restart budget exhausted/);
    expect(manager.getStatus().state).toBe('degraded');

    // The other session never noticed, and keeps working on the same host.
    const s2 = manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === 's2');
    expect(s2).toMatchObject({ state: 'ready', generation: 1 });
    await manager.send({
      sessionId: 's2',
      attemptId: 'b1',
      text: 'still here',
      ownerWebContentsId: 8,
    });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(controls(child).filter((message) => message.type === 'shutdown')).toEqual([]);
    expect(h.supervisor.status()).toMatchObject({ state: 'ready' });
  });
});
