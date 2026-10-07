import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createDshChatSlot } from '../createDshChatSlot';
import { DSH_HOST_RESTART_BUDGET, DSH_HOST_TIMINGS } from '../DshHostSupervisor';
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
 * dsh-rebase P1-3a / P1-3c — sessions on the shared host, with everything real
 * but the host process: WorkerManager (given the supervisor as its host),
 * createDshChatSlot, WorkerSlot, DshChannelTransport and DshHostSupervisor.
 * Each spawned host is a scripted fake, so nothing is spawned or signalled.
 *
 *  - Stop ladder A (decision 021): the watchdog's forced stop reopens the
 *    session through the crash path, and the old slot's dispose becomes, on a
 *    channel, `worker.dispose` then `{host:'close'}`. A host that closes the
 *    channel keeps serving everyone else.
 *  - Stop ladder B: a channel that never closes escalates to one host restart.
 *  - Host faults (decision 020): one new host per exit, one recovery batch, the
 *    host budget, and the user action that starts a failed host again.
 */

interface Script {
  /** Sessions whose channel answers neither worker.dispose nor close: an agent stuck in the host. */
  stuck?: ReadonlySet<string>;
  /** `{type:'shutdown'}` ends the host (stopped, then exit 0); otherwise only SIGKILL does. */
  exitsOnShutdown?: boolean;
  /** Sessions whose `worker.dispose` is never answered, though their close would be. */
  disposeHangs?: ReadonlySet<string>;
}

const stubFor = (sessionId: string) => `/dsh-home/aiclient-sessions/aiclient-${sessionId}.dsh.json`;

/** A host that answers like the bridge, per `script`; returns the sessions it bootstrapped, in order. */
function scriptHost(child: FakeChild, script: Script): string[] {
  const sessionOf = new Map<string, string>();
  const bootstraps: string[] = [];
  const stuck = (ch: string) => script.stuck?.has(sessionOf.get(ch) ?? '') === true;
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
    if (message.type === 'shutdown') {
      if (script.exitsOnShutdown) {
        child.post({ type: 'stopped', ms: 5, reason: 'ipc' });
        child.die(0);
      }
      return;
    }
    if (message.host === 'close') {
      if (!stuck(String(message.ch))) child.post({ host: 'closed', ch: message.ch });
      return;
    }
    const ch = message.ch as string | undefined;
    const rpc = message.rpc as Record<string, unknown> | undefined;
    if (!ch || !rpc) return;
    const payload = rpc.payload as Record<string, string>;
    switch (rpc.type) {
      case 'worker.bootstrap': {
        sessionOf.set(ch, payload.logicalSessionId);
        bootstraps.push(payload.logicalSessionId);
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
        if (stuck(ch) || script.disposeHangs?.has(sessionOf.get(ch) ?? '')) return;
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
  // SIGKILL ends the fake the way it ends a process: an exit follows.
  child.kill.mockImplementation(() => {
    queueMicrotask(() => {
      if (child.exitCode === null && child.signalCode === null) child.die(null, 'SIGKILL');
    });
    return true;
  });
  return bootstraps;
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

/** Sessions `[id, owner]` created in order on one supervisor; each host it spawns is scripted. */
async function sessionsOnOneHost(
  sessions: Array<[string, number | undefined]>,
  scriptFor: (hostIndex: number) => Script = () => ({})
) {
  const bootstrapsByHost: string[][] = [];
  const h: FakeHostHarness = createFakeHostHarness({
    onSpawn: (child, index) => {
      bootstrapsByHost[index] = scriptHost(child, scriptFor(index));
      queueMicrotask(() => child.ready());
    },
  });
  const events: RuntimeEvent[] = [];
  const manager = new WorkerManager({
    host: h.supervisor,
    createSlot: (options) =>
      createDshChatSlot({
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
  for (const [sessionId, owner] of sessions) {
    await manager.createSession({ sessionId, workspacePath: '/repo', ownerWebContentsId: owner });
  }
  return { h, manager, events, bootstrapsByHost };
}

/** What one session was told: statuses (with their reason), stops (with their cause), the rest by type. */
const forSession = (events: RuntimeEvent[], sessionId: string) =>
  events
    .filter((event) => event.sessionId === sessionId)
    .map((event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.type === 'session.status') {
        return `status:${String(payload.status)}${payload.disconnectReason ? `/${String(payload.disconnectReason)}` : ''}`;
      }
      if (event.type === 'session.stopped') return `stopped:${String(payload.stopCause)}`;
      return event.type;
    });

const controls = (child: FakeChild) =>
  child.sent.filter(
    (message) => typeof message === 'object' && message !== null && !('rpc' in message)
  ) as Array<Record<string, unknown>>;

async function everyoneReady(manager: WorkerManager): Promise<void> {
  await vi.waitFor(() =>
    expect(manager.getSlotSnapshots().every((slot) => slot.state === 'ready')).toBe(true)
  );
}

describe('Stop on the shared host (P1-3a, P1-3c; decision 021)', () => {
  it('[WMH-05] ladder A: a channel the host closes reopens that session on the same host, the other untouched', async () => {
    const { h, manager, events } = await sessionsOnOneHost([
      ['s1', 7],
      ['s2', 8],
    ]);
    const child = h.child();
    await manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go', ownerWebContentsId: 7 });
    await flushMicrotasks();
    await manager.stop('s1');
    const stopAt = events.length;
    await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
    await vi.advanceTimersByTimeAsync(100);

    expect(forSession(events.slice(stopAt), 's1')).toEqual([
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
    expect(h.supervisor.status()).toMatchObject({ state: 'ready', channels: 2, recentFaults: 0 });
    expect(controls(child).filter((message) => message.host === 'close')).toEqual([]);
  });

  it('[WMH-06] ladder B: a channel that never closes restarts the host once, and every session comes back', async () => {
    const { h, manager, events, bootstrapsByHost } = await sessionsOnOneHost(
      [
        ['s1', 7],
        ['s3', undefined],
        ['s2', undefined],
      ],
      // The first host keeps an agent it cannot stop, and cannot stop itself either.
      (hostIndex) => (hostIndex === 0 ? { stuck: new Set(['s1']) } : {})
    );
    const child = h.child();
    await manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go', ownerWebContentsId: 7 });
    const s2Turn = await manager.send({ sessionId: 's2', attemptId: 'b1', text: 'go' });
    await flushMicrotasks();
    await manager.stop('s1');
    const stopAt = events.length;

    await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS);
    // T144: settled for the user at the watchdog, whatever follows.
    expect(forSession(events.slice(stopAt), 's1')).toEqual(['stopped:forced', 'status:idle']);

    // worker.dispose (3 s) and then the channel close (3 s) go unanswered: the
    // host is asked to stop, gracefully first.
    await vi.advanceTimersByTimeAsync(3_000 + 3_000 + 100);
    expect(controls(child).filter((message) => message.host === 'close')).toEqual([
      { host: 'close', ch: 'c1-1' },
    ]);
    expect(controls(child).filter((message) => message.type === 'shutdown')).toHaveLength(1);
    expect(child.kill).not.toHaveBeenCalled();

    // Wedged, it is SIGKILLed 3.5 s later; one new host then serves everyone.
    await vi.advanceTimersByTimeAsync(DSH_HOST_TIMINGS.gracefulStopMs);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await everyoneReady(manager);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    // The stuck session first, then the one that was mid-turn, then the rest.
    expect(bootstrapsByHost[1]).toEqual(['s1', 's2', 's3']);
    expect(
      manager.getSlotSnapshots().map((slot) => [slot.logicalSessionId, slot.generation])
    ).toEqual([
      ['s1', 2],
      ['s3', 2],
      ['s2', 2],
    ]);
    expect(h.supervisor.status()).toMatchObject({
      state: 'ready',
      generation: 2,
      channels: 3,
      recentFaults: 1,
      lastExit: { reason: 'stuck-session', signal: 'SIGKILL', generation: 1 },
    });

    // The others were restarted on purpose, and are told so.
    expect(forSession(events.slice(stopAt), 's2')).toEqual([
      'status:disconnected/engine_restarted',
      'session.failed',
      'session.resumed',
      'session.history',
      'status:idle',
    ]);
    expect(
      events.find((event) => event.type === 'session.failed' && event.sessionId === 's2')
    ).toMatchObject({ requestId: s2Turn, payload: { errorCode: 'dsh_engine_restarted' } });
    expect(forSession(events.slice(stopAt), 's3')).toEqual([
      'status:disconnected/engine_restarted',
      'session.resumed',
      'session.history',
      'status:idle',
    ]);
    expect(forSession(events.slice(stopAt), 's1').slice(-3)).toEqual([
      'session.resumed',
      'session.history',
      'status:idle',
    ]);
  });

  it('[WMH-06c] ladder B: the other busy sessions get worker.dispose before the shutdown, all at once, 3 s at most (decision 155)', async () => {
    const { h, manager, events } = await sessionsOnOneHost(
      [
        ['s1', 7],
        ['s2', undefined],
        ['s3', undefined],
        ['s4', undefined],
      ],
      // s2's channel closes when told; s3's never answers.
      (hostIndex) =>
        hostIndex === 0 ? { stuck: new Set(['s1']), disposeHangs: new Set(['s3']) } : {}
    );
    const child = h.child();
    await manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go', ownerWebContentsId: 7 });
    await manager.send({ sessionId: 's2', attemptId: 'b1', text: 'go' });
    await manager.send({ sessionId: 's3', attemptId: 'c1', text: 'go' });
    await flushMicrotasks();
    await manager.stop('s1');
    const stopAt = events.length;
    const sentIndex = (match: (message: Record<string, unknown>) => boolean) =>
      child.sent.findIndex((message) => match(message as Record<string, unknown>));
    const disposeOf = (ch: string) => (message: Record<string, unknown>) =>
      message.ch === ch &&
      (message.rpc as { type?: string } | undefined)?.type === 'worker.dispose';
    const isShutdown = (message: Record<string, unknown>) => message.type === 'shutdown';

    // Ladder A runs out (3 s ACK, 3 s close); the two busy channels are asked together.
    await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS + 3_000 + 3_000 + 100);
    expect(sentIndex(disposeOf('c1-2'))).toBeGreaterThan(-1);
    expect(sentIndex(disposeOf('c1-3'))).toBeGreaterThan(-1);
    expect(sentIndex(disposeOf('c1-4'))).toBe(-1);
    expect(sentIndex(isShutdown)).toBe(-1);
    // s2 answered and its channel closed; s3 holds the shutdown back, 3 s at most.
    expect(forSession(events.slice(stopAt), 's2').slice(0, 2)).toEqual([
      'status:disconnected/engine_restarted',
      'session.failed',
    ]);
    await vi.advanceTimersByTimeAsync(2_800);
    expect(sentIndex(isShutdown)).toBe(-1);
    await vi.advanceTimersByTimeAsync(200);
    expect(sentIndex(isShutdown)).toBeGreaterThan(sentIndex(disposeOf('c1-3')));

    await vi.advanceTimersByTimeAsync(DSH_HOST_TIMINGS.gracefulStopMs);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await everyoneReady(manager);
    for (const id of ['s2', 's3']) {
      expect(forSession(events.slice(stopAt), id), id).toEqual([
        'status:disconnected/engine_restarted',
        'session.failed',
        'session.resumed',
        'session.history',
        'status:idle',
      ]);
    }
    expect(forSession(events.slice(stopAt), 's4')).toEqual([
      'status:disconnected/engine_restarted',
      'session.resumed',
      'session.history',
      'status:idle',
    ]);
    expect(
      manager
        .getSlotSnapshots()
        .map((slot) => [slot.logicalSessionId, slot.generation, slot.restartAttempts])
    ).toEqual([
      ['s1', 2, 1],
      ['s2', 2, 0],
      ['s3', 2, 0],
      ['s4', 2, 0],
    ]);
    expect(h.supervisor.status()).toMatchObject({
      state: 'ready',
      generation: 2,
      recentFaults: 1,
      lastExit: { reason: 'stuck-session', signal: 'SIGKILL', generation: 1 },
    });
  });

  it('ladder B needs no signal for a host that stops when asked', async () => {
    const { h, manager } = await sessionsOnOneHost([['s1', 7]], (hostIndex) =>
      hostIndex === 0 ? { stuck: new Set(['s1']), exitsOnShutdown: true } : {}
    );
    const child = h.child();
    await manager.send({ sessionId: 's1', attemptId: 'a1', text: 'go', ownerWebContentsId: 7 });
    await flushMicrotasks();
    await manager.stop('s1');
    await vi.advanceTimersByTimeAsync(STOP_WATCHDOG_MS + 3_000 + 3_000 + 100);
    await everyoneReady(manager);
    expect(child.kill).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.supervisor.status()).toMatchObject({
      state: 'ready',
      lastExit: { reason: 'stuck-session', code: 0 },
    });
    expect(manager.getSlotSnapshots()).toEqual([
      expect.objectContaining({ logicalSessionId: 's1', state: 'ready', generation: 2 }),
    ]);
  });
});

describe('Host faults on the shared host (P1-3c; decision 020)', () => {
  it('[WMH-01] a crash brings up one host and reopens every session in priority order, at no session cost', async () => {
    const { h, manager, events, bootstrapsByHost } = await sessionsOnOneHost([
      ['idle', undefined],
      ['busy', undefined],
      ['fg', 7],
    ]);
    const turn = await manager.send({ sessionId: 'busy', attemptId: 'a1', text: 'go' });
    await flushMicrotasks();
    const crashAt = events.length;

    h.child().die(null, 'SIGKILL');
    await everyoneReady(manager);

    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(bootstrapsByHost[1]).toEqual(['fg', 'busy', 'idle']);
    expect(
      manager
        .getSlotSnapshots()
        .map((slot) => [slot.logicalSessionId, slot.generation, slot.restartAttempts])
    ).toEqual([
      ['idle', 2, 0],
      ['busy', 2, 0],
      ['fg', 2, 0],
    ]);
    expect(forSession(events.slice(crashAt), 'busy')).toEqual([
      'status:disconnected',
      'session.failed',
      'session.resumed',
      'session.history',
      'status:idle',
    ]);
    expect(events.find((event) => event.type === 'session.failed')).toMatchObject({
      requestId: turn,
      payload: { errorCode: 'dsh_host_crashed' },
    });
    expect(forSession(events.slice(crashAt), 'idle')).toEqual([
      'status:disconnected',
      'session.resumed',
      'session.history',
      'status:idle',
    ]);
    expect(h.supervisor.status()).toMatchObject({
      state: 'ready',
      generation: 2,
      channels: 3,
      recentFaults: 1,
      lastExit: { reason: 'crashed', signal: 'SIGKILL' },
    });
    expect(manager.getStatus().state).toBe('ready');
  });

  it('[WMH-02] three faults are recovered; the fourth in 5 min waits for a user open', async () => {
    const { h, manager } = await sessionsOnOneHost([
      ['s1', 7],
      ['s2', undefined],
    ]);
    for (let fault = 1; fault <= DSH_HOST_RESTART_BUDGET.restarts; fault += 1) {
      h.child().die(null, 'SIGKILL');
      await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(fault + 1));
      await everyoneReady(manager);
    }
    // Three host crashes inside a minute cost no session anything.
    expect(
      manager.getSlotSnapshots().map((slot) => [slot.state, slot.generation, slot.restartAttempts])
    ).toEqual([
      ['ready', 4, 0],
      ['ready', 4, 0],
    ]);

    h.child().die(null, 'SIGKILL');
    await vi.waitFor(() =>
      expect(manager.getSlotSnapshots().map((slot) => slot.state)).toEqual(['error', 'error'])
    );
    expect(h.spawn).toHaveBeenCalledTimes(DSH_HOST_RESTART_BUDGET.restarts + 1);
    expect(h.supervisor.status()).toMatchObject({
      state: 'failed',
      recentFaults: 4,
      failure: { code: 'DSH_HOST_UNAVAILABLE' },
    });
    for (const slot of manager.getSlotSnapshots()) {
      expect(slot.error).toMatch(/^dsh_host_unavailable: DSH_HOST_UNAVAILABLE: /);
    }
    expect(manager.getStatus().state).toBe('degraded');

    // A user's open may start the host once more, whatever the budget says.
    await manager.resumeSession({
      sessionId: 's1',
      sessionFile: stubFor('s1'),
      workspacePath: '/repo',
      ownerWebContentsId: 7,
    });
    expect(h.spawn).toHaveBeenCalledTimes(DSH_HOST_RESTART_BUDGET.restarts + 2);
    expect(manager.getSlotSnapshots().find((slot) => slot.logicalSessionId === 's1')).toMatchObject(
      { state: 'ready', generation: 1 }
    );
    expect(h.supervisor.status()).toMatchObject({ state: 'ready' });
  });
});
