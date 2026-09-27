/**
 * A fake DSH host for supervisor and channel tests: no process is ever started
 * and nothing is ever signalled. `kill` is a `vi.fn`, pids are fixed fakes, and
 * `installKillTripwire` turns any real `process.kill` into a test failure
 * (the kill(-1) incident took down a whole desktop session).
 *
 * Test files importing this must mock `electron` and `node:child_process`
 * themselves (vi.mock is hoisted per test file).
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { type Mock, type MockInstance, vi } from 'vitest';
import type { DshHostLaunch } from '../DshHostProcess';
import { DshHostSupervisor, type DshPowerMonitor } from '../DshHostSupervisor';

export const FAKE_PID = 424242;
export const SELF_PID = 1000;

export const LAUNCH: DshHostLaunch = {
  command: '/fake/node',
  args: ['--expose-internals', '/fake/host.js'],
  cwd: '/fake/state/dsh-host-cwd',
  env: { DSH_HOME: '/fake/state/dsh-home', DSH_TELEMETRY_DISABLED: '1' },
  privateDirs: ['/fake/state/dsh-home', '/fake/state/dsh-host-cwd'],
};

export class FakeChild extends EventEmitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly sent: unknown[] = [];
  readonly send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
    this.sent.push(message);
    callback?.(null);
    return true;
  });
  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => true);

  constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  ready(pid: number | undefined = this.pid): void {
    this.emit('message', { type: 'ready', pid, node: 'v24.0.0' });
  }

  post(message: unknown): void {
    this.emit('message', message);
  }

  writeStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }

  die(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.connected = false;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  /** Messages that are not channel envelopes. */
  controls(): unknown[] {
    return this.sent.filter(
      (message) =>
        !(typeof message === 'object' && message !== null && 'ch' in message && 'rpc' in message)
    );
  }

  pings(): unknown[] {
    return this.sent.filter(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { host?: unknown }).host === 'ping'
    );
  }
}

export interface FakeHostHarness {
  supervisor: DshHostSupervisor;
  spawn: Mock<(command: string, args: readonly string[], options: SpawnOptions) => ChildProcess>;
  children: FakeChild[];
  child: () => FakeChild;
  monitor: EventEmitter;
  logLine: Mock<(line: string) => void>;
  prepareDirectories: Mock<(launch: DshHostLaunch) => void>;
}

export function createFakeHostHarness(
  options: {
    /** Pid per spawn, in order; later spawns get FAKE_PID + index. `undefined` = spawn failure. */
    pids?: Array<number | undefined>;
    selfPid?: number;
    resolveLaunch?: () => DshHostLaunch;
  } = {}
): FakeHostHarness {
  const children: FakeChild[] = [];
  const pids = options.pids ?? [];
  const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    const index = children.length;
    const child = new FakeChild(index < pids.length ? pids[index] : FAKE_PID + index);
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const monitor = new EventEmitter();
  const logLine = vi.fn((_line: string) => {});
  const prepareDirectories = vi.fn((_launch: DshHostLaunch) => {});
  const supervisor = new DshHostSupervisor({
    spawn,
    resolveLaunch: options.resolveLaunch ?? (() => LAUNCH),
    prepareDirectories,
    powerMonitor: () => monitor as unknown as DshPowerMonitor,
    // Fake timers move Date.now; vi.setSystemTime alone models a Main stall.
    now: () => Date.now(),
    logLine,
    selfPid: options.selfPid ?? SELF_PID,
  });
  return {
    supervisor,
    spawn,
    children,
    child: () => {
      const last = children.at(-1);
      if (!last) throw new Error('nothing spawned');
      return last;
    },
    monitor,
    logLine,
    prepareDirectories,
  };
}

/** Brings the harness's host to `ready` and returns its fake child. */
export async function startReadyHost(harness: FakeHostHarness): Promise<FakeChild> {
  const pending = harness.supervisor.ensureHost();
  const child = harness.child();
  child.ready();
  await pending;
  return child;
}

/** Drains promise chains without advancing fake time. */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Records how a promise settled, without awaiting it. */
export function settlement<T>(promise: Promise<T>): {
  settled: () => boolean;
  value: () => unknown;
} {
  let done = false;
  let outcome: unknown;
  promise.then(
    (value) => {
      done = true;
      outcome = value;
    },
    (error: unknown) => {
      done = true;
      outcome = error;
    }
  );
  return { settled: () => done, value: () => outcome };
}

/** Any real `process.kill` throws; the returned spy must end the test uncalled. */
export function installKillTripwire(): MockInstance {
  return vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('real process.kill is forbidden in these tests');
  });
}
