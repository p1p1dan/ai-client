/**
 * The one DSH host process of this app instance (dsh-rebase P1-3b; decisions
 * 019, 020, 025).
 *
 * Every chat session is a virtual slot: a `DshChannelTransport` over this
 * supervisor's single Node IPC link (protocol: `@shared/types/dshHostProtocol`).
 *
 * States: idle -> starting -> ready -> restarting | stopping; failed; disposed.
 *   starting    spawned; `ready` must arrive within 60 s from the pid we spawned
 *   ready       heartbeat every 5 s; no message for 20 s with two pings out is a hang
 *   restarting  the current host is being taken down (hang, lost IPC, restart())
 *   stopping    planned stop (app quit, idle, invalidate)
 *   failed      a host could not be confirmed gone; only a user action retries
 *   disposed    app quit; everything is refused
 *
 * Invariants:
 *   - At most one host process: nothing is spawned until the previous host's
 *     `exit` has been observed. A wedged host keeps its session locks, so a
 *     second one could not serve them anyway (P0-6).
 *   - The only signal ever sent is `child.kill('SIGKILL')` on the ChildProcess
 *     this supervisor spawned, after checking its pid. Never `process.kill`
 *     with a computed pid, never a process group (the kill(-1) incident).
 *   - A new host starts on demand only (`ensureHost`, `openChannel`,
 *     `restart`). A crash or a hang leaves the supervisor idle; WorkerManager's
 *     recovery batch asks for the one replacement (P1-3c).
 *   - Restart budget (decision 020 rule 4): crashes, hangs, lost IPC, failed
 *     starts and Stop ladder B restarts are counted over a sliding 5 min. Past
 *     three, an automatic request fails the supervisor (`DSH_HOST_UNAVAILABLE`);
 *     every user-initiated request may still start one host.
 *   - Idle stop (decision 025 rule 1, P1-3d): a ready host with no channel and
 *     no channel being opened for 10 min is stopped gracefully; the next
 *     channel starts a new one.
 *   - A host that died abnormally after it was ready may leave its tools
 *     running in systemd scopes; they are stopped before the next host starts
 *     (decision 075, `dshHostScopes.ts`).
 *
 * The host's stderr belongs to the host: redacted, logged line by line, kept
 * in a ring and replayed once at error level when the host dies. It never
 * becomes a session's `session.stderr`.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import {
  type DshChannelId,
  type DshHostChannelStatus,
  type DshHostGcResult,
  type DshHostPong,
  type DshMainToHostMessage,
  dshHostControlKind,
  formatDshChannelId,
  isDshChannelEnvelope,
  isDshHostChannelClosed,
  isDshHostFatal,
  isDshHostGcResult,
  isDshHostPong,
  isDshHostReady,
  isDshHostStopped,
} from '@shared/types/dshHostProtocol';
import { powerMonitor as electronPowerMonitor } from 'electron';
import { sanitizeStderrLine } from '../../../agent-host/stderrRedaction';
import { type DshChannelLink, DshChannelTransport } from './DshChannelTransport';
import {
  currentDshHostLaunch,
  type DshHostLaunch,
  dshHostSpawnOptions,
  prepareDshHostDirectories,
} from './DshHostProcess';
import { stopDeadHostScopes } from './dshHostScopes';
import { drainStderrLines, flushStderrPending, pushRecentStderr } from './hostStderr';

export const DSH_HOST_TIMINGS = {
  /** Spawn to a verified `ready`. */
  readyTimeoutMs: 60_000,
  heartbeatIntervalMs: 5_000,
  /** Silence (no message of any kind) after which the host is hung, given enough pings out. */
  hungAfterMs: 20_000,
  hungMinUnansweredPings: 2,
  /** A heartbeat tick later than this means Main itself stalled; that stretch is not billed to the host. */
  timerLateToleranceMs: 1_000,
  /** `{type:'shutdown'}` to exit: dispose plus host.ts's own forced exit 3 s later. */
  gracefulStopMs: 3_500,
  /** After `stopped` everything is persisted; a host still lingering this much later is killed. */
  stoppedExitGraceMs: 500,
  /** SIGKILL to `exit`; past this the host is presumed unkillable and no successor may start. */
  exitAfterKillMs: 5_000,
  /** How long a dead host's stderr may keep draining before its replay is written. */
  stderrTailMs: 1_000,
  slowPongWarnMs: 2_000,
  eventLoopDelayWarnMs: 200,
  /** Minimum spacing between repeated warnings of one kind. */
  warnIntervalMs: 60_000,
  /** Decision 025 rule 1: this long with no channel stops the host (about 180 MB). */
  idleStopMs: 10 * 60_000,
  /** The longest a new host waits for the dead one's scopes to stop (decision 075). */
  scopeStopWaitMs: 6_000,
  /** A `gc` pass (decision 024) not answered in this long is given up on. */
  gcTimeoutMs: 120_000,
} as const;

/**
 * Decision 020 rule 4: automatic host replacements allowed per sliding window.
 * The fourth budgeted exit inside the window leaves the host down until a user
 * action asks for it.
 */
export const DSH_HOST_RESTART_BUDGET = { restarts: 3, windowMs: 5 * 60_000 } as const;

/** Unacked ping ids kept for round-trip timing. */
const MAX_TRACKED_PINGS = 8;

/**
 * Channel ids remembered after their `closed`. The host answers every
 * `close`, so a channel its own `worker.dispose` already closed can hear a
 * second `closed` when the slot's close crossed it on the wire.
 */
const RECENTLY_CLOSED_KEPT = 64;

export type DshHostSupervisorState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'stopping'
  | 'failed'
  | 'disposed';

export type DshHostSupervisorErrorCode =
  | 'DSH_HOST_START_FAILED'
  | 'DSH_HOST_START_TIMEOUT'
  | 'DSH_HOST_PID_MISMATCH'
  | 'DSH_HOST_EXIT_UNCONFIRMED'
  | 'DSH_HOST_STOPPED'
  | 'DSH_HOST_DISPOSED'
  | 'DSH_HOST_UNAVAILABLE';

export class DshHostSupervisorError extends Error {
  constructor(
    readonly code: DshHostSupervisorErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'DshHostSupervisorError';
  }
}

/**
 * Restarts Main asks for. `stuck-session` is Stop ladder B (decision 021);
 * `user` is the session_locked card's "Restart engine"; `config` is P1-10's.
 */
export type DshHostRestartReason = 'stuck-session' | 'config' | 'user';

/** Planned stops. Only `app-quit` is terminal (decision 025). */
export type DshHostShutdownReason = 'app-quit' | 'idle' | 'invalidate';

export type DshHostExitReason =
  | 'crashed'
  | 'start-failed'
  | 'hung'
  | 'disconnected'
  | 'force-kill'
  | DshHostRestartReason
  | DshHostShutdownReason;

/** Reasons that are routine lifecycle, not faults: no stderr replay when the host exits. */
const QUIET_EXIT_REASONS: ReadonlySet<DshHostExitReason> = new Set([
  'app-quit',
  'idle',
  'invalidate',
  'config',
  'user',
  'force-kill',
]);

/**
 * Exits that spend the restart budget: faults, and ladder B, which only runs
 * because a session wedged the host (decision 020 rule 4).
 */
const BUDGETED_EXIT_REASONS: ReadonlySet<DshHostExitReason> = new Set([
  'crashed',
  'start-failed',
  'hung',
  'disconnected',
  'stuck-session',
]);

const PLANNED_RESTART_REASONS: ReadonlySet<DshHostExitReason> = new Set<DshHostExitReason>([
  'stuck-session',
  'config',
  'user',
]);

/** A host Main itself restarted: its sessions were interrupted gracefully, not by a crash. */
export function isPlannedHostRestart(reason: DshHostExitReason | undefined): boolean {
  return reason !== undefined && PLANNED_RESTART_REASONS.has(reason);
}

export interface DshHostInfo {
  generation: number;
  pid: number;
}

export interface DshHostEnsureOptions {
  /** A user's create / resume / retry: the one kind of request allowed to leave `failed`. */
  userInitiated?: boolean;
}

export interface DshHostPongRecord {
  at: number;
  rttMs?: number;
  eldMaxMs: number;
  rssMb: number;
  channels: DshHostChannelStatus[];
}

export interface DshHostExitRecord {
  generation: number;
  pid?: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: DshHostExitReason;
  at: number;
}

export interface DshHostSupervisorStatus {
  state: DshHostSupervisorState;
  /** Hosts spawned so far; also the live (or last) host's generation. */
  generation: number;
  /** The live host's pid, until its exit is observed. */
  pid?: number;
  channels: number;
  readyAt?: number;
  lastPong?: DshHostPongRecord;
  lastExit?: DshHostExitRecord;
  /** Budgeted exits inside the current restart window (decision 020 rule 4). */
  recentFaults: number;
  failure?: { code: DshHostSupervisorErrorCode; message: string };
}

export interface DshPowerMonitor {
  on(event: 'resume', listener: () => void): unknown;
  removeListener(event: 'resume', listener: () => void): unknown;
}

export type DshHostSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface DshHostSupervisorOptions {
  spawn?: DshHostSpawn;
  resolveLaunch?: () => DshHostLaunch;
  prepareDirectories?: (launch: DshHostLaunch) => void;
  /** Resolved at the first start (Electron's powerMonitor needs a ready app). */
  powerMonitor?: () => DshPowerMonitor | null;
  /** Monotonic milliseconds. */
  now?: () => number;
  /** Sink for each redacted stderr line of the host. */
  logLine?: (line: string) => void;
  /** This process; a child reporting this pid is never signalled. */
  selfPid?: number;
  /** Stops the systemd scopes a dead host left (decision 075); `null` never does. */
  stopOrphanScopes?: ((pid: number) => Promise<unknown>) | null;
  /** Overrides `DSH_HOST_TIMINGS.idleStopMs`; 0 never stops an idle host. */
  idleStopMs?: number;
}

/** What `collectSessions` asks the host to keep; see `DshHostGcRequest`. */
export interface DshHostGcRequestInput {
  claimed: readonly string[];
  graceMs: number;
}

interface PendingGc {
  readonly host: HostRecord;
  readonly resolve: (result: DshHostGcResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface HostRecord {
  readonly generation: number;
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  readonly ready: Promise<DshHostInfo>;
  readonly resolveReady: (info: DshHostInfo) => void;
  readonly rejectReady: (error: Error) => void;
  readySettled: boolean;
  readyTimer: NodeJS.Timeout | null;
  handshakePid?: number;
  readyAt?: number;
  connected: boolean;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
  readonly exited: Promise<void>;
  readonly resolveExited: () => void;
  readonly stopped: Promise<void>;
  readonly resolveStopped: () => void;
  closed: boolean;
  spawnError?: Error;
  stopReason?: DshHostExitReason;
  replayOnExit: boolean;
  takedown: Promise<boolean> | null;
  sigkillSent: boolean;
  tickTimer: NodeJS.Timeout | null;
  tickDueAt: number;
  lastHeardAt: number;
  unansweredPings: number;
  pingSequence: number;
  readonly pingsSentAt: Map<number, number>;
  lastPong?: DshHostPongRecord;
  stderrPending: string;
  stderrDropped: number;
  recentStderr: string[];
  stderrReplayed: boolean;
  stderrReplayScheduled: boolean;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Only a real child pid may be signalled: never 0, 1, a negative (group) pid, or ourselves. */
function isSignallablePid(pid: number | undefined, selfPid: number): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 1 && pid !== selfPid;
}

export class DshHostSupervisor {
  private readonly spawnHost: DshHostSpawn;
  private readonly resolveLaunch: () => DshHostLaunch;
  private readonly prepareDirectories: (launch: DshHostLaunch) => void;
  private readonly resolvePowerMonitor: () => DshPowerMonitor | null;
  private readonly now: () => number;
  private readonly logLine: (line: string) => void;
  private readonly selfPid: number;
  private readonly stopOrphanScopes: ((pid: number) => Promise<unknown>) | null;
  private readonly idleStopMs: number;

  private state: DshHostSupervisorState = 'idle';
  private host: HostRecord | null = null;
  private spawnCount = 0;
  private channelSequence = 0;
  private readonly channels = new Map<DshChannelId, DshChannelTransport>();
  private readonly recentlyClosed = new Set<DshChannelId>();
  private startTask: Promise<DshHostInfo> | null = null;
  private takedownTask: Promise<boolean> | null = null;
  private restartTask: Promise<DshHostInfo> | null = null;
  private stopTask: Promise<void> | null = null;
  private terminal = false;
  private failure: DshHostSupervisorError | null = null;
  private lastExit: DshHostExitRecord | null = null;
  /** When each budgeted exit happened, oldest first; pruned to the window on read. */
  private budgetedExits: number[] = [];
  private powerMonitor: DshPowerMonitor | null = null;
  private readonly lastWarnAt = new Map<string, number>();
  /** `openChannel` calls in flight: a host about to get a channel is not idle. */
  private pendingOpens = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** The dead host's scopes being stopped; the next start waits for it (decision 075). */
  private scopeCleanup: Promise<void> | null = null;
  private gcSequence = 0;
  private readonly pendingGc = new Map<number, PendingGc>();

  private readonly channelLink: DshChannelLink = {
    send: (ch, rpc, onError) => {
      const host = this.host;
      if (!host || !this.channels.has(ch) || !host.connected || host.exitInfo) {
        throw new DshHostSupervisorError(
          'DSH_HOST_UNAVAILABLE',
          `the DSH host cannot take messages for channel ${ch}`
        );
      }
      const envelope: DshMainToHostMessage = { ch, rpc };
      host.child.send(envelope, (error) => {
        if (error) onError(error);
      });
    },
    close: (ch) => {
      const host = this.host;
      if (host && this.channels.has(ch)) this.sendControl(host, { host: 'close', ch });
    },
  };

  private readonly onSystemResume = (): void => this.notifySystemResume();

  constructor(options: DshHostSupervisorOptions = {}) {
    this.spawnHost = options.spawn ?? nodeSpawn;
    this.resolveLaunch = options.resolveLaunch ?? (() => currentDshHostLaunch());
    this.prepareDirectories = options.prepareDirectories ?? prepareDshHostDirectories;
    this.resolvePowerMonitor = options.powerMonitor ?? (() => electronPowerMonitor);
    this.now = options.now ?? (() => performance.now());
    this.logLine = options.logLine ?? ((line) => console.info(line));
    this.selfPid = options.selfPid ?? process.pid;
    this.stopOrphanScopes =
      options.stopOrphanScopes === undefined
        ? (pid) => stopDeadHostScopes(pid)
        : options.stopOrphanScopes;
    this.idleStopMs = options.idleStopMs ?? DSH_HOST_TIMINGS.idleStopMs;
  }

  status(): DshHostSupervisorStatus {
    const host = this.host;
    const live = host && !host.exitInfo ? host : null;
    return {
      state: this.state,
      generation: this.spawnCount,
      ...(live?.pid !== undefined ? { pid: live.pid } : {}),
      channels: this.channels.size,
      ...(live?.readyAt !== undefined ? { readyAt: live.readyAt } : {}),
      ...(host?.lastPong ? { lastPong: { ...host.lastPong } } : {}),
      ...(this.lastExit ? { lastExit: { ...this.lastExit } } : {}),
      recentFaults: this.recentFaults(),
      ...(this.failure
        ? { failure: { code: this.failure.code, message: this.failure.message } }
        : {}),
    };
  }

  /** Resolves once a host is ready; concurrent callers share one start. */
  async ensureHost(options: DshHostEnsureOptions = {}): Promise<DshHostInfo> {
    for (;;) {
      const host = this.host;
      if (this.state === 'ready' && host) return this.infoOf(host);
      if (this.state === 'disposed') throw this.disposedError();
      if (this.state === 'starting' && this.startTask) return this.startTask;
      if (this.state === 'restarting' && this.takedownTask) {
        await this.takedownTask;
        continue;
      }
      if (this.state === 'stopping' && this.stopTask) {
        await this.stopTask;
        continue;
      }
      if (this.state === 'failed') {
        if (!options.userInitiated) {
          throw this.failure ?? new DshHostSupervisorError('DSH_HOST_UNAVAILABLE', 'host failed');
        }
        if (host && !host.exitInfo) throw this.exitUnconfirmedError(host);
      }
      if (!options.userInitiated) {
        const faults = this.recentFaults();
        if (faults > DSH_HOST_RESTART_BUDGET.restarts) {
          const error = new DshHostSupervisorError(
            'DSH_HOST_UNAVAILABLE',
            `the DSH host went down ${faults} times within ${DSH_HOST_RESTART_BUDGET.windowMs / 60_000} min; ` +
              'it starts again only for a user action'
          );
          this.fail(error);
          throw error;
        }
      }
      return this.start();
    }
  }

  /** A fresh channel on a ready host. Ids are never reused, across hosts included. */
  async openChannel(options: DshHostEnsureOptions = {}): Promise<DshChannelTransport> {
    // A host about to get a channel is not idle, however long its start takes.
    this.pendingOpens += 1;
    this.disarmIdleStop();
    try {
      const info = await this.ensureHost(options);
      const host = this.host;
      if (this.state !== 'ready' || !host || host.generation !== info.generation) {
        throw new DshHostSupervisorError(
          'DSH_HOST_UNAVAILABLE',
          'the DSH host went away while a channel was being opened'
        );
      }
      const ch = formatDshChannelId(host.generation, ++this.channelSequence);
      const channel = new DshChannelTransport(ch, host.pid, this.channelLink);
      this.channels.set(ch, channel);
      return channel;
    } finally {
      this.pendingOpens -= 1;
      this.armIdleStop();
    }
  }

  /**
   * Decision 024: one orphan collection pass on the ready host. Resolves with
   * its `gc-result`; rejects when no host is ready, when the host goes away
   * first, or after `gcTimeoutMs` without an answer.
   */
  collectSessions(request: DshHostGcRequestInput): Promise<DshHostGcResult> {
    const host = this.host;
    if (this.state !== 'ready' || !host || host.exitInfo || !host.connected) {
      return Promise.reject(
        new DshHostSupervisorError(
          'DSH_HOST_UNAVAILABLE',
          'no ready DSH host to collect sessions on'
        )
      );
    }
    const id = ++this.gcSequence;
    return new Promise<DshHostGcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingGc.delete(id);
        reject(
          new DshHostSupervisorError(
            'DSH_HOST_UNAVAILABLE',
            `gc ${id} was not answered within ${DSH_HOST_TIMINGS.gcTimeoutMs}ms`
          )
        );
      }, DSH_HOST_TIMINGS.gcTimeoutMs);
      timer.unref?.();
      this.pendingGc.set(id, { host, resolve, reject, timer });
      const sent = this.sendControl(host, {
        host: 'gc',
        id,
        claimed: [...request.claimed],
        graceMs: request.graceMs,
      });
      if (!sent) {
        this.settleGc(id)?.reject(
          new DshHostSupervisorError('DSH_HOST_UNAVAILABLE', 'the gc request could not be sent')
        );
      }
    });
  }

  /**
   * Replace the host: graceful stop (3.5 s), SIGKILL if it lingers, then one
   * new host once the old one's exit is confirmed. Single flight. A
   * `stuck-session` restart spends the budget and may therefore end `failed`;
   * a user's restart passes `userInitiated` and is never refused by it.
   */
  restart(reason: DshHostRestartReason, options: DshHostEnsureOptions = {}): Promise<DshHostInfo> {
    if (this.restartTask) return this.restartTask;
    const host = this.host;
    if (this.state === 'ready' && host) void this.beginTakedown(host, 'graceful', reason);
    const task = this.ensureHost(options);
    this.restartTask = task;
    const clear = () => {
      if (this.restartTask === task) this.restartTask = null;
    };
    task.then(clear, clear);
    return task;
  }

  /**
   * Planned stop: `{type:'shutdown'}`, SIGKILL after 3.5 s, then wait for the
   * exit. `app-quit` leaves the supervisor disposed; the others leave it idle
   * for the next `ensureHost`.
   */
  shutdown(reason: DshHostShutdownReason): Promise<void> {
    if (reason === 'app-quit') this.terminal = true;
    if (this.state === 'disposed') return Promise.resolve();
    if (this.stopTask) return this.stopTask;
    const task = this.runStop(reason);
    this.stopTask = task;
    const clear = () => {
      if (this.stopTask === task) this.stopTask = null;
    };
    task.then(clear, clear);
    return task;
  }

  /** Signal and deadline path: SIGKILL the host now, synchronously; idempotent and terminal. */
  forceKillNow(): boolean {
    this.terminal = true;
    const host = this.host;
    let killed = true;
    if (host && !host.exitInfo) {
      this.markStopping(host, 'force-kill');
      this.stopHeartbeat(host);
      this.abandonStart(host, this.disposedError());
      killed = this.hardKill(host);
    }
    this.dispose();
    return killed;
  }

  /** The system woke from sleep: both processes were frozen, so the gap is nobody's silence. */
  notifySystemResume(): void {
    const host = this.host;
    if (!host || this.state !== 'ready' || host.exitInfo) return;
    host.lastHeardAt = this.now();
    host.unansweredPings = 0;
    this.scheduleTick(host);
  }

  // ---- start ------------------------------------------------------------------

  private start(): Promise<DshHostInfo> {
    const previous = this.host;
    if (previous && !previous.exitInfo) {
      return Promise.reject(this.exitUnconfirmedError(previous));
    }
    this.failure = null;
    this.setState('starting');
    const cleanup = this.scopeCleanup;
    this.scopeCleanup = null;
    const task = cleanup ? this.launchAfter(cleanup) : this.launch();
    this.startTask = task;
    const clear = () => {
      if (this.startTask === task) this.startTask = null;
    };
    task.then(clear, clear);
    return task;
  }

  /** Decision 075: the dead host's tools stop before the next host starts, within a bound. */
  private async launchAfter(cleanup: Promise<void>): Promise<DshHostInfo> {
    let timer: NodeJS.Timeout | null = null;
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DSH_HOST_TIMINGS.scopeStopWaitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    // A stop or a force kill may have taken over while the scopes were stopped.
    if (this.state !== 'starting') {
      throw this.terminal ? this.disposedError() : this.stoppedError();
    }
    return this.launch();
  }

  private async launch(): Promise<DshHostInfo> {
    let child: ChildProcess;
    try {
      const launch = this.resolveLaunch();
      this.prepareDirectories(launch);
      this.subscribePowerMonitor();
      child = this.spawnHost(launch.command, launch.args, dshHostSpawnOptions(launch));
    } catch (error) {
      if (this.state === 'starting') this.setState('idle');
      throw error instanceof Error ? error : new Error(String(error));
    }
    const host = this.attach(child, ++this.spawnCount);
    this.host = host;
    return host.ready;
  }

  private attach(child: ChildProcess, generation: number): HostRecord {
    const ready = deferred<DshHostInfo>();
    // Awaited by callers; a start nobody waits for must not surface as unhandled.
    ready.promise.catch(() => {});
    const exited = deferred<void>();
    const stopped = deferred<void>();
    const now = this.now();
    const host: HostRecord = {
      generation,
      child,
      pid: child.pid,
      ready: ready.promise,
      resolveReady: ready.resolve,
      rejectReady: ready.reject,
      readySettled: false,
      readyTimer: null,
      connected: child.connected !== false,
      exitInfo: null,
      exited: exited.promise,
      resolveExited: () => exited.resolve(),
      stopped: stopped.promise,
      resolveStopped: () => stopped.resolve(),
      closed: false,
      replayOnExit: true,
      takedown: null,
      sigkillSent: false,
      tickTimer: null,
      tickDueAt: now,
      lastHeardAt: now,
      unansweredPings: 0,
      pingSequence: 0,
      pingsSentAt: new Map(),
      stderrPending: '',
      stderrDropped: 0,
      recentStderr: [],
      stderrReplayed: false,
      stderrReplayScheduled: false,
    };
    child.on('message', (message: unknown) => this.onHostMessage(host, message));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
      this.onHostExit(host, code, signal)
    );
    child.on('close', () => {
      host.closed = true;
    });
    child.on('error', (error: Error) => this.onHostError(host, error));
    child.on('disconnect', () => this.onHostDisconnect(host));
    // RPC is IPC only; drain stdout so tool or plugin output cannot fill its pipe.
    child.stdout?.on('error', () => {});
    child.stdout?.resume();
    child.stderr?.on('error', () => {});
    // Decode as a stream so a multi-byte character split across chunks survives.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: Buffer | string) => this.absorbStderr(host, String(chunk)));
    host.readyTimer = setTimeout(() => {
      this.failStart(
        host,
        new DshHostSupervisorError(
          'DSH_HOST_START_TIMEOUT',
          `no ready from the DSH host within ${DSH_HOST_TIMINGS.readyTimeoutMs}ms`
        )
      );
    }, DSH_HOST_TIMINGS.readyTimeoutMs);
    host.readyTimer.unref?.();
    return host;
  }

  private onReady(host: HostRecord, message: Record<string, unknown>): void {
    if (host.readySettled) {
      this.warnRateLimited('duplicate-ready', `[dsh-host:g${host.generation}] duplicate ready`);
      return;
    }
    if (!isDshHostReady(message) || message.pid !== host.pid) {
      this.failStart(
        host,
        new DshHostSupervisorError(
          'DSH_HOST_PID_MISMATCH',
          `ready reported pid ${String(message.pid)}, but the spawned host is pid ${host.pid}`
        )
      );
      return;
    }
    host.readySettled = true;
    this.clearReadyTimer(host);
    host.handshakePid = message.pid;
    host.readyAt = this.now();
    if (this.host !== host || this.state !== 'starting') {
      host.rejectReady(this.stoppedError());
      return;
    }
    this.setState('ready');
    this.startHeartbeat(host);
    host.resolveReady(this.infoOf(host));
    this.armIdleStop();
  }

  /** Settles a failed start once the process is confirmed gone (or presumed unkillable). */
  private failStart(host: HostRecord, error: DshHostSupervisorError): void {
    if (host.readySettled) return;
    host.readySettled = true;
    this.clearReadyTimer(host);
    this.markStopping(host, 'start-failed');
    // Replayed below with the cause, instead of by the exit handler.
    host.replayOnExit = false;
    void this.confirmGone(host).then((gone) => {
      const outcome = gone ? error : this.exitUnconfirmedError(host);
      this.scheduleStderrReplay(host, `failed to start (${error.message})`);
      if (this.host === host && this.state === 'starting') {
        if (gone) this.setState('idle');
        else this.fail(outcome);
      }
      host.rejectReady(outcome);
    });
  }

  /** A stop or kill took over a start still in flight. */
  private abandonStart(host: HostRecord, error: DshHostSupervisorError): void {
    if (host.readySettled) return;
    host.readySettled = true;
    this.clearReadyTimer(host);
    host.rejectReady(error);
  }

  // ---- messages from the host -------------------------------------------------

  private onHostMessage(host: HostRecord, message: unknown): void {
    if (host.exitInfo) return;
    // Any message proves the event loop is alive; session traffic included.
    host.lastHeardAt = this.now();
    host.unansweredPings = 0;
    if (isDshChannelEnvelope(message)) {
      const channel = this.host === host ? this.channels.get(message.ch) : undefined;
      if (channel) channel.dispatchMessage(message.rpc);
      else
        this.warnRateLimited('stale-channel', `[dsh-host] dropped RPC for channel ${message.ch}`);
      return;
    }
    if (isDshHostPong(message)) {
      this.onPong(host, message);
      return;
    }
    if (isDshHostChannelClosed(message)) {
      this.onChannelClosed(host, message.ch);
      return;
    }
    if (isDshHostGcResult(message)) {
      const pending = this.pendingGc.get(message.id);
      if (pending?.host === host) this.settleGc(message.id)?.resolve(message);
      else this.warnRateLimited('stale-gc', `[dsh-host] dropped gc-result ${message.id}`);
      return;
    }
    const record =
      typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : null;
    if (record?.type === 'ready') {
      this.onReady(host, record);
      return;
    }
    if (isDshHostFatal(message)) {
      const reason = message.message ?? 'no reason given';
      if (!host.readySettled) {
        this.failStart(
          host,
          new DshHostSupervisorError(
            'DSH_HOST_START_FAILED',
            `the DSH host refused to start: ${reason}`
          )
        );
      } else {
        console.error(`[dsh-host:g${host.generation}] fatal: ${reason}`);
      }
      return;
    }
    if (isDshHostStopped(message)) {
      host.resolveStopped();
      return;
    }
    const kind =
      dshHostControlKind(message) ??
      (typeof record?.type === 'string' ? `type:${record.type}` : typeof message);
    this.warnRateLimited(`unknown:${kind}`, `[dsh-host] dropped an unrecognized message (${kind})`);
  }

  private onPong(host: HostRecord, pong: DshHostPong): void {
    const sentAt = host.pingsSentAt.get(pong.id);
    for (const id of [...host.pingsSentAt.keys()]) {
      if (id <= pong.id) host.pingsSentAt.delete(id);
    }
    const at = this.now();
    const rttMs = sentAt === undefined ? undefined : at - sentAt;
    host.lastPong = {
      at,
      ...(rttMs !== undefined ? { rttMs } : {}),
      eldMaxMs: pong.eldMaxMs,
      rssMb: pong.rssMb,
      channels: pong.channels.map((channel) => ({ ch: channel.ch, busy: channel.busy })),
    };
    const detail = `${this.channels.size} channel(s), rss ${pong.rssMb} MB`;
    if (rttMs !== undefined && rttMs > DSH_HOST_TIMINGS.slowPongWarnMs) {
      this.warnRateLimited(
        'slow-pong',
        `[dsh-host:g${host.generation}] pong took ${Math.round(rttMs)}ms (${detail})`
      );
    }
    if (pong.eldMaxMs > DSH_HOST_TIMINGS.eventLoopDelayWarnMs) {
      this.warnRateLimited(
        'event-loop-delay',
        `[dsh-host:g${host.generation}] event loop blocked up to ${pong.eldMaxMs}ms (${detail})`
      );
    }
  }

  private onChannelClosed(host: HostRecord, ch: DshChannelId): void {
    const channel = this.host === host ? this.channels.get(ch) : undefined;
    if (!channel) {
      if (!this.recentlyClosed.has(ch)) {
        this.warnRateLimited('stale-closed', `[dsh-host] closed for unknown channel ${ch}`);
      }
      return;
    }
    this.channels.delete(ch);
    this.recentlyClosed.add(ch);
    if (this.recentlyClosed.size > RECENTLY_CLOSED_KEPT) {
      const oldest = this.recentlyClosed.values().next().value;
      if (oldest !== undefined) this.recentlyClosed.delete(oldest);
    }
    channel.dispatchExit({ code: 0, signal: null, cause: 'channel-closed' });
    this.armIdleStop();
  }

  // ---- process events -----------------------------------------------------------

  private onHostExit(host: HostRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (host.exitInfo) return;
    host.exitInfo = { code, signal };
    host.connected = false;
    this.stopHeartbeat(host);
    let reason: DshHostExitReason =
      host.stopReason ?? (host.readyAt === undefined ? 'start-failed' : 'crashed');
    // A host that dies drops its IPC before Node reports the exit (P1-3a, seen
    // on SIGKILL): an abnormal exit we did not force after that drop is a crash.
    if (reason === 'disconnected' && !host.sigkillSent && (signal !== null || code !== 0)) {
      reason = 'crashed';
    }
    this.lastExit = {
      generation: host.generation,
      ...(host.pid !== undefined ? { pid: host.pid } : {}),
      code,
      signal,
      reason,
      at: this.now(),
    };
    if (BUDGETED_EXIT_REASONS.has(reason)) this.budgetedExits.push(this.lastExit.at);
    // Set before anything below can ask for the next host (decision 075). A
    // clean exit (code 0) went through DSH's own teardown, which ends its
    // scopes; a host that never got ready never ran a tool.
    if (
      this.stopOrphanScopes &&
      host.readyAt !== undefined &&
      host.pid !== undefined &&
      (signal !== null || code !== 0)
    ) {
      this.scopeCleanup = this.stopScopesOf(this.stopOrphanScopes, host.pid);
    }
    this.rejectGc(host);
    host.resolveExited();
    const channels = this.host === host ? this.takeChannels() : [];
    if (!host.readySettled) {
      this.failStart(
        host,
        new DshHostSupervisorError(
          'DSH_HOST_START_FAILED',
          host.spawnError
            ? `could not spawn the DSH host: ${host.spawnError.message}`
            : `the DSH host exited before ready (code=${code} signal=${signal})`
        )
      );
    } else {
      if (reason === 'crashed') {
        console.error(
          `[dsh-host:g${host.generation}] pid ${host.pid} exited unexpectedly (code=${code} signal=${signal})`
        );
      }
      if (host.replayOnExit) {
        this.scheduleStderrReplay(host, `${reason} (code=${code} signal=${signal})`);
      }
      if (this.host === host && this.state === 'ready') this.setState('idle');
    }
    for (const channel of channels) channel.dispatchExit({ code, signal, cause: 'host-exit' });
  }

  private onHostError(host: HostRecord, error: Error): void {
    if (host.exitInfo) return;
    if (host.pid === undefined) {
      // The spawn produced no process: there is nothing to signal or wait for.
      host.spawnError = error;
      this.onHostExit(host, null, null);
      return;
    }
    this.warnRateLimited(
      `process-error:${host.generation}`,
      `[dsh-host:g${host.generation}] process error: ${error.message}`
    );
  }

  /** host.ts stops itself when IPC drops; it gets the graceful budget to exit before SIGKILL. */
  private onHostDisconnect(host: HostRecord): void {
    host.connected = false;
    if (host.exitInfo || host.takedown) return;
    if (!host.readySettled) {
      this.failStart(
        host,
        new DshHostSupervisorError(
          'DSH_HOST_START_FAILED',
          'the DSH host closed its IPC channel before ready'
        )
      );
      return;
    }
    if (this.host === host && this.state === 'ready') {
      console.error(`[dsh-host:g${host.generation}] pid ${host.pid} closed its IPC channel`);
      void this.beginTakedown(host, 'graceful', 'disconnected');
    }
  }

  // ---- heartbeat ------------------------------------------------------------------

  private startHeartbeat(host: HostRecord): void {
    host.lastHeardAt = this.now();
    host.unansweredPings = 0;
    this.scheduleTick(host);
  }

  private scheduleTick(host: HostRecord): void {
    this.stopHeartbeat(host);
    host.tickDueAt = this.now() + DSH_HOST_TIMINGS.heartbeatIntervalMs;
    host.tickTimer = setTimeout(() => this.onTick(host), DSH_HOST_TIMINGS.heartbeatIntervalMs);
    host.tickTimer.unref?.();
  }

  private stopHeartbeat(host: HostRecord): void {
    if (host.tickTimer) clearTimeout(host.tickTimer);
    host.tickTimer = null;
  }

  private onTick(host: HostRecord): void {
    host.tickTimer = null;
    if (this.host !== host || this.state !== 'ready' || host.exitInfo) return;
    const now = this.now();
    const late = now - host.tickDueAt;
    if (late > DSH_HOST_TIMINGS.timerLateToleranceMs) {
      // Main itself stalled (busy loop, paging, a clock that ran through sleep):
      // the host's replies may still sit unread in the pipe, so the stall is not
      // counted as the host's silence.
      host.lastHeardAt = Math.min(now, host.lastHeardAt + late);
    }
    const silence = now - host.lastHeardAt;
    if (
      silence >= DSH_HOST_TIMINGS.hungAfterMs &&
      host.unansweredPings >= DSH_HOST_TIMINGS.hungMinUnansweredPings
    ) {
      console.error(
        `[dsh-host:g${host.generation}] pid ${host.pid} sent nothing for ${Math.round(silence)}ms ` +
          `with ${host.unansweredPings} pings unanswered; killing it`
      );
      void this.beginTakedown(host, 'hard', 'hung');
      return;
    }
    this.sendPing(host);
    this.scheduleTick(host);
  }

  private sendPing(host: HostRecord): void {
    const id = ++host.pingSequence;
    host.pingsSentAt.set(id, this.now());
    if (host.pingsSentAt.size > MAX_TRACKED_PINGS) {
      const oldest = host.pingsSentAt.keys().next().value;
      if (oldest !== undefined) host.pingsSentAt.delete(oldest);
    }
    host.unansweredPings += 1;
    this.sendControl(host, { host: 'ping', id });
  }

  // ---- taking a host down -----------------------------------------------------------

  private markStopping(host: HostRecord, reason: DshHostExitReason): void {
    if (host.stopReason !== undefined) return;
    host.stopReason = reason;
    host.replayOnExit = !QUIET_EXIT_REASONS.has(reason);
  }

  /** Takes the current host down under `restarting`; ends idle, or failed if it will not die. */
  private beginTakedown(
    host: HostRecord,
    mode: 'graceful' | 'hard',
    reason: DshHostExitReason
  ): Promise<boolean> {
    this.markStopping(host, reason);
    this.stopHeartbeat(host);
    this.setState('restarting');
    const task = this.takeDown(host, mode).then((gone) => {
      if (this.takedownTask === task) this.takedownTask = null;
      if (this.host === host && this.state === 'restarting') {
        if (gone) this.setState('idle');
        else this.fail(this.exitUnconfirmedError(host));
      }
      return gone;
    });
    this.takedownTask = task;
    return task;
  }

  /** Resolves true once `exit` is observed, false if it never came. One takedown per host. */
  private takeDown(host: HostRecord, mode: 'graceful' | 'hard'): Promise<boolean> {
    // A hard request escalates a graceful takedown already under way.
    if (mode === 'hard') this.hardKill(host);
    if (host.takedown) return host.takedown;
    host.takedown = (async () => {
      if (host.exitInfo) return true;
      if (mode === 'graceful') {
        this.sendControl(host, { type: 'shutdown' });
        if (await this.waitForGracefulExit(host)) return true;
      }
      return this.confirmGone(host);
    })();
    return host.takedown;
  }

  private waitForGracefulExit(host: HostRecord): Promise<boolean> {
    if (host.exitInfo) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (gone: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(gone);
      };
      const arm = (ms: number) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => finish(host.exitInfo !== null), ms);
        timer.unref?.();
      };
      arm(DSH_HOST_TIMINGS.gracefulStopMs);
      void host.exited.then(() => finish(true));
      // Everything is disposed and persisted; waiting out host.ts's linger buys nothing.
      void host.stopped.then(() => {
        if (!settled) arm(DSH_HOST_TIMINGS.stoppedExitGraceMs);
      });
    });
  }

  /** SIGKILL unless already gone, then wait up to 5 s for `exit`. */
  private confirmGone(host: HostRecord): Promise<boolean> {
    if (host.exitInfo) return Promise.resolve(true);
    this.hardKill(host);
    return this.waitForExit(host, DSH_HOST_TIMINGS.exitAfterKillMs);
  }

  private waitForExit(host: HostRecord, ms: number): Promise<boolean> {
    if (host.exitInfo) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
      void host.exited.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * The one place a signal is sent: SIGKILL on the exact ChildProcess we
   * spawned, whose pid is plausible and matches the handshake. Returns false
   * when the kill is refused or fails; the caller still waits for `exit`.
   */
  private hardKill(host: HostRecord): boolean {
    const child = host.child;
    if (host.exitInfo || child.exitCode !== null || child.signalCode !== null) return true;
    if (host.sigkillSent) return true;
    const pid = child.pid;
    if (
      !isSignallablePid(pid, this.selfPid) ||
      pid !== host.pid ||
      (host.handshakePid !== undefined && pid !== host.handshakePid)
    ) {
      console.error(
        `[dsh-host:g${host.generation}] refusing to signal pid ${String(pid)} ` +
          `(spawned ${String(host.pid)}, handshake ${String(host.handshakePid)})`
      );
      return false;
    }
    host.sigkillSent = true;
    try {
      child.kill('SIGKILL');
      return true;
    } catch (error) {
      console.error(`[dsh-host:g${host.generation}] SIGKILL failed: ${errorMessage(error)}`);
      return false;
    }
  }

  private async runStop(reason: DshHostShutdownReason): Promise<void> {
    const host = this.host;
    this.setState('stopping');
    if (host && !host.exitInfo) {
      this.markStopping(host, reason);
      this.stopHeartbeat(host);
      this.abandonStart(host, this.terminal ? this.disposedError() : this.stoppedError());
      const gone = await this.takeDown(host, host.readyAt !== undefined ? 'graceful' : 'hard');
      if (!gone) {
        const error = this.exitUnconfirmedError(host);
        console.error(`[dsh-host:g${host.generation}] ${error.message}`);
        if (!this.terminal) {
          this.fail(error);
          return;
        }
      }
    }
    if (this.terminal) this.dispose();
    else this.setState('idle');
  }

  private dispose(): void {
    this.setState('disposed');
    if (this.host) this.stopHeartbeat(this.host);
    this.disarmIdleStop();
    this.powerMonitor?.removeListener('resume', this.onSystemResume);
    this.powerMonitor = null;
  }

  // ---- idle stop (decision 025 rule 1) ---------------------------------------------

  private armIdleStop(): void {
    if (this.idleTimer || this.idleStopMs <= 0 || !this.isIdle()) return;
    this.idleTimer = setTimeout(() => this.onIdle(), this.idleStopMs);
    this.idleTimer.unref?.();
  }

  private disarmIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private isIdle(): boolean {
    return (
      !this.terminal &&
      this.state === 'ready' &&
      this.host !== null &&
      this.channels.size === 0 &&
      this.pendingOpens === 0
    );
  }

  private onIdle(): void {
    this.idleTimer = null;
    const host = this.host;
    if (!host || !this.isIdle()) return;
    console.info(
      `[dsh-host:g${host.generation}] no session for ${Math.round(this.idleStopMs / 1000)}s; ` +
        `stopping pid ${String(host.pid)} until one is opened`
    );
    void this.shutdown('idle');
  }

  // ---- dead host scopes (decision 075) ------------------------------------------------

  /** Started right away, from the exit handler; the result never rejects. */
  private stopScopesOf(stop: (pid: number) => Promise<unknown>, pid: number): Promise<void> {
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(stop(pid));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      () => undefined,
      (error: unknown) => {
        console.warn(`[dsh-host] stopping the scopes of pid ${pid} failed: ${errorMessage(error)}`);
      }
    );
  }

  // ---- gc (decision 024) ----------------------------------------------------------------

  /** Takes a pending pass out of the table, its timer with it. */
  private settleGc(id: number): PendingGc | undefined {
    const pending = this.pendingGc.get(id);
    if (!pending) return undefined;
    this.pendingGc.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  private rejectGc(host: HostRecord): void {
    for (const [id, pending] of [...this.pendingGc]) {
      if (pending.host !== host) continue;
      this.settleGc(id)?.reject(
        new DshHostSupervisorError('DSH_HOST_UNAVAILABLE', `the DSH host exited during gc ${id}`)
      );
    }
  }

  // ---- stderr ---------------------------------------------------------------------

  private absorbStderr(host: HostRecord, chunk: string): void {
    const drained = drainStderrLines(host.stderrPending, chunk, host.stderrDropped);
    host.stderrPending = drained.pending;
    host.stderrDropped = drained.dropped;
    if (drained.lines.length === 0) return;
    // Redacted once, here: the log sink and the crash replay are both exits.
    const lines = drained.lines.map(sanitizeStderrLine);
    host.recentStderr = pushRecentStderr(host.recentStderr, lines);
    for (const line of lines) this.logLine(`[dsh-host:g${host.generation}:stderr] ${line}`);
  }

  /** Waits for the stderr pipe to close (or 1 s), so the dying lines make the replay. */
  private scheduleStderrReplay(host: HostRecord, reason: string): void {
    if (host.stderrReplayScheduled) return;
    host.stderrReplayScheduled = true;
    if (host.closed) {
      this.replayStderr(host, reason);
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    const run = () => {
      if (timer) clearTimeout(timer);
      host.child.off('close', run);
      this.replayStderr(host, reason);
    };
    host.child.once('close', run);
    timer = setTimeout(run, DSH_HOST_TIMINGS.stderrTailMs);
    timer.unref?.();
  }

  private replayStderr(host: HostRecord, reason: string): void {
    if (host.stderrReplayed) return;
    host.stderrReplayed = true;
    const lines = [
      ...host.recentStderr,
      ...flushStderrPending(host.stderrPending, host.stderrDropped).map(sanitizeStderrLine),
    ];
    host.recentStderr = [];
    host.stderrPending = '';
    host.stderrDropped = 0;
    const label = `[dsh-host:g${host.generation} pid ${String(host.pid)}] ${reason}`;
    // console.error: electron-log keeps error level even when file logging is off.
    console.error(
      lines.length > 0
        ? `${label}; last ${lines.length} stderr line(s):\n${lines.join('\n')}`
        : `${label}; no stderr`
    );
  }

  // ---- helpers ----------------------------------------------------------------------

  private sendControl(host: HostRecord, message: DshMainToHostMessage): boolean {
    if (!host.connected || host.exitInfo) return false;
    try {
      host.child.send(message, (error) => {
        if (error) {
          this.warnRateLimited('send-failed', `[dsh-host] IPC send failed: ${error.message}`);
        }
      });
      return true;
    } catch (error) {
      this.warnRateLimited('send-failed', `[dsh-host] IPC send failed: ${errorMessage(error)}`);
      return false;
    }
  }

  private takeChannels(): DshChannelTransport[] {
    const channels = [...this.channels.values()];
    this.channels.clear();
    return channels;
  }

  private subscribePowerMonitor(): void {
    if (this.powerMonitor) return;
    try {
      const monitor = this.resolvePowerMonitor();
      if (!monitor) return;
      monitor.on('resume', this.onSystemResume);
      this.powerMonitor = monitor;
    } catch (error) {
      this.warnRateLimited(
        'power-monitor',
        `[dsh-host] system resume events unavailable: ${errorMessage(error)}`
      );
    }
  }

  private clearReadyTimer(host: HostRecord): void {
    if (host.readyTimer) clearTimeout(host.readyTimer);
    host.readyTimer = null;
  }

  private setState(next: DshHostSupervisorState): void {
    if (this.state === 'disposed') return;
    this.state = next;
    if (next !== 'ready') this.disarmIdleStop();
  }

  private fail(error: DshHostSupervisorError): void {
    this.failure = error;
    this.setState('failed');
    console.error(`[dsh-host] supervisor failed: ${error.message}`);
  }

  /** Budgeted exits inside the sliding window; older ones are dropped. */
  private recentFaults(): number {
    const cutoff = this.now() - DSH_HOST_RESTART_BUDGET.windowMs;
    if (this.budgetedExits.some((at) => at <= cutoff)) {
      this.budgetedExits = this.budgetedExits.filter((at) => at > cutoff);
    }
    return this.budgetedExits.length;
  }

  private infoOf(host: HostRecord): DshHostInfo {
    return { generation: host.generation, pid: host.handshakePid ?? host.pid ?? 0 };
  }

  private exitUnconfirmedError(host: HostRecord): DshHostSupervisorError {
    return new DshHostSupervisorError(
      'DSH_HOST_EXIT_UNCONFIRMED',
      `DSH host pid ${String(host.pid)} has not been confirmed gone; no second host may start`
    );
  }

  private stoppedError(): DshHostSupervisorError {
    return new DshHostSupervisorError(
      'DSH_HOST_STOPPED',
      'the DSH host was stopped while starting'
    );
  }

  private disposedError(): DshHostSupervisorError {
    return new DshHostSupervisorError('DSH_HOST_DISPOSED', 'the DSH host supervisor is disposed');
  }

  private warnRateLimited(key: string, message: string): void {
    const now = this.now();
    const last = this.lastWarnAt.get(key);
    if (last !== undefined && now - last < DSH_HOST_TIMINGS.warnIntervalMs) return;
    this.lastWarnAt.set(key, now);
    console.warn(message);
  }
}

export const dshHostSupervisor = new DshHostSupervisor();
