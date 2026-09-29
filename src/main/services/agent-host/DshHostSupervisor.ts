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
 *   - A history read (`readPage`, decision 030) starts a host on demand like a
 *     channel does, and holds off the idle stop while it runs; it opens no
 *     channel, so the host it started stops once idle.
 *   - A migration (`seedSession`, decision 054, P1-9d) does the same, and may
 *     start a host out of `failed` for the user's continue it serves. A host
 *     that exits under it fails it with `DSH_HOST_SEED_INTERRUPTED`; nothing
 *     retries it here (the migration service decides). An import
 *     (`seedImportedConversation`, decision 056, P1-9f) is the same message
 *     with the other source kind, and the same rules.
 *   - A one-shot completion (`startCompletion`, P1-15, decision 125) starts a
 *     host on demand like a migration, out of `failed` too (the user clicked
 *     for it), and holds off the idle stop until it is answered, cancelled
 *     or cut by the host's exit (`DSH_HOST_COMPLETION_INTERRUPTED`). It opens
 *     no channel; `status().completions` counts the ones in flight.
 *
 * The host's stderr belongs to the host: redacted, logged line by line, kept
 * in a ring and replayed once at error level when the host dies. It never
 * becomes a session's `session.stderr`.
 *
 * Models and keys (P1-5, decisions 033 and 034): the first message every host
 * gets is `configure`, Main's model plan as of its spawn plus a fresh nonce;
 * the supervisor remembers the revision it ran with (`status().planRevision`)
 * so a later plan can tell whether the host is stale. The host holds no key:
 * each `credential` request it sends is answered by the model source's broker,
 * told whether the request came from the running host and with which nonce
 * and references.
 *
 * Plugins (P1-10b, decision 108): every launch carries the user's plugin
 * selection as of its spawn (`AICLIENT_DSH_PLUGINS`); the supervisor remembers
 * it per host (`status().pluginSelection`) so WorkerManager can tell a host
 * that runs another set, and keeps the latest `ready.plugins` report past the
 * host's exit (`pluginReport()`).
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildDshModelPlan, type DshModelPlan } from '@shared/dshModelPlan';
import { type DshPluginReport, isDshPluginReport } from '@shared/dshPlugins';
import {
  type DshChannelId,
  type DshCompletionPurpose,
  type DshHostChannelStatus,
  type DshHostCompleted,
  type DshHostConfigure,
  type DshHostCredentialRequest,
  type DshHostCredentialResult,
  type DshHostGcResult,
  type DshHostPage,
  type DshHostPong,
  type DshHostSeeded,
  type DshMainToHostMessage,
  type DshRouteDiagnostic,
  type DshSeedImportResult,
  type DshSeedImportSource,
  type DshSeedPiFileSource,
  type DshSeedSessionResult,
  type DshSeedSessionSource,
  dshHostControlKind,
  dshSeedResultKind,
  formatDshChannelId,
  isDshChannelEnvelope,
  isDshHostChannelClosed,
  isDshHostCompleted,
  isDshHostCompletionDelta,
  isDshHostCredentialRequest,
  isDshHostFatal,
  isDshHostGcResult,
  isDshHostPage,
  isDshHostPong,
  isDshHostReady,
  isDshHostSeeded,
  isDshHostStopped,
} from '@shared/types/dshHostProtocol';
import type { SessionHistoryPage } from '@shared/types/sessionHistory';
import { powerMonitor as electronPowerMonitor } from 'electron';
import { sanitizeStderrLine } from '../../../agent-host/stderrRedaction';
import { type DshChannelLink, DshChannelTransport } from './DshChannelTransport';
import {
  currentDshHostLaunch,
  type DshHostLaunch,
  dshHostPluginSelection,
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
  /**
   * A history read (decision 030) not answered in this long is given up on;
   * the preview then falls back to a resume. A 2000-message log reads in well
   * under a second (P1-4a); the rest covers a busy 2-core box.
   */
  readPageTimeoutMs: 20_000,
  /**
   * A migration (`seedSession`, decision 054; P1-9d, decision 122) not
   * answered in this long is given up on. The host runs one at a time, so the
   * wait includes any queued ahead; a 32 MiB session is estimated at 5-10 s
   * of conversion plus its images (plan P1-9 shard 03 §7), and a busy 2-core
   * box can triple that. The host's answer is idempotent, so a continue after
   * a timeout reuses what the late migration made.
   */
  seedSessionTimeoutMs: 120_000,
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
  | 'DSH_HOST_UNAVAILABLE'
  /** The host answered a history read with an error; its code leads the message. */
  | 'DSH_HOST_READ_FAILED'
  /** A migration (`seedSession`) was not answered within `seedSessionTimeoutMs`. */
  | 'DSH_HOST_SEED_TIMEOUT'
  /** The host exited while a migration was in flight (crash, hang, restart, stop). */
  | 'DSH_HOST_SEED_INTERRUPTED'
  /** The host answered a migration with a `seeded` message the protocol does not allow. */
  | 'DSH_HOST_SEED_MALFORMED'
  /** The host exited while a one-shot completion was in flight (P1-15). */
  | 'DSH_HOST_COMPLETION_INTERRUPTED'
  /** The host answered a completion with a `completed` message the protocol does not allow. */
  | 'DSH_HOST_COMPLETION_MALFORMED'
  /** Main cancelled the completion before its answer came. */
  | 'DSH_HOST_COMPLETION_CANCELLED';

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

/** What the supervisor knows about the host a credential request came from. */
export interface DshHostCredentialContext {
  current: boolean;
  nonce: string;
  refs: Readonly<Record<string, string>>;
}

/**
 * Where each host's model plan and keys come from (decisions 033, 034). Main's
 * wiring (`dshHostModelSource.ts`) sets the real one; without one a host gets
 * an empty plan and every credential request is answered `unavailable`.
 */
export interface DshHostModelSource {
  /** Main's plan now (`resolveDshModelPlan()`); read once per spawn. */
  plan(): DshModelPlan;
  /** Answers one credential request of a host (`DshCredentialBroker`). */
  credentials?: {
    answer(
      request: DshHostCredentialRequest,
      context: DshHostCredentialContext
    ): DshHostCredentialResult;
  };
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
  /** Decision 033: the plan revision the live host was configured with. */
  planRevision?: string;
  /** The plan's routes the live host reported not serving as planned (empty: none). */
  routeDiagnostics?: DshRouteDiagnostic[];
  /**
   * P1-10b (decision 108 rule 7): the plugin selection the live host was
   * launched with, `dshHostPluginSelection` of its environment.
   */
  pluginSelection?: string;
  /** P1-15: one-shot completions in flight, a host start for one included. */
  completions: number;
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
  /** Decisions 033, 034; `setModelSource` sets it later. */
  modelSource?: DshHostModelSource;
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

/** What `readPage` asks the host for; see `DshHostReadPageRequest`. */
export interface DshHostReadPageInput {
  stubFile: string;
  logicalSessionId: string;
  offset?: number;
  limit?: number;
}

interface PendingRead {
  readonly host: HostRecord;
  readonly resolve: (page: SessionHistoryPage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** What `seedSession` asks the host to migrate; see `DshSeedPiFileSource`. */
export type DshHostSeedInput = Omit<DshSeedPiFileSource, 'kind'>;

/** What `seedImportedConversation` asks the host to import (P1-9f); see `DshSeedImportSource`. */
export type DshHostSeedImportInput = Omit<DshSeedImportSource, 'kind'>;

type AnySeeded = DshHostSeeded<DshSeedSessionResult | DshSeedImportResult>;

/** What `startCompletion` asks the host to complete; see `DshHostCompleteRequest`. */
export interface DshHostCompletionInput {
  purpose: DshCompletionPurpose;
  prompt: string;
  /** Our `provider/modelId`; absent: the plan's default model. */
  model?: string;
  /** Our effort word; absent or `off`: none sent. */
  effort?: string;
  timeoutMs: number;
}

/** One completion in flight (P1-15). */
export interface DshHostCompletionCall {
  /**
   * The host's `completed` answer as it came, a failed completion included.
   * Rejects when no host can be had (`DSH_HOST_UNAVAILABLE` and the start
   * codes), when the host exits first (`DSH_HOST_COMPLETION_INTERRUPTED`),
   * on a malformed answer (`DSH_HOST_COMPLETION_MALFORMED`), and once
   * `cancel` was called (`DSH_HOST_COMPLETION_CANCELLED`).
   */
  readonly result: Promise<DshHostCompleted>;
  /** Settles `result` now and tells the host to abort; a no-op once settled. */
  cancel(): void;
}

interface PendingCompletion {
  readonly id: number;
  /** Set once the request went out; a cancel before that sends nothing. */
  host: HostRecord | null;
  readonly onDelta?: (text: string) => void;
  readonly resolve: (answer: DshHostCompleted) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
}

interface PendingSeed {
  readonly host: HostRecord;
  /** The request's source kind: an answer carrying the other kind's result is malformed. */
  readonly kind: DshSeedSessionSource['kind'];
  readonly resolve: (answer: AnySeeded) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface HostRecord {
  readonly generation: number;
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  /** Decisions 033, 034: what this host was configured with. */
  readonly plan: { revision: string; nonce: string; refs: Readonly<Record<string, string>> };
  /** P1-10b: the plugin selection its launch carried (`dshHostPluginSelection`). */
  readonly pluginSelection: string;
  /** What its `ready` said about the plan's routes. */
  routeDiagnostics?: DshRouteDiagnostic[];
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
  private modelSource: DshHostModelSource | null;

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
  private readSequence = 0;
  private readonly pendingReadPages = new Map<number, PendingRead>();
  /** `readPage` calls in flight, host start included: a host about to be read is not idle. */
  private pendingReads = 0;
  private seedSequence = 0;
  private readonly pendingSeedSessions = new Map<number, PendingSeed>();
  /** `seedSession` calls in flight, host start included: a host migrating a chat is not idle. */
  private pendingSeeds = 0;
  private completionSequence = 0;
  /** P1-15: completions in flight by id, from the call until they settle, host start included. */
  private readonly pendingCompletions = new Map<number, PendingCompletion>();
  /** P1-10b: the plugin report of the latest `ready`, kept past that host's exit. */
  private lastPluginReport: DshPluginReport | null = null;

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
    this.modelSource = options.modelSource ?? null;
  }

  /**
   * Decisions 033, 034: where the next host's plan, and every host's keys,
   * come from. A running host keeps the plan it was spawned with.
   */
  setModelSource(source: DshHostModelSource | null): void {
    this.modelSource = source;
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
      ...(live ? { planRevision: live.plan.revision } : {}),
      ...(live?.routeDiagnostics ? { routeDiagnostics: [...live.routeDiagnostics] } : {}),
      ...(live ? { pluginSelection: live.pluginSelection } : {}),
      completions: this.pendingCompletions.size,
    };
  }

  /**
   * P1-10b (decision 108 rule 9): every allowlisted plugin's state as the
   * latest host start composed it (loaded, disabled, missing, rejected), with
   * what that start dropped. Kept after the host stops, for the settings page
   * (P1-10c); `undefined` until a host has reported once.
   */
  pluginReport(): DshPluginReport | undefined {
    return this.lastPluginReport ? structuredClone(this.lastPluginReport) : undefined;
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
   * Decision 030: one page of a session's history, read by the host without a
   * channel (Main's preview of a DSH session). A host is started when none is
   * up, but never out of `failed`: a preview is not a user's create or resume,
   * and the resume it falls back to is. Resolves with the page; rejects when
   * no host can be had, when it goes away or does not answer within
   * `readPageTimeoutMs`, and with `DSH_HOST_READ_FAILED` (the host's code
   * leading the message) when the read itself failed.
   */
  async readPage(request: DshHostReadPageInput): Promise<SessionHistoryPage> {
    this.pendingReads += 1;
    this.disarmIdleStop();
    try {
      const info = await this.ensureHost();
      const host = this.host;
      if (
        this.state !== 'ready' ||
        !host ||
        host.generation !== info.generation ||
        host.exitInfo ||
        !host.connected
      ) {
        throw new DshHostSupervisorError(
          'DSH_HOST_UNAVAILABLE',
          'the DSH host went away before the history read'
        );
      }
      return await this.sendReadPage(host, request);
    } finally {
      this.pendingReads -= 1;
      this.armIdleStop();
    }
  }

  private sendReadPage(
    host: HostRecord,
    request: DshHostReadPageInput
  ): Promise<SessionHistoryPage> {
    const id = ++this.readSequence;
    return new Promise<SessionHistoryPage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReadPages.delete(id);
        reject(
          new DshHostSupervisorError(
            'DSH_HOST_UNAVAILABLE',
            `readPage ${id} was not answered within ${DSH_HOST_TIMINGS.readPageTimeoutMs}ms`
          )
        );
      }, DSH_HOST_TIMINGS.readPageTimeoutMs);
      timer.unref?.();
      this.pendingReadPages.set(id, { host, resolve, reject, timer });
      const sent = this.sendControl(host, {
        host: 'readPage',
        id,
        stubFile: request.stubFile,
        logicalSessionId: request.logicalSessionId,
        ...(request.offset !== undefined ? { offset: request.offset } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      });
      if (!sent) {
        this.settleRead(id)?.reject(
          new DshHostSupervisorError(
            'DSH_HOST_UNAVAILABLE',
            'the readPage request could not be sent'
          )
        );
      }
    });
  }

  /**
   * Decision 054 (P1-9d): one legacy pi session file made a DSH session by
   * the host, with no channel. A host is started when none is up, out of
   * `failed` too when `userInitiated` (a migration runs for the user's
   * continue). Resolves with the host's `seeded` answer as it came, a failed
   * migration included: where it stopped is the host's to say. Rejects when
   * no host can be had (`DSH_HOST_UNAVAILABLE` and the start codes), when the
   * host exits before answering (`DSH_HOST_SEED_INTERRUPTED`: a crash, a hang,
   * any restart or stop), when it does not answer within
   * `seedSessionTimeoutMs` (`DSH_HOST_SEED_TIMEOUT`), and when its answer is
   * not a `seeded` message (`DSH_HOST_SEED_MALFORMED`). Holds off the idle
   * stop while it runs.
   */
  async seedSession(
    input: DshHostSeedInput,
    options: DshHostEnsureOptions = {}
  ): Promise<DshHostSeeded<DshSeedSessionResult>> {
    const request: DshSeedPiFileSource = {
      kind: 'pi-file',
      sourceFile: input.sourceFile,
      logicalSessionId: input.logicalSessionId,
      cwd: input.cwd,
      ...(input.expect
        ? { expect: { bytes: input.expect.bytes, mtimeMs: input.expect.mtimeMs } }
        : {}),
    };
    return (await this.seed(request, options)) as DshHostSeeded<DshSeedSessionResult>;
  }

  /**
   * Decision 056 (P1-9f): one Claude Code / Codex conversation Main read
   * made a DSH session by the host, for the chat Main minted for it. The
   * same message and the same rules as `seedSession`, with the source kind
   * `imported-conversation`; resolves with a `seeded` whose result, when
   * there is one, is `DshSeedImportResult` (an answer carrying a migration
   * result is `DSH_HOST_SEED_MALFORMED`).
   */
  async seedImportedConversation(
    input: DshHostSeedImportInput,
    options: DshHostEnsureOptions = {}
  ): Promise<DshHostSeeded<DshSeedImportResult>> {
    const request: DshSeedImportSource = {
      kind: 'imported-conversation',
      conversation: input.conversation,
      logicalSessionId: input.logicalSessionId,
      cwd: input.cwd,
    };
    return (await this.seed(request, options)) as DshHostSeeded<DshSeedImportResult>;
  }

  private async seed(
    request: DshSeedSessionSource,
    options: DshHostEnsureOptions
  ): Promise<AnySeeded> {
    this.pendingSeeds += 1;
    this.disarmIdleStop();
    try {
      const info = await this.ensureHost(options);
      const host = this.host;
      if (
        this.state !== 'ready' ||
        !host ||
        host.generation !== info.generation ||
        host.exitInfo ||
        !host.connected
      ) {
        throw new DshHostSupervisorError(
          'DSH_HOST_UNAVAILABLE',
          'the DSH host went away before the migration'
        );
      }
      return await this.sendSeedSession(host, request);
    } finally {
      this.pendingSeeds -= 1;
      this.armIdleStop();
    }
  }

  private sendSeedSession(host: HostRecord, request: DshSeedSessionSource): Promise<AnySeeded> {
    const id = ++this.seedSequence;
    return new Promise<AnySeeded>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSeedSessions.delete(id);
        reject(
          new DshHostSupervisorError(
            'DSH_HOST_SEED_TIMEOUT',
            `seedSession ${id} was not answered within ${DSH_HOST_TIMINGS.seedSessionTimeoutMs}ms`
          )
        );
      }, DSH_HOST_TIMINGS.seedSessionTimeoutMs);
      timer.unref?.();
      this.pendingSeedSessions.set(id, { host, kind: request.kind, resolve, reject, timer });
      const sent = this.sendControl(host, { host: 'seedSession', id, ...request });
      if (!sent) {
        this.settleSeed(id)?.reject(
          new DshHostSupervisorError(
            'DSH_HOST_UNAVAILABLE',
            'the seedSession request could not be sent'
          )
        );
      }
    });
  }

  /**
   * P1-15 (decisions 039, 125): one tool-free completion on the host's LLM
   * service, with no channel and no session. A host is started when none is
   * up, out of `failed` too: the user asked for this one. `onDelta` gets the
   * text as it arrives (the request asks the host to stream only when there
   * is one). Main's deadline is the caller's: `cancel` on timeout. Holds off
   * the idle stop until it settles.
   */
  startCompletion(
    input: DshHostCompletionInput,
    onDelta?: (text: string) => void
  ): DshHostCompletionCall {
    const id = ++this.completionSequence;
    const answer = deferred<DshHostCompleted>();
    // The caller awaits it; a call cancelled before anyone did must not surface as unhandled.
    answer.promise.catch(() => {});
    const pending: PendingCompletion = {
      id,
      host: null,
      ...(onDelta ? { onDelta } : {}),
      resolve: answer.resolve,
      reject: answer.reject,
      settled: false,
    };
    this.pendingCompletions.set(id, pending);
    this.disarmIdleStop();
    void this.sendCompletion(pending, input).catch((error: unknown) => {
      this.settleCompletion(id)?.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return {
      result: answer.promise,
      cancel: () => {
        const settled = this.settleCompletion(id);
        if (!settled) return;
        if (settled.host) this.sendControl(settled.host, { host: 'complete-cancel', id });
        settled.reject(
          new DshHostSupervisorError(
            'DSH_HOST_COMPLETION_CANCELLED',
            `completion ${id} was cancelled`
          )
        );
      },
    };
  }

  private async sendCompletion(
    pending: PendingCompletion,
    input: DshHostCompletionInput
  ): Promise<void> {
    const info = await this.ensureHost({ userInitiated: true });
    // Cancelled while the host was starting: nothing goes out.
    if (pending.settled) return;
    const host = this.host;
    if (
      this.state !== 'ready' ||
      !host ||
      host.generation !== info.generation ||
      host.exitInfo ||
      !host.connected
    ) {
      throw new DshHostSupervisorError(
        'DSH_HOST_UNAVAILABLE',
        'the DSH host went away before the completion'
      );
    }
    pending.host = host;
    const sent = this.sendControl(host, {
      host: 'complete',
      id: pending.id,
      purpose: input.purpose,
      prompt: input.prompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      timeoutMs: input.timeoutMs,
      ...(pending.onDelta ? { stream: true } : {}),
    });
    if (!sent) {
      throw new DshHostSupervisorError(
        'DSH_HOST_UNAVAILABLE',
        'the complete request could not be sent'
      );
    }
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
    let configure: DshHostConfigure;
    let pluginSelection: string;
    try {
      // The plan first: a plan that cannot be built spawns nothing.
      configure = this.configureMessage();
      const launch = this.resolveLaunch();
      pluginSelection = dshHostPluginSelection(launch.env);
      this.prepareDirectories(launch);
      this.subscribePowerMonitor();
      child = this.spawnHost(launch.command, launch.args, dshHostSpawnOptions(launch));
    } catch (error) {
      if (this.state === 'starting') this.setState('idle');
      throw error instanceof Error ? error : new Error(String(error));
    }
    const host = this.attach(
      child,
      ++this.spawnCount,
      {
        revision: configure.revision,
        nonce: configure.nonce,
        refs: { ...configure.refs },
      },
      pluginSelection
    );
    this.host = host;
    // Decision 033: the host composes nothing before it (and refuses to boot without it).
    this.sendControl(host, configure);
    return host.ready;
  }

  /** The `configure` for the next host: Main's plan now, and a nonce of its own. */
  private configureMessage(): DshHostConfigure {
    const plan =
      this.modelSource?.plan() ?? buildDshModelPlan({ models: { providers: {} }, keyed: {} });
    return {
      host: 'configure',
      nonce: randomBytes(24).toString('base64url'),
      revision: plan.revision,
      routes: plan.routes,
      defaultModel: plan.defaultModel,
      index: plan.index,
      refs: plan.refs,
    };
  }

  private attach(
    child: ChildProcess,
    generation: number,
    plan: HostRecord['plan'],
    pluginSelection: string
  ): HostRecord {
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
      plan,
      pluginSelection,
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
    this.notePlanReport(host, message);
    this.notePluginReport(host, message);
    if (this.host !== host || this.state !== 'starting') {
      host.rejectReady(this.stoppedError());
      return;
    }
    this.setState('ready');
    this.startHeartbeat(host);
    host.resolveReady(this.infoOf(host));
    this.armIdleStop();
  }

  /**
   * Decision 033: what the host says it runs. A revision other than the one
   * it was sent, or routes DSH did not take, is logged; the menu is built from
   * the same plan, so a route DSH refused fails its turns with DSH's reason.
   */
  private notePlanReport(host: HostRecord, ready: Record<string, unknown>): void {
    if (ready.revision !== host.plan.revision) {
      console.warn(
        `[dsh-host:g${host.generation}] runs plan ${String(ready.revision).slice(0, 12)}, ` +
          `sent ${host.plan.revision.slice(0, 12)}`
      );
    }
    const diagnostics = (Array.isArray(ready.routeDiagnostics) ? ready.routeDiagnostics : [])
      .filter(
        (item): item is DshRouteDiagnostic =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as DshRouteDiagnostic).provider === 'string' &&
          typeof (item as DshRouteDiagnostic).error === 'string'
      )
      .map((item) => ({ provider: item.provider, error: item.error.slice(0, 500) }));
    host.routeDiagnostics = diagnostics;
    if (diagnostics.length > 0) {
      console.warn(
        `[dsh-host:g${host.generation}] ${diagnostics.length} route(s) of the model plan not served as planned:`,
        JSON.stringify(diagnostics).slice(0, 2000)
      );
    }
  }

  /**
   * P1-10b (decision 108 rule 9): the host's plugin report, kept for the
   * settings page. A plugin that is enabled but missing or rejected, a loaded
   * one whose rows did not start, and a malformed selection are logged.
   */
  private notePluginReport(host: HostRecord, ready: Record<string, unknown>): void {
    if (ready.plugins === undefined) return;
    if (!isDshPluginReport(ready.plugins)) {
      console.warn(`[dsh-host:g${host.generation}] ready carried a malformed plugin report`);
      return;
    }
    this.lastPluginReport = structuredClone(ready.plugins);
    const troubled = ready.plugins.plugins.filter(
      (plugin) =>
        plugin.state === 'missing' ||
        plugin.state === 'rejected' ||
        (plugin.inactiveRows?.length ?? 0) > 0
    );
    if (troubled.length > 0 || ready.plugins.enabledFrom === 'invalid') {
      console.warn(
        `[dsh-host:g${host.generation}] plugins (enabled from ${ready.plugins.enabledFrom}) not composed as asked:`,
        JSON.stringify(troubled).slice(0, 2000)
      );
    }
  }

  /**
   * Decision 034: one key, for one model request of `host`. The broker checks
   * that the request came from the running host with its nonce and a
   * reference of its plan; the value goes back over IPC and nowhere else.
   */
  private onCredentialRequest(host: HostRecord, request: DshHostCredentialRequest): void {
    const context: DshHostCredentialContext = {
      current: this.host === host && !host.exitInfo,
      nonce: host.plan.nonce,
      refs: host.plan.refs,
    };
    let answer: DshHostCredentialResult;
    try {
      answer = this.modelSource?.credentials?.answer(request, context) ?? {
        host: 'credential-result',
        id: request.id,
        ok: false,
        error: 'unavailable',
      };
    } catch (error) {
      this.warnRateLimited(
        'credential-broker',
        `[dsh-host] the credential broker failed: ${errorMessage(error)}`
      );
      answer = { host: 'credential-result', id: request.id, ok: false, error: 'unavailable' };
    }
    this.sendControl(host, answer);
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
    if (isDshHostPage(message)) {
      this.onPage(host, message);
      return;
    }
    if (isDshHostSeeded(message)) {
      this.onSeeded(host, message);
      return;
    }
    if (dshHostControlKind(message) === 'seeded') {
      this.onMalformedSeeded(host, message as Record<string, unknown>);
      return;
    }
    if (isDshHostCredentialRequest(message)) {
      this.onCredentialRequest(host, message);
      return;
    }
    if (isDshHostCompletionDelta(message)) {
      const pending = this.pendingCompletions.get(message.id);
      if (pending?.host === host && !pending.settled) pending.onDelta?.(message.text);
      return;
    }
    if (isDshHostCompleted(message)) {
      this.onCompleted(host, message);
      return;
    }
    if (dshHostControlKind(message) === 'completed') {
      this.onMalformedCompleted(host, message as Record<string, unknown>);
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
    this.rejectReads(host);
    this.rejectSeeds(host);
    this.rejectCompletions(host);
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
      this.pendingOpens === 0 &&
      this.pendingReads === 0 &&
      this.pendingSeeds === 0 &&
      this.pendingCompletions.size === 0
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

  // ---- readPage (decision 030) ------------------------------------------------------------

  private onPage(host: HostRecord, message: DshHostPage): void {
    const pending = this.pendingReadPages.get(message.id);
    if (pending?.host !== host) {
      this.warnRateLimited('stale-page', `[dsh-host] dropped page ${message.id}`);
      return;
    }
    const settled = this.settleRead(message.id);
    if (message.ok && message.page) {
      settled?.resolve(message.page);
      return;
    }
    settled?.reject(
      new DshHostSupervisorError(
        'DSH_HOST_READ_FAILED',
        `${message.error?.code ?? 'unknown'}: ${message.error?.message ?? 'no reason given'}`
      )
    );
  }

  /** Takes a pending read out of the table, its timer with it. */
  private settleRead(id: number): PendingRead | undefined {
    const pending = this.pendingReadPages.get(id);
    if (!pending) return undefined;
    this.pendingReadPages.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  private rejectReads(host: HostRecord): void {
    for (const [id, pending] of [...this.pendingReadPages]) {
      if (pending.host !== host) continue;
      this.settleRead(id)?.reject(
        new DshHostSupervisorError(
          'DSH_HOST_UNAVAILABLE',
          `the DSH host exited during readPage ${id}`
        )
      );
    }
  }

  // ---- seedSession (decision 054, P1-9d) ------------------------------------------

  private onSeeded(host: HostRecord, message: AnySeeded): void {
    const pending = this.pendingSeedSessions.get(message.id);
    if (pending?.host !== host) {
      // Too late (timed out) or never asked: the host's work is idempotent,
      // so the next continue reuses whatever this migration made.
      this.warnRateLimited('stale-seeded', `[dsh-host] dropped seeded ${message.id}`);
      return;
    }
    if (message.result && dshSeedResultKind(message.result) !== pending.kind) {
      // P1-9f: a migration answered with an import result, or the reverse.
      this.onMalformedSeeded(host, message as unknown as Record<string, unknown>);
      return;
    }
    this.settleSeed(message.id)?.resolve(message);
  }

  /** A `seeded` the protocol does not allow: the migration waiting on its id fails now, not at the timeout. */
  private onMalformedSeeded(host: HostRecord, message: Record<string, unknown>): void {
    const id = message.id;
    const pending = typeof id === 'number' ? this.pendingSeedSessions.get(id) : undefined;
    if (typeof id !== 'number' || pending?.host !== host) {
      this.warnRateLimited('malformed-seeded', '[dsh-host] dropped a malformed seeded message');
      return;
    }
    this.settleSeed(id)?.reject(
      new DshHostSupervisorError(
        'DSH_HOST_SEED_MALFORMED',
        `seedSession ${id} was answered with a malformed seeded message`
      )
    );
  }

  /** Takes a pending migration out of the table, its timer with it. */
  private settleSeed(id: number): PendingSeed | undefined {
    const pending = this.pendingSeedSessions.get(id);
    if (!pending) return undefined;
    this.pendingSeedSessions.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  private rejectSeeds(host: HostRecord): void {
    for (const [id, pending] of [...this.pendingSeedSessions]) {
      if (pending.host !== host) continue;
      this.settleSeed(id)?.reject(
        new DshHostSupervisorError(
          'DSH_HOST_SEED_INTERRUPTED',
          `the DSH host exited during seedSession ${id}`
        )
      );
    }
  }

  // ---- one-shot completions (P1-15, decision 125) ------------------------------------

  private onCompleted(host: HostRecord, message: DshHostCompleted): void {
    const pending = this.pendingCompletions.get(message.id);
    if (pending?.host !== host) {
      // Cancelled (or timed out) before the host's answer: nobody waits on it.
      this.warnRateLimited('stale-completed', `[dsh-host] dropped completed ${message.id}`);
      return;
    }
    this.settleCompletion(message.id)?.resolve(message);
  }

  /** A `completed` the protocol does not allow: the completion waiting on its id fails now. */
  private onMalformedCompleted(host: HostRecord, message: Record<string, unknown>): void {
    const id = message.id;
    const pending = typeof id === 'number' ? this.pendingCompletions.get(id) : undefined;
    if (typeof id !== 'number' || pending?.host !== host) {
      this.warnRateLimited(
        'malformed-completed',
        '[dsh-host] dropped a malformed completed message'
      );
      return;
    }
    this.settleCompletion(id)?.reject(
      new DshHostSupervisorError(
        'DSH_HOST_COMPLETION_MALFORMED',
        `completion ${id} was answered with a malformed completed message`
      )
    );
  }

  /** Takes a completion out of the table and re-arms the idle stop; undefined once settled. */
  private settleCompletion(id: number): PendingCompletion | undefined {
    const pending = this.pendingCompletions.get(id);
    if (!pending || pending.settled) return undefined;
    pending.settled = true;
    this.pendingCompletions.delete(id);
    this.armIdleStop();
    return pending;
  }

  private rejectCompletions(host: HostRecord): void {
    for (const [id, pending] of [...this.pendingCompletions]) {
      if (pending.host !== host) continue;
      this.settleCompletion(id)?.reject(
        new DshHostSupervisorError(
          'DSH_HOST_COMPLETION_INTERRUPTED',
          `the DSH host exited during completion ${id}`
        )
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
