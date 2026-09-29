import { buildDshModelPlan } from '@shared/dshModelPlan';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { DSH_HOST_RESTART_BUDGET, DSH_HOST_TIMINGS } from '../DshHostSupervisor';
import {
  createFakeHostHarness,
  FAKE_PID,
  type FakeChild,
  flushMicrotasks,
  installKillTripwire,
  LAUNCH,
  SELF_PID,
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

const T = DSH_HOST_TIMINGS;

const pong = (id: number, extra: Partial<{ eldMaxMs: number; rssMb: number }> = {}) => ({
  host: 'pong',
  id,
  eldMaxMs: extra.eldMaxMs ?? 4,
  rssMb: extra.rssMb ?? 180,
  channels: [],
});

const runtimeEvent = {
  protocolVersion: 1,
  kind: 'event',
  generation: 1,
  type: 'runtime.event',
  payload: {},
};

let processKill: MockInstance;
let consoleError: MockInstance;
let consoleWarn: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
  processKill = installKillTripwire();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  expect(processKill).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function errorLines(): string[] {
  return consoleError.mock.calls.map((call) => String(call[0]));
}

describe('DshHostSupervisor start and handshake', () => {
  it('[SH-13] prepares the private directories, then spawns with ipc stdio and no detach', async () => {
    const h = createFakeHostHarness();
    const pending = h.supervisor.ensureHost();
    expect(h.prepareDirectories).toHaveBeenCalledWith(LAUNCH);
    expect(h.prepareDirectories.mock.invocationCallOrder[0]).toBeLessThan(
      h.spawn.mock.invocationCallOrder[0]
    );
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = h.spawn.mock.calls[0];
    expect(command).toBe(LAUNCH.command);
    expect(args).toEqual(LAUNCH.args);
    expect(options).toStrictEqual({
      cwd: LAUNCH.cwd,
      env: LAUNCH.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    expect(h.supervisor.status()).toMatchObject({ state: 'starting', pid: FAKE_PID });
    h.child().ready();
    await expect(pending).resolves.toEqual({ generation: 1, pid: FAKE_PID });
    expect(h.supervisor.status()).toMatchObject({ state: 'ready', generation: 1, channels: 0 });
  });

  it('[SH-01] concurrent ensureHost and openChannel calls share one spawn', async () => {
    const h = createFakeHostHarness();
    const first = h.supervisor.ensureHost();
    const second = h.supervisor.ensureHost();
    const channel = h.supervisor.openChannel();
    await flushMicrotasks();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.child().ready();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { generation: 1, pid: FAKE_PID },
      { generation: 1, pid: FAKE_PID },
    ]);
    expect((await channel).ch).toBe('c1-1');
    await h.supervisor.ensureHost();
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('[SH-02] a ready from the wrong pid SIGKILLs the child; the start fails only once it is gone', async () => {
    const h = createFakeHostHarness();
    const pending = h.supervisor.ensureHost();
    const outcome = settlement(pending);
    const child = h.child();
    child.ready(FAKE_PID + 99);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await flushMicrotasks();
    expect(outcome.settled()).toBe(false);
    expect(h.supervisor.status().state).toBe('starting');
    child.die(null, 'SIGKILL');
    await expect(pending).rejects.toMatchObject({ code: 'DSH_HOST_PID_MISMATCH' });
    expect(h.supervisor.status()).toMatchObject({
      state: 'idle',
      lastExit: { reason: 'start-failed', signal: 'SIGKILL' },
    });
    // Retrying spawns a fresh host, now that the old one is confirmed gone.
    const retry = h.supervisor.ensureHost();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.child().ready();
    await expect(retry).resolves.toEqual({ generation: 2, pid: FAKE_PID + 1 });
  });

  it('[SH-02] a ready with no usable pid is a mismatch too', async () => {
    const h = createFakeHostHarness();
    const pending = h.supervisor.ensureHost();
    h.child().post({ type: 'ready', pid: 0 });
    expect(h.child().kill).toHaveBeenCalledWith('SIGKILL');
    h.child().die(null, 'SIGKILL');
    await expect(pending).rejects.toMatchObject({ code: 'DSH_HOST_PID_MISMATCH' });
  });

  it('[SH-02] fatal before ready SIGKILLs, fails the start and replays its stderr once', async () => {
    const h = createFakeHostHarness();
    const pending = h.supervisor.ensureHost();
    const child = h.child();
    child.writeStderr('[dsh-host] bundles skipped: ["@aiclient/dsh-app"]\n');
    child.post({ type: 'fatal', message: 'bundles skipped' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.die(1);
    await expect(pending).rejects.toMatchObject({
      code: 'DSH_HOST_START_FAILED',
      message: expect.stringContaining('bundles skipped'),
    });
    const replays = errorLines().filter((line) => line.includes('stderr line'));
    expect(replays).toHaveLength(1);
    expect(replays[0]).toContain('bundles skipped: ["@aiclient/dsh-app"]');
    expect(h.supervisor.status().state).toBe('idle');
  });

  it('[SH-03] no ready within 60 s kills the child and fails the start', async () => {
    const h = createFakeHostHarness();
    const pending = h.supervisor.ensureHost();
    const outcome = settlement(pending);
    const child = h.child();
    await vi.advanceTimersByTimeAsync(T.readyTimeoutMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(outcome.settled()).toBe(false);
    child.die(null, 'SIGKILL');
    await expect(pending).rejects.toMatchObject({ code: 'DSH_HOST_START_TIMEOUT' });
    expect(h.supervisor.status().state).toBe('idle');
  });

  it('an early exit fails the start without a signal', async () => {
    const h = createFakeHostHarness();
    const pending = h.supervisor.ensureHost();
    h.child().die(1);
    await expect(pending).rejects.toMatchObject({
      code: 'DSH_HOST_START_FAILED',
      message: expect.stringContaining('exited before ready (code=1'),
    });
    expect(h.child().kill).not.toHaveBeenCalled();
  });

  it('a spawn that yields no process fails the start without signalling anything', async () => {
    const h = createFakeHostHarness({ pids: [undefined] });
    const pending = h.supervisor.ensureHost();
    h.child().emit(
      'error',
      Object.assign(new Error('spawn /fake/node ENOENT'), { code: 'ENOENT' })
    );
    await expect(pending).rejects.toMatchObject({
      code: 'DSH_HOST_START_FAILED',
      message: expect.stringContaining('ENOENT'),
    });
    expect(h.child().kill).not.toHaveBeenCalled();
    expect(h.supervisor.status().state).toBe('idle');
  });

  it('a missing host build fails loudly before anything is spawned', async () => {
    const missing = Object.assign(new Error('DSH_HOST_MISSING: the DSH host entry is missing'), {
      code: 'DSH_HOST_MISSING',
    });
    const h = createFakeHostHarness({
      resolveLaunch: () => {
        throw missing;
      },
    });
    await expect(h.supervisor.ensureHost()).rejects.toBe(missing);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.supervisor.status().state).toBe('idle');
  });
});

describe('DshHostSupervisor heartbeat', () => {
  it('[SH-04] pings every 5 s and stays up while the host answers', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    for (let id = 1; id <= 6; id += 1) {
      await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
      expect(child.sent.at(-1)).toEqual({ host: 'ping', id });
      child.post(pong(id));
    }
    expect(child.kill).not.toHaveBeenCalled();
    expect(h.supervisor.status().lastPong).toMatchObject({ rttMs: 0, eldMaxMs: 4, rssMb: 180 });
  });

  it('[SH-04] 20 s without any message, with pings out, kills the host exactly once', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const channel = await h.supervisor.openChannel();
    const exits = vi.fn();
    channel.onExit(exits);
    await vi.advanceTimersByTimeAsync(T.hungAfterMs - T.heartbeatIntervalMs);
    expect(child.pings()).toHaveLength(3);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(h.supervisor.status().state).toBe('restarting');
    await vi.advanceTimersByTimeAsync(T.exitAfterKillMs - 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.die(null, 'SIGKILL');
    await flushMicrotasks();
    expect(exits).toHaveBeenCalledWith({ code: null, signal: 'SIGKILL', cause: 'host-exit' });
    expect(h.supervisor.status()).toMatchObject({
      state: 'idle',
      lastExit: { reason: 'hung', signal: 'SIGKILL' },
    });
    // No replacement until someone asks for one.
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('[SH-04] any message resets the silence, session traffic included', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const channel = await h.supervisor.openChannel();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 4_000) {
      await vi.advanceTimersByTimeAsync(4_000);
      child.post({ ch: channel.ch, rpc: runtimeEvent });
    }
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('[SH-04] a tick delayed by a Main stall does not bill the stall to the host', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    await vi.advanceTimersByTimeAsync(2 * T.heartbeatIntervalMs);
    expect(child.pings()).toHaveLength(2);
    // Main freezes for 15 s: the clock runs, no timer fires, the host's replies sit unread.
    vi.setSystemTime(Date.now() + 15_000);
    await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
    // 30 s since the last message read, three pings out, and still no verdict.
    expect(child.pings()).toHaveLength(3);
    expect(child.kill).not.toHaveBeenCalled();
    // Main reads the queued reply; the host was fine all along.
    child.post(pong(3));
    await vi.advanceTimersByTimeAsync(3 * T.heartbeatIntervalMs);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('[SH-04] the stall allowance does not hide a host that stays silent', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    await vi.advanceTimersByTimeAsync(2 * T.heartbeatIntervalMs);
    vi.setSystemTime(Date.now() + 15_000);
    await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
    expect(child.kill).not.toHaveBeenCalled();
    // 10 s of awake silence before the stall + 10 s after it = 20 s.
    await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('[SH-04] waking from sleep restarts the silence count', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    expect(h.monitor.listenerCount('resume')).toBe(1);
    await vi.advanceTimersByTimeAsync(T.hungAfterMs - T.heartbeatIntervalMs);
    expect(child.pings()).toHaveLength(3);
    h.monitor.emit('resume');
    await vi.advanceTimersByTimeAsync(T.hungAfterMs - T.heartbeatIntervalMs);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('warns about slow pongs and a blocked host event loop, once a minute per kind', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    await h.supervisor.openChannel();
    await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
    await vi.advanceTimersByTimeAsync(2_500);
    child.post(pong(1, { eldMaxMs: 350, rssMb: 900 }));
    const warnings = consoleWarn.mock.calls.map((call) => String(call[0]));
    expect(warnings).toEqual([
      expect.stringContaining('pong took 2500ms (1 channel(s), rss 900 MB)'),
      expect.stringContaining('event loop blocked up to 350ms (1 channel(s), rss 900 MB)'),
    ]);
    await vi.advanceTimersByTimeAsync(2_500);
    child.post(pong(2, { eldMaxMs: 400 }));
    expect(consoleWarn).toHaveBeenCalledTimes(2);
  });
});

describe('DshHostSupervisor signalling guards', () => {
  it.each([
    ['pid 1', { pids: [1] }],
    ['a pid equal to our own', { pids: [SELF_PID] }],
  ])('[SH-05] never signals %s; the start fails as unconfirmed instead', async (_label, options) => {
    const h = createFakeHostHarness(options);
    const pending = h.supervisor.ensureHost();
    const outcome = settlement(pending);
    await vi.advanceTimersByTimeAsync(T.readyTimeoutMs);
    expect(h.child().kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(T.exitAfterKillMs);
    expect(outcome.settled()).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'DSH_HOST_EXIT_UNCONFIRMED' });
    expect(h.supervisor.status()).toMatchObject({
      state: 'failed',
      failure: { code: 'DSH_HOST_EXIT_UNCONFIRMED' },
    });
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('[SH-05] refuses a pid that no longer matches the spawn and the handshake', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    child.pid = 31337;
    await vi.advanceTimersByTimeAsync(T.hungAfterMs);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(T.exitAfterKillMs);
    expect(h.supervisor.status()).toMatchObject({ state: 'failed' });
  });

  it('[SH-05] does not signal a child whose exit is already recorded', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    child.exitCode = 0;
    expect(h.supervisor.forceKillNow()).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('[SH-06] spawns nothing until the killed host is confirmed gone', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    await vi.advanceTimersByTimeAsync(T.hungAfterMs);
    expect(child.kill).toHaveBeenCalledTimes(1);
    const waiting = h.supervisor.ensureHost();
    const outcome = settlement(waiting);
    await vi.advanceTimersByTimeAsync(T.exitAfterKillMs - 1);
    expect(outcome.settled()).toBe(false);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).rejects.toMatchObject({ code: 'DSH_HOST_EXIT_UNCONFIRMED' });
    expect(h.supervisor.status()).toMatchObject({
      state: 'failed',
      pid: FAKE_PID,
      failure: { code: 'DSH_HOST_EXIT_UNCONFIRMED' },
    });
    // Neither an automatic nor a user request may start a second host now.
    await expect(h.supervisor.ensureHost()).rejects.toMatchObject({
      code: 'DSH_HOST_EXIT_UNCONFIRMED',
    });
    await expect(h.supervisor.ensureHost({ userInitiated: true })).rejects.toMatchObject({
      code: 'DSH_HOST_EXIT_UNCONFIRMED',
    });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    // The exit shows up late. Only a user action leaves `failed`.
    child.die(null, 'SIGKILL');
    await expect(h.supervisor.ensureHost()).rejects.toMatchObject({
      code: 'DSH_HOST_EXIT_UNCONFIRMED',
    });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const retry = h.supervisor.ensureHost({ userInitiated: true });
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.child().ready();
    await expect(retry).resolves.toEqual({ generation: 2, pid: FAKE_PID + 1 });
  });

  // P1-3a, found against the real host: Node emits the IPC drop of a killed
  // child before its exit, so a crash first looks like a disconnect.
  it('a host that dies after dropping IPC is recorded as crashed, and not signalled', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    child.connected = false;
    child.emit('disconnect');
    child.die(null, 'SIGKILL');
    await flushMicrotasks();
    expect(child.kill).not.toHaveBeenCalled();
    expect(h.supervisor.status()).toMatchObject({
      state: 'idle',
      lastExit: { reason: 'crashed', signal: 'SIGKILL' },
    });
  });

  it('a host that drops IPC without exiting is killed after the graceful budget', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    child.connected = false;
    child.emit('disconnect');
    expect(h.supervisor.status().state).toBe('restarting');
    await vi.advanceTimersByTimeAsync(T.gracefulStopMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.die(null, 'SIGKILL');
    await flushMicrotasks();
    expect(h.supervisor.status()).toMatchObject({
      state: 'idle',
      lastExit: { reason: 'disconnected' },
    });
  });
});

describe('DshHostSupervisor restart', () => {
  it('is single flight: one graceful stop, one new host after the old exit', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const first = h.supervisor.restart('stuck-session');
    const second = h.supervisor.restart('stuck-session');
    expect(second).toBe(first);
    expect(h.supervisor.status().state).toBe('restarting');
    expect(child.controls()).toEqual([{ type: 'shutdown' }]);
    await vi.advanceTimersByTimeAsync(T.gracefulStopMs);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    child.die(null, 'SIGKILL');
    await flushMicrotasks();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.child().ready();
    await expect(first).resolves.toEqual({ generation: 2, pid: FAKE_PID + 1 });
    expect(h.supervisor.status().lastExit).toMatchObject({
      reason: 'stuck-session',
      generation: 1,
    });
    expect(
      errorLines().some((line) => line.includes('stuck-session (code=null signal=SIGKILL)'))
    ).toBe(true);
  });

  it('needs no signal when the host exits inside the grace, and replays nothing for config', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    child.writeStderr('ordinary line\n');
    const restarted = h.supervisor.restart('config');
    child.post({ type: 'stopped', ms: 40, reason: 'ipc' });
    child.die(0);
    await flushMicrotasks();
    h.child().ready();
    await expect(restarted).resolves.toEqual({ generation: 2, pid: FAKE_PID + 1 });
    expect(child.kill).not.toHaveBeenCalled();
    expect(errorLines().filter((line) => line.includes('stderr line'))).toEqual([]);
  });

  it('joins a start already in flight instead of stopping it', async () => {
    const h = createFakeHostHarness();
    const pending = h.supervisor.ensureHost();
    const restarted = h.supervisor.restart('config');
    h.child().ready();
    await expect(restarted).resolves.toEqual(await pending);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.child().controls()).toEqual([]);
  });

  it('after a hang, one restart waits for the takedown and brings up one host', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    await vi.advanceTimersByTimeAsync(T.hungAfterMs);
    const restarted = h.supervisor.restart('stuck-session');
    const opened = h.supervisor.openChannel();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    child.die(null, 'SIGKILL');
    await flushMicrotasks();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.child().ready();
    await expect(restarted).resolves.toEqual({ generation: 2, pid: FAKE_PID + 1 });
    expect((await opened).ch).toBe('c2-1');
  });
});

describe('DshHostSupervisor shutdown and force kill', () => {
  it('[SH-09] asks first, SIGKILLs after 3.5 s, waits for the exit, then refuses everything', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const stopping = h.supervisor.shutdown('app-quit');
    const outcome = settlement(stopping);
    expect(child.controls()).toEqual([{ type: 'shutdown' }]);
    expect(h.supervisor.status().state).toBe('stopping');
    await vi.advanceTimersByTimeAsync(T.gracefulStopMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await flushMicrotasks();
    expect(outcome.settled()).toBe(false);
    child.die(null, 'SIGKILL');
    await stopping;
    expect(h.supervisor.status()).toMatchObject({
      state: 'disposed',
      lastExit: { reason: 'app-quit' },
    });
    await expect(h.supervisor.ensureHost({ userInitiated: true })).rejects.toMatchObject({
      code: 'DSH_HOST_DISPOSED',
    });
    await expect(h.supervisor.openChannel()).rejects.toMatchObject({ code: 'DSH_HOST_DISPOSED' });
    await expect(h.supervisor.restart('config')).rejects.toMatchObject({
      code: 'DSH_HOST_DISPOSED',
    });
    await expect(h.supervisor.shutdown('app-quit')).resolves.toBeUndefined();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.monitor.listenerCount('resume')).toBe(0);
    expect(errorLines().filter((line) => line.includes('stderr'))).toEqual([]);
  });

  it('[SH-09] `stopped` ends the wait early: a host lingering 0.5 s past it is killed', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const stopping = h.supervisor.shutdown('app-quit');
    child.post({ type: 'stopped', ms: 30, reason: 'ipc' });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(T.stoppedExitGraceMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.die(null, 'SIGKILL');
    await stopping;
    expect(h.supervisor.status().state).toBe('disposed');
  });

  it('[SH-09] a non-terminal stop needs no signal for a clean exit and leaves the supervisor idle', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const stopping = h.supervisor.shutdown('idle');
    child.die(0);
    await stopping;
    expect(child.kill).not.toHaveBeenCalled();
    expect(h.supervisor.status()).toMatchObject({
      state: 'idle',
      lastExit: { reason: 'idle', code: 0 },
    });
    const again = h.supervisor.ensureHost();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.child().ready();
    await expect(again).resolves.toEqual({ generation: 2, pid: FAKE_PID + 1 });
  });

  it('[SH-09] a new request during a non-terminal stop waits for it, then starts one host', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const stopping = h.supervisor.shutdown('invalidate');
    const next = h.supervisor.ensureHost();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    child.die(0);
    await stopping;
    await flushMicrotasks();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.child().ready();
    await expect(next).resolves.toEqual({ generation: 2, pid: FAKE_PID + 1 });
  });

  it('[SH-09] stopping a host that is still booting kills it and fails its start', async () => {
    const h = createFakeHostHarness();
    const pending = h.supervisor.ensureHost();
    const child = h.child();
    const stopping = h.supervisor.shutdown('app-quit');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(pending).rejects.toMatchObject({ code: 'DSH_HOST_DISPOSED' });
    child.die(null, 'SIGKILL');
    await stopping;
    expect(h.supervisor.status().state).toBe('disposed');
  });

  it('[SH-10] forceKillNow SIGKILLs synchronously, once, and disposes', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    expect(h.supervisor.forceKillNow()).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(h.supervisor.status().state).toBe('disposed');
    expect(h.supervisor.forceKillNow()).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(h.monitor.listenerCount('resume')).toBe(0);
    await expect(h.supervisor.ensureHost({ userInitiated: true })).rejects.toMatchObject({
      code: 'DSH_HOST_DISPOSED',
    });
    // The late exit changes nothing and replays nothing.
    child.die(null, 'SIGKILL');
    await flushMicrotasks();
    expect(h.supervisor.status().state).toBe('disposed');
    expect(errorLines().filter((line) => line.includes('stderr'))).toEqual([]);
  });

  it('[SH-10] forceKillNow with no host just disposes', () => {
    const h = createFakeHostHarness();
    expect(h.supervisor.forceKillNow()).toBe(true);
    expect(h.supervisor.status().state).toBe('disposed');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('[SH-10] forceKillNow during a boot rejects the start as disposed', async () => {
    const h = createFakeHostHarness();
    const pending = h.supervisor.ensureHost();
    expect(h.supervisor.forceKillNow()).toBe(true);
    expect(h.child().kill).toHaveBeenCalledWith('SIGKILL');
    await expect(pending).rejects.toMatchObject({ code: 'DSH_HOST_DISPOSED' });
  });
});

describe('DshHostSupervisor crash and stderr', () => {
  async function crashWithChannels(): Promise<{
    h: ReturnType<typeof createFakeHostHarness>;
    child: FakeChild;
    exits: Array<ReturnType<typeof vi.fn>>;
  }> {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const channels = [await h.supervisor.openChannel(), await h.supervisor.openChannel()];
    const exits = channels.map((channel) => {
      const listener = vi.fn();
      channel.onExit(listener);
      return listener;
    });
    return { h, child, exits };
  }

  it('[SH-07] a crash ends every channel once with cause host-exit and leaves the supervisor idle', async () => {
    const { h, child, exits } = await crashWithChannels();
    expect(h.supervisor.status().channels).toBe(2);
    child.die(null, 'SIGSEGV');
    for (const exit of exits) {
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith({ code: null, signal: 'SIGSEGV', cause: 'host-exit' });
    }
    expect(h.supervisor.status()).toMatchObject({
      state: 'idle',
      channels: 0,
      lastExit: { reason: 'crashed', signal: 'SIGSEGV', generation: 1 },
    });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    // Next request brings up generation 2; channel ids keep counting.
    const next = h.supervisor.openChannel();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.child().ready();
    expect((await next).ch).toBe('c2-3');
    child.post({ host: 'closed', ch: 'c1-1' });
    for (const exit of exits) expect(exit).toHaveBeenCalledTimes(1);
  });

  // P1-3a: the host answers every close, so a slot's close that crossed the
  // `closed` its own worker.dispose produced gets a second, expected one.
  it('[SH-07] a repeated closed for a channel it just closed is expected, not warned', async () => {
    const { child, exits } = await crashWithChannels();
    child.post({ host: 'closed', ch: 'c1-2' });
    child.post({ host: 'closed', ch: 'c1-2' });
    expect(exits[1]).toHaveBeenCalledTimes(1);
    expect(consoleWarn).not.toHaveBeenCalled();
    child.post({ host: 'closed', ch: 'c1-7' });
    expect(consoleWarn).toHaveBeenCalledWith('[dsh-host] closed for unknown channel c1-7');
  });

  it('[SH-07] closed ends only its own channel', async () => {
    const { h, child, exits } = await crashWithChannels();
    child.post({ host: 'closed', ch: 'c1-2' });
    expect(exits[0]).not.toHaveBeenCalled();
    expect(exits[1]).toHaveBeenCalledWith({ code: 0, signal: null, cause: 'channel-closed' });
    expect(h.supervisor.status()).toMatchObject({ state: 'ready', channels: 1 });
    child.post({ host: 'closed', ch: 'c1-2' });
    expect(exits[1]).toHaveBeenCalledTimes(1);
  });

  it('[SH-12] stderr is redacted into the log and replayed once when the host crashes', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const channel = await h.supervisor.openChannel();
    const channelStderr = vi.fn();
    channel.onStderr(channelStderr);
    child.writeStderr('[dsh-host] warn llm: key sk-ant-abcdefghijklmnop1234 rejected\nstack tail');
    expect(h.logLine).toHaveBeenCalledWith(
      '[dsh-host:g1:stderr] [dsh-host] warn llm: key [redacted] rejected'
    );
    expect(h.logLine.mock.calls.flat().join('\n')).not.toContain('sk-ant-');
    child.emit('exit', 1, null);
    // The replay waits for the pipe to drain: lines written after `exit` still make it.
    child.writeStderr(' at the very end\n');
    expect(errorLines().filter((line) => line.includes('stderr line'))).toEqual([]);
    child.emit('close', 1, null);
    const replays = errorLines().filter((line) => line.includes('stderr line'));
    expect(replays).toHaveLength(1);
    expect(replays[0]).toContain('crashed (code=1 signal=null); last 2 stderr line(s)');
    expect(replays[0]).toContain('key [redacted] rejected');
    expect(replays[0]).toContain('stack tail at the very end');
    expect(replays[0]).not.toContain('sk-ant-');
    expect(channelStderr).not.toHaveBeenCalled();
  });

  it('[SH-12] replays after 1 s when the pipe never closes, and never for a planned stop', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    child.writeStderr('before the crash\n');
    child.emit('exit', null, 'SIGABRT');
    await vi.advanceTimersByTimeAsync(T.stderrTailMs);
    expect(errorLines().filter((line) => line.includes('before the crash'))).toHaveLength(1);

    const quiet = createFakeHostHarness();
    const quietChild = await startReadyHost(quiet);
    quietChild.writeStderr('routine line\n');
    const stopping = quiet.supervisor.shutdown('idle');
    quietChild.die(0);
    await stopping;
    await vi.advanceTimersByTimeAsync(T.stderrTailMs);
    expect(errorLines().filter((line) => line.includes('routine line'))).toEqual([]);
  });

  it('drops messages it does not understand, with a rate-limited warning', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    child.post({ host: 'credential', id: 1, ref: 'X' });
    child.post({ host: 'credential', id: 2, ref: 'X' });
    child.post('noise');
    const warnings = consoleWarn.mock.calls.map((call) => String(call[0]));
    expect(warnings).toEqual([
      expect.stringContaining('unrecognized message (credential)'),
      expect.stringContaining('unrecognized message (string)'),
    ]);
    expect(h.supervisor.status().state).toBe('ready');
  });
});

describe('DshHostSupervisor restart budget (decision 020)', () => {
  const B = DSH_HOST_RESTART_BUDGET;

  /** The live host dies on its own. */
  const crash = (h: ReturnType<typeof createFakeHostHarness>) => h.child().die(null, 'SIGKILL');

  /** An automatic request brings the next host up. */
  async function recover(h: ReturnType<typeof createFakeHostHarness>) {
    const next = h.supervisor.ensureHost();
    h.child().ready();
    return next;
  }

  it('[SH-08] the fourth fault in 5 min refuses automatic starts; each user action gets one host', async () => {
    const h = createFakeHostHarness();
    await startReadyHost(h);
    for (let fault = 1; fault <= B.restarts; fault += 1) {
      crash(h);
      await recover(h);
    }
    expect(h.supervisor.status()).toMatchObject({
      state: 'ready',
      generation: B.restarts + 1,
      recentFaults: B.restarts,
    });

    crash(h);
    await expect(h.supervisor.ensureHost()).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE' });
    await expect(h.supervisor.openChannel()).rejects.toMatchObject({
      code: 'DSH_HOST_UNAVAILABLE',
    });
    expect(h.spawn).toHaveBeenCalledTimes(B.restarts + 1);
    expect(h.supervisor.status()).toMatchObject({
      state: 'failed',
      recentFaults: B.restarts + 1,
      failure: { code: 'DSH_HOST_UNAVAILABLE' },
    });
    expect(
      errorLines().some((line) => line.includes('it starts again only for a user action'))
    ).toBe(true);

    // A user's open is let through, budget or not.
    const opened = h.supervisor.openChannel({ userInitiated: true });
    expect(h.spawn).toHaveBeenCalledTimes(B.restarts + 2);
    h.child().ready();
    await expect(opened).resolves.toMatchObject({ ch: `c${B.restarts + 2}-1` });
    // The next fault still finds it spent; the next user action is let through again.
    crash(h);
    await expect(h.supervisor.ensureHost()).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE' });
    const again = h.supervisor.ensureHost({ userInitiated: true });
    h.child().ready();
    await expect(again).resolves.toMatchObject({ generation: B.restarts + 3 });

    // Faults age out of the window: automatic restarts come back.
    vi.setSystemTime(Date.now() + B.windowMs);
    crash(h);
    await expect(recover(h)).resolves.toMatchObject({ generation: B.restarts + 4 });
    expect(h.supervisor.status()).toMatchObject({ state: 'ready', recentFaults: 1 });
  });

  it('[SH-08] planned stops and restarts are not faults; a Stop ladder B restart is', async () => {
    const h = createFakeHostHarness();
    let child = await startReadyHost(h);
    for (const reason of ['idle', 'invalidate'] as const) {
      const stopping = h.supervisor.shutdown(reason);
      child.die(0);
      await stopping;
      child = await startReadyHost(h);
    }
    for (const [reason, options] of [
      ['user', { userInitiated: true }],
      ['config', {}],
    ] as const) {
      const restarted = h.supervisor.restart(reason, options);
      child.die(0);
      await flushMicrotasks();
      h.child().ready();
      await restarted;
      child = h.child();
    }
    expect(h.supervisor.status()).toMatchObject({
      state: 'ready',
      recentFaults: 0,
      lastExit: { reason: 'config' },
    });
    // Nothing is replayed for them either: they are routine.
    expect(errorLines().filter((line) => line.includes('stderr'))).toEqual([]);

    const stuck = h.supervisor.restart('stuck-session');
    child.die(0);
    await flushMicrotasks();
    h.child().ready();
    await stuck;
    expect(h.supervisor.status()).toMatchObject({
      recentFaults: 1,
      lastExit: { reason: 'stuck-session' },
    });
  });

  it('[SH-08] a ladder B restart past the budget ends failed, with no new host', async () => {
    const h = createFakeHostHarness();
    await startReadyHost(h);
    for (let fault = 1; fault <= B.restarts; fault += 1) {
      crash(h);
      await recover(h);
    }
    const child = h.child();
    const restarted = h.supervisor.restart('stuck-session');
    child.die(0);
    await expect(restarted).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE' });
    expect(h.spawn).toHaveBeenCalledTimes(B.restarts + 1);
    expect(h.supervisor.status()).toMatchObject({ state: 'failed', recentFaults: B.restarts + 1 });
    // A user's restart is refused by nothing but a host that will not die.
    const user = h.supervisor.restart('user', { userInitiated: true });
    expect(h.spawn).toHaveBeenCalledTimes(B.restarts + 2);
    h.child().ready();
    await expect(user).resolves.toMatchObject({ generation: B.restarts + 2 });
  });
});

describe('DshHostSupervisor idle stop (P1-3d, decision 025)', () => {
  const IDLE = 10 * 60_000;

  /** Moves fake time while the host answers every ping, as a healthy idle host does. */
  async function advanceAnswering(child: FakeChild, ms: number): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, T.heartbeatIntervalMs);
      await vi.advanceTimersByTimeAsync(step);
      child.post(pong(child.pings().length || 1));
      left -= step;
    }
  }

  it('[SH-11] a host with no channel for the idle time is stopped gracefully; the next open starts one', async () => {
    expect(T.idleStopMs).toBe(IDLE);
    const h = createFakeHostHarness({ idleStopMs: IDLE });
    const child = await startReadyHost(h);
    const channel = await h.supervisor.openChannel();
    // An open channel keeps the host up however long it sits.
    await advanceAnswering(child, 2 * IDLE);
    expect(child.controls()).not.toContainEqual({ type: 'shutdown' });
    channel.kill();
    child.post({ host: 'closed', ch: channel.ch });
    await advanceAnswering(child, IDLE - 1);
    expect(child.controls()).not.toContainEqual({ type: 'shutdown' });
    await vi.advanceTimersByTimeAsync(1);
    expect(child.controls()).toContainEqual({ type: 'shutdown' });
    expect(h.supervisor.status().state).toBe('stopping');
    child.post({ type: 'stopped' });
    child.die(0);
    await flushMicrotasks();
    expect(child.kill).not.toHaveBeenCalled();
    expect(h.supervisor.status()).toMatchObject({
      state: 'idle',
      recentFaults: 0,
      lastExit: { reason: 'idle', code: 0 },
    });
    const next = h.supervisor.openChannel();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.child().ready();
    expect((await next).ch).toBe('c2-2');
  });

  it('[SH-11] a new channel cancels the countdown, and an open still starting counts as a channel', async () => {
    const h = createFakeHostHarness({ idleStopMs: IDLE });
    const child = await startReadyHost(h);
    // Ready with no channel: the countdown runs.
    await advanceAnswering(child, IDLE - 1_000);
    const channel = await h.supervisor.openChannel();
    await advanceAnswering(child, 2_000);
    expect(child.controls()).not.toContainEqual({ type: 'shutdown' });
    child.post({ host: 'closed', ch: channel.ch });
    // It starts over from the last close.
    await advanceAnswering(child, IDLE - 1);
    expect(child.controls()).not.toContainEqual({ type: 'shutdown' });
    await vi.advanceTimersByTimeAsync(1);
    expect(child.controls()).toContainEqual({ type: 'shutdown' });
  });

  it('[SH-11] a 0 idle time never stops the host; app quit cancels the countdown', async () => {
    const h = createFakeHostHarness({ idleStopMs: 0 });
    const child = await startReadyHost(h);
    await advanceAnswering(child, 3 * IDLE);
    expect(child.controls()).not.toContainEqual({ type: 'shutdown' });

    const other = createFakeHostHarness({ idleStopMs: IDLE });
    const host = await startReadyHost(other);
    other.supervisor.forceKillNow();
    host.die(null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(2 * IDLE);
    expect(host.controls()).not.toContainEqual({ type: 'shutdown' });
    expect(other.supervisor.status().state).toBe('disposed');
  });
});

describe('DshHostSupervisor scopes of a dead host (P1-3d, decision 075)', () => {
  it('stops the dead pid’s scopes before the next host starts, and only after an abnormal exit of a ready host', async () => {
    let release!: () => void;
    const stopOrphanScopes = vi.fn(
      (_pid: number) =>
        new Promise<number>((resolve) => {
          release = () => resolve(1);
        })
    );
    const h = createFakeHostHarness({ stopOrphanScopes });
    const child = await startReadyHost(h);
    child.die(null, 'SIGKILL');
    expect(stopOrphanScopes).toHaveBeenCalledWith(FAKE_PID);
    const next = h.supervisor.ensureHost();
    await flushMicrotasks();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.supervisor.status().state).toBe('starting');
    release();
    await flushMicrotasks();
    expect(h.spawn).toHaveBeenCalledTimes(2);
    h.child().ready();
    await expect(next).resolves.toMatchObject({ generation: 2 });

    // A clean exit went through DSH's own teardown: nothing to stop.
    h.supervisor.shutdown('idle');
    h.child().post({ type: 'stopped' });
    h.child().die(0);
    await flushMicrotasks();
    expect(stopOrphanScopes).toHaveBeenCalledTimes(1);
  });

  it('never stops scopes for a host that never got ready, and waits no longer than its bound', async () => {
    const stopOrphanScopes = vi.fn((_pid: number) => new Promise<number>(() => {}));
    const h = createFakeHostHarness({ stopOrphanScopes });
    const booting = h.supervisor.ensureHost();
    h.child().die(1);
    await expect(booting).rejects.toMatchObject({ code: 'DSH_HOST_START_FAILED' });
    expect(stopOrphanScopes).not.toHaveBeenCalled();

    const child = await startReadyHost(h);
    child.die(1);
    expect(stopOrphanScopes).toHaveBeenCalledTimes(1);
    const next = h.supervisor.ensureHost();
    await vi.advanceTimersByTimeAsync(T.scopeStopWaitMs - 1);
    expect(h.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawn).toHaveBeenCalledTimes(3);
    h.child().ready();
    await expect(next).resolves.toMatchObject({ generation: 3 });
  });

  it('a stop or force kill during the wait wins: no host is spawned', async () => {
    let release!: () => void;
    const h = createFakeHostHarness({
      stopOrphanScopes: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const child = await startReadyHost(h);
    child.die(null, 'SIGKILL');
    const next = h.supervisor.ensureHost();
    const outcome = settlement(next);
    h.supervisor.forceKillNow();
    release();
    await flushMicrotasks();
    expect(outcome.value()).toMatchObject({ code: 'DSH_HOST_DISPOSED' });
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('DshHostSupervisor gc (P1-3d, decision 024)', () => {
  const result = (id: number) => ({
    host: 'gc-result',
    id,
    ok: true,
    deleted: ['aiclient-old'],
    stubsDeleted: 1,
    skipped: { claimed: 2 },
    ms: 4,
  });

  it('sends one gc with the claimed ids and resolves with the matching answer', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const pass = h.supervisor.collectSessions({ claimed: ['aiclient-a'], graceMs: 86_400_000 });
    expect(child.controls()).toContainEqual({
      host: 'gc',
      id: 1,
      claimed: ['aiclient-a'],
      graceMs: 86_400_000,
    });
    // Another id is not this pass's answer.
    child.post(result(9));
    child.post(result(1));
    await expect(pass).resolves.toEqual(result(1));
  });

  it('rejects without a ready host, when the host exits, and after its timeout', async () => {
    const h = createFakeHostHarness();
    await expect(h.supervisor.collectSessions({ claimed: [], graceMs: 0 })).rejects.toMatchObject({
      code: 'DSH_HOST_UNAVAILABLE',
    });
    const child = await startReadyHost(h);
    const dying = h.supervisor.collectSessions({ claimed: [], graceMs: 0 });
    child.die(null, 'SIGKILL');
    await expect(dying).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE' });
    const next = h.supervisor.ensureHost();
    h.child().ready();
    await next;
    const slow = settlement(h.supervisor.collectSessions({ claimed: [], graceMs: 0 }));
    // The heartbeat keeps the host alive meanwhile.
    for (let at = 0; at < T.gcTimeoutMs; at += T.heartbeatIntervalMs) {
      h.child().post(pong(h.child().pings().length));
      await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
    }
    await flushMicrotasks();
    expect(slow.value()).toMatchObject({ code: 'DSH_HOST_UNAVAILABLE' });
  });
});

describe('DshHostSupervisor readPage (P1-4a, decision 030)', () => {
  const page = {
    messages: [
      { id: 'h:u1', role: 'user', blocks: [{ type: 'text', id: 'h:u1:text:0', text: 'hi' }] },
    ],
    offset: 0,
    limit: 80,
    totalCount: 1,
    hasMore: false,
  };
  const stubFile = '/fake/state/dsh-home/aiclient-sessions/aiclient-s1.dsh.json';
  const answer = (id: number, extra: Record<string, unknown> = { ok: true, page }) => ({
    host: 'page',
    id,
    ms: 2.5,
    ...extra,
  });
  const reads = (child: FakeChild) =>
    child
      .controls()
      .filter((message) => (message as { host?: unknown }).host === 'readPage') as Array<{
      id: number;
    }>;

  it('starts a host when none is up, sends one readPage and resolves with the matching page', async () => {
    const h = createFakeHostHarness();
    const read = h.supervisor.readPage({ stubFile, logicalSessionId: 's1', offset: 80, limit: 40 });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const child = h.child();
    child.ready();
    await flushMicrotasks();
    expect(reads(child)).toEqual([
      { host: 'readPage', id: 1, stubFile, logicalSessionId: 's1', offset: 80, limit: 40 },
    ]);
    // Another id, or a malformed answer, is not this read's.
    child.post(answer(9));
    child.post({ host: 'page', id: 1, ok: true, ms: 1 });
    await flushMicrotasks();
    child.post(answer(1));
    await expect(read).resolves.toEqual(page);
    // No channel was opened for it: the host it started is idle.
    expect(h.supervisor.status()).toMatchObject({ state: 'ready', channels: 0 });
  });

  it('rejects with the host’s code when the read failed there', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const read = h.supervisor.readPage({ stubFile, logicalSessionId: 's1' });
    await flushMicrotasks();
    const [sent] = reads(child);
    child.post(
      answer(sent?.id ?? 0, {
        ok: false,
        error: { code: 'dsh_session_missing', message: 'DSH session aiclient-s1 is not on disk' },
      })
    );
    await expect(read).rejects.toMatchObject({
      code: 'DSH_HOST_READ_FAILED',
      message: expect.stringContaining('dsh_session_missing'),
    });
  });

  it('rejects when the host exits during the read, and when it never answers', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const dying = h.supervisor.readPage({ stubFile, logicalSessionId: 's1' });
    await flushMicrotasks();
    child.die(null, 'SIGKILL');
    await expect(dying).rejects.toMatchObject({ code: 'DSH_HOST_UNAVAILABLE' });

    const next = startReadyHost(h);
    const replacement = await next;
    const slow = settlement(h.supervisor.readPage({ stubFile, logicalSessionId: 's1' }));
    for (let at = 0; at < T.readPageTimeoutMs; at += T.heartbeatIntervalMs) {
      replacement.post(pong(replacement.pings().length));
      await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
    }
    await flushMicrotasks();
    expect(slow.value()).toMatchObject({ code: 'DSH_HOST_UNAVAILABLE' });
    expect(String((slow.value() as Error).message)).toContain('not answered');
  });

  it('never starts a host out of failed: the resume it falls back to is the user’s action', async () => {
    const h = createFakeHostHarness();
    await startReadyHost(h);
    for (let fault = 1; fault <= DSH_HOST_RESTART_BUDGET.restarts; fault += 1) {
      h.child().die(null, 'SIGKILL');
      const next = h.supervisor.ensureHost();
      h.child().ready();
      await next;
    }
    h.child().die(null, 'SIGKILL');
    const spawned = h.spawn.mock.calls.length;
    await expect(h.supervisor.readPage({ stubFile, logicalSessionId: 's1' })).rejects.toMatchObject(
      {
        code: 'DSH_HOST_UNAVAILABLE',
      }
    );
    expect(h.spawn).toHaveBeenCalledTimes(spawned);
  });

  it('holds off the idle stop while a read runs, and arms it once the read is answered', async () => {
    // Shorter than the read's own timeout, so a pending read outlives it.
    const IDLE = T.readPageTimeoutMs / 2;
    const h = createFakeHostHarness({ idleStopMs: IDLE });
    const read = h.supervisor.readPage({ stubFile, logicalSessionId: 's1' });
    const child = h.child();
    child.ready();
    await flushMicrotasks();
    const advance = async (ms: number) => {
      for (let at = 0; at < ms; at += T.heartbeatIntervalMs) {
        child.post(pong(child.pings().length || 1));
        await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
      }
    };
    await advance(IDLE + T.heartbeatIntervalMs);
    expect(child.controls()).not.toContainEqual({ type: 'shutdown' });
    const [sent] = reads(child);
    child.post(answer(sent?.id ?? 0));
    await expect(read).resolves.toEqual(page);
    await advance(IDLE - T.heartbeatIntervalMs);
    expect(child.controls()).not.toContainEqual({ type: 'shutdown' });
    await advance(T.heartbeatIntervalMs);
    expect(child.controls()).toContainEqual({ type: 'shutdown' });
  });
});

/**
 * P1-9d (decisions 054, 122): Main's half of `seedSession`. A host answer is
 * resolved as it came, failed migrations included; only the transport fails
 * the call, each way with its own code.
 */
describe('DshHostSupervisor seedSession (P1-9d, decision 054)', () => {
  const input = {
    sourceFile: '/fake/profile/sessions/s1.jsonl',
    logicalSessionId: 's1',
    cwd: '/fake/workspace',
    expect: { bytes: 1234, mtimeMs: 1_700_000_000_123.5 },
  };
  const result = {
    stubFile: '/fake/state/dsh-home/aiclient-sessions/aiclient-s1.dsh.json',
    dshSessionId: 'aiclient-s1',
    reused: false,
    source: { sha256: 'a'.repeat(64), bytes: 1234, mtimeMs: 1_700_000_000_123.5 },
    converted: 'source',
    legacyPermissions: { mode: 'agent', gear: 'ask' },
    grants: 0,
    images: { admitted: 1, refused: 0 },
    report: { converterVersion: 2, source: {} },
  };
  const seeded = (id: number, extra: Record<string, unknown> = { ok: true, result }) => ({
    host: 'seeded',
    id,
    ms: 42,
    ...extra,
  });
  const seeds = (child: FakeChild) =>
    child
      .controls()
      .filter((message) => (message as { host?: unknown }).host === 'seedSession') as Array<{
      id: number;
    }>;
  const idOf = (child: FakeChild) => seeds(child).at(-1)?.id ?? 0;

  it('starts a host when none is up, sends one seedSession and resolves with the matching answer', async () => {
    const h = createFakeHostHarness();
    const migration = h.supervisor.seedSession(input, { userInitiated: true });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const child = h.child();
    child.ready();
    await flushMicrotasks();
    expect(seeds(child)).toEqual([{ host: 'seedSession', id: 1, kind: 'pi-file', ...input }]);
    // Another id is not this migration's answer.
    child.post(seeded(9));
    child.post(seeded(1));
    await expect(migration).resolves.toEqual(seeded(1));
    // No channel was opened for it.
    expect(h.supervisor.status()).toMatchObject({ state: 'ready', channels: 0 });
  });

  it('omits `expect` when Main has none, and hands a failed migration back as the host answered it', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const { expect: _none, ...bare } = input;
    const migration = h.supervisor.seedSession(bare);
    await flushMicrotasks();
    expect(seeds(child).at(-1)).not.toHaveProperty('expect');
    const failed = seeded(idOf(child), {
      ok: false,
      error: {
        stage: 'read',
        code: 'source_busy',
        message: '/fake/profile/sessions/s1.jsonl changed while it was read',
        retryable: true,
      },
    });
    child.post(failed);
    await expect(migration).resolves.toEqual(failed);
  });

  it('fails a migration in flight when the host exits, and when Main restarts it', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const dying = h.supervisor.seedSession(input);
    await flushMicrotasks();
    child.die(null, 'SIGKILL');
    await expect(dying).rejects.toMatchObject({ code: 'DSH_HOST_SEED_INTERRUPTED' });

    const replacement = await startReadyHost(h);
    const restarted = settlement(h.supervisor.seedSession(input));
    await flushMicrotasks();
    expect(seeds(replacement)).toHaveLength(1);
    const next = h.supervisor.restart('user', { userInitiated: true });
    await flushMicrotasks();
    expect(replacement.controls()).toContainEqual({ type: 'shutdown' });
    replacement.post({ type: 'stopped' });
    replacement.die(0);
    await flushMicrotasks();
    expect(restarted.value()).toMatchObject({ code: 'DSH_HOST_SEED_INTERRUPTED' });
    h.child().ready();
    await next;
    // The late answer of the dead host is nobody's: dropped.
    replacement.post(seeded(1));
  });

  it('gives up after its timeout; a late answer is dropped', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const slow = settlement(h.supervisor.seedSession(input));
    await flushMicrotasks();
    for (let at = 0; at < T.seedSessionTimeoutMs; at += T.heartbeatIntervalMs) {
      child.post(pong(child.pings().length));
      await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
    }
    await flushMicrotasks();
    expect(slow.value()).toMatchObject({ code: 'DSH_HOST_SEED_TIMEOUT' });
    child.post(seeded(1));
    await flushMicrotasks();
    expect(consoleWarn.mock.calls.map((call) => String(call[0]))).toContain(
      '[dsh-host] dropped seeded 1'
    );
    // The host itself is fine.
    expect(h.supervisor.status()).toMatchObject({ state: 'ready' });
  });

  it('fails at once on a malformed answer to its id, instead of waiting out the timeout', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    const migration = h.supervisor.seedSession(input);
    await flushMicrotasks();
    child.post({ host: 'seeded', id: idOf(child), ok: true, ms: 1 });
    await expect(migration).rejects.toMatchObject({ code: 'DSH_HOST_SEED_MALFORMED' });
  });

  it('comes out of failed only for a user-initiated migration', async () => {
    const h = createFakeHostHarness();
    await startReadyHost(h);
    for (let fault = 1; fault <= DSH_HOST_RESTART_BUDGET.restarts; fault += 1) {
      h.child().die(null, 'SIGKILL');
      const next = h.supervisor.ensureHost();
      h.child().ready();
      await next;
    }
    h.child().die(null, 'SIGKILL');
    const spawned = h.spawn.mock.calls.length;
    await expect(h.supervisor.seedSession(input)).rejects.toMatchObject({
      code: 'DSH_HOST_UNAVAILABLE',
    });
    expect(h.spawn).toHaveBeenCalledTimes(spawned);
    const migration = h.supervisor.seedSession(input, { userInitiated: true });
    expect(h.spawn).toHaveBeenCalledTimes(spawned + 1);
    const child = h.child();
    child.ready();
    await flushMicrotasks();
    child.post(seeded(idOf(child)));
    await expect(migration).resolves.toMatchObject({ ok: true });
  });

  it('holds off the idle stop while a migration runs, and arms it once it is answered', async () => {
    const IDLE = T.seedSessionTimeoutMs / 4;
    const h = createFakeHostHarness({ idleStopMs: IDLE });
    const migration = h.supervisor.seedSession(input);
    const child = h.child();
    child.ready();
    await flushMicrotasks();
    const advance = async (ms: number) => {
      for (let at = 0; at < ms; at += T.heartbeatIntervalMs) {
        child.post(pong(child.pings().length || 1));
        await vi.advanceTimersByTimeAsync(T.heartbeatIntervalMs);
      }
    };
    await advance(IDLE + T.heartbeatIntervalMs);
    expect(child.controls()).not.toContainEqual({ type: 'shutdown' });
    child.post(seeded(idOf(child)));
    await expect(migration).resolves.toMatchObject({ ok: true });
    await advance(IDLE - T.heartbeatIntervalMs);
    expect(child.controls()).not.toContainEqual({ type: 'shutdown' });
    await advance(T.heartbeatIntervalMs);
    expect(child.controls()).toContainEqual({ type: 'shutdown' });
  });
});

describe('DshHostSupervisor model plan and keys (P1-5, decisions 033 and 034)', () => {
  const plan = buildDshModelPlan({
    models: {
      providers: {
        gw: { baseUrl: 'http://127.0.0.1:9', api: 'anthropic-messages', models: [{ id: 'm1' }] },
      },
    },
    keyed: { gw: true },
  });
  const ref = Object.keys(plan.refs)[0] as string;
  const request = (child: FakeChild, extra: Record<string, unknown> = {}) => {
    const nonce = child.configures()[0]?.nonce;
    child.post({ host: 'credential', id: 7, ref, nonce, ...extra });
  };
  const answers = (child: FakeChild) =>
    child.sent.filter(
      (message) => (message as { host?: unknown } | null)?.host === 'credential-result'
    );

  it('[SH-P1] sends the plan first, with a nonce of its own per spawn, and reports its revision', async () => {
    const h = createFakeHostHarness({ modelSource: { plan: () => plan } });
    const child = await startReadyHost(h);
    const [configure] = child.configures();
    expect(child.sent[0]).toBe(configure);
    expect(configure).toMatchObject({
      host: 'configure',
      revision: plan.revision,
      routes: plan.routes,
      defaultModel: plan.defaultModel,
      index: plan.index,
      refs: plan.refs,
    });
    expect(String(configure?.nonce).length).toBeGreaterThanOrEqual(24);
    expect(JSON.stringify(configure)).not.toMatch(/sk-/);
    expect(h.supervisor.status().planRevision).toBe(plan.revision);
    // The next host is the one after this one exits; it gets a nonce of its own.
    child.die(0);
    await flushMicrotasks();
    expect(h.supervisor.status().planRevision).toBeUndefined();
    const next = await startReadyHost(h);
    expect(h.children).toHaveLength(2);
    expect(next.configures()[0]?.nonce).not.toBe(configure?.nonce);
  });

  it('[SH-P1] a supervisor without a model source configures an empty plan', async () => {
    const h = createFakeHostHarness();
    const child = await startReadyHost(h);
    expect(child.configures()[0]).toMatchObject({
      routes: {},
      index: {},
      refs: {},
      defaultModel: { provider: 'aiclient-none', model: 'none' },
    });
  });

  it('[SH-P2] a plan that cannot be built spawns nothing', async () => {
    const h = createFakeHostHarness({
      modelSource: {
        plan: () => {
          throw new Error('catalog unreadable');
        },
      },
    });
    await expect(h.supervisor.ensureHost()).rejects.toThrow('catalog unreadable');
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.supervisor.status().state).toBe('idle');
  });

  it('[SH-P3] answers a credential request through the broker, with what it knows of the host', async () => {
    const answer = vi.fn(() => ({
      host: 'credential-result' as const,
      id: 7,
      ok: true as const,
      value: 'sk-canary-supervisor',
    }));
    const h = createFakeHostHarness({ modelSource: { plan: () => plan, credentials: { answer } } });
    const child = await startReadyHost(h);
    request(child);
    expect(answer).toHaveBeenCalledWith(
      { host: 'credential', id: 7, ref, nonce: child.configures()[0]?.nonce },
      { current: true, nonce: child.configures()[0]?.nonce, refs: plan.refs }
    );
    expect(answers(child)).toEqual([
      { host: 'credential-result', id: 7, ok: true, value: 'sk-canary-supervisor' },
    ]);
    // The key crosses IPC and nothing else: no log line holds it.
    const logged = [...consoleWarn.mock.calls, ...consoleError.mock.calls].flat().join(' ');
    expect(logged).not.toContain('sk-canary-supervisor');
  });

  it('[SH-P3] answers unavailable without a broker, or when the broker throws', async () => {
    const bare = createFakeHostHarness({ modelSource: { plan: () => plan } });
    const child = await startReadyHost(bare);
    request(child);
    expect(answers(child)).toEqual([
      { host: 'credential-result', id: 7, ok: false, error: 'unavailable' },
    ]);
    const throwing = createFakeHostHarness({
      modelSource: {
        plan: () => plan,
        credentials: {
          answer: () => {
            throw new Error('vault gone');
          },
        },
      },
    });
    const other = await startReadyHost(throwing);
    request(other);
    expect(answers(other)).toEqual([
      { host: 'credential-result', id: 7, ok: false, error: 'unavailable' },
    ]);
  });

  it('[SH-P4] logs routes the host did not take, and a revision it does not run', async () => {
    const h = createFakeHostHarness({ modelSource: { plan: () => plan } });
    const pending = h.supervisor.ensureHost();
    const child = h.child();
    child.post({
      type: 'ready',
      pid: child.pid,
      revision: 'something-else',
      routeDiagnostics: [{ provider: 'gw', error: 'compat key not offered' }],
    });
    await pending;
    const warned = consoleWarn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warned).toContain('runs plan something-el');
    expect(warned).toContain('1 route(s) of the model plan not served as planned');
    expect(warned).toContain('compat key not offered');
  });
});

describe('DshHostSupervisor plugins (P1-10b, decision 108)', () => {
  const report = {
    enabledFrom: 'main' as const,
    plugins: [
      { name: 'dsh-a', version: '1.0.0', state: 'loaded' as const, defaultEnabled: false },
      {
        name: 'dsh-b',
        version: '1.0.0',
        state: 'missing' as const,
        reason: 'not in the install directory',
        defaultEnabled: true,
      },
    ],
    dropped: [{ name: '@evil/bundle', reason: 'not on the allowlist' }],
  };
  const withPlugins = (selection?: string) => ({
    ...LAUNCH,
    env: {
      ...LAUNCH.env,
      ...(selection === undefined ? {} : { AICLIENT_DSH_PLUGINS: selection }),
    },
  });

  it('[SH-PL1] remembers the selection each host was launched with, while it lives', async () => {
    let selection: string | undefined = '["dsh-a"]';
    const h = createFakeHostHarness({ resolveLaunch: () => withPlugins(selection) });
    const child = await startReadyHost(h);
    expect(h.supervisor.status().pluginSelection).toBe('["dsh-a"]');
    child.die(0);
    await flushMicrotasks();
    expect(h.supervisor.status().pluginSelection).toBeUndefined();
    selection = undefined;
    await startReadyHost(h);
    expect(h.supervisor.status().pluginSelection).toBe('default');
  });

  it("[SH-PL2] keeps the latest ready's plugin report, past the host's exit", async () => {
    const h = createFakeHostHarness();
    expect(h.supervisor.pluginReport()).toBeUndefined();
    const pending = h.supervisor.ensureHost();
    const child = h.child();
    child.post({ type: 'ready', pid: child.pid, plugins: report });
    await pending;
    expect(h.supervisor.pluginReport()).toEqual(report);
    // A copy: nobody outside can edit what the next caller reads.
    const copy = h.supervisor.pluginReport();
    copy?.plugins.pop();
    expect(h.supervisor.pluginReport()).toEqual(report);
    child.die(0);
    await flushMicrotasks();
    expect(h.supervisor.pluginReport()).toEqual(report);
    const warned = consoleWarn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warned).toContain('plugins (enabled from main) not composed as asked');
    expect(warned).toContain('not in the install directory');
  });

  it('[SH-PL3] ignores a malformed report and keeps the last good one', async () => {
    const h = createFakeHostHarness();
    const first = h.supervisor.ensureHost();
    const child = h.child();
    child.post({ type: 'ready', pid: child.pid, plugins: report });
    await first;
    child.die(0);
    await flushMicrotasks();
    const second = h.supervisor.ensureHost();
    const next = h.child();
    next.post({ type: 'ready', pid: next.pid, plugins: { enabledFrom: 'user', plugins: 'x' } });
    await second;
    expect(h.supervisor.pluginReport()).toEqual(report);
    const warned = consoleWarn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(warned).toContain('ready carried a malformed plugin report');
  });
});
