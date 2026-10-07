import { randomUUID } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import { dirname } from 'node:path';
import { translate } from '@shared/i18n';
import { forkSessionTitle } from '@shared/sessionTitles';
import { STDERR_FORWARD_MAX_LINES_PER_TURN, sanitizeStderrLine } from '@shared/stderrRedaction';
import type { SessionAttachment, SessionEffortLevel } from '@shared/types/agentHost';
import { type AgentWireName, DSH_AGENT } from '@shared/types/agentWire';
import {
  type PermissionDecisionId,
  type RuntimeEvent,
  type RuntimeEventDraft,
  SESSION_FAILED_ENGINE_RESTARTED,
  SESSION_FAILED_HOST_CRASHED,
  type SessionDisconnectReason,
  type SessionRetryInfo,
  type SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
import {
  DEFAULT_RUNTIME_PERMISSION,
  migratePermissionTier,
  type RuntimePermissionSettings,
} from '@shared/types/runtimePermission';
import type { PiLeafCheckpoint, SessionTreeSnapshot } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import type { SessionPermissionTier } from '@shared/types/sessionPermissionTier';
import type {
  WorkerSetPermissionGearPayload,
  WorkerSetPermissionsPayload,
} from '@shared/types/workerRpc';
import {
  isWorkerAcceptForkResult,
  isWorkerCommandResult,
  isWorkerCommandsResult,
  isWorkerDiscardForkResult,
  isWorkerDisposeResult,
  isWorkerForkResult,
  isWorkerHistoryResult,
  isWorkerInterjectResult,
  isWorkerJobKillResult,
  isWorkerPermissionRespondResult,
  isWorkerQuestionRespondResult,
  isWorkerRewindResult,
  isWorkerSendResult,
  isWorkerSetPermissionTierResult,
  isWorkerStopResult,
  isWorkerSubagentInterruptResult,
  isWorkerTreeResult,
  normalizeWorkerCapabilities,
  STAGED_FORK_MARKER_SUFFIX,
  sanitizeWorkerCommandRows,
  sanitizeWorkerJobRead,
  sanitizeWorkerPanels,
  WORKER_COMPACT_REQUEST_TIMEOUT_MS,
  WORKER_RETRY_UNAVAILABLE,
  type WorkerAcceptForkPayload,
  type WorkerAcceptForkResult,
  type WorkerCapabilityInventory,
  type WorkerCommandPayload,
  type WorkerCommandResult,
  type WorkerCommandsPayload,
  type WorkerCommandsResult,
  type WorkerCompactPayload,
  type WorkerCompactResult,
  type WorkerDiscardForkPayload,
  type WorkerDiscardForkResult,
  type WorkerDisposeRequest,
  type WorkerDisposeResult,
  type WorkerForkPayload,
  type WorkerForkResult,
  type WorkerHistoryPayload,
  type WorkerHistoryResult,
  type WorkerInterjectPayload,
  type WorkerInterjectResult,
  type WorkerJobKillPayload,
  type WorkerJobKillResult,
  type WorkerJobReadPayload,
  type WorkerJobReadResult,
  type WorkerPanelsPayload,
  type WorkerPanelsResult,
  type WorkerPermissionRespondPayload,
  type WorkerPermissionRespondResult,
  type WorkerPreviewRespondPayload,
  type WorkerPreviewRespondResult,
  type WorkerQuestionRespondPayload,
  type WorkerQuestionRespondResult,
  type WorkerRewindPayload,
  type WorkerRewindResult,
  type WorkerRpcEvent,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerSetPermissionTierPayload,
  type WorkerSetPermissionTierResult,
  type WorkerSlashCommandInfo,
  type WorkerStopPayload,
  type WorkerStopResult,
  type WorkerSubagentInterruptPayload,
  type WorkerSubagentInterruptResult,
  type WorkerTreePayload,
  type WorkerTreeResult,
} from '@shared/types/workerRpc';
import { sessionIndexService } from '../chat/SessionIndexService';
import { getCurrentLocale } from '../i18n';
import { type PreviewShowRequest, previewWindowManager } from '../preview/PreviewWindowManager';
import { type CreatedDshChatSlot, createDshChatSlot } from './createDshChatSlot';
import {
  DSH_HOST_RESTART_BUDGET,
  type DshHostRestartReason,
  type DshHostSupervisor,
  DshHostSupervisorError,
  dshHostSupervisor,
  isPlannedHostRestart,
} from './DshHostSupervisor';
import { claimedDshSessionIds, DSH_SESSION_GC_GRACE_MS, readDshSessionStub } from './dshSessionGc';
import { drainStderrLines, flushStderrPending, pushRecentStderr } from './hostStderr';
import type { WorkerSlot, WorkerSlotLifecycleEvent } from './WorkerSlot';
import type { WorkerTransportExit } from './WorkerTransport';
import {
  joinWorkerPath,
  normalizeWorkerPath,
  sessionWorkerKey,
  workspaceWorkerKey,
} from './workerSessionKey';

export type WorkerManagerState = 'stopped' | 'ready' | 'degraded';
export type WorkerManagerEntryState =
  | 'creating'
  | 'ready'
  | 'restarting'
  | 'crashed'
  | 'disposing'
  | 'error';

export class WorkerManagerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'WorkerManagerError';
  }
}

interface ManagedSlot {
  key: string;
  readonly temporaryKey: string;
  readonly logicalSessionId: string;
  readonly cwd: string;
  /**
   * U05-c — `cwd` is a throwaway scratch directory, not a project the user
   * picked, so this session must bootstrap without project trust. Held on the
   * entry (not just passed at create time) so a crash restart re-spawns with
   * the same posture instead of silently coming back trusted.
   */
  readonly unbound: boolean;
  /**
   * concurrency-02 invariant — there is deliberately NO `forceTakeover` field
   * here, and there must not be one.
   *
   * `unbound` is held on the entry because re-spawning without it would make a
   * scratch session silently more trusted. A takeover is the opposite: it is a
   * one-time authorisation to displace another writer, and a crash restart
   * (`restartEntry`) or a fork that inherited it would strip the next real
   * holder of its lock with nobody having asked. It rides the single
   * `spawnForEntry` call that the user's click produced, and nowhere else.
   */
  /**
   * U12 fix — the permission tier this session's worker must run on.
   *
   * Mutable, and deliberately held on the entry rather than only inside the
   * worker: `setPermissionTier` can only reach a worker that exists and is
   * ready, so a tier picked before the first send used to be dropped on the
   * floor, and a worker respawned after a crash used to come back on the
   * default. Keeping it here makes the tier part of what a spawn restores,
   * so both paths stop drifting from what the composer chip shows.
   *
   * `undefined` means "the default tier" and is what an untouched session
   * carries, so nothing is sent for it.
   */
  tier: SessionPermissionTier | undefined;
  permissions: RuntimePermissionSettings | undefined;
  sessionFile: string | null;
  /**
   * Has `sessionFile` been written into the durable session index?
   *
   * Pi names a session's JSONL when the session is created but writes nothing
   * to it until the first assistant message lands, so the path Main receives at
   * bootstrap is a reservation, not a file. Publishing it as the durable
   * identity is what used to brick sessions: every later reopen — the crash
   * restart in `restartEntry`, and resume after an app restart — points at a
   * file Pi never wrote. Main therefore withholds the identity until the file
   * exists, and `ensureIdentityCommitted` publishes it the moment it does.
   */
  identityCommitted: boolean;
  slot: WorkerSlot | null;
  bootstrap: CreatedDshChatSlot['bootstrap'] | null;
  state: WorkerManagerEntryState;
  activeRequestId: string | null;
  ownerWebContentsId: number | null;
  acceptEvents: boolean;
  /**
   * main-host-03 — the window in which a retired entry still forwards the two
   * events its worker emits ON THE WAY OUT.
   *
   * `retireEntry` closes `acceptEvents` and unbooks the entry from both maps
   * the instant a disposal starts, which is right for routing: nothing new may
   * be addressed to a worker that is going away. But the worker deliberately
   * keeps emitting after it receives `worker.dispose` — its `handleDispose`
   * flips `disposed` only AFTER the runtime teardown, precisely so the engine
   * can deny the permission gates and cancel the questions parked in front of
   * the user (see dsh-host/bridge/bridgeRpcServer.ts; the native
   * runtime did the same until dsh-rebase P1-12). Closing Main's gate first dropped
   * every one of those resolutions, so the cards stayed on screen with nothing
   * alive left to answer them.
   *
   * Open from `retireEntry` until the disposal settles, and read only by
   * `handleWorkerEvent`, which lets `permission.resolved` and
   * `question.resolved` through it — the two events that RETRACT a pending
   * card. Nothing else rides it: a retired session must not keep appending to
   * a transcript the renderer has moved on from. (A drained preview needs no
   * event; the worker answers that parked call in-process.)
   */
  drainingEvents: boolean;
  lastUsedAt: number;
  lastIdleAt: number;
  restartAttempts: number[];
  generation: number;
  configGeneration: number;
  error: string | null;
  /**
   * The active leaf this worker last reported, mirrored so `commitPiLeaf` can
   * skip a write that would not change the index row.
   *
   * T025: Main-only since the bootstrap payload lost its `leafCheckpoint`. It
   * is written from bootstrap / rewind / fork results and read on the way into
   * the session index (`piLeaf`); it is never sent back to a worker, because
   * the native runtime resolves the active leaf from the session file itself.
   */
  leafCheckpoint: PiLeafCheckpoint | null;
  branchRevision: number;
  mutationInFlight: 'rewind' | 'fork' | null;
  /** Bytes after the last newline of this worker's stderr; see hostStderr.ts. */
  stderrPending: string;
  /**
   * main-aux-08 — chars already discarded from a stderr line that ran past the
   * cap without a newline. Optional: a worker that never prints one never pays
   * for the field.
   */
  stderrDropped?: number;
  /** Last RECENT_STDERR_LIMIT stderr lines, replayed when the worker dies. */
  recentStderr: string[];
  /**
   * rpc-projector-17 — how many stderr lines this turn has already forwarded,
   * and which turn that count belongs to. `undefined` until the first line, and
   * a turn that never produced one never pays for either field.
   */
  stderrForwarded?: number;
  stderrForwardTurn?: string | null;
  /**
   * decision 046 — armed when a `worker.stop` goes out, cleared by the turn's
   * terminal event or by anything that takes the slot away. Firing means the
   * worker never finished the turn it was told to stop.
   */
  stopWatchdog?: NodeJS.Timeout;
  /**
   * The last busy `session.status` the worker itself reported for the active
   * turn: what a re-claim may re-announce. Unset until the worker says
   * anything, so a latch it never confirmed is not replayed as `running`.
   */
  reportedStatus?: SessionRuntimeStatus;
  /**
   * dsh-rebase P1-7e (problem 4, decision 142) — the busy status the worker
   * last reported for ANY turn, with the turn's request id, including the
   * turns Main never sent (a goal round, a job's wake-up). `reportedStatus`
   * only follows Main's own `activeRequestId`, so a warm resume told a window
   * that had reloaded mid-round the session was idle. Cleared by the turn's
   * end and by anything that takes the worker away.
   */
  workerTurn?: { status: SessionRuntimeStatus; requestId?: string };
  /**
   * dsh-rebase decision 020 rule 5 — unplanned host exits in a row this session
   * was active at (a turn, a Stop, or its own recovery), plus Stop ladder B
   * restarts it caused. At {@link HOST_FAULT_SUSPECT_STREAK} it is no longer
   * recovered automatically; a user retry builds a fresh entry and clears it.
   */
  hostFaultStreak?: number;
  /** It was running or stopping a turn when the host last went away: recovered early. */
  activeAtHostExit?: boolean;
}

/**
 * dsh-rebase P1-3c — the shared DSH host, as WorkerManager drives it. The
 * supervisor's own interface; a narrower type so tests can stand one in.
 * `collectSessions` (P1-3d, decision 024) is optional: a host without it
 * simply never collects.
 */
export type WorkerManagerHost = Pick<
  DshHostSupervisor,
  'status' | 'ensureHost' | 'restart' | 'shutdown' | 'forceKillNow'
> &
  Partial<Pick<DshHostSupervisor, 'collectSessions'>>;

export interface WorkerManagerOptions {
  createSlot?: typeof createDshChatSlot;
  bindRuntimeIdentity?: (sessionId: string, sessionFile: string) => Promise<void>;
  commitResumed?: (input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    /** The engine the reopened session runs on; the index row records it (P1-1). */
    agent: AgentWireName;
    model?: string;
    piLeaf?: PiLeafCheckpoint;
  }) => Promise<void>;
  commitPiLeaf?: (input: {
    sessionId: string;
    runtimeIdentity: string;
    piLeaf: PiLeafCheckpoint;
  }) => Promise<void>;
  createForked?: (entry: SessionIndexEntry) => Promise<SessionIndexEntry>;
  /**
   * Does this Pi JSONL exist on disk right now? Injected so unit tests stay
   * hermetic; production stats the real path.
   */
  sessionFileExists?: (sessionFile: string) => Promise<boolean>;
  /**
   * session-index-09 — every indexed session row, for the one startup sweep
   * that reclaims staged fork files.
   *
   * The DEFAULT answers "no rows", which makes the sweep a no-op: it only ever
   * looks inside directories the index itself names, so a manager with no index
   * (every unit test here) never reads a directory and never deletes anything.
   */
  listIndexedSessions?: () => Promise<SessionIndexEntry[]>;
  /** Names in a session directory. Injected for the same reason as the stat above. */
  readSessionDirectory?: (directory: string) => Promise<string[]>;
  removeSessionFile?: (file: string) => Promise<void>;
  /**
   * P5-2-3 — show a workspace page in the preview window.
   *
   * Injected for the same reason as the stat above: production opens a real
   * Electron window, and a unit test that wants to prove the event is answered
   * must not have to open one. Rejecting is a real outcome — the reason becomes
   * the tool error the model reads.
   */
  showPreview?: (request: PreviewShowRequest) => Promise<void>;
  onEvent?: (event: RuntimeEvent) => void;
  log?: (...args: unknown[]) => void;
  now?: () => number;
  createToken?: () => string;
  capacity?: number;
  idleTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  maxRestartAttempts?: number;
  restartWindowMs?: number;
  /** decision 046 — see {@link STOP_WATCHDOG_MS}. */
  stopWatchdogMs?: number;
  /**
   * dsh-rebase P1-3c — the shared DSH host every session's channel runs on.
   * With one, a host exit is recovered in one batch under the host's own
   * restart budget (decision 020), a channel that will not close escalates to
   * a host restart (decision 021), and app quit and invalidation stop the host
   * itself (decision 025). Without one (tests that fake the slot), every crash
   * is a per-session restart.
   */
  host?: WorkerManagerHost;
  /**
   * dsh-rebase P1-3d (decision 024) — reads an identity stub the index names,
   * for the reference set of the one orphan collection per run. Injected for
   * the same reason as the stat above.
   */
  readDshStub?: (file: string) => Promise<unknown>;
  /** How long after the host is first up the collection waits; see `scheduleOrphanCollection`. */
  orphanCollectionDelayMs?: number;
}

export interface WorkerManagerSlotSnapshot {
  key: string;
  logicalSessionId: string;
  cwd: string;
  sessionFile: string | null;
  state: WorkerManagerEntryState;
  generation: number;
  active: boolean;
  foreground: boolean;
  lastUsedAt: number;
  lastIdleAt: number;
  error: string | null;
  /** Its own restarts inside the current window (decision 020: host exits never add one). */
  restartAttempts: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;
/** Decision 033 rule 4: how often a stale host's restart re-checks for idle. */
const PLAN_RECHECK_MS = 2_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 2;
const DEFAULT_RESTART_WINDOW_MS = 60_000;

/** decision 020 rule 5: host faults in a row a session may be present at before it is left alone. */
const HOST_FAULT_SUSPECT_STREAK = 2;

/**
 * Decision 155: how long, in all, a host restart Main starts waits for the
 * busy sessions it closes first (`closeBusyChannelsBeforeRestart`). The same
 * 3 s a session's own dispose ACK gets (`WorkerSlot`).
 */
export const HOST_RESTART_DRAIN_MS = 3_000;

/**
 * dsh-rebase P1-3d (decision 024) — the orphan collection runs this long after
 * the host is first up with nothing being recovered, so the first session's
 * own history and first turn go before it.
 */
const DEFAULT_ORPHAN_COLLECTION_DELAY_MS = 5_000;

/** Deleted ids named in the collection's log line; the count covers the rest. */
const ORPHAN_IDS_LOGGED = 20;

/**
 * dsh-rebase P1-3c — codes a session parks in `error` under (`entry.error`
 * leads with one), and the code a user-facing spawn fails with while the
 * shared host cannot be brought up. The renderer maps the last one to its own
 * card (`historyError.ts`).
 */
const HOST_UNAVAILABLE = 'dsh_host_unavailable';
const SESSION_SUSPECT = 'dsh_session_suspect';
const SESSION_RESTART_EXHAUSTED = 'session_restart_exhausted';

/** The shared host's own refusal: it is down, failed, or was stopped under the caller. */
function isHostSupervisorFailure(error: unknown): boolean {
  if (error instanceof DshHostSupervisorError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return (
    (typeof code === 'string' && code.startsWith('DSH_HOST_')) ||
    (error instanceof WorkerManagerError && error.code === HOST_UNAVAILABLE)
  );
}

/** The supervisor's refusal in this layer's vocabulary, so it crosses IPC with a code. */
function hostUnavailableError(error: unknown): unknown {
  if (error instanceof WorkerManagerError || !isHostSupervisorFailure(error)) return error;
  return new WorkerManagerError(
    HOST_UNAVAILABLE,
    error instanceof Error ? error.message : String(error),
    true
  );
}

/**
 * decision 046 — how long a Stop the worker accepted may take to produce the
 * turn's terminal event before Main restarts that worker itself. 10 s: well
 * past a healthy stop (provider abort, the 2 s bash cleanup, a session flush),
 * short enough that "stopping" cannot become the new "running forever".
 */
export const STOP_WATCHDOG_MS = 10_000;

/** Statuses that mean a turn is over (or was never there); see `reportedStatus`. */
const SETTLED_STATUSES: ReadonlySet<SessionRuntimeStatus> = new Set([
  'idle',
  'completed',
  'failed',
  'disconnected',
]);

let commandSequence = 0;
function nextRequestId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}-${Date.now()}-${commandSequence}`;
}

/** The worker's own error, as `WorkerSlot` carries a rejected RPC (`remoteError`). */
function remoteError(error: unknown): { code: string; message: string } | undefined {
  const remote = (error as { remoteError?: { code?: unknown; message?: unknown } } | null)
    ?.remoteError;
  return typeof remote?.code === 'string' && typeof remote.message === 'string'
    ? { code: remote.code, message: remote.message }
    : undefined;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer, received ${value}`);
  }
  return value;
}

/** Production `readSessionDirectory`: plain file names, directories included. */
async function readSessionDirectoryNames(directory: string): Promise<string[]> {
  return readdir(directory);
}

/** Production `sessionFileExists`: a missing or non-regular path is "not yet written". */
async function statSessionFileExists(sessionFile: string): Promise<boolean> {
  try {
    return (await stat(sessionFile)).isFile();
  } catch {
    return false;
  }
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number, received ${value}`);
  }
  return value;
}

/** The ceiling `AICLIENT_PI_WORKER_CAPACITY` may raise the pool to (D12). */
export const MAX_WORKER_CAPACITY = 10;

/**
 * Product default: 10, and 6 on hosts with at most 4 GiB (dsh-rebase decision
 * 019).
 *
 * D12 raised the ceiling to 10 because the user asked for "about 10
 * conversations at once": past capacity a new session does not queue, it fails
 * with `worker_capacity_reached`. D12's tiers (10 / 6 / 3) priced a session as
 * a whole process plus one model context. On the shared DSH host a session is
 * a channel costing 3 to 46 MB of one process (P0-6), so only the smallest
 * machines keep a lower number.
 */
export function resolveDefaultWorkerCapacity(totalMemoryBytes = os.totalmem()): number {
  if (totalMemoryBytes <= 4 * 1024 ** 3) return 6;
  return MAX_WORKER_CAPACITY;
}

/** Startup-only product configuration; the wire protocol never fixes capacity. */
export function resolveWorkerCapacity(
  env: NodeJS.ProcessEnv = process.env,
  totalMemoryBytes = os.totalmem()
): number {
  const configured = env.AICLIENT_PI_WORKER_CAPACITY?.trim();
  if (!configured) return resolveDefaultWorkerCapacity(totalMemoryBytes);
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_WORKER_CAPACITY) {
    throw new Error(
      `AICLIENT_PI_WORKER_CAPACITY must be an integer from 1 to ${MAX_WORKER_CAPACITY}, received ${configured}`
    );
  }
  return parsed;
}

function readString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * T093 / decision 029 clause 8 — how long the attempt that just failed ran.
 *
 * This is THE number the 2026-09-19 field report was missing. "provider retry
 * 1/3 in 3000ms" says what happens next and nothing about what took the time:
 * the user's seven-minute message was seven minutes of attempts hanging, not of
 * backoff, and the log could not tell the two apart.
 *
 * Derived rather than carried as a third field, and exactly so: the runtime
 * computes `retryAt` as the instant the attempt failed PLUS `delayMs`, so
 * `retryAt - delayMs` is that instant back, with no rounding and nothing that
 * can drift from the number the banner shows. Empty string when an older worker
 * sends neither field, which keeps the line's shape for whatever is parsing it.
 */
function attemptDurationSuffix(retry: SessionRetryInfo): string {
  if (retry.retryAt === undefined || retry.attemptStartedAt === undefined) return '';
  const failedAt = retry.retryAt - retry.delayMs;
  return ` after ${Math.max(0, failedAt - retry.attemptStartedAt)}ms`;
}

export class WorkerManager {
  private readonly createSlot: typeof createDshChatSlot;
  private readonly showPreview: (request: PreviewShowRequest) => Promise<void>;
  private readonly bindRuntimeIdentity: (sessionId: string, sessionFile: string) => Promise<void>;
  private readonly commitResumed: NonNullable<WorkerManagerOptions['commitResumed']>;
  private readonly commitPiLeaf: NonNullable<WorkerManagerOptions['commitPiLeaf']>;
  private readonly createForked: NonNullable<WorkerManagerOptions['createForked']>;
  private readonly sessionFileExists: (sessionFile: string) => Promise<boolean>;
  private readonly listIndexedSessions: () => Promise<SessionIndexEntry[]>;
  private readonly readSessionDirectory: (directory: string) => Promise<string[]>;
  private readonly removeSessionFile: (file: string) => Promise<void>;
  /** The one staged-fork sweep of this run; see `sweepStagedForkFiles`. */
  private stagedForkSweep: Promise<void> | null = null;
  private readonly handlers = new Set<(event: RuntimeEvent) => void>();
  private readonly log: (...args: unknown[]) => void;
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly capacity: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRestartAttempts: number;
  private readonly restartWindowMs: number;
  private readonly stopWatchdogMs: number;
  private readonly entriesByKey = new Map<string, ManagedSlot>();
  private readonly entriesBySession = new Map<string, ManagedSlot>();
  private readonly resumeFlights = new Map<
    string,
    { fingerprint: string; promise: Promise<string>; ownerWebContentsId?: number }
  >();
  private readonly historyPageFlights = new Map<string, Promise<void>>();
  /** Every spawned physical slot, including failed-disposal retired generations. */
  private readonly ownedSlots = new Set<WorkerSlot>();
  private eventSequence = 0;
  private lifecycleChain: Promise<void> = Promise.resolve();
  private state: WorkerManagerState = 'stopped';
  private configGeneration = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  /** See {@link WorkerManagerOptions.host}. */
  private readonly host: WorkerManagerHost | null;
  /** Entries a host exit took down, waiting for the one recovery batch (decision 020). */
  private readonly pendingHostRecovery = new Set<ManagedSlot>();
  private hostRecoveryScheduled = false;
  /** Set while Main itself restarts the host: the exits it causes read `engine_restarted`. */
  private plannedHostRestart: DshHostRestartReason | null = null;
  /** Decision 155: slots told to close ahead of a host restart; their channel's close is that restart's. */
  private readonly drainedSlots = new WeakSet<WorkerSlot>();
  private readonly readDshStub: (file: string) => Promise<unknown>;
  private readonly orphanCollectionDelayMs: number;
  private orphanCollectionTimer: NodeJS.Timeout | null = null;
  /** Decision 024: at most one collection per run, started or not. */
  private orphanCollectionStarted = false;
  /** Decision 033 rule 4: a plan revision the running host does not run yet. */
  private pendingPlanRevision: string | null = null;
  /** P1-10b (decision 108 rule 7): a plugin selection the running host does not run yet. */
  private pendingPluginSelection: string | null = null;
  private planRecheckTimer: NodeJS.Timeout | null = null;

  constructor(options: WorkerManagerOptions = {}) {
    this.host = options.host ?? null;
    this.readDshStub = options.readDshStub ?? readDshSessionStub;
    this.orphanCollectionDelayMs = nonNegativeFinite(
      options.orphanCollectionDelayMs ?? DEFAULT_ORPHAN_COLLECTION_DELAY_MS,
      'Orphan collection delay'
    );
    this.createSlot = options.createSlot ?? createDshChatSlot;
    // The DEFAULT refuses. A manager with no host has no window to open, and
    // answering `ok: true` from one would tell the model a page is on screen
    // when nothing is. The production singleton below injects the real window
    // manager.
    this.showPreview =
      options.showPreview ??
      (async () => {
        throw new Error('this build has no preview surface');
      });
    this.bindRuntimeIdentity = options.bindRuntimeIdentity ?? (async () => undefined);
    this.commitResumed = options.commitResumed ?? (async () => undefined);
    this.commitPiLeaf = options.commitPiLeaf ?? (async () => undefined);
    this.createForked = options.createForked ?? (async (entry) => entry);
    this.sessionFileExists = options.sessionFileExists ?? statSessionFileExists;
    this.listIndexedSessions = options.listIndexedSessions ?? (async () => []);
    this.readSessionDirectory = options.readSessionDirectory ?? readSessionDirectoryNames;
    this.removeSessionFile = options.removeSessionFile ?? ((file) => unlink(file));
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.createToken = options.createToken ?? randomUUID;
    this.capacity = positiveInteger(
      options.capacity ?? resolveWorkerCapacity(),
      'Worker pool capacity'
    );
    this.idleTimeoutMs = nonNegativeFinite(
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      'Worker idle timeout'
    );
    this.maxRestartAttempts = positiveInteger(
      options.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS,
      'Worker restart attempt limit'
    );
    this.restartWindowMs = positiveInteger(
      options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS,
      'Worker restart window'
    );
    this.stopWatchdogMs = positiveInteger(
      options.stopWatchdogMs ?? STOP_WATCHDOG_MS,
      'Worker stop watchdog'
    );
    const sweepInterval = nonNegativeFinite(
      options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS,
      'Worker idle sweep interval'
    );
    if (this.idleTimeoutMs > 0 && sweepInterval > 0) {
      this.idleTimer = setInterval(() => void this.reclaimIdle(), sweepInterval);
      this.idleTimer.unref?.();
    }
    if (options.onEvent) this.handlers.add(options.onEvent);
  }

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async ensureReady(): Promise<void> {
    if (this.state === 'stopped') this.state = 'ready';
    await this.sweepStagedForkFiles();
  }

  /**
   * Reclaim fork transcripts that were staged but never became sessions
   * (session-index-09).
   *
   * `worker.fork` writes the transcript into the session directory before the
   * new worker is spawned and long before the index row is written, so a crash,
   * a kill, or a cleanup that could not confirm its delete used to leave a full
   * copy of a conversation there with nothing pointing at it and no surface
   * able to remove it.
   *
   * Two rules keep this from ever deleting a real session:
   *
   *  - it only reads directories the session index itself names, so it can
   *    never be aimed at an arbitrary path, and an empty/unreadable index makes
   *    it a no-op rather than a wipe;
   *  - it only deletes a transcript that BOTH still carries its staging marker
   *    and is claimed by no row. A fork whose row landed but whose "adopted"
   *    acknowledgement did not (Main died in between) keeps its file and loses
   *    only the marker.
   *
   * Runs once per process and never rejects: this is housekeeping, and a
   * failure here must not keep the chat surface from coming up.
   */
  private async sweepStagedForkFiles(): Promise<void> {
    this.stagedForkSweep ??= this.reclaimStagedForkFiles().catch((error) => {
      this.log('[worker-manager] staged fork sweep failed', error);
    });
    await this.stagedForkSweep;
  }

  private async reclaimStagedForkFiles(): Promise<void> {
    const rows = await this.listIndexedSessions();
    const committed = new Set<string>();
    const directories = new Set<string>();
    for (const row of rows) {
      if (!row.runtimeIdentity?.trim()) continue;
      try {
        const file = normalizeWorkerPath(row.runtimeIdentity, 'Pi session file');
        committed.add(sessionWorkerKey(file));
        directories.add(dirname(file));
      } catch (error) {
        this.log('[worker-manager] skipped an unusable indexed session path', error);
      }
    }
    for (const directory of directories) {
      let names: string[];
      try {
        names = await this.readSessionDirectory(directory);
      } catch (error) {
        this.log('[worker-manager] could not read a session directory', directory, error);
        continue;
      }
      for (const name of names) {
        // A bare `.staged` names no transcript; skipping it keeps the key
        // helpers below from rejecting an empty path and aborting the sweep.
        if (!name.endsWith(STAGED_FORK_MARKER_SUFFIX)) continue;
        if (name.length === STAGED_FORK_MARKER_SUFFIX.length) continue;
        // Joined in the directory's own flavour: the host's `join` would turn a
        // foreign `/sessions` into `\sessions` and key it as a different file.
        const marker = joinWorkerPath(directory, name);
        const transcript = marker.slice(0, -STAGED_FORK_MARKER_SUFFIX.length);
        if (!committed.has(sessionWorkerKey(transcript))) {
          try {
            await this.removeSessionFile(transcript);
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
              // Keep the marker: it is the only durable record that this file
              // is unclaimed, so the next start gets to try again.
              this.log('[worker-manager] staged fork transcript not removed', transcript, error);
              continue;
            }
          }
        }
        try {
          await this.removeSessionFile(marker);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            this.log('[worker-manager] staged fork marker not removed', marker, error);
          }
        }
      }
    }
  }

  /**
   * dsh-rebase P1-3d (decision 024) — the one DSH orphan collection of this
   * run, armed once a host is up and nothing is being recovered: after a
   * user's create or resume, or after a recovery batch. It runs a short delay
   * later, off the lifecycle queue, and only if the host is still ready with
   * no recovery pending; otherwise the next of those moments arms it again.
   */
  private scheduleOrphanCollection(): void {
    if (this.orphanCollectionStarted || this.orphanCollectionTimer) return;
    if (!this.host?.collectSessions) return;
    this.orphanCollectionTimer = setTimeout(() => {
      this.orphanCollectionTimer = null;
      void this.runOrphanCollection();
    }, this.orphanCollectionDelayMs);
    this.orphanCollectionTimer.unref?.();
  }

  private cancelOrphanCollection(): void {
    if (this.orphanCollectionTimer) clearTimeout(this.orphanCollectionTimer);
    this.orphanCollectionTimer = null;
  }

  /** Never rejects: housekeeping, like the staged-fork sweep. */
  private async runOrphanCollection(): Promise<void> {
    const host = this.host;
    if (this.orphanCollectionStarted || !host?.collectSessions || this.state === 'stopped') return;
    if (
      host.status().state !== 'ready' ||
      this.pendingHostRecovery.size > 0 ||
      this.hostRecoveryScheduled
    ) {
      return;
    }
    this.orphanCollectionStarted = true;
    try {
      // A failed index read ends the pass: nothing is orphaned without the index.
      const rows = await this.listIndexedSessions();
      const claimed = await claimedDshSessionIds(rows, this.readDshStub);
      const result = await host.collectSessions({ claimed, graceMs: DSH_SESSION_GC_GRACE_MS });
      const skipped = Object.entries(result.skipped)
        .map(([reason, count]) => `${reason} ${count}`)
        .join(', ');
      const summary =
        `deleted ${result.deleted.length} session(s) and ${result.stubsDeleted} stub(s), ` +
        `left ${skipped || 'none'} (${claimed.length} claimed, ${result.ms} ms)`;
      if (!result.ok) {
        console.warn(`[worker-manager] DSH session collection did not run: ${result.error}`);
      } else if (
        result.deleted.length > 0 ||
        result.stubsDeleted > 0 ||
        (result.skipped.failed ?? 0) > 0
      ) {
        // Deleting user data is always on record (warn survives the logging switch).
        const named = result.deleted.slice(0, ORPHAN_IDS_LOGGED).join(' ');
        console.warn(
          `[worker-manager] DSH session collection: ${summary}${named ? `; deleted ${named}` : ''}`
        );
      } else {
        console.info(`[worker-manager] DSH session collection: ${summary}`);
      }
    } catch (error) {
      console.warn(
        `[worker-manager] DSH session collection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getStatus(): {
    state: WorkerManagerState;
    capabilities: { history: true; thinking: true };
    capacity: number;
    slots: number;
    active: number;
    restarting: number;
    errors: number;
  } {
    const entries = [...this.entriesBySession.values()];
    return {
      state: this.state,
      capabilities: { history: true, thinking: true },
      capacity: this.capacity,
      slots: entries.length,
      active: entries.filter((entry) => entry.activeRequestId !== null).length,
      restarting: entries.filter((entry) => entry.state === 'restarting').length,
      errors: entries.filter((entry) => entry.state === 'error' || entry.state === 'crashed')
        .length,
    };
  }

  /**
   * T026 — what this session's worker brought up, as it reported at bootstrap.
   *
   * `null` is "nobody has reported": no live worker (the chat has not been sent
   * yet, or its slot was evicted), or a worker whose build reports no inventory
   * at all. It is NOT "this session has nothing" — the panel says those two
   * differently, and guessing either way would misreport the user's setup.
   *
   * Replaces `getSessionExtensions`, which answered from a `extensions` field
   * no backend has written since P6-5 and so reported "0 plugins" for every
   * session (cutover-03).
   *
   * Read off the cached bootstrap rather than asked over RPC: the inventory
   * cannot change without a new bootstrap, and a round trip to a busy worker to
   * re-read a constant would put a UI panel in the turn's path.
   */
  getSessionCapabilities(sessionId: string): WorkerCapabilityInventory | null {
    const entry = this.entriesBySession.get(sessionId);
    if (!entry?.bootstrap) return null;
    return normalizeWorkerCapabilities(entry.bootstrap.capabilities);
  }

  getSlotSnapshots(): WorkerManagerSlotSnapshot[] {
    const now = this.now();
    return [...this.entriesBySession.values()].map((entry) => ({
      key: entry.key,
      logicalSessionId: entry.logicalSessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      state: entry.state,
      generation: entry.generation,
      active: entry.activeRequestId !== null,
      foreground: entry.ownerWebContentsId !== null,
      lastUsedAt: entry.lastUsedAt,
      lastIdleAt: entry.lastIdleAt,
      error: entry.error,
      restartAttempts: entry.restartAttempts.filter(
        (attempt) => now - attempt <= this.restartWindowMs
      ).length,
    }));
  }

  createSession(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    effort?: SessionEffortLevel;
    ownerWebContentsId?: number;
    /** U05-c — `workspacePath` is a scratch directory; bootstrap untrusted. */
    unbound?: boolean;
    /** U12 fix — tier the worker starts on; omit for the default. */
    tier?: SessionPermissionTier;
    permissions?: RuntimePermissionSettings;
  }): Promise<string> {
    const requestId = nextRequestId('create');
    return this.serialize(async () => {
      const existing = this.entriesBySession.get(input.sessionId);
      if (existing?.state === 'error') {
        // `error` is terminal for the worker, never for the session. Leaving the
        // dead entry in the maps is what made a failed restart permanent: it
        // answered every later create and resume, held a pool slot no eviction
        // could reclaim, and had no path back to `ready`. Retire it and take the
        // cold path below instead.
        await this.retireAndDispose(existing, 'slot-dispose').catch(() => undefined);
      } else if (existing && existing.state !== 'disposing') {
        this.claimEntry(existing, input.ownerWebContentsId);
        if (
          input.permissions &&
          (existing.permissions?.mode !== input.permissions.mode ||
            existing.permissions?.gear !== input.permissions.gear)
        )
          await this.setPermissions(input.sessionId, input.permissions);
        existing.lastUsedAt = this.now();
        if (existing.state === 'ready' && existing.sessionFile) {
          // Re-announcing an uncommitted path would put the reservation back in
          // the index the very next event, undoing the whole point of holding it
          // back. An unmaterialized session simply reports no identity.
          const committed = await this.commitIdentityIfMaterialized(existing);
          this.dispatch({
            type: 'session.created',
            sessionId: existing.logicalSessionId,
            requestId,
            payload: {
              agent: DSH_AGENT,
              ...(committed ? { runtimeIdentity: existing.sessionFile } : {}),
              ...this.gatePayload(existing),
            },
          });
          // decision 046 — re-announce only what the worker itself last said
          // about the turn. Replaying a latch it never confirmed as `running`
          // is how a turn that never started kept a re-opened session spinning.
          const status = existing.activeRequestId ? existing.reportedStatus : 'idle';
          if (status) {
            this.dispatch({
              type: 'session.status',
              sessionId: existing.logicalSessionId,
              requestId,
              payload: { status },
            });
          }
        }
        return;
      }

      await this.reclaimIdleInternal();
      if (this.entriesBySession.size >= this.capacity) {
        const victim = this.selectEvictionCandidate();
        if (!victim) {
          throw new WorkerManagerError(
            'worker_capacity_reached',
            `Pi worker capacity ${this.capacity} is fully protected by foreground, active, or blocking sessions`,
            true
          );
        }
        await this.evictForCapacity(victim);
      }

      const cwd = normalizeWorkerPath(input.workspacePath, 'Workspace path');
      const temporaryKey = workspaceWorkerKey({
        workspacePath: cwd,
        logicalSessionId: input.sessionId,
        createToken: this.createToken(),
      });
      const timestamp = this.now();
      const entry: ManagedSlot = {
        key: temporaryKey,
        temporaryKey,
        logicalSessionId: input.sessionId,
        cwd,
        unbound: input.unbound === true,
        tier: input.tier,
        permissions: input.permissions,
        sessionFile: null,
        identityCommitted: false,
        slot: null,
        bootstrap: null,
        state: 'creating',
        activeRequestId: null,
        ownerWebContentsId: null,
        acceptEvents: true,
        drainingEvents: false,
        lastUsedAt: timestamp,
        lastIdleAt: timestamp,
        restartAttempts: [],
        generation: 1,
        configGeneration: this.configGeneration,
        error: null,
        leafCheckpoint: null,
        branchRevision: 0,
        mutationInFlight: null,
        stderrPending: '',
        recentStderr: [],
      };
      this.entriesByKey.set(temporaryKey, entry);
      this.entriesBySession.set(input.sessionId, entry);
      this.claimEntry(entry, input.ownerWebContentsId);
      this.state = 'ready';

      try {
        const created = await this.spawnForEntry(
          entry,
          {
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
          },
          { userInitiated: true }
        );
        if (!created.bootstrap.sessionFile) {
          throw new WorkerManagerError(
            'worker_session_file_missing',
            'Pi worker bootstrap did not return a durable session file'
          );
        }
        const sessionFile = normalizeWorkerPath(created.bootstrap.sessionFile, 'Pi session file');
        const durableKey = sessionWorkerKey(sessionFile);
        const conflict = this.entriesByKey.get(durableKey);
        if (conflict && conflict !== entry) {
          throw new WorkerManagerError(
            'worker_session_identity_conflict',
            `Pi session file is already owned by logical session ${conflict.logicalSessionId}`
          );
        }
        if (
          this.entriesByKey.get(entry.key) !== entry ||
          entry.configGeneration !== this.configGeneration
        ) {
          throw new WorkerManagerError(
            'worker_create_superseded',
            `Worker creation for ${entry.logicalSessionId} lost lifecycle authority`
          );
        }

        entry.slot?.remapSlotKey(durableKey);
        this.entriesByKey.delete(entry.key);
        entry.key = durableKey;
        entry.sessionFile = sessionFile;
        entry.leafCheckpoint = created.bootstrap.leaf;
        entry.bootstrap = { ...created.bootstrap, sessionFile };
        entry.lastIdleAt = this.now();
        this.entriesByKey.set(durableKey, entry);

        // The map has one authority before persistence, but remains non-ready:
        // send/stop cannot observe it until the durable index commit succeeds.
        // If persistence fails, the catch path removes and disposes it; no
        // success event or turn side effect is published.
        //
        // A brand-new Pi session usually has no file yet (Pi defers the first
        // write until an assistant message exists), and then there is no commit
        // to await and no identity to announce. That is strictly more
        // conservative than the old unconditional bind: Main still never
        // advertises an identity the index did not persist, and now it also
        // never persists one the filesystem cannot back.
        const materialized = await this.commitIdentityIfMaterialized(entry);
        entry.state = 'ready';
        this.dispatch({
          type: 'session.created',
          sessionId: entry.logicalSessionId,
          requestId,
          payload: {
            agent: DSH_AGENT,
            ...(materialized ? { runtimeIdentity: sessionFile } : {}),
            ...this.gatePayload(entry),
          },
        });
        this.dispatch({
          type: 'session.status',
          sessionId: entry.logicalSessionId,
          requestId,
          payload: { status: 'idle' },
        });
        this.scheduleOrphanCollection();
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        await this.retireAndDispose(entry, 'slot-dispose').catch(() => undefined);
        this.updateManagerState();
        throw error;
      }
    }).then(() => requestId);
  }

  resumeSession(input: {
    sessionId: string;
    sessionFile: string;
    workspacePath: string;
    model?: string;
    effort?: SessionEffortLevel;
    ownerWebContentsId?: number;
    /** U05-c — `workspacePath` is a scratch directory; bootstrap untrusted. */
    unbound?: boolean;
    /** U12 fix — tier the worker starts on; omit for the default. */
    tier?: SessionPermissionTier;
    permissions?: RuntimePermissionSettings;
    /**
     * concurrency-02 — open the session even though its writer lock still
     * looks held.
     *
     * One-shot by construction: it reaches the spawn below and is never stored
     * on the entry, so a crash restart or a fork rebuilds the worker on the
     * normal, refusing open. A takeover is a decision the user made about one
     * lock at one moment, not a posture the session keeps.
     */
    forceTakeover?: boolean;
  }): Promise<string> {
    const sessionFile = normalizeWorkerPath(input.sessionFile, 'Pi session file');
    const cwd = normalizeWorkerPath(input.workspacePath, 'Workspace path');
    // T025: the leaf checkpoint used to be part of this fingerprint. It was
    // dropped with the field itself — two resumes that differ only by a leaf
    // the worker never reads are the same resume, and treating them as a
    // conflict rejected a legitimate second call.
    // concurrency-02: part of the fingerprint, so a plain resume and a forced
    // one are never answered by each other's in-flight promise. Reporting an
    // identity conflict is the right failure here — silently reusing the plain
    // flight would leave the user pressing "Restart engine" to no effect.
    const fingerprint = JSON.stringify([
      sessionFile,
      cwd,
      input.model ?? '',
      input.effort ?? '',
      input.forceTakeover === true,
    ]);
    const existingFlight = this.resumeFlights.get(input.sessionId);
    if (existingFlight) {
      if (existingFlight.fingerprint !== fingerprint) {
        return Promise.reject(
          new WorkerManagerError(
            'worker_resume_identity_conflict',
            `Session ${input.sessionId} already has a different resume in flight`
          )
        );
      }
      existingFlight.ownerWebContentsId = input.ownerWebContentsId;
      const readyEntry = this.entriesBySession.get(input.sessionId);
      if (readyEntry?.state === 'ready') {
        this.claimEntry(readyEntry, input.ownerWebContentsId);
      }
      return existingFlight.promise;
    }

    const requestId = nextRequestId('resume');
    const promise = this.serialize(async () => {
      let entry = this.entriesBySession.get(input.sessionId);
      if (entry?.state === 'error') {
        // See createSession: retiring the dead entry is the only way a session
        // parked in `error` becomes usable again without restarting the app.
        // Falling through re-spawns it from the durable file below.
        await this.retireAndDispose(entry, 'slot-dispose').catch(() => undefined);
        entry = undefined;
      }
      // concurrency-02: `input.forceTakeover` is deliberately unused on this
      // warm path. A ready entry means THIS process already holds the file's
      // writer lock, so there is nobody to take it from — replaying the
      // history is the whole of what a resume owes the caller here.
      if (entry && entry.state !== 'disposing') {
        if (!entry.sessionFile || sessionWorkerKey(sessionFile) !== entry.key) {
          throw new WorkerManagerError(
            'worker_resume_identity_conflict',
            `Session ${input.sessionId} is already bound to another Pi session file`
          );
        }
        if (entry.cwd !== cwd) {
          throw new WorkerManagerError(
            'worker_resume_cwd_conflict',
            `Session ${input.sessionId} is already bound to workspace ${entry.cwd}`
          );
        }
        if (entry.state !== 'ready' || !entry.slot) {
          throw new WorkerManagerError(
            'session_not_ready',
            `Pi WorkerSlot for ${input.sessionId} is ${entry.state}`,
            true
          );
        }
        if (entry.activeRequestId) {
          throw new WorkerManagerError(
            'session_busy',
            `Session ${input.sessionId} cannot resume while active`,
            true
          );
        }
        this.claimEntry(entry, input.ownerWebContentsId);
        if (
          input.permissions &&
          (entry.permissions?.mode !== input.permissions.mode ||
            entry.permissions?.gear !== input.permissions.gear)
        )
          await this.setPermissions(input.sessionId, input.permissions);
        const history = await this.readHistory(entry, 0, 80);
        await this.commitResumed({
          sessionId: input.sessionId,
          workspacePath: cwd,
          runtimeIdentity: sessionFile,
          agent: DSH_AGENT,
          ...(input.model ? { model: input.model } : {}),
          ...(entry.leafCheckpoint ? { piLeaf: entry.leafCheckpoint } : {}),
        });
        this.claimEntry(
          entry,
          this.resumeFlights.get(input.sessionId)?.ownerWebContentsId ?? input.ownerWebContentsId
        );
        this.publishHistoryTriplet(entry, requestId, history, 'initial');
        return;
      }

      await this.reclaimIdleInternal();
      if (this.entriesBySession.size >= this.capacity) {
        const victim = this.selectEvictionCandidate();
        if (!victim) {
          throw new WorkerManagerError(
            'worker_capacity_reached',
            `Pi worker capacity ${this.capacity} is fully protected by foreground, active, or blocking sessions`,
            true
          );
        }
        await this.evictForCapacity(victim);
      }

      const durableKey = sessionWorkerKey(sessionFile);
      const conflict = this.entriesByKey.get(durableKey);
      if (conflict) {
        throw new WorkerManagerError(
          'worker_session_identity_conflict',
          `Pi session file is already owned by logical session ${conflict.logicalSessionId}`
        );
      }
      // concurrency-02 on DSH (P1-3c): the session lock is a kernel lock that
      // cannot be forced, and the holder this app can reach is its own shared
      // host keeping an agent that never let go. Restarting the host is the
      // takeover — the session_locked card's "Restart engine". The other
      // sessions are interrupted gracefully (the busy ones closed first,
      // decision 155) and reopened in one batch after this resume. A holder
      // outside the app keeps the lock regardless, and the reopen below
      // reports it again.
      if (input.forceTakeover && this.host) await this.restartHost('user');
      const timestamp = this.now();
      entry = {
        key: durableKey,
        temporaryKey: durableKey,
        logicalSessionId: input.sessionId,
        cwd,
        unbound: input.unbound === true,
        tier: input.tier,
        permissions: input.permissions,
        sessionFile,
        // Resume is only reachable through an indexed runtimeIdentity, so the
        // durable commit already happened — for this file, by definition.
        identityCommitted: true,
        slot: null,
        bootstrap: null,
        state: 'creating',
        activeRequestId: null,
        ownerWebContentsId: null,
        acceptEvents: true,
        drainingEvents: false,
        lastUsedAt: timestamp,
        lastIdleAt: timestamp,
        restartAttempts: [],
        generation: 1,
        configGeneration: this.configGeneration,
        error: null,
        leafCheckpoint: null,
        branchRevision: 0,
        mutationInFlight: null,
        stderrPending: '',
        recentStderr: [],
      };
      this.entriesByKey.set(durableKey, entry);
      this.entriesBySession.set(input.sessionId, entry);
      this.claimEntry(entry, input.ownerWebContentsId);
      this.state = 'ready';

      try {
        const created = await this.spawnForEntry(
          entry,
          {
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
          },
          // Third argument, not folded into `selection`: a takeover is a
          // property of THIS spawn, where selection is what the session runs
          // on. `spawnForEntry` is also reached from the crash restart and the
          // fork, neither of which may ever inherit it.
          { ...(input.forceTakeover ? { forceTakeover: true } : {}), userInitiated: true }
        );
        const reopenedFile = created.bootstrap.sessionFile
          ? normalizeWorkerPath(created.bootstrap.sessionFile, 'Pi session file')
          : null;
        if (!reopenedFile) {
          throw new WorkerManagerError(
            'worker_resume_identity_mismatch',
            'Pi worker did not open the requested exact session file'
          );
        }
        let resumedFile = sessionFile;
        if (sessionWorkerKey(reopenedFile) !== durableKey) {
          // A pre-v4 session cannot be resumed where it lies: the native runtime
          // converts it and opens the copy, so what comes back is legitimately
          // not the file Main asked for. Accept that only when the worker names
          // this exact request as the copy's source — anything else is the
          // silent divergence this check exists to catch.
          const declaredSource =
            typeof created.bootstrap.sessionSourceFile === 'string'
              ? normalizeWorkerPath(created.bootstrap.sessionSourceFile, 'Pi session file')
              : null;
          if (!declaredSource || sessionWorkerKey(declaredSource) !== durableKey) {
            throw new WorkerManagerError(
              'worker_resume_identity_mismatch',
              'Pi worker did not open the requested exact session file'
            );
          }
          // Move the durable identity onto the copy. Leaving it on the legacy
          // file would make every later resume convert and mismatch again.
          this.adoptRematerializedFile(entry, reopenedFile);
          await this.bindRuntimeIdentity(input.sessionId, reopenedFile);
          resumedFile = reopenedFile;
        }
        const history = created.bootstrap.initialHistory;
        if (!isWorkerHistoryResult(history)) {
          throw new WorkerManagerError(
            'worker_resume_history_missing',
            'Pi worker did not return initial branch history'
          );
        }
        this.validateHistoryResult(entry, history);
        await this.commitResumed({
          sessionId: input.sessionId,
          workspacePath: cwd,
          runtimeIdentity: resumedFile,
          agent: DSH_AGENT,
          ...(input.model ? { model: input.model } : {}),
          piLeaf: created.bootstrap.leaf,
        });
        entry.leafCheckpoint = created.bootstrap.leaf;
        entry.bootstrap = { ...created.bootstrap, sessionFile: reopenedFile };
        entry.state = 'ready';
        entry.error = null;
        entry.lastIdleAt = this.now();
        this.claimEntry(
          entry,
          this.resumeFlights.get(input.sessionId)?.ownerWebContentsId ?? input.ownerWebContentsId
        );
        this.publishHistoryTriplet(entry, requestId, history, 'initial');
        this.scheduleOrphanCollection();
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        await this.retireAndDispose(entry, 'slot-dispose').catch(() => undefined);
        this.updateManagerState();
        throw error;
      }
    }).then(() => requestId);
    this.resumeFlights.set(input.sessionId, {
      fingerprint,
      promise,
      ownerWebContentsId: input.ownerWebContentsId,
    });
    const clearFlight = () => {
      if (this.resumeFlights.get(input.sessionId)?.promise === promise) {
        this.resumeFlights.delete(input.sessionId);
      }
    };
    void promise.then(clearFlight, clearFlight);
    return promise;
  }

  async loadHistoryPage(input: {
    sessionId: string;
    offset: number;
    limit?: number;
    ownerWebContentsId?: number;
  }): Promise<string> {
    const requestId = nextRequestId('history');
    const entry = this.requireReadySession(input.sessionId);
    this.assertIdleEntry(entry, 'paginate history');
    this.claimEntry(entry, input.ownerWebContentsId);
    const slot = entry.slot;
    const generation = entry.generation;
    const branchRevision = entry.branchRevision;
    const assertAuthority = () => {
      if (
        !slot ||
        entry.slot !== slot ||
        !this.isAuthoritative(entry, generation) ||
        entry.branchRevision !== branchRevision
      ) {
        throw new WorkerManagerError(
          'worker_history_stale_generation',
          `History page for ${input.sessionId} arrived from a retired WorkerSlot`,
          true
        );
      }
    };
    const previous = this.historyPageFlights.get(input.sessionId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        assertAuthority();
        const history = await this.readHistory(entry, input.offset, input.limit ?? 80);
        assertAuthority();
        this.dispatchHistory(entry, requestId, history, 'older');
      });
    this.historyPageFlights.set(input.sessionId, task);
    const clear = () => {
      if (this.historyPageFlights.get(input.sessionId) === task) {
        this.historyPageFlights.delete(input.sessionId);
      }
    };
    void task.then(clear, clear);
    return task.then(() => requestId);
  }

  /**
   * R02-b — the slash commands available to the composer.
   *
   * Four ways this deliberately differs from every other read on this class:
   *
   *  - **No `requireReadySession`.** The composer asks while the user types,
   *    and on the start screen there is no session at all. That is the ordinary
   *    case, so it answers with an empty list instead of throwing.
   *  - **No `assertIdleEntry`.** Listing commands is read-only, and the moment
   *    it is needed is often mid-turn.
   *  - **No `claimEntry`.** Reading a list is not taking ownership of a session.
   *  - **A stand-in must share the workspace** (main-host-01). The fallback
   *    used to take the first ready worker in the pool, on the strength of a
   *    comment claiming the command set does not vary by working directory
   *    because project scope is withheld. Decision 009 made project scope
   *    trusted and loaded (decision 009), so it does vary: every
   *    row carries an absolute `path`, and half of them come from the
   *    answering worker's `<cwd>/.pi/skills` and `<cwd>/.pi/prompts`. A named
   *    session is therefore only ever answered by a worker with the same
   *    `cwd`, and a session this pool has never started — the lazy-start case,
   *    which has no entry and so no workspace to compare — gets an empty list
   *    rather than another repository's menu.
   *
   * The unnamed call is the start screen, where there is no session to hand a
   * wrong list to and no workspace to match against; it keeps the any-worker
   * fallback so the menu is not empty for the whole first turn.
   *
   * Not cached. The RPC is in-process message passing and the menu asks once
   * per open, while a cache would keep a skill the user just installed hidden
   * until something invalidated it.
   */
  async getSlashCommands(
    input: { sessionId?: string } = {}
  ): Promise<{ commands: WorkerSlashCommandInfo[]; truncated: boolean }> {
    const named = input.sessionId ? this.entriesBySession.get(input.sessionId) : undefined;
    const isReady = (candidate: ManagedSlot): boolean =>
      candidate.state === 'ready' && candidate.slot !== null;
    let entry: ManagedSlot | undefined;
    if (!input.sessionId) {
      entry = [...this.entriesBySession.values()].find(isReady);
    } else if (named && isReady(named)) {
      entry = named;
    } else if (named) {
      const workspace = named.cwd;
      entry = [...this.entriesBySession.values()].find(
        (candidate) => isReady(candidate) && candidate.cwd === workspace
      );
    }
    if (!entry?.slot) return { commands: [], truncated: false };

    const result = await entry.slot.request<WorkerCommandsResult, WorkerCommandsPayload>(
      'worker.commands',
      { logicalSessionId: entry.logicalSessionId }
    );
    // A malformed list costs the menu, never the session: unlike a tree or a
    // history page, nothing downstream acts on these rows.
    if (!isWorkerCommandsResult(result)) return { commands: [], truncated: false };
    return {
      commands: sanitizeWorkerCommandRows(result.commands),
      truncated: result.truncated === true,
    };
  }

  /**
   * R02-c — manual context compaction (`/compact`).
   *
   * A mutation, so unlike `getSlashCommands` above it takes the full guard set:
   * the session must be ready, idle, and claimed by this window. pi aborts the
   * running turn and never resumes it, so letting this through mid-turn would
   * silently discard work the user is watching.
   */
  async compactSession(input: {
    sessionId: string;
    instructions?: string;
    ownerWebContentsId?: number;
  }): Promise<WorkerCompactResult> {
    const entry = this.requireReadySession(input.sessionId);
    this.assertIdleEntry(entry, 'compact the conversation');
    this.claimEntry(entry, input.ownerWebContentsId);
    const result = await entry.slot?.request<WorkerCompactResult, WorkerCompactPayload>(
      'worker.compact',
      {
        logicalSessionId: entry.logicalSessionId,
        ...(input.instructions ? { instructions: input.instructions } : {}),
      },
      // A summary is a full provider request, so the warm 10s default is the
      // wrong clock: it expired while the worker was still summarizing, and
      // because a timeout only rejects the pending promise, the worker went on
      // to write the compaction the user had just been told had failed. The
      // worker now aborts itself first — this budget only has to outlast that.
      { timeoutMs: WORKER_COMPACT_REQUEST_TIMEOUT_MS }
    );
    if (!result || result.compacted !== true) {
      throw new WorkerManagerError('worker_compact_failed', 'Pi worker could not compact');
    }
    return result;
  }

  /**
   * dsh-rebase P1-7a (decisions 072 rule 2, 118) — one engine command run out
   * of band: the goal bar's pause, resume, edit and clear.
   *
   * A mutation, so the session must be ready and is claimed by the window —
   * but, unlike `compactSession`, NOT refused while a turn runs: pausing the
   * goal round that is running is the point, and the engine cancels that
   * round itself. The worker bounds the command inside the warm request
   * timeout; its answer (DSH's text, `ok` or not) goes back as it came.
   */
  async runSessionCommand(input: {
    sessionId: string;
    line: string;
    ownerWebContentsId?: number;
  }): Promise<WorkerCommandResult> {
    const entry = this.requireReadySession(input.sessionId);
    this.claimEntry(entry, input.ownerWebContentsId);
    const result = await entry.slot?.request<WorkerCommandResult, WorkerCommandPayload>(
      'worker.command',
      { logicalSessionId: entry.logicalSessionId, line: input.line }
    );
    if (!isWorkerCommandResult(result)) {
      throw new WorkerManagerError('worker_command_failed', 'The worker could not run the command');
    }
    return result;
  }

  /**
   * dsh-rebase P1-7a (decisions 113 rule 12, 118) — the panels' current
   * projections, for a renderer that missed the events (a reload, a chat
   * switched to, a session reopened with no event since).
   *
   * A read, like `getSlashCommands`: no claim, no idle check, and a session
   * without a ready slot answers no panels rather than an error — the
   * renderer asks for every chat it shows, and most of them are not running.
   */
  async getSessionPanels(input: { sessionId: string }): Promise<WorkerPanelsResult> {
    const entry = this.entriesBySession.get(input.sessionId);
    if (!entry || entry.state !== 'ready' || !entry.slot) return { projections: [] };
    const result = await entry.slot.request<WorkerPanelsResult, WorkerPanelsPayload>(
      'worker.panels',
      { logicalSessionId: entry.logicalSessionId }
    );
    return sanitizeWorkerPanels(result);
  }

  /**
   * dsh-rebase P1-7b (decisions 069, 119) — the jobs window's stop for one
   * background job. A mutation, so the session must be ready and is claimed
   * by the window; not refused while a turn runs (a background job is what
   * runs beside a turn). The engine settles the job `killed` once its work
   * stops; the `jobs` projection reports it.
   */
  async killSessionJob(input: {
    sessionId: string;
    jobId: string;
    ownerWebContentsId?: number;
  }): Promise<WorkerJobKillResult> {
    const entry = this.requireReadySession(input.sessionId);
    this.claimEntry(entry, input.ownerWebContentsId);
    const result = await entry.slot?.request<WorkerJobKillResult, WorkerJobKillPayload>(
      'worker.job.kill',
      { logicalSessionId: entry.logicalSessionId, jobId: input.jobId }
    );
    if (!isWorkerJobKillResult(result)) {
      throw new WorkerManagerError('worker_job_failed', 'The worker could not stop the job');
    }
    return result;
  }

  /**
   * dsh-rebase P1-7b (decision 119) — one job's output for the jobs window,
   * read without moving the model's cursor. A read, like `getSessionPanels`:
   * no claim, and a session without a ready slot answers `null` (its jobs
   * went with its host) rather than an error.
   */
  async readSessionJob(input: {
    sessionId: string;
    jobId: string;
    from?: number;
    maxBytes?: number;
  }): Promise<WorkerJobReadResult | null> {
    const entry = this.entriesBySession.get(input.sessionId);
    if (!entry || entry.state !== 'ready' || !entry.slot) return null;
    const result = await entry.slot.request<WorkerJobReadResult, WorkerJobReadPayload>(
      'worker.job.read',
      {
        logicalSessionId: entry.logicalSessionId,
        jobId: input.jobId,
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}),
      }
    );
    return sanitizeWorkerJobRead(result);
  }

  /**
   * dsh-rebase P1-7b (decisions 069, 119) — interrupt one continuable
   * subagent's current run, as its human parent (the subagents window, and
   * the jobs window's row for it). A mutation: ready and claimed.
   */
  async interruptSubagent(input: {
    sessionId: string;
    childId: string;
    ownerWebContentsId?: number;
  }): Promise<WorkerSubagentInterruptResult> {
    const entry = this.requireReadySession(input.sessionId);
    this.claimEntry(entry, input.ownerWebContentsId);
    const result = await entry.slot?.request<
      WorkerSubagentInterruptResult,
      WorkerSubagentInterruptPayload
    >('worker.subagent.interrupt', {
      logicalSessionId: entry.logicalSessionId,
      childId: input.childId,
    });
    if (!isWorkerSubagentInterruptResult(result)) {
      throw new WorkerManagerError(
        'worker_subagent_failed',
        'The worker could not interrupt the subagent'
      );
    }
    return result;
  }

  async getSessionTree(input: {
    sessionId: string;
    requestSequence: number;
    ownerWebContentsId?: number;
  }): Promise<{
    sessionKey: string;
    requestSequence: number;
    branchRevision: number;
    snapshot: SessionTreeSnapshot;
  }> {
    const entry = this.requireReadySession(input.sessionId);
    this.assertIdleEntry(entry, 'load the session tree');
    this.claimEntry(entry, input.ownerWebContentsId);
    const slot = entry.slot;
    const generation = entry.generation;
    const branchRevision = entry.branchRevision;
    const result = await this.readTree(entry);
    if (
      !slot ||
      entry.slot !== slot ||
      !this.isAuthoritative(entry, generation) ||
      entry.branchRevision !== branchRevision
    ) {
      throw new WorkerManagerError(
        'worker_tree_stale',
        `Session tree for ${input.sessionId} lost slot or branch authority`,
        true
      );
    }
    return {
      sessionKey: `${entry.logicalSessionId}:${entry.key}`,
      requestSequence: input.requestSequence,
      branchRevision,
      snapshot: result.snapshot,
    };
  }

  async rewindSession(input: {
    sessionId: string;
    entryId: string;
    confirmed: true;
    ownerWebContentsId?: number;
  }): Promise<{
    requestId: string;
    sessionKey: string;
    leaf: PiLeafCheckpoint;
    editorText?: string;
    tree: SessionTreeSnapshot;
  }> {
    if (input.confirmed !== true) {
      throw new WorkerManagerError(
        'rewind_confirmation_required',
        'Session rewind requires explicit confirmation'
      );
    }
    const requestId = nextRequestId('rewind');
    return this.serialize(async () => {
      const entry = this.requireReadySession(input.sessionId);
      this.assertIdleEntry(entry, 'rewind');
      this.claimEntry(entry, input.ownerWebContentsId);
      entry.mutationInFlight = 'rewind';
      try {
        const slot = entry.slot;
        const generation = entry.generation;
        const result = await slot?.request<WorkerRewindResult, WorkerRewindPayload>(
          'worker.rewind',
          {
            logicalSessionId: entry.logicalSessionId,
            targetEntryId: input.entryId,
            confirmed: true,
          }
        );
        if (!isWorkerRewindResult(result)) {
          throw new WorkerManagerError(
            'worker_invalid_rewind_result',
            'Pi worker returned an invalid rewind result'
          );
        }
        this.validateHistoryResult(entry, result.history);
        this.validateTreeResult(entry, result.tree);
        if (!slot || entry.slot !== slot || !this.isAuthoritative(entry, generation)) {
          throw new WorkerManagerError(
            'worker_rewind_stale',
            `Rewind for ${input.sessionId} arrived from a retired WorkerSlot`,
            true
          );
        }
        try {
          await this.commitPiLeaf({
            sessionId: entry.logicalSessionId,
            runtimeIdentity: result.sessionFile,
            piLeaf: result.leaf,
          });
        } catch (error) {
          await this.retireAndDispose(entry, 'slot-dispose').catch(() => undefined);
          throw error;
        }
        entry.leafCheckpoint = result.leaf;
        entry.branchRevision += 1;
        entry.lastUsedAt = this.now();
        entry.lastIdleAt = this.now();
        this.dispatchHistory(entry, requestId, result.history, 'branch');
        this.dispatch({
          type: 'session.status',
          sessionId: entry.logicalSessionId,
          requestId,
          payload: { status: 'idle' },
        });
        return {
          requestId,
          sessionKey: `${entry.logicalSessionId}:${entry.key}`,
          leaf: result.leaf,
          ...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
          tree: result.tree.snapshot,
        };
      } finally {
        if (this.entriesBySession.get(entry.logicalSessionId) === entry) {
          entry.mutationInFlight = null;
        }
      }
    });
  }

  async forkSession(input: {
    sourceSessionId: string;
    entryId: string;
    sourceTitle: string;
    model?: string;
    ownerWebContentsId?: number;
  }): Promise<{ requestId: string; session: SessionIndexEntry }> {
    const requestId = nextRequestId('fork');
    return this.serialize(async () => {
      const source = this.requireReadySession(input.sourceSessionId);
      this.assertIdleEntry(source, 'fork');
      this.claimEntry(source, input.ownerWebContentsId);
      source.mutationInFlight = 'fork';
      try {
        await this.reclaimIdleInternal();
        if (this.entriesBySession.size >= this.capacity) {
          const victim = this.selectEvictionCandidate();
          if (!victim) {
            throw new WorkerManagerError(
              'worker_capacity_reached',
              `Pi worker capacity ${this.capacity} has no safe slot for a fork`,
              true
            );
          }
          await this.evictForCapacity(victim);
        }

        const sourceSlot = source.slot;
        const sourceGeneration = source.generation;
        // dsh-rebase P1-4b (decision 027 rule 4): minted before asking, so the
        // DSH worker names the child session after it (`aiclient-<id>`).
        const sessionId = `session-fork-${randomUUID()}`;
        const fork = await sourceSlot?.request<WorkerForkResult, WorkerForkPayload>('worker.fork', {
          logicalSessionId: source.logicalSessionId,
          entryId: input.entryId,
          targetLogicalSessionId: sessionId,
        });
        if (!isWorkerForkResult(fork)) {
          throw new WorkerManagerError(
            'worker_invalid_fork_result',
            'Pi worker returned an invalid fork result'
          );
        }
        if (
          !sourceSlot ||
          source.slot !== sourceSlot ||
          !this.isAuthoritative(source, sourceGeneration) ||
          source.sessionFile !== fork.sourceSessionFile
        ) {
          throw new WorkerManagerError(
            'worker_fork_stale',
            `Fork source ${input.sourceSessionId} lost slot authority`,
            true
          );
        }

        const sessionFile = normalizeWorkerPath(fork.sessionFile, 'Fork Pi session file');
        const durableKey = sessionWorkerKey(sessionFile);
        if (this.entriesByKey.has(durableKey) || this.entriesBySession.has(sessionId)) {
          const discarded = await this.discardForkFile(source, sessionFile);
          if (!discarded) {
            throw new WorkerManagerError(
              'worker_fork_cleanup_failed',
              `Fork identity collided and the staged Pi file could not be removed: ${sessionFile}`,
              true
            );
          }
          throw new WorkerManagerError(
            'worker_session_identity_conflict',
            'Fork Pi session file is already owned'
          );
        }
        const timestamp = this.now();
        const target: ManagedSlot = {
          key: durableKey,
          temporaryKey: durableKey,
          logicalSessionId: sessionId,
          cwd: source.cwd,
          // A fork shares its source's directory, so it must share its trust
          // posture too — forking must never launder a scratch session into a
          // trusted one.
          unbound: source.unbound,
          // Deliberately NOT inherited, unlike `unbound`. Inheriting the trust
          // posture is the SAFE direction (a scratch fork stays untrusted);
          // inheriting the tier would be the unsafe one — a fork of a
          // `fullopen` chat would silently start wide open, while its own
          // (empty) stored preference makes the composer chip read `pragmatic`.
          tier: undefined,
          permissions: undefined,
          sessionFile,
          // Unlike a new session, a fork's JSONL is written eagerly: Pi's
          // createBranchedSession writes the header plus the copied branch, and
          // the worker preflights the file before this point.
          identityCommitted: true,
          slot: null,
          bootstrap: null,
          state: 'creating',
          activeRequestId: null,
          ownerWebContentsId: null,
          acceptEvents: true,
          drainingEvents: false,
          lastUsedAt: timestamp,
          lastIdleAt: timestamp,
          restartAttempts: [],
          generation: 1,
          configGeneration: this.configGeneration,
          error: null,
          leafCheckpoint: fork.leaf,
          branchRevision: 0,
          mutationInFlight: null,
          stderrPending: '',
          recentStderr: [],
        };
        this.entriesByKey.set(durableKey, target);
        this.entriesBySession.set(sessionId, target);
        this.claimEntry(target, input.ownerWebContentsId);
        let indexCommitted = false;

        try {
          const created = await this.spawnForEntry(
            target,
            { ...(input.model ? { model: input.model } : {}) },
            { userInitiated: true }
          );
          const reopenedFile = created.bootstrap.sessionFile
            ? normalizeWorkerPath(created.bootstrap.sessionFile, 'Fork Pi session file')
            : null;
          if (!reopenedFile || sessionWorkerKey(reopenedFile) !== durableKey) {
            throw new WorkerManagerError(
              'worker_fork_identity_mismatch',
              'Fork WorkerSlot did not exact-open the generated Pi session file'
            );
          }
          const history = created.bootstrap.initialHistory;
          if (!isWorkerHistoryResult(history)) {
            throw new WorkerManagerError(
              'worker_fork_history_missing',
              'Fork WorkerSlot did not return initial branch history'
            );
          }
          this.validateHistoryResult(target, history);
          target.bootstrap = { ...created.bootstrap, sessionFile: reopenedFile };
          target.leafCheckpoint = created.bootstrap.leaf;
          const indexed = await this.createForked({
            sessionId,
            runtimeIdentity: sessionFile,
            piLeaf: created.bootstrap.leaf,
            agent: DSH_AGENT,
            workspacePath: source.cwd,
            // P1-7e e6 (problem 40, decision 145): worded in the app's
            // language when the fork is made, like decision 131's branch title.
            title: forkSessionTitle(input.sourceTitle, (key, params) =>
              translate(getCurrentLocale(), key, params)
            ),
            ...(input.model ? { model: input.model } : {}),
            // session-index-02: the row has to carry the posture the spawn
            // above already inherited. `workspacePath` is the source's scratch
            // directory, which matches no project folder — without this key the
            // renderer cannot materialize the fork it just created, and the
            // next start drops the row as an orphan. Absent (not `false`) for a
            // bound session, like every other writer of this field.
            ...(source.unbound ? { unbound: true } : {}),
            updatedAt: this.now(),
            archived: false,
          });
          indexCommitted = true;
          // session-index-04: the file is a session now, so the source worker
          // must stop listing it as an uncommitted artifact it may delete.
          // After the commit and best-effort by design — the row exists either
          // way, and a stale claim is a permission a later caller could misuse,
          // not data loss to roll back.
          await this.acceptForkFile(source, sessionFile);
          target.state = 'ready';
          target.error = null;
          this.dispatch({
            type: 'session.created',
            sessionId,
            requestId,
            payload: {
              agent: DSH_AGENT,
              runtimeIdentity: sessionFile,
              ...this.gatePayload(target),
            },
          });
          this.dispatchHistory(target, requestId, history, 'initial');
          this.dispatch({
            type: 'session.status',
            sessionId,
            requestId,
            payload: { status: 'idle' },
          });
          return { requestId, session: indexed };
        } catch (error) {
          let stagedFileDiscarded = true;
          if (!indexCommitted) {
            stagedFileDiscarded = target.slot
              ? await this.discardForkFile(target, sessionFile)
              : false;
            if (!stagedFileDiscarded) {
              stagedFileDiscarded = await this.discardForkFile(source, sessionFile);
            }
          }
          let disposalError: unknown;
          try {
            await this.retireAndDispose(target, 'slot-dispose');
          } catch (cleanupError) {
            disposalError = cleanupError;
          }
          if (!stagedFileDiscarded) {
            throw new WorkerManagerError(
              'worker_fork_cleanup_failed',
              `Fork failed and the staged Pi file could not be confirmed removed: ${sessionFile}`,
              true
            );
          }
          if (disposalError) {
            throw new WorkerManagerError(
              'worker_fork_cleanup_failed',
              `Fork failed and the provisional WorkerSlot did not confirm disposal: ${disposalError instanceof Error ? disposalError.message : String(disposalError)}`,
              true
            );
          }
          throw error;
        }
      } finally {
        if (
          this.entriesBySession.get(source.logicalSessionId) === source &&
          source.mutationInFlight === 'fork'
        ) {
          source.mutationInFlight = null;
        }
      }
    });
  }

  async send(input: {
    sessionId: string;
    attemptId: string;
    text: string;
    attachments?: SessionAttachment[];
    model?: string;
    effort?: SessionEffortLevel;
    ownerWebContentsId?: number;
  }): Promise<string> {
    return this.startTurn(input);
  }

  /**
   * T135 / decision 045 — the failure card's Continue: re-run the last turn
   * from the context before its failure, with no new user message.
   *
   * The same admission path as `send`, on purpose: the latch, the busy gate,
   * the Stop watchdog and the crash path cannot tell a retried turn from any
   * other, so Stop and "end conversation" behave exactly as they do for a
   * send (decision 046). A worker with nothing to re-run rejects with
   * `retry_unavailable` and leaves no latch behind.
   */
  async retryLastTurn(input: {
    sessionId: string;
    attemptId: string;
    model?: string;
    effort?: SessionEffortLevel;
    ownerWebContentsId?: number;
  }): Promise<string> {
    return this.startTurn({ ...input, text: '' }, 'retry');
  }

  private async startTurn(
    input: {
      sessionId: string;
      attemptId: string;
      text: string;
      attachments?: SessionAttachment[];
      model?: string;
      effort?: SessionEffortLevel;
      ownerWebContentsId?: number;
    },
    mode?: 'retry'
  ): Promise<string> {
    const entry = this.requireReadySession(input.sessionId);
    if (!input.attemptId.trim()) {
      throw new WorkerManagerError('invalid_send_attempt', 'Pi send attemptId must be non-empty');
    }
    this.claimEntry(entry, input.ownerWebContentsId);
    if (entry.activeRequestId || entry.mutationInFlight !== null) {
      throw new WorkerManagerError(
        'session_busy',
        entry.activeRequestId
          ? `Session ${input.sessionId} already has active turn ${entry.activeRequestId}`
          : `Session ${input.sessionId} is applying ${entry.mutationInFlight}`,
        true
      );
    }
    const requestId = nextRequestId('send');
    const payload: WorkerSendPayload = {
      logicalSessionId: input.sessionId,
      requestId,
      attemptId: input.attemptId,
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(mode ? { mode } : {}),
    };
    entry.activeRequestId = requestId;
    entry.reportedStatus = undefined;
    entry.lastUsedAt = this.now();
    try {
      const result = await entry.slot?.request<WorkerSendResult, WorkerSendPayload>(
        'worker.send',
        payload
      );
      if (!isWorkerSendResult(result) || result.requestId !== requestId) {
        throw new WorkerManagerError(
          'worker_invalid_send_ack',
          'Pi worker returned an invalid send acknowledgement'
        );
      }
      return requestId;
    } catch (error) {
      if (entry.activeRequestId === requestId) {
        entry.activeRequestId = null;
        entry.lastIdleAt = this.now();
      }
      // Renamed into this layer's vocabulary so the renderer can match it the
      // way it matches `session_busy`: the worker's code only survives the RPC
      // as `remoteError`, and the IPC crossing keeps nothing but the message.
      const remote = remoteError(error);
      if (remote?.code === WORKER_RETRY_UNAVAILABLE) {
        throw new WorkerManagerError('retry_unavailable', remote.message);
      }
      throw error;
    }
  }

  /**
   * decision 046 rule 2 — a Stop always ends in `session.stopped` + a settling
   * status, within {@link STOP_WATCHDOG_MS}:
   *
   *  - no worker Main can reach, or a worker with no turn: Main answers at once
   *    (`stopCause: 'no_active_turn'`) and drops its own latch;
   *  - a worker that took the stop: the turn's own terminal answers, and the
   *    watchdog restarts the worker (`stopCause: 'forced'`) if it never comes.
   */
  async stop(sessionId: string): Promise<string> {
    const requestId = nextRequestId('stop');
    const entry = this.entriesBySession.get(sessionId);
    if (!entry?.slot || entry.state !== 'ready') {
      // Nothing here can be running a turn: a crash or a close already
      // reported the one it cut short, and a slot still spawning has none.
      this.settleWithoutTurn(sessionId, entry, requestId);
      return requestId;
    }
    entry.lastUsedAt = this.now();
    const slot = entry.slot;
    // Armed before the request, not on the ACK: a worker too wedged to answer
    // `worker.stop` at all is exactly the case the watchdog is for.
    this.armStopWatchdog(entry, slot);
    const payload: WorkerStopPayload = { logicalSessionId: sessionId, reason: 'user' };
    const result = await slot.request<WorkerStopResult, WorkerStopPayload>('worker.stop', payload);
    if (!isWorkerStopResult(result)) {
      throw new WorkerManagerError(
        'worker_invalid_stop_ack',
        'Pi worker returned an invalid stop acknowledgement'
      );
    }
    if (!result.stopped && this.ownsLiveSlot(entry, slot)) {
      this.settleWithoutTurn(sessionId, entry, requestId);
    }
    return requestId;
  }

  /**
   * Ctrl+Enter while a turn runs (dsh-rebase decision 093): hand the message
   * to the worker, which steers it into the running turn. No latch is taken
   * or changed — the turn it joins is the one already running, and its echo
   * rides that turn's requestId.
   *
   * `interjected: false` means nothing was sent and the renderer sends the
   * message the ordinary way. When the worker reports no turn at all
   * (`turnActive: false`, decision 046), a latch Main still holds is settled
   * the way a Stop that found nothing is, so that ordinary send is admitted.
   */
  async interject(
    sessionId: string,
    input: { attemptId: string; text: string; attachments?: SessionAttachment[] }
  ): Promise<WorkerInterjectResult> {
    const entry = this.entriesBySession.get(sessionId);
    if (!entry?.slot || entry.state !== 'ready') return { interjected: false };
    entry.lastUsedAt = this.now();
    const slot = entry.slot;
    const payload: WorkerInterjectPayload = {
      logicalSessionId: entry.logicalSessionId,
      attemptId: input.attemptId,
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    };
    const result = await slot.request<WorkerInterjectResult, WorkerInterjectPayload>(
      'worker.interject',
      payload
    );
    if (!isWorkerInterjectResult(result)) {
      throw new WorkerManagerError(
        'worker_invalid_interject_ack',
        'Pi worker returned an invalid interject acknowledgement'
      );
    }
    if (!result.interjected && result.turnActive === false && this.ownsLiveSlot(entry, slot)) {
      this.settleWithoutTurn(sessionId, entry, nextRequestId('interject'));
    }
    return {
      interjected: result.interjected,
      ...(result.turnActive !== undefined ? { turnActive: result.turnActive } : {}),
    };
  }

  /** `slot` is still the one this session's live, ready entry runs on. */
  private ownsLiveSlot(entry: ManagedSlot, slot: WorkerSlot): boolean {
    return (
      entry.slot === slot &&
      entry.state === 'ready' &&
      this.entriesBySession.get(entry.logicalSessionId) === entry
    );
  }

  /**
   * decision 046 rule 2 — answer a Stop that found no turn to stop.
   *
   * Main's latch goes too: a turn the worker does not have is not one Main may
   * keep refusing sends for. Idempotent on purpose — the renderer may already
   * be idle, and `no_active_turn` tells it nothing was interrupted.
   */
  private settleWithoutTurn(
    sessionId: string,
    entry: ManagedSlot | undefined,
    requestId: string
  ): void {
    const latched = entry?.activeRequestId ?? null;
    if (entry) {
      this.clearStopWatchdog(entry);
      entry.activeRequestId = null;
      entry.reportedStatus = undefined;
      entry.workerTurn = undefined;
      entry.lastIdleAt = this.now();
    }
    if (latched) {
      console.warn(
        `[worker-manager] ${sessionId}: dropped turn ${latched}, which its worker was no longer running`
      );
    }
    const eventRequestId = latched ?? requestId;
    this.dispatch({
      type: 'session.stopped',
      sessionId,
      requestId: eventRequestId,
      payload: { stopCause: 'no_active_turn' },
    });
    this.dispatch({
      type: 'session.status',
      sessionId,
      requestId: eventRequestId,
      payload: { status: 'idle' },
    });
  }

  /** A second Stop keeps the first deadline rather than extending it. */
  private armStopWatchdog(entry: ManagedSlot, slot: WorkerSlot): void {
    if (entry.stopWatchdog !== undefined) return;
    const generation = entry.generation;
    const timer = setTimeout(() => {
      if (entry.stopWatchdog === timer) entry.stopWatchdog = undefined;
      this.forceStop(entry, slot, generation);
    }, this.stopWatchdogMs);
    timer.unref?.();
    entry.stopWatchdog = timer;
  }

  private clearStopWatchdog(entry: ManagedSlot): void {
    if (entry.stopWatchdog === undefined) return;
    clearTimeout(entry.stopWatchdog);
    entry.stopWatchdog = undefined;
  }

  /**
   * decision 046 rule 2 — the watchdog fired: the worker took the Stop and never
   * ended the turn. Main stops waiting on it and restarts the slot through the
   * crash path, which is the one teardown that does not need the worker's help.
   *
   * On the shared DSH host that restart is dsh-rebase decision 021's ladder:
   * closing this session's channel (A), and a host restart if the channel
   * never confirms it closed (B, `escalateStuckChannel`). The user's Stop is
   * settled here either way.
   */
  private forceStop(entry: ManagedSlot, slot: WorkerSlot, generation: number): void {
    if (!this.ownsLiveSlot(entry, slot) || !this.isAuthoritative(entry, generation)) return;
    const reason = `stop did not settle within ${this.stopWatchdogMs}ms`;
    console.warn(`[worker-manager] ${entry.logicalSessionId}: ${reason}; restarting its worker`);
    const { turnId } = this.enterCrashed(entry, reason);
    this.dispatchForcedStop(entry.logicalSessionId, turnId);
    this.updateManagerState();
    void this.serialize(() => this.restartEntry(entry));
  }

  /** `session.stopped` (`forced`) and the idle that settles it. */
  private dispatchForcedStop(sessionId: string, turnId: string | null): void {
    const requestId = turnId ?? nextRequestId('stop');
    this.dispatch({
      type: 'session.stopped',
      sessionId,
      requestId,
      payload: { stopCause: 'forced' },
    });
    this.dispatch({
      type: 'session.status',
      sessionId,
      requestId,
      payload: { status: 'idle' },
    });
  }

  /**
   * Answer one `permission.requested` the native backend asked.
   *
   * No ownership or generation guard of its own: a permission is keyed by the
   * tool call inside one live turn, so the worker itself is the authority on
   * whether the id is still parked — it answers `handled: false` when it is
   * not, and the card treats that as "already settled".
   */
  async respondPermission(input: {
    sessionId: string;
    permissionId: string;
    decision: PermissionDecisionId;
  }): Promise<boolean> {
    const entry = this.entriesBySession.get(input.sessionId);
    if (!entry?.slot) {
      throw new WorkerManagerError(
        'session_not_ready',
        `Session ${input.sessionId} has no worker to answer a permission`
      );
    }
    const payload: WorkerPermissionRespondPayload = {
      logicalSessionId: entry.logicalSessionId,
      permissionId: input.permissionId,
      decision: input.decision,
    };
    const result = await entry.slot.request<
      WorkerPermissionRespondResult,
      WorkerPermissionRespondPayload
    >('worker.permission.respond', payload);
    if (!isWorkerPermissionRespondResult(result)) {
      throw new WorkerManagerError(
        'worker_invalid_permission_ack',
        'Pi worker returned an invalid permission acknowledgement'
      );
    }
    return result.handled;
  }

  /**
   * F5 — answer one `question.requested`.
   *
   * Same thinness and the same reasoning as `respondPermission` above: the
   * question is parked inside one live turn, so the worker is the authority on
   * whether the id is still waiting.
   */
  async respondQuestion(input: {
    sessionId: string;
    questionId: string;
    answers?: Record<string, string>;
    response?: string;
    cancel?: boolean;
  }): Promise<boolean> {
    const entry = this.entriesBySession.get(input.sessionId);
    if (!entry?.slot) {
      throw new WorkerManagerError(
        'session_not_ready',
        `Session ${input.sessionId} has no worker to answer a question`
      );
    }
    const payload: WorkerQuestionRespondPayload = {
      logicalSessionId: entry.logicalSessionId,
      questionId: input.questionId,
      ...(input.answers ? { answers: input.answers } : {}),
      ...(input.response ? { response: input.response } : {}),
      ...(input.cancel ? { cancel: true } : {}),
    };
    const result = await entry.slot.request<
      WorkerQuestionRespondResult,
      WorkerQuestionRespondPayload
    >('worker.question.respond', payload);
    if (!isWorkerQuestionRespondResult(result)) {
      throw new WorkerManagerError(
        'worker_invalid_question_ack',
        'Pi worker returned an invalid question acknowledgement'
      );
    }
    return result.handled;
  }

  /**
   * P5-2-3 — open the preview the runtime asked for and tell it what happened.
   *
   * Not `async` from the caller's point of view on purpose: `handleWorkerEvent`
   * is the event pump, and blocking it on a window load would stall every other
   * event from every session. The tool call is already parked on the answer.
   *
   * Failures are reported, never swallowed. A promise that never settles here
   * is a `browser_preview` call that hangs until the turn is stopped, which is
   * the one outcome worse than "this build has no preview surface".
   */
  private async servePreview(
    entry: ManagedSlot,
    generation: number,
    payload: unknown
  ): Promise<void> {
    const previewId = readString(payload, 'previewId');
    const path = readString(payload, 'path');
    if (!previewId || !path) return;
    const focus =
      !!payload &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>).focus === true;

    let ok = true;
    let error: string | undefined;
    try {
      await this.showPreview({ path, focus });
    } catch (cause) {
      ok = false;
      error = cause instanceof Error ? cause.message : String(cause);
    }
    // Re-checked AFTER the await: a window load takes time, and the slot may
    // have been replaced or disposed meanwhile. Sending into a retired
    // generation would answer a preview nobody is waiting for.
    if (!this.isAuthoritative(entry, generation) || !entry.slot) return;
    const respondPayload: WorkerPreviewRespondPayload = {
      logicalSessionId: entry.logicalSessionId,
      previewId,
      ok,
      ...(error ? { error } : {}),
    };
    try {
      await entry.slot.request<WorkerPreviewRespondResult, WorkerPreviewRespondPayload>(
        'worker.preview.respond',
        respondPayload
      );
    } catch (cause) {
      // The worker went away between the request and the answer. Nothing to
      // recover: its pending previews are drained by its own dispose.
      this.log('preview response failed', cause);
    }
  }

  async setPermissions(sessionId: string, permissions: RuntimePermissionSettings): Promise<string> {
    const requestId = nextRequestId('permissions');
    const entry = this.entriesBySession.get(sessionId);
    if (entry && entry.state !== 'ready')
      throw new WorkerManagerError(
        'session_not_ready',
        'Wait for the worker before changing permissions'
      );
    // A turn in flight locks the MODE, not the gear. Plan mode decides which
    // tools the model was handed when the turn started, so switching it halfway
    // through would leave the turn running on a tool set its own posture no
    // longer matches; the gear only decides how often the user is asked, which
    // is exactly the thing they are trying to change while a card is up.
    //
    // `entry.permissions` is Main's record of what the worker was last told.
    // Absent means nothing was ever told to it, which is the runtime default —
    // so the comparison is against that rather than refused outright.
    const current = entry?.permissions ?? DEFAULT_RUNTIME_PERMISSION;
    const gearOnly = permissions.mode === current.mode;
    if (entry?.activeRequestId && !gearOnly)
      throw new WorkerManagerError(
        'session_busy',
        'The mode cannot change during a turn; the permission level can'
      );
    if (entry?.slot && entry.state === 'ready') {
      // Mid-turn the narrow RPC is the only one the worker will accept, and
      // between turns the broad one is what re-applies both axes from scratch.
      const result = entry.activeRequestId
        ? await entry.slot.request<WorkerSetPermissionTierResult, WorkerSetPermissionGearPayload>(
            'worker.setPermissionGear',
            { logicalSessionId: sessionId, gear: permissions.gear }
          )
        : await entry.slot.request<WorkerSetPermissionTierResult, WorkerSetPermissionsPayload>(
            'worker.setPermissions',
            { logicalSessionId: sessionId, permissions }
          );
      if (!isWorkerSetPermissionTierResult(result) || !result.applied)
        throw new WorkerManagerError(
          'worker_permission_not_applied',
          'Worker did not apply permission settings'
        );
      entry.lastUsedAt = this.now();
    }
    if (entry) entry.permissions = { ...permissions };
    return requestId;
  }

  async setPermissionTier(sessionId: string, tier: SessionPermissionTier): Promise<string> {
    const requestId = nextRequestId('permtier');
    const entry = this.entriesBySession.get(sessionId);
    // Recorded before the reachability check on purpose. A session with no
    // worker yet (nothing sent) or one mid-restart cannot be told anything —
    // that early return is what used to make the whole call a no-op. Now the
    // choice survives on the entry and the next spawn comes up on it, so the
    // unreachable case is a deferral rather than a silent drop.
    if (entry) {
      entry.tier = tier;
      entry.permissions = migratePermissionTier(tier);
    }
    if (!entry?.slot || entry.state !== 'ready') return requestId;
    const payload: WorkerSetPermissionTierPayload = { logicalSessionId: sessionId, tier };
    await entry.slot.request<WorkerSetPermissionTierResult, WorkerSetPermissionTierPayload>(
      'worker.setPermissionTier',
      payload
    );
    entry.lastUsedAt = this.now();
    return requestId;
  }

  closeSession(sessionId: string): Promise<string> {
    const requestId = nextRequestId('close');
    return this.serialize(async () => {
      const entry = this.entriesBySession.get(sessionId);
      if (!entry) return;
      await this.retireAndDispose(entry, 'slot-dispose');
      this.updateManagerState();
    }).then(() => requestId);
  }

  claimSession(sessionId: string, ownerWebContentsId: number): void {
    const entry = this.entriesBySession.get(sessionId);
    if (entry) this.claimEntry(entry, ownerWebContentsId);
  }

  releaseWindow(ownerWebContentsId: number): void {
    for (const entry of this.entriesBySession.values()) {
      if (entry.ownerWebContentsId === ownerWebContentsId) entry.ownerWebContentsId = null;
    }
  }

  releaseSession(sessionId: string): void {
    const entry = this.entriesBySession.get(sessionId);
    if (entry) entry.ownerWebContentsId = null;
  }

  reclaimIdle(): Promise<void> {
    return this.serialize(() => this.reclaimIdleInternal());
  }

  /**
   * Login, logout, a model or plugin change: every session is rebuilt.
   *
   * dsh-rebase decision 025 rule 2: the shared host goes too, gracefully, so
   * no credential or route outlives the change inside it. After the sessions:
   * each channel's own disposal lets a turn in flight settle first (DSH cancels
   * it, waits for the agent to go idle and saves what it had streamed), so the
   * host is stopped with nothing left running. The next session starts a
   * fresh host.
   */
  invalidateAll(): Promise<void> {
    return this.serialize(async () => {
      this.configGeneration += 1;
      // P1-7e e6 (problem 37, decision 145): nothing reopens these sessions,
      // so each one says it went (`released`) and leaves "Active now".
      await this.disposeEntries([...this.entriesBySession.values()], 'slot-replace', 'released');
      this.pendingHostRecovery.clear();
      this.updateManagerState();
      if (this.host) {
        try {
          await this.host.shutdown('invalidate');
        } catch (error) {
          this.log('[worker-manager] DSH host stop after invalidation failed', error);
        }
      }
    });
  }

  /**
   * dsh-rebase decision 033 rule 4 — Main just rebuilt the model plan. A
   * running host configured with another revision is stale (a sync finished
   * after it started, a setting changed): it goes the way a login takes it,
   * `invalidateAll`, but only once no session has a turn or other work under
   * way; until then the check repeats. A host that is not running starts on
   * the new plan anyway. Idempotent: calling it for the host's own revision
   * cancels a pending restart.
   */
  reconcileModelPlan(revision: string): void {
    this.pendingPlanRevision = revision;
    this.recheckModelPlan();
  }

  /**
   * dsh-rebase P1-10b (decisions 025 rule 2, 059 rule 4, 108 rule 7) — the
   * user changed which DSH plugins are enabled; `selection` is the key the
   * next launch will carry (`dshPluginSelectionKey`). The composition is
   * host-wide, so a running host launched with another selection goes the way
   * a new model plan takes it: `invalidateAll`, once no session has work under
   * way — and then, unlike a plan change, starts again at once (P1-7e e5,
   * `startHostAfterPluginChange`). A host that is not running picks the
   * selection up when it starts.
   */
  reconcileHostPlugins(selection: string): void {
    this.pendingPluginSelection = selection;
    this.recheckModelPlan();
  }

  /** Restarts a running host that is stale on its plan or its plugins, once idle. */
  private recheckModelPlan(): void {
    if (this.planRecheckTimer) clearTimeout(this.planRecheckTimer);
    this.planRecheckTimer = null;
    const status = this.host?.status();
    const revision = this.pendingPlanRevision;
    const running = status?.planRevision;
    const planStale = revision !== null && running !== undefined && running !== revision;
    if (!planStale) this.pendingPlanRevision = null;
    const selection = this.pendingPluginSelection;
    const runningSelection = status?.pluginSelection;
    const pluginsStale =
      selection !== null && runningSelection !== undefined && runningSelection !== selection;
    if (!pluginsStale) this.pendingPluginSelection = null;
    if (!planStale && !pluginsStale) return;
    if (this.hasWorkInFlight()) {
      this.planRecheckTimer = setTimeout(() => this.recheckModelPlan(), PLAN_RECHECK_MS);
      this.planRecheckTimer.unref?.();
      return;
    }
    this.pendingPlanRevision = null;
    this.pendingPluginSelection = null;
    if (planStale && running !== undefined && revision !== null) {
      this.log(
        `[worker-manager] the DSH host runs model plan ${running.slice(0, 12)}, Main has ` +
          `${revision.slice(0, 12)}; restarting it`
      );
    }
    if (pluginsStale) {
      this.log(
        `[worker-manager] the DSH host runs plugin selection ${String(runningSelection)}, ` +
          `Main has ${String(selection)}; restarting it`
      );
    }
    this.invalidateAll()
      .then(() => (pluginsStale ? this.startHostAfterPluginChange() : undefined))
      .catch((error: unknown) =>
        this.log('[worker-manager] restart for a new model plan or plugin selection failed', error)
      );
  }

  /**
   * P1-7e e5 (decision 143) — the second half of a restart for a plugin
   * change: the host that `invalidateAll` stopped comes back at once, with no
   * session on it, so its `ready` reports what the new selection loaded and
   * the settings page shows it without waiting for the next chat (decision
   * 117 rule 13 said "restarts on its own"; before this it only stopped).
   *
   * Only from `idle`: a session that already started it, a failed supervisor
   * and a disposed one are left as they are. Not user-initiated, and skipped
   * past the restart budget, so a start nobody asked for never fails the
   * supervisor. A host that stays unused stops again by the idle rule.
   */
  private async startHostAfterPluginChange(): Promise<void> {
    const host = this.host;
    if (!host) return;
    const status = host.status();
    if (status.state !== 'idle') return;
    if (status.recentFaults > DSH_HOST_RESTART_BUDGET.restarts) return;
    try {
      await host.ensureHost();
    } catch (error) {
      this.log('[worker-manager] the DSH host did not come back after a plugin change', error);
    }
  }

  /**
   * A turn, a mutation, work the host reports on some session's channel, or
   * a one-shot completion on the host (P1-15, decision 125: a code review may
   * stream for minutes, and a restart would cut it).
   */
  private hasWorkInFlight(): boolean {
    if ((this.host?.status().completions ?? 0) > 0) return true;
    const busy = this.busyChannels();
    return [...this.entriesBySession.values()].some((entry) => {
      const channel = entry.slot?.channelId;
      return (
        entry.activeRequestId !== null ||
        entry.mutationInFlight !== null ||
        (channel !== undefined && busy.has(channel))
      );
    });
  }

  private cancelPlanRecheck(): void {
    if (this.planRecheckTimer) clearTimeout(this.planRecheckTimer);
    this.planRecheckTimer = null;
    this.pendingPlanRevision = null;
    this.pendingPluginSelection = null;
  }

  disposeAll(reason: 'app-shutdown' | 'slot-dispose' = 'app-shutdown'): Promise<void> {
    return this.serialize(async () => {
      if (reason === 'app-shutdown' && this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }
      if (reason === 'app-shutdown') this.cancelPlanRecheck();
      if (reason === 'app-shutdown') this.cancelOrphanCollection();
      if (reason === 'app-shutdown' && this.host) await this.shutDownWithHost();
      else await this.disposeEntries([...this.entriesBySession.values()], reason);
      this.state = 'stopped';
    });
  }

  /**
   * dsh-rebase decision 025 rule 3 — app quit goes to the host, not to each
   * channel: one `{type:'shutdown'}` makes DSH dispose every agent and save
   * what it had streamed, and SIGKILL follows after 3.5 s. The sessions are
   * retired locally first (a turn in flight reads stopped(forced)); their
   * slots are released once the host is gone, every channel with it.
   */
  private async shutDownWithHost(): Promise<void> {
    const entries = [...this.entriesBySession.values()];
    for (const entry of entries) this.retireEntry(entry);
    this.pendingHostRecovery.clear();
    try {
      await this.host?.shutdown('app-quit');
    } catch (error) {
      this.log('[worker-manager] DSH host shutdown failed', error);
    } finally {
      for (const entry of entries) entry.drainingEvents = false;
      for (const slot of [...this.ownedSlots]) {
        if (slot.forceKillNow()) this.ownedSlots.delete(slot);
      }
    }
  }

  forceKillAllNow(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.cancelPlanRecheck();
    this.cancelOrphanCollection();
    const entries = [...this.entriesBySession.values()];
    const slots = [...this.ownedSlots];
    this.entriesByKey.clear();
    this.entriesBySession.clear();
    this.state = 'stopped';
    for (const entry of entries) {
      entry.acceptEvents = false;
      // No drain window on this path: nothing is being asked to tear down
      // gracefully, so there is no resolution left to wait for.
      entry.drainingEvents = false;
      entry.state = 'disposing';
    }
    for (const slot of slots) {
      if (slot.forceKillNow()) this.ownedSlots.delete(slot);
    }
    this.pendingHostRecovery.clear();
    // After the slots detached: SIGKILL the shared host itself (decision 025).
    this.host?.forceKillNow();
  }

  private async spawnForEntry(
    entry: ManagedSlot,
    selection: { model?: string; effort?: SessionEffortLevel } = {},
    /**
     * Spawn a brand-new Pi session and ignore whatever file the entry names.
     * Used by the re-materialization path, which must not clear
     * `entry.sessionFile` up front: a failed spawn has to leave the entry
     * exactly as it found it so the next restart attempt sees the same state.
     *
     * `forceTakeover` — concurrency-02 — is passed per call and never read off
     * `entry`: the restart and fork paths below call this without it, so
     * neither can inherit a takeover the user authorised for one open.
     *
     * `userInitiated` — dsh-rebase P1-3a — marks a user's create, resume or
     * fork: only those may try the shared DSH host again after it failed
     * (decision 020 rule 6). A crash restart never sets it.
     */
    options: { fresh?: boolean; forceTakeover?: boolean; userInitiated?: boolean } = {}
  ): Promise<CreatedDshChatSlot> {
    let expectedSlot: WorkerSlot | null = null;
    // dsh-rebase P1-1: no model catalog here. Its `auth` half holds plaintext
    // provider keys and the DSH host never reads it; keys reach the host per
    // request instead (P1-5, decision 034). See `ChatSlotBootstrapPayload`.
    const created = await this.createSlot({
      slotKey: entry.key,
      logicalSessionId: entry.logicalSessionId,
      cwd: entry.cwd,
      generation: entry.generation,
      ...(entry.sessionFile && !options.fresh ? { sessionFile: entry.sessionFile } : {}),
      ...(entry.unbound ? { unbound: true } : {}),
      ...(options.forceTakeover ? { forceTakeover: true } : {}),
      ...(options.userInitiated ? { userInitiated: true } : {}),
      ...(entry.tier ? { tier: entry.tier } : {}),
      ...(entry.permissions ? { permissions: entry.permissions } : {}),
      // P1-12 step 1 (decision 147): no `subagents`, prompt-cache TTLs or
      // provider idle timeout. The bridge never read them; the main TTL and
      // the timeout reach the host through the model plan (decision 040).
      ...selection,
      onSlotCreated: (slot) => {
        this.ownedSlots.add(slot);
        expectedSlot = slot;
        entry.slot = slot;
        entry.generation = slot.generation;
      },
      onEvent: (event) => {
        if (expectedSlot && entry.slot === expectedSlot) {
          this.handleWorkerEvent(entry, expectedSlot, event);
        }
      },
      onLifecycle: (event) => {
        if (expectedSlot && entry.slot === expectedSlot) {
          this.handleLifecycle(entry, expectedSlot, event);
        }
      },
      onStderr: (chunk, generation) => this.absorbStderr(entry, generation, chunk),
    }).catch((error: unknown) => {
      // A worker that dies during bootstrap never reaches handleLifecycle, so
      // this is the only place its own stderr can still be recovered.
      this.dumpWorkerStderr(entry, 'failed to start');
      // dsh-rebase P1-3c: a shared host that could not be brought up reaches
      // the renderer as `dsh_host_unavailable`, its card, not as prose.
      throw hostUnavailableError(error);
    });
    this.ownedSlots.add(created.slot);
    expectedSlot = created.slot;
    entry.slot = created.slot;
    entry.bootstrap = created.bootstrap;
    entry.generation = created.slot.generation;
    return created;
  }

  /**
   * Assemble the worker's stderr into whole lines and keep the tail.
   *
   * Chunks arrive split at arbitrary byte boundaries, so logging them verbatim
   * interleaves half-lines — the reason hostStderr.ts exists. Lines go to the
   * optional `log` sink (info level, off in the shipped configuration) and into
   * a bounded buffer that `dumpWorkerStderr` replays at error level when the
   * worker dies. Without that replay a boot crash reaches the user as a bare
   * "Worker exited (code=1)" with the cause discarded.
   *
   * main-aux-06 — redaction happens HERE, once, not at the IPC edge. One
   * assembled line has three exits (the `log` sink, the replay buffer, the
   * renderer event) and only the renderer one used to be gated, so a worker
   * that printed its environment on a failed spawn showed the user a masked
   * line and wrote the key into main.log: `dumpWorkerStderr` uses
   * `console.error`, and electron-log keeps error level even when file logging
   * is off. That is the copy a user attaches to a bug report.
   */
  private absorbStderr(entry: ManagedSlot, generation: number, chunk: string): void {
    const drained = drainStderrLines(entry.stderrPending, chunk, entry.stderrDropped);
    entry.stderrPending = drained.pending;
    entry.stderrDropped = drained.dropped;
    const lines = drained.lines.map(sanitizeStderrLine);
    entry.recentStderr = pushRecentStderr(entry.recentStderr, lines);
    const prefix = `[dsh-chat:${entry.logicalSessionId}:g${generation}:stderr]`;
    for (const line of lines) {
      this.log(prefix, line);
      this.forwardStderr(entry, line);
    }
  }

  /**
   * rpc-projector-17 — put the worker's own diagnostics where the user is.
   *
   * `session.stderr` has had a type, a redaction module written for it and
   * three renderer consumers — the Context panel's "Host stderr" group, the
   * runtime-facts ring, the turn-liveness classifier — since T-35, and no
   * producer at all since the Claude CLI host it was built for was replaced.
   * The worker IS the session's subprocess now, and this manager already holds
   * both halves the event needs: whole assembled lines, and the logical session
   * they came from. So the gap is the emit, and this is it.
   *
   * Already redacted when it gets here: `absorbStderr` runs
   * `sanitizeStderrLine` over every assembled line, because this exit is not
   * the only one (main-aux-06). The bridge downstream is a content-agnostic
   * passthrough and gets no second chance.
   *
   * Capped per turn, and the cap announces itself. A worker stuck in a retry
   * loop streams stderr for as long as it runs, and one IPC event per line is a
   * cost the renderer should not pay; the log and the crash dump still keep
   * every line. A silent cutoff would be the worse failure — the panel would
   * show a plausible excerpt with no hint that it stopped being current.
   */
  private forwardStderr(entry: ManagedSlot, line: string): void {
    if (entry.stderrForwardTurn !== entry.activeRequestId) {
      entry.stderrForwardTurn = entry.activeRequestId;
      entry.stderrForwarded = 0;
    }
    const forwarded = entry.stderrForwarded ?? 0;
    if (forwarded > STDERR_FORWARD_MAX_LINES_PER_TURN) return;
    entry.stderrForwarded = forwarded + 1;
    this.dispatch({
      type: 'session.stderr',
      sessionId: entry.logicalSessionId,
      payload: {
        line:
          forwarded === STDERR_FORWARD_MAX_LINES_PER_TURN
            ? `…more stderr this turn is in the worker log only (forwarding capped at ${STDERR_FORWARD_MAX_LINES_PER_TURN} lines)`
            : line,
      },
    });
  }

  /** Replay the dead worker's own diagnostics; clears the buffer. */
  private dumpWorkerStderr(entry: ManagedSlot, reason: string): void {
    // The buffered lines are already redacted (main-aux-06); the unterminated
    // tail has never been through `absorbStderr`'s loop, so it is gated here.
    const lines = [
      ...entry.recentStderr,
      ...flushStderrPending(entry.stderrPending, entry.stderrDropped).map(sanitizeStderrLine),
    ];
    entry.stderrPending = '';
    entry.stderrDropped = 0;
    entry.recentStderr = [];
    if (lines.length === 0) return;
    // console.error, not this.log: electron-log keeps error level even when
    // file logging is off, which is the configuration nearly everyone runs.
    console.error(
      `[dsh-chat:${entry.logicalSessionId}:g${entry.generation}] ${reason}; last ${lines.length} stderr line(s):\n${lines.join('\n')}`
    );
  }

  private assertIdleEntry(entry: ManagedSlot, action: string): void {
    if (entry.activeRequestId || entry.mutationInFlight !== null) {
      throw new WorkerManagerError(
        'session_busy',
        `Session ${entry.logicalSessionId} cannot ${action} while active`,
        true
      );
    }
  }

  private async readTree(entry: ManagedSlot): Promise<WorkerTreeResult> {
    const result = await entry.slot?.request<WorkerTreeResult, WorkerTreePayload>('worker.tree', {
      logicalSessionId: entry.logicalSessionId,
    });
    if (!isWorkerTreeResult(result)) {
      throw new WorkerManagerError(
        'worker_invalid_tree_result',
        'Pi worker returned an invalid session tree'
      );
    }
    this.validateTreeResult(entry, result);
    return result;
  }

  private validateTreeResult(entry: ManagedSlot, result: WorkerTreeResult): void {
    const snapshot = result.snapshot;
    if (
      snapshot.logicalSessionId !== entry.logicalSessionId ||
      sessionWorkerKey(snapshot.sessionFile) !== entry.key ||
      normalizeWorkerPath(snapshot.workspacePath, 'Tree workspace') !== entry.cwd
    ) {
      throw new WorkerManagerError(
        'worker_tree_identity_mismatch',
        'Pi worker session tree does not match its authoritative slot identity'
      );
    }
  }

  private async acceptForkFile(owner: ManagedSlot, sessionFile: string): Promise<void> {
    try {
      const result = await owner.slot?.request<WorkerAcceptForkResult, WorkerAcceptForkPayload>(
        'worker.fork.accept',
        {
          logicalSessionId: owner.logicalSessionId,
          sessionFile,
        }
      );
      if (!isWorkerAcceptForkResult(result) || !result.accepted) {
        this.log('[worker-manager] fork adoption was not acknowledged', sessionFile);
      }
    } catch (error) {
      this.log('[worker-manager] failed to report fork adoption to the source worker', error);
    }
  }

  private async discardForkFile(owner: ManagedSlot, sessionFile: string): Promise<boolean> {
    try {
      const result = await owner.slot?.request<WorkerDiscardForkResult, WorkerDiscardForkPayload>(
        'worker.fork.discard',
        {
          logicalSessionId: owner.logicalSessionId,
          sessionFile,
        }
      );
      if (!isWorkerDiscardForkResult(result) || !result.discarded) {
        this.log('[worker-manager] fork discard was not acknowledged', sessionFile);
        return false;
      }
      return true;
    } catch (error) {
      this.log('[worker-manager] failed to discard uncommitted fork file', error);
      return false;
    }
  }

  private async readHistory(
    entry: ManagedSlot,
    offset: number,
    limit: number
  ): Promise<WorkerHistoryResult> {
    const result = await entry.slot?.request<WorkerHistoryResult, WorkerHistoryPayload>(
      'worker.history',
      { logicalSessionId: entry.logicalSessionId, offset, limit }
    );
    if (!isWorkerHistoryResult(result)) {
      throw new WorkerManagerError(
        'worker_invalid_history_result',
        'Pi worker returned an invalid history page'
      );
    }
    this.validateHistoryResult(entry, result);
    return result;
  }

  private validateHistoryResult(entry: ManagedSlot, history: WorkerHistoryResult): void {
    if (
      history.logicalSessionId !== entry.logicalSessionId ||
      sessionWorkerKey(history.sessionFile) !== entry.key ||
      normalizeWorkerPath(history.workspacePath, 'History workspace') !== entry.cwd
    ) {
      throw new WorkerManagerError(
        'worker_history_identity_mismatch',
        'Pi worker history page does not match its authoritative slot identity'
      );
    }
  }

  private dispatchHistory(
    entry: ManagedSlot,
    requestId: string,
    history: WorkerHistoryResult,
    mode: 'initial' | 'older' | 'refresh' | 'branch'
  ): void {
    const page = history.page;
    this.dispatch({
      type: 'session.history',
      sessionId: entry.logicalSessionId,
      requestId,
      payload: {
        runtimeIdentity: history.sessionFile,
        workspacePath: history.workspacePath,
        mode,
        messages: page.messages,
        offset: page.offset,
        limit: page.limit,
        totalCount: page.totalCount,
        hasMore: page.hasMore,
        branchRevision: entry.branchRevision,
        truncated: page.hasMore,
        omittedCount: Math.max(0, page.totalCount - page.messages.length),
        // P5-2-6: the delegations this branch recorded, so reopening a session
        // puts their panels back. Forwarded rather than interpreted — Main has
        // no opinion about a delegation, and the renderer's lane store is the
        // one consumer.
        ...(history.subagents?.length ? { subagents: history.subagents } : {}),
      },
    });
  }

  /**
   * The permission system this entry's worker actually bootstrapped on, for the
   * session.created/resumed payload.
   *
   * Read from the bootstrap acknowledgement rather than recomputed here: the
   * decision is made inside the worker, against the agentDir and settings that
   * worker resolved, and a second copy of that logic in Main would be a second
   * answer. Omitted (not defaulted) when there is no acknowledgement to read —
   * "unknown" and "bundled" must not collapse into the same payload.
   */
  private gatePayload(entry: ManagedSlot): { permissionGate?: 'bundled' | 'user_configured' } {
    return entry.bootstrap ? { permissionGate: entry.bootstrap.permissionGate } : {};
  }

  private publishHistoryTriplet(
    entry: ManagedSlot,
    requestId: string,
    history: WorkerHistoryResult,
    mode: 'initial' | 'refresh'
  ): void {
    this.dispatch({
      type: 'session.resumed',
      sessionId: entry.logicalSessionId,
      requestId,
      payload: {
        agent: DSH_AGENT,
        runtimeIdentity: history.sessionFile,
        ...this.gatePayload(entry),
      },
    });
    this.dispatchHistory(entry, requestId, history, mode);
    // P1-7e (problem 4, decision 142): a warm resume of a worker that is in
    // the middle of a turn it started itself (a goal round, a job's wake-up)
    // says so, under that turn's id — the window that reloaded knows nothing
    // else about it. Only what the worker last reported is re-announced
    // (decision 046); a fresh worker has reported nothing, so it reads idle.
    const turn = entry.workerTurn;
    this.dispatch({
      type: 'session.status',
      sessionId: entry.logicalSessionId,
      requestId: turn?.requestId ?? requestId,
      payload: { status: turn?.status ?? 'idle' },
    });
  }

  private requireReadySession(sessionId: string): ManagedSlot {
    const entry = this.entriesBySession.get(sessionId);
    if (!entry || entry.state !== 'ready' || !entry.slot) {
      throw new WorkerManagerError(
        'session_not_found',
        `No ready Pi WorkerSlot exists for ${sessionId}`
      );
    }
    return entry;
  }

  private claimEntry(entry: ManagedSlot, ownerWebContentsId: number | undefined): void {
    if (ownerWebContentsId === undefined) return;
    for (const candidate of this.entriesBySession.values()) {
      if (candidate !== entry && candidate.ownerWebContentsId === ownerWebContentsId) {
        candidate.ownerWebContentsId = null;
      }
    }
    entry.ownerWebContentsId = ownerWebContentsId;
    entry.lastUsedAt = this.now();
  }

  private serialize<TResult>(work: () => Promise<TResult>): Promise<TResult> {
    const run = this.lifecycleChain.then(work);
    this.lifecycleChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private selectEvictionCandidate(): ManagedSlot | null {
    const busy = this.busyChannels();
    const candidates = [...this.entriesBySession.values()].filter((entry) =>
      this.isSafeToEvict(entry, busy)
    );
    // An entry parked in `error` has no live worker left to lose, so retire it
    // before evicting a healthy idle session.
    candidates.sort(
      (left, right) =>
        Number(right.state === 'error') - Number(left.state === 'error') ||
        left.lastUsedAt - right.lastUsedAt
    );
    return candidates[0] ?? null;
  }

  /**
   * `error` counts as evictable: such an entry can no longer serve anything,
   * but it still occupied a pool slot against `capacity` that no eviction could
   * reclaim — enough of them and every new session failed with
   * `worker_capacity_reached`.
   *
   * dsh-rebase P1-3d (decision 025): a session the shared host last reported
   * busy — a goal round, or a background job still running after its turn —
   * is not idle, and closing its channel would end that work.
   */
  private isSafeToEvict(entry: ManagedSlot, busy: ReadonlySet<string>): boolean {
    const channel = entry.slot?.channelId;
    return (
      (entry.state === 'ready' || entry.state === 'error') &&
      entry.ownerWebContentsId === null &&
      entry.activeRequestId === null &&
      entry.mutationInFlight === null &&
      !(channel !== undefined && busy.has(channel))
    );
  }

  /** Channels the shared host's last pong reported busy. */
  private busyChannels(): Set<string> {
    const channels = this.host?.status().lastPong?.channels ?? [];
    return new Set(channels.filter((channel) => channel.busy).map((channel) => channel.ch));
  }

  private async reclaimIdleInternal(): Promise<void> {
    if (this.idleTimeoutMs === 0) return;
    const cutoff = this.now() - this.idleTimeoutMs;
    const busy = this.busyChannels();
    const victims = [...this.entriesBySession.values()].filter(
      (entry) => this.isSafeToEvict(entry, busy) && entry.lastIdleAt <= cutoff
    );
    // P1-7e e6 (decision 145): `released`, not `capacity_reclaimed` — a
    // timeout is not a full pool (D12), but the renderer still has to drop
    // the binding of a session that is no longer on the engine.
    const stuck = await this.disposeEntries(victims, 'slot-replace', 'released');
    await this.releaseStuckChannels(stuck);
    this.updateManagerState();
  }

  /**
   * Resolves the slots whose channel would not close (`dispose-failed`); never rejects.
   *
   * `announce` — see `retireEntry`: every retired session says it went, with
   * this reason. Omitted, only a session with a turn under way says so.
   */
  private async disposeEntries(
    entries: ManagedSlot[],
    reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace',
    announce?: SessionDisconnectReason
  ): Promise<WorkerSlot[]> {
    const unique = [...new Set(entries)];
    for (const entry of unique) this.retireEntry(entry, announce);
    const stuck: WorkerSlot[] = [];
    const results = await Promise.allSettled(
      unique.map(async (entry) => {
        const slot = entry.slot;
        try {
          await slot?.dispose(reason);
        } catch (error) {
          if (slot?.state === 'dispose-failed') stuck.push(slot);
          throw error;
        } finally {
          entry.drainingEvents = false;
        }
        if (slot) this.ownedSlots.delete(slot);
      })
    );
    for (const result of results) {
      if (result.status === 'rejected')
        this.log('[worker-manager] slot disposal failed', result.reason);
    }
    return stuck;
  }

  private async retireAndDispose(
    entry: ManagedSlot,
    reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace'
  ): Promise<void> {
    this.retireEntry(entry);
    const slot = entry.slot;
    try {
      await slot?.dispose(reason);
    } catch (error) {
      // P1-3d: a channel that would not close is released by a host restart
      // when nothing else is running; the disposal then did what it was for.
      if (
        !slot ||
        reason === 'app-shutdown' ||
        slot.state !== 'dispose-failed' ||
        (await this.releaseStuckChannels([slot])) === 0
      ) {
        throw error;
      }
    } finally {
      entry.drainingEvents = false;
    }
    if (slot) this.ownedSlots.delete(slot);
  }

  /**
   * dsh-rebase P1-3d (decision 074's leftover) — channels that would not close
   * when their session was closed, evicted or reclaimed. Each keeps an agent
   * in the host holding that session's lock until the host restarts. When
   * nothing else is running on the host — no turn, Stop, fork or rewind in
   * any session, no session the host reports busy, and the restart budget has
   * room — Main restarts it now (Stop ladder B, decision 021): the idle
   * sessions read `engine_restarted` and come back in one batch. Otherwise the
   * lock waits for the next host restart: the user's "Restart engine" on the
   * `session_locked` card, the idle stop, or a later crash. Resolves how many
   * channels it released.
   */
  private async releaseStuckChannels(slots: WorkerSlot[]): Promise<number> {
    const host = this.host;
    const stuck = slots.filter((slot) => slot.state === 'dispose-failed');
    if (!host || stuck.length === 0) return 0;
    const status = host.status();
    // A host already going away takes the locks with it.
    if (status.state !== 'ready') return 0;
    const stuckChannels = new Set(stuck.map((slot) => slot.channelId));
    const working = [...this.entriesBySession.values()].some(
      (entry) =>
        entry.activeRequestId !== null ||
        entry.stopWatchdog !== undefined ||
        entry.mutationInFlight !== null ||
        entry.state === 'creating' ||
        entry.state === 'restarting'
    );
    const busy = [...this.busyChannels()].some((channel) => !stuckChannels.has(channel));
    const budgetLeft = status.recentFaults < DSH_HOST_RESTART_BUDGET.restarts;
    if (working || busy || !budgetLeft) {
      console.warn(
        `[worker-manager] ${stuck.length} DSH channel(s) did not close; their session locks stay ` +
          `until the next engine restart (${working || busy ? 'other sessions are working' : 'restart budget spent'})`
      );
      return 0;
    }
    console.warn(
      `[worker-manager] ${stuck.length} DSH channel(s) did not close; restarting the DSH host to release their session locks`
    );
    try {
      await this.restartHost('stuck-session');
    } catch (error) {
      console.warn(
        `[worker-manager] the DSH host restart for stuck channels failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return 0;
    }
    // Their channels went with the old host; this only retires the slot objects.
    for (const slot of stuck) {
      if (slot.forceKillNow()) this.ownedSlots.delete(slot);
    }
    return stuck.length;
  }

  /**
   * D12 (U24): reclaim an idle worker for a new session, and SAY SO.
   *
   * The reclamation itself is unchanged and predates this method — what was
   * missing is that it was silent in both directions. The renderer kept the
   * session in `hostBoundSessionIds`, so its next send would skip
   * `createSession` and address a worker that no longer exists; and the user
   * saw a conversation quietly stop being started with nothing to explain it.
   *
   * One `session.status` covers both: `disconnected` is the state the renderer
   * needs, and `capacity_reclaimed` is the sentence it shows once.
   *
   * Deliberately NOT used by `reclaimIdleInternal`. The idle sweep is a
   * separate line (15 minutes with no use, regardless of capacity) and D12
   * left it alone; announcing it here would attribute a timeout to a full pool.
   */
  private async evictForCapacity(victim: ManagedSlot): Promise<void> {
    const sessionId = victim.logicalSessionId;
    // Decision 156: an entry parked in `error` was already announced
    // `released` when Main stopped reopening it; nothing on the engine is
    // reclaimed from it, so there is nothing to say a second time (D12).
    const alreadyReleased = victim.state === 'error';
    await this.retireAndDispose(victim, 'slot-replace');
    if (alreadyReleased) return;
    this.dispatch({
      type: 'session.status',
      sessionId,
      payload: { status: 'disconnected', disconnectReason: 'capacity_reclaimed' },
    });
  }

  /**
   * Unbook one slot from the pool.
   *
   * Took the disposal reason until T036: it existed only to pick which flavour
   * of dialog cancellation to announce on the retired Extension UI chain
   * (decision 012). `slot.dispose(reason)` still carries it, which is where it
   * belongs.
   *
   * `announce` — P1-7e e6 (problem 37, decision 145): a retirement nothing
   * reopens (`invalidateAll`, the idle sweep). The session says it went with
   * this reason even when it was idle, so the renderer drops its host
   * binding; a session mid-turn carries the same reason on the `disconnected`
   * that follows its forced stop. Without it an idle session goes silently,
   * which is what every other caller wants: it reopens the session itself
   * (a crash, a user's resume) or announces on its own (`evictForCapacity`,
   * `closeSession`).
   */
  private retireEntry(entry: ManagedSlot, announce?: SessionDisconnectReason): void {
    // decision 046 rule 3 — a turn in flight, or a Stop still waiting on one,
    // ends here for everyone outside the worker: its own terminal will meet the
    // closed gate below. Main says so, before the session goes disconnected.
    const turnId = entry.activeRequestId;
    const interrupted = turnId !== null || entry.stopWatchdog !== undefined;
    this.clearStopWatchdog(entry);
    entry.reportedStatus = undefined;
    entry.workerTurn = undefined;
    entry.acceptEvents = false;
    // main-host-03: routing stops here, the event stream does not. The worker
    // emits its parked resolutions during `worker.dispose`, so the window
    // opens with the retirement and is closed again by whichever of
    // `retireAndDispose` / `disposeEntries` is driving that disposal.
    entry.drainingEvents = true;
    entry.state = 'disposing';
    if (this.entriesByKey.get(entry.key) === entry) this.entriesByKey.delete(entry.key);
    if (this.entriesByKey.get(entry.temporaryKey) === entry) {
      this.entriesByKey.delete(entry.temporaryKey);
    }
    if (this.entriesBySession.get(entry.logicalSessionId) === entry) {
      this.entriesBySession.delete(entry.logicalSessionId);
    }
    entry.ownerWebContentsId = null;
    entry.activeRequestId = null;
    if (interrupted) {
      const requestId = turnId ?? nextRequestId('close');
      this.dispatch({
        type: 'session.stopped',
        sessionId: entry.logicalSessionId,
        requestId,
        payload: { stopCause: 'forced' },
      });
      this.dispatch({
        type: 'session.status',
        sessionId: entry.logicalSessionId,
        requestId,
        payload: {
          status: 'disconnected',
          ...(announce ? { disconnectReason: announce } : {}),
        },
      });
    } else if (announce) {
      this.dispatch({
        type: 'session.status',
        sessionId: entry.logicalSessionId,
        requestId: nextRequestId('release'),
        payload: { status: 'disconnected', disconnectReason: announce },
      });
    }
  }

  private handleWorkerEvent(entry: ManagedSlot, slot: WorkerSlot, message: WorkerRpcEvent): void {
    if (entry.slot !== slot || message.type !== 'runtime.event') return;
    const event = message.payload as RuntimeEvent;
    if (!event || typeof event.type !== 'string') return;
    if (event.sessionId && event.sessionId !== entry.logicalSessionId) return;
    if (!this.isAuthoritative(entry, message.generation) || entry.state !== 'ready') {
      // main-host-03 — the drain window. `retireEntry` has already closed
      // `acceptEvents` and unbooked this entry, so `isAuthoritative` is false
      // by construction while the worker tears down; forwarding the two
      // resolutions it emits there is the only way the renderer learns that
      // the cards it is showing were answered on the user's behalf. Slot
      // identity, generation and session ownership are still checked above and
      // here, so nothing a worker can put in a payload widens this.
      this.forwardDrainResolution(entry, message.generation, event);
      return;
    }

    entry.lastUsedAt = this.now();
    if (event.type === 'preview.requested') {
      // P5-2-3. Answered HERE rather than forwarded to a card: the preview
      // surface is an Electron window, which is Main's to own. It is still
      // dispatched below, so the event stays visible to anything tracing the
      // session — it just does not need a renderer to be answered.
      void this.servePreview(entry, message.generation, event.payload);
    }

    if (!entry.identityCommitted && event.type === 'message.completed') {
      // The one moment Pi writes a session it has so far only named: the file
      // appears with the first completed assistant message. Claiming the
      // identity here rather than waiting for the turn to end matters because a
      // long turn can hold a written session hostage for minutes — and an app
      // killed inside that window would otherwise come back to a chat with no
      // identity while its transcript sat on disk, unreachable. Costs one stat
      // per completed message until it lands, and nothing afterwards.
      void this.ensureIdentityCommitted(entry, message.generation);
    }
    if (event.type === 'session.status' && entry.activeRequestId !== null) {
      entry.reportedStatus = SETTLED_STATUSES.has(event.payload.status)
        ? undefined
        : event.payload.status;
    }
    if (event.type === 'session.status') {
      // P1-7e (problem 4): whoever started the turn.
      entry.workerTurn = SETTLED_STATUSES.has(event.payload.status)
        ? undefined
        : {
            status: event.payload.status,
            ...(event.requestId ? { requestId: event.requestId } : {}),
          };
    }
    if (
      event.type === 'session.completed' ||
      event.type === 'session.failed' ||
      event.type === 'session.stopped'
    ) {
      entry.activeRequestId = null;
      entry.reportedStatus = undefined;
      entry.workerTurn = undefined;
      entry.lastIdleAt = this.now();
      // decision 046: the turn a pending Stop was waiting on has ended.
      this.clearStopWatchdog(entry);
      void this.syncLeafCheckpoint(entry, message.generation);
    }
    this.logNotableEvent(entry, event);
    this.dispatch({ ...event, sessionId: event.sessionId ?? entry.logicalSessionId });
  }

  /**
   * T066 — the two worker facts an operator has no other way to see.
   *
   * A retry and a refused turn both used to exist only inside the worker: the
   * retry as a `provider_retry` note in a trace file nobody has unless they
   * exported `AICLIENT_RUNTIME_TRACE_DIR` first, the refusal as a line of the
   * worker's stderr that main.log only ever received as part of the crash
   * replay — i.e. after the process died, truncated to the last N lines. The
   * 2026-09-17 field pass hit four `session_size_limit` refusals and could
   * find three of them, hours later, in the dump of a killed worker.
   *
   * `console.warn` rather than `this.log`: the `log` sink is optional and
   * production never injects one (see the export at the bottom of this file),
   * so it is a no-op on every real machine — the same reason
   * `dumpWorkerStderr` reaches for `console.error`. Both lines are anomalies,
   * so `warn` is also the level that survives the logging switch being off.
   *
   * Redacted (T042) because a provider error body is a place credentials show
   * up, and clamped by the same rule the stderr exits use.
   */
  private logNotableEvent(entry: ManagedSlot, event: RuntimeEvent): void {
    if (event.type === 'session.status' && event.payload.retry) {
      const retry = event.payload.retry;
      console.warn(
        `[dsh-chat:${entry.logicalSessionId}] provider retry ${retry.attempt}/${retry.maxRetries} in ${retry.delayMs}ms${attemptDurationSuffix(retry)} (status=${retry.errorStatus ?? 'none'} code=${retry.error}${retry.delegationId ? ` delegate=${retry.delegationId}` : ''})`
      );
      return;
    }
    if (event.type === 'session.failed') {
      // T066 rework: the 2026-09-17 field pass found this line reading `turn
      // failed: session exceeds the configured size budget` — no code to grep
      // for. A run that ends in failure carries the code beside the sentence;
      // one that throws already has it in front of the sentence, hence the
      // guard against printing it twice.
      const text = sanitizeStderrLine(event.payload?.error ?? 'no reason reported');
      const code = event.payload?.errorCode;
      const reason = code && !text.startsWith(`${code}:`) ? `${code}: ${text}` : text;
      console.warn(`[dsh-chat:${entry.logicalSessionId}] turn failed: ${reason}`);
    }
  }

  /** main-host-03 — the only events a retired entry may still forward. */
  private forwardDrainResolution(
    entry: ManagedSlot,
    generation: number,
    event: RuntimeEvent
  ): void {
    if (!entry.drainingEvents || entry.generation !== generation) return;
    if (event.type !== 'permission.resolved' && event.type !== 'question.resolved') return;
    this.dispatch({ ...event, sessionId: event.sessionId ?? entry.logicalSessionId });
  }

  private handleLifecycle(
    entry: ManagedSlot,
    slot: WorkerSlot,
    event: WorkerSlotLifecycleEvent
  ): void {
    if (
      event.type !== 'crashed' ||
      entry.slot !== slot ||
      !entry.acceptEvents ||
      !this.isAuthoritative(entry, event.generation)
    ) {
      return;
    }
    const hostFault = this.hostFaultOf(slot, event.exit);
    // decision 020 rule 5: a session the host died under while it was being
    // recovered was at the scene as much as one mid-turn.
    const recovering = entry.state === 'restarting';
    const { turnId: activeRequestId, stopping } = this.enterCrashed(
      entry,
      event.error.message,
      `crashed: ${event.error.message}`
    );
    if (hostFault) {
      entry.activeAtHostExit = activeRequestId !== null || stopping;
      // Main's own restarts are not faults; ladder B bills the one session
      // that caused it (`escalateStuckChannel`).
      if (hostFault === 'crashed') {
        entry.hostFaultStreak =
          entry.activeAtHostExit || recovering ? (entry.hostFaultStreak ?? 0) + 1 : 0;
      }
    }
    const status = {
      status: 'disconnected' as const,
      ...(hostFault === 'restarted' ? { disconnectReason: 'engine_restarted' as const } : {}),
    };
    if (stopping) {
      // Died on its way out of a Stop: for the user that IS the stop, forced.
      this.dispatchForcedStop(entry.logicalSessionId, activeRequestId);
    } else if (activeRequestId) {
      this.dispatch({
        type: 'session.status',
        sessionId: entry.logicalSessionId,
        requestId: activeRequestId,
        payload: status,
      });
      this.dispatch({
        type: 'session.failed',
        sessionId: entry.logicalSessionId,
        requestId: activeRequestId,
        payload: {
          error: event.error.message,
          // dsh-rebase P1-3c: the renderer names the cause from this, not from
          // the sentence (`sessionFailure.ts`).
          ...(hostFault === 'crashed' ? { errorCode: SESSION_FAILED_HOST_CRASHED } : {}),
          ...(hostFault === 'restarted' ? { errorCode: SESSION_FAILED_ENGINE_RESTARTED } : {}),
        },
      });
    } else {
      // decision 046: no turn Main knew of, but a renderer that still thinks
      // one runs must not stay "running" on a dead worker. The restart below
      // settles it to idle again.
      this.dispatch({
        type: 'session.status',
        sessionId: entry.logicalSessionId,
        requestId: nextRequestId('crash'),
        payload: status,
      });
    }
    this.updateManagerState();
    if (hostFault) this.queueHostRecovery(entry);
    else void this.serialize(() => this.restartEntry(entry));
  }

  /**
   * dsh-rebase P1-3c — did this slot die with the shared host, and how?
   *
   * `null` is the session's own crash (its channel closed, or its transport
   * failed on a live host): restarted alone, on its own budget. Otherwise the
   * host went away under it — `restarted` when Main itself restarted the host
   * (Stop ladder B, the user's "Restart engine"), `crashed` for anything else
   * (a crash, a hang, lost IPC). A transport failure while the host is not
   * ready is the host's too: a send that races the host's exit fails before
   * the exit is reported. A channel Main closed ahead of its own restart
   * (decision 155) went for that restart.
   */
  private hostFaultOf(
    slot: WorkerSlot,
    exit: WorkerTransportExit | undefined
  ): 'crashed' | 'restarted' | null {
    const host = this.host;
    if (!host) return null;
    if (exit?.cause === 'channel-closed' && this.drainedSlots.has(slot)) return 'restarted';
    const hostExit = exit?.cause === 'host-exit';
    const status = host.status();
    if (!hostExit && status.state === 'ready') return null;
    if (this.plannedHostRestart !== null) return 'restarted';
    return hostExit && isPlannedHostRestart(status.lastExit?.reason) ? 'restarted' : 'crashed';
  }

  /** One host exit, one recovery batch: every channel of a host ends in the same burst. */
  private queueHostRecovery(entry: ManagedSlot): void {
    this.pendingHostRecovery.add(entry);
    if (this.hostRecoveryScheduled) return;
    this.hostRecoveryScheduled = true;
    queueMicrotask(() => {
      void this.serialize(() => this.recoverHostEntries());
    });
  }

  private awaitsHostRecovery(entry: ManagedSlot): boolean {
    return (
      this.entriesBySession.get(entry.logicalSessionId) === entry &&
      entry.state === 'crashed' &&
      entry.acceptEvents
    );
  }

  /**
   * decision 020 rule 3 — one replacement host for everything the exit took,
   * then its sessions one by one: the foreground ones, those that were mid-turn,
   * then the rest from the most recently used. The host is single-threaded, so
   * serial costs little (P0-6) and says which session brought it down again.
   *
   * No session budget is spent here (rule 4). A session present at two host
   * faults in a row stays in `error` (rule 5); a host its budget will not bring
   * back leaves every waiting session in the same `error` (rule 6), and a
   * user's next open or retry starts one again.
   */
  private async recoverHostEntries(): Promise<void> {
    this.hostRecoveryScheduled = false;
    const host = this.host;
    const waiting = [...this.pendingHostRecovery].filter((entry) => this.awaitsHostRecovery(entry));
    this.pendingHostRecovery.clear();
    if (!host || waiting.length === 0) return;
    const batch: ManagedSlot[] = [];
    for (const entry of waiting) {
      if ((entry.hostFaultStreak ?? 0) >= HOST_FAULT_SUSPECT_STREAK) {
        this.parkInError(
          entry,
          SESSION_SUSPECT,
          `present at ${entry.hostFaultStreak} DSH host faults in a row, so it is not reopened automatically`
        );
      } else {
        batch.push(entry);
      }
    }
    if (batch.length === 0) {
      this.updateManagerState();
      return;
    }
    const rank = (entry: ManagedSlot) =>
      entry.ownerWebContentsId !== null ? 0 : entry.activeAtHostExit ? 1 : 2;
    batch.sort((left, right) => rank(left) - rank(right) || right.lastUsedAt - left.lastUsedAt);
    let generation: number;
    try {
      generation = (await host.ensureHost()).generation;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const entry of batch) {
        if (this.awaitsHostRecovery(entry)) this.parkInError(entry, HOST_UNAVAILABLE, reason);
      }
      this.updateManagerState();
      return;
    }
    for (const [index, entry] of batch.entries()) {
      if (!this.awaitsHostRecovery(entry)) continue;
      const status = host.status();
      if (status.state !== 'ready' || status.generation !== generation) {
        // The replacement went down under this batch. The rest waits for the
        // next one, which this schedules (the exit of any session reopened on
        // it joins the same one): never a second host from here.
        for (const rest of batch.slice(index)) {
          if (this.awaitsHostRecovery(rest)) this.queueHostRecovery(rest);
        }
        return;
      }
      await this.restartEntry(entry, { hostFault: true });
    }
    this.updateManagerState();
    this.scheduleOrphanCollection();
  }

  /** `error` is terminal for the worker, never for the session: a user's open retires it. */
  private parkInError(entry: ManagedSlot, code: string, reason: string): void {
    entry.state = 'error';
    entry.error = `${code}: ${reason}`;
    console.error(`[worker-manager] ${entry.logicalSessionId}: ${entry.error}`);
    this.announceParked(entry);
  }

  /**
   * dsh-rebase decision 156 (decision 145's finding 6): Main gave up reopening
   * this session by itself — the entry stays, in `error`, until a user's open
   * retires it — so it is `released` (decision 145 §4): the renderer drops the
   * binding and the chat leaves "Active now", keeping a failed turn's card and
   * badge. Without this, a session whose recovery failed after a host crash
   * stayed listed as running in the background for the rest of the run.
   */
  private announceParked(entry: ManagedSlot): void {
    this.dispatch({
      type: 'session.status',
      sessionId: entry.logicalSessionId,
      requestId: nextRequestId('release'),
      payload: { status: 'disconnected', disconnectReason: 'released' },
    });
  }

  /** The last host exit the supervisor recorded, as a comparable mark. */
  private hostExitMark(): string {
    const exit = this.host?.status().lastExit;
    return exit ? `${exit.generation}@${exit.at}` : '';
  }

  /**
   * A restart attempt that failed because the shared host went away under it
   * (it refused, failed, or exited since `exitMark`), rather than for the
   * session's own reasons (its log missing, a cwd mismatch, a corrupt file).
   */
  private isHostFault(error: unknown, exitMark: string): boolean {
    const host = this.host;
    if (!host) return false;
    if (isHostSupervisorFailure(error)) return true;
    return host.status().state !== 'ready' || this.hostExitMark() !== exitMark;
  }

  /**
   * Main's own host restart (decision 021 ladder B; the session_locked card's
   * "Restart engine"): graceful stop, SIGKILL after 3.5 s, one new host. Every
   * other session's channel ends with the old host; `plannedHostRestart` makes
   * those exits read `engine_restarted`, and one batch reopens them afterwards.
   *
   * Decision 155: the sessions with work under way are closed first
   * (`closeBusyChannelsBeforeRestart`), so what they streamed is saved even
   * when the agent that forced the restart keeps the host from stopping.
   * `stuck` — the session the restart is for; never one of them.
   */
  private async restartHost(reason: DshHostRestartReason, stuck?: ManagedSlot): Promise<void> {
    const host = this.host;
    if (!host) return;
    await this.closeBusyChannelsBeforeRestart(stuck);
    this.plannedHostRestart = reason;
    try {
      await host.restart(reason, reason === 'user' ? { userInitiated: true } : {});
    } catch (error) {
      throw hostUnavailableError(error);
    } finally {
      this.plannedHostRestart = null;
    }
  }

  /**
   * Decision 155 (decision 149 rule 6): before Main restarts the host, every
   * other session with work under way — a turn Main sent, a Stop, a turn the
   * engine started (a goal round, a job's wake-up), or a channel the last pong
   * called busy — is sent `worker.dispose`, all at once, and the restart waits
   * {@link HOST_RESTART_DRAIN_MS} for them in all. DSH cancels each turn and
   * saves what it streamed as interrupted before it answers. A graceful stop
   * would do the same, but an agent stuck in the host keeps that stop from
   * finishing, and the SIGKILL after it saves nothing.
   *
   * A session that answers closes its channel ahead of the host: that exit
   * reads `engine_restarted` (`hostFaultOf`), and it waits for the same
   * recovery batch as the rest. One that does not answer in time, or fails,
   * goes with the host as before. Idle sessions, and one mid-rewind or fork,
   * are left to the restart: nothing they streamed is at stake.
   */
  private async closeBusyChannelsBeforeRestart(stuck: ManagedSlot | undefined): Promise<void> {
    const busy = this.busyChannels();
    const targets = [...this.entriesBySession.values()].filter((entry) => {
      const slot = entry.slot;
      if (entry === stuck || entry.state !== 'ready' || entry.mutationInFlight !== null) {
        return false;
      }
      if (!slot || slot.state !== 'running') return false;
      return (
        entry.activeRequestId !== null ||
        entry.stopWatchdog !== undefined ||
        entry.workerTurn !== undefined ||
        (slot.channelId !== undefined && busy.has(slot.channelId))
      );
    });
    if (targets.length === 0) return;
    const started = this.now();
    let closed = 0;
    const closing = Promise.allSettled(
      targets.map(async (entry) => {
        const slot = entry.slot as WorkerSlot;
        this.drainedSlots.add(slot);
        try {
          const result = await slot.request<WorkerDisposeResult, WorkerDisposeRequest['payload']>(
            'worker.dispose',
            { reason: 'slot-replace' },
            { timeoutMs: HOST_RESTART_DRAIN_MS }
          );
          if (isWorkerDisposeResult(result)) closed += 1;
        } catch (error) {
          console.warn(
            `[worker-manager] ${entry.logicalSessionId}: not closed before the DSH host restart, so it goes with the host: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HOST_RESTART_DRAIN_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([closing, deadline]);
    } finally {
      clearTimeout(timer);
    }
    console.warn(
      `[worker-manager] closed ${closed} of ${targets.length} busy session(s) in ${this.now() - started} ms before restarting the DSH host`
    );
  }

  /**
   * Take a live entry out of service ahead of `restartEntry`: a crash, or a
   * Stop the watchdog gave up on. Reports the turn it cut short, and whether a
   * Stop was waiting on it, so each caller can say how that turn ended.
   */
  private enterCrashed(
    entry: ManagedSlot,
    error: string,
    dumpReason = error
  ): { turnId: string | null; stopping: boolean } {
    const stopping = entry.stopWatchdog !== undefined;
    this.clearStopWatchdog(entry);
    entry.state = 'crashed';
    entry.error = error;
    this.dumpWorkerStderr(entry, dumpReason);
    const turnId = entry.activeRequestId;
    entry.activeRequestId = null;
    entry.reportedStatus = undefined;
    entry.workerTurn = undefined;
    entry.lastIdleAt = this.now();
    return { turnId, stopping };
  }

  /**
   * Reopen one crashed session on a fresh slot.
   *
   * `hostFault` — dsh-rebase decision 020 rule 4: the recovery batch reopens a
   * session the shared host took down, which costs the session nothing. Its
   * own budget (per `restartWindowMs`) is spent only by its own crashes and by
   * attempts that fail for its own reasons; an attempt the host went away
   * under goes back to the host's batch instead.
   */
  private async restartEntry(
    entry: ManagedSlot,
    options: { hostFault?: boolean } = {}
  ): Promise<void> {
    if (
      this.entriesBySession.get(entry.logicalSessionId) !== entry ||
      entry.state !== 'crashed' ||
      !entry.acceptEvents
    ) {
      return;
    }
    if (!entry.sessionFile) {
      entry.state = 'error';
      entry.error = 'Crashed worker has no durable session identity and cannot be restarted safely';
      this.announceParked(entry);
      this.updateManagerState();
      return;
    }
    const now = this.now();
    entry.restartAttempts = entry.restartAttempts.filter(
      (attempt) => now - attempt <= this.restartWindowMs
    );
    if (!options.hostFault) {
      if (entry.restartAttempts.length >= this.maxRestartAttempts) {
        this.parkInError(
          entry,
          SESSION_RESTART_EXHAUSTED,
          `Worker restart budget exhausted (${this.maxRestartAttempts} attempts per ${this.restartWindowMs}ms)`
        );
        this.updateManagerState();
        return;
      }
      entry.restartAttempts.push(now);
    }
    entry.state = 'restarting';
    const oldSlot = entry.slot;
    // A session whose identity was never committed has no file on disk to
    // reopen — Pi reserved the name and died before writing it. Reopening that
    // path fails with WORKER_SESSION_FILE_NOT_FOUND on every attempt, which is
    // what used to burn the whole restart budget and park the session in
    // `error` for the rest of the run. Nothing was written and nothing durable
    // was ever advertised, so the honest recovery is a fresh Pi session under
    // the same logical session id. The existence re-check matters: the file can
    // land between the last commit attempt and the crash, and abandoning a real
    // file with real content would be data loss.
    const rematerialize =
      !entry.identityCommitted &&
      (entry.sessionFile === null || !(await this.sessionFileExists(entry.sessionFile)));
    let exitMark = this.hostExitMark();
    try {
      if (oldSlot) {
        // Never open the same JSONL in a replacement until old-process exit is
        // confirmed. A failed disposal remains physically owned for app-close
        // force kill and consumes the bounded restart budget.
        try {
          await oldSlot.dispose('slot-replace');
        } catch (error) {
          // decision 046: a worker the stop watchdog gave up on is wedged, so
          // missing its dispose ACK is expected. The exit is what the
          // replacement needs, and `disposed` is the slot confirming it.
          if (oldSlot.state !== 'disposed') {
            // A channel on the shared host is never confirmed by waiting
            // longer: its agent still holds the lock (decision 021 ladder B).
            if (!this.host) throw error;
            await this.escalateStuckChannel(entry, oldSlot);
            exitMark = this.hostExitMark();
            if ((entry.hostFaultStreak ?? 0) >= HOST_FAULT_SUSPECT_STREAK) {
              this.parkInError(
                entry,
                SESSION_SUSPECT,
                'its channel would not close twice in a row, so it is not reopened automatically'
              );
              this.updateManagerState();
              return;
            }
          }
        }
        this.ownedSlots.delete(oldSlot);
      }
      entry.generation += 1;
      entry.slot = null;
      const created = await this.spawnForEntry(
        entry,
        {
          ...(entry.bootstrap?.model ? { model: entry.bootstrap.model } : {}),
          ...(entry.bootstrap?.effort ? { effort: entry.bootstrap.effort } : {}),
        },
        { fresh: rematerialize }
      );
      const reopenedFile = created.bootstrap.sessionFile
        ? normalizeWorkerPath(created.bootstrap.sessionFile, 'Pi session file')
        : null;
      if (!reopenedFile) {
        await this.abandonSpawnedSlot(created.slot);
        throw new WorkerManagerError(
          'worker_restart_identity_mismatch',
          'Restarted worker did not report a Pi session file'
        );
      }
      if (rematerialize) {
        this.adoptRematerializedFile(entry, reopenedFile);
        // The replacement session starts at its own root, whatever branch the
        // dead one had been sitting on.
        entry.leafCheckpoint = created.bootstrap.leaf;
        entry.bootstrap = { ...created.bootstrap, sessionFile: reopenedFile };
        entry.state = 'ready';
        entry.error = null;
        entry.lastIdleAt = this.now();
        this.state = 'ready';
        // No history triplet: the replacement session is empty, and the turn
        // that died was never persisted, so there is nothing to replay. The
        // renderer already saw session.failed for that turn.
        this.dispatch({
          type: 'session.status',
          sessionId: entry.logicalSessionId,
          requestId: nextRequestId('restart'),
          payload: { status: 'idle' },
        });
        return;
      }
      if (sessionWorkerKey(reopenedFile) !== entry.key) {
        await this.abandonSpawnedSlot(created.slot);
        throw new WorkerManagerError(
          'worker_restart_identity_mismatch',
          'Restarted worker did not reopen the authoritative Pi session file'
        );
      }
      const history = created.bootstrap.initialHistory;
      if (!isWorkerHistoryResult(history)) {
        throw new WorkerManagerError(
          'worker_restart_history_missing',
          'Restarted Pi worker did not return branch history'
        );
      }
      this.validateHistoryResult(entry, history);
      // The file exists — the worker just reopened it — so a session that
      // crashed after its first assistant message finally gets its identity
      // indexed. commitPiLeaf below requires that row, so this has to precede it.
      await this.ensureIdentityCommitted(entry, entry.generation);
      await this.commitPiLeaf({
        sessionId: entry.logicalSessionId,
        runtimeIdentity: reopenedFile,
        piLeaf: created.bootstrap.leaf,
      });
      entry.leafCheckpoint = created.bootstrap.leaf;
      entry.bootstrap = { ...created.bootstrap, sessionFile: reopenedFile };
      entry.state = 'ready';
      entry.error = null;
      entry.lastIdleAt = this.now();
      this.state = 'ready';
      this.publishHistoryTriplet(entry, nextRequestId('restart'), history, 'refresh');
    } catch (error) {
      entry.state = 'crashed';
      entry.error = error instanceof Error ? error.message : String(error);
      if (this.host && this.isHostFault(error, exitMark)) {
        // decision 020 rule 4: the host went away under this attempt, which is
        // not the session's doing and costs it nothing. A failed host (budget
        // spent, or a predecessor that would not die) leaves it in the shared
        // `error`; otherwise the host's next batch reopens it.
        if (this.host.status().state === 'failed') {
          this.parkInError(entry, HOST_UNAVAILABLE, entry.error);
        } else {
          console.warn(
            `[worker-manager] ${entry.logicalSessionId}: reopening waits for the DSH host: ${entry.error}`
          );
          this.queueHostRecovery(entry);
        }
        this.updateManagerState();
        return;
      }
      // Each failed attempt eats the restart budget, and exhausting it parks the
      // session in `error` for good. Without this line the only trace of WHY is
      // a field nobody reads, and the session just stops working.
      console.error(
        `[worker-manager] restart attempt ${entry.restartAttempts.length}/${this.maxRestartAttempts} failed for ${entry.logicalSessionId}: ${entry.error}`
      );
      this.updateManagerState();
      void this.serialize(() => this.restartEntry(entry));
    }
  }

  /**
   * decision 021 ladder B — the channel neither answered `worker.dispose` nor
   * confirmed its close, and the host did not exit: an agent stuck inside the
   * host still holds this session's lock, and only a host restart releases it.
   * The other sessions with work under way are closed first, so their streamed
   * text is saved as interrupted (decision 155): the stuck agent keeps the
   * graceful stop from finishing. Then graceful, SIGKILL after 3.5 s, then one
   * new host. The others read `engine_restarted` and are reopened in one batch
   * after this session, which goes first. The restart spends the host budget, and wedging the host counts
   * as this session's presence at a fault (decision 020 rule 5).
   */
  private async escalateStuckChannel(entry: ManagedSlot, oldSlot: WorkerSlot): Promise<void> {
    console.warn(
      `[worker-manager] ${entry.logicalSessionId}: its channel did not close; restarting the DSH host (Stop ladder B)`
    );
    entry.hostFaultStreak = (entry.hostFaultStreak ?? 0) + 1;
    await this.restartHost('stuck-session', entry);
    // Its channel went with the old host; this only retires the slot object.
    if (oldSlot.forceKillNow()) this.ownedSlots.delete(oldSlot);
  }

  /** Drop a replacement slot that failed its identity check; keep it force-killable. */
  private async abandonSpawnedSlot(slot: WorkerSlot): Promise<void> {
    try {
      await slot.dispose('slot-dispose');
      this.ownedSlots.delete(slot);
    } catch {
      // Retain physical ownership for forceKillAllNow().
    }
  }

  /**
   * Rebind a re-materialized session to the file its replacement worker created.
   *
   * The logical session id never changes, so this retargets one existing index
   * row rather than creating a second session: no duplicate rows, no orphans.
   * The identity stays uncommitted — the new file is as unwritten as the old
   * one was, and it earns its durable entry the same way, by materializing.
   */
  private adoptRematerializedFile(entry: ManagedSlot, sessionFile: string): void {
    const durableKey = sessionWorkerKey(sessionFile);
    const conflict = this.entriesByKey.get(durableKey);
    if (conflict && conflict !== entry) {
      throw new WorkerManagerError(
        'worker_session_identity_conflict',
        `Pi session file is already owned by logical session ${conflict.logicalSessionId}`
      );
    }
    entry.slot?.remapSlotKey(durableKey);
    this.entriesByKey.delete(entry.key);
    entry.key = durableKey;
    entry.sessionFile = sessionFile;
    this.entriesByKey.set(durableKey, entry);
  }

  /**
   * Write `entry.sessionFile` into the durable index, but only once the file
   * actually exists.
   *
   * Returns whether the entry now holds a committed identity. `false` is not a
   * failure: it means Pi has not written this session yet, so there is nothing
   * durable to advertise and nothing a later reopen could resume.
   */
  private async commitIdentityIfMaterialized(entry: ManagedSlot): Promise<boolean> {
    if (entry.identityCommitted) return true;
    const sessionFile = entry.sessionFile;
    if (!sessionFile || !(await this.sessionFileExists(sessionFile))) return false;
    await this.bindRuntimeIdentity(entry.logicalSessionId, sessionFile);
    entry.identityCommitted = true;
    return true;
  }

  /**
   * Publish the durable identity of a session whose JSONL materialized after
   * creation, so the index and the renderer stop treating it as unbound.
   *
   * `session.updated` already exists for exactly this — SessionIndexService and
   * the renderer store both fold its `runtimeIdentity` in — it simply had no
   * emitter until the identity stopped being published up front.
   */
  private async ensureIdentityCommitted(entry: ManagedSlot, generation: number): Promise<void> {
    if (entry.identityCommitted) return;
    const sessionFile = entry.sessionFile;
    if (!sessionFile) return;
    if (!(await this.commitIdentityIfMaterialized(entry))) return;
    // The stat and the index write are both awaited, so re-check that this
    // entry still owns the same file before announcing it.
    if (!this.isAuthoritative(entry, generation) || entry.sessionFile !== sessionFile) return;
    this.dispatch({
      type: 'session.updated',
      sessionId: entry.logicalSessionId,
      payload: { runtimeIdentity: sessionFile },
    });
  }

  private isAuthoritative(entry: ManagedSlot, generation: number): boolean {
    return (
      entry.acceptEvents &&
      this.entriesBySession.get(entry.logicalSessionId) === entry &&
      this.entriesByKey.get(entry.key) === entry &&
      entry.generation === generation
    );
  }

  private async syncLeafCheckpoint(entry: ManagedSlot, generation: number): Promise<void> {
    try {
      if (!this.isAuthoritative(entry, generation) || entry.activeRequestId) return;
      // A turn that just ended may have materialized this session's JSONL for
      // the first time. Publish the identity before the leaf commit, which the
      // index rejects for a session it has no runtimeIdentity for; a session
      // Pi still has not written has no leaf worth persisting either.
      await this.ensureIdentityCommitted(entry, generation);
      if (!entry.identityCommitted) return;
      const tree = await this.readTree(entry);
      if (!this.isAuthoritative(entry, generation)) return;
      const leaf = tree.snapshot.leaf;
      if (
        entry.leafCheckpoint?.activeEntryId === leaf.activeEntryId &&
        entry.leafCheckpoint?.fileTailEntryId === leaf.fileTailEntryId
      ) {
        return;
      }
      await this.commitPiLeaf({
        sessionId: entry.logicalSessionId,
        runtimeIdentity: tree.snapshot.sessionFile,
        piLeaf: leaf,
      });
      if (this.isAuthoritative(entry, generation)) entry.leafCheckpoint = leaf;
    } catch (error) {
      this.log('[worker-manager] failed to persist Pi leaf checkpoint', error);
    }
  }

  /**
   * Recompute the manager-level state from the pool.
   *
   * An EMPTY pool deliberately leaves the state alone. Workers are spawned
   * lazily — a freshly created session has no worker until its first send — so
   * "no entries" is the idle state of a perfectly healthy manager, not a
   * stopped one. Deriving `stopped` from it made the renderer show
   * "Pi session service stopped · click Retry" on a service that answered the
   * very next message, which is the one thing a status ribbon must never do.
   *
   * `stopped` is therefore only ever set by the two paths that really stop the
   * manager (`shutdown`, `forceKillAllNow`) and by the initial value before
   * `ensureReady`. Leaving it untouched here preserves both: a manager that
   * was never started stays `stopped`, and one that was shut down does not
   * silently come back as `ready` when a stale disposal recomputes the state.
   */
  private updateManagerState(): void {
    const entries = [...this.entriesBySession.values()];
    if (entries.some((entry) => entry.state === 'error' || entry.state === 'crashed')) {
      this.state = 'degraded';
    } else if (entries.length > 0) {
      this.state = 'ready';
    } else if (this.state === 'degraded') {
      // The last failed worker just left the pool — the manager is usable again.
      this.state = 'ready';
    }
  }

  private dispatch(event: RuntimeEventDraft): void {
    const stamped = {
      ...event,
      seq: ++this.eventSequence,
      timestamp: this.now(),
    } as RuntimeEvent;
    for (const handler of this.handlers) handler(stamped);
  }
}

export const workerManager = new WorkerManager({
  // dsh-rebase P1-3c: the one shared DSH host every chat channel runs on, the
  // same supervisor `createDshChatSlot` opens channels from.
  host: dshHostSupervisor,
  // P5-2-3: the real preview window, injected here rather than defaulted
  // inside the class. See the constructor note.
  showPreview: (request) => previewWindowManager.show(request),
  bindRuntimeIdentity: (sessionId, sessionFile) =>
    sessionIndexService.bindRuntimeIdentity(sessionId, sessionFile),
  commitResumed: (input) => sessionIndexService.commitResumed(input),
  commitPiLeaf: (input) => sessionIndexService.commitPiLeaf(input),
  createForked: (entry) => sessionIndexService.createForked(entry),
  // session-index-09: the sweep reconciles against the real index, which is
  // also what keeps it from looking anywhere the app does not already know.
  listIndexedSessions: () => sessionIndexService.list(),
});
