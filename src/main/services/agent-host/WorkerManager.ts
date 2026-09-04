import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import type { SessionAttachment, SessionEffortLevel } from '@shared/types/agentHost';
import { PI_AGENT } from '@shared/types/agentWire';
import type {
  WorkerImportConversationPayload,
  WorkerInspectImportedSessionPayload,
  WorkerInspectImportedSessionResult,
  WorkerReconcileImportedSessionPayload,
  WorkerReconcileImportedSessionResult,
} from '@shared/types/legacyImport';
import {
  type ExtensionUiResponse,
  isExtensionUiDialogMethod,
  type RuntimeEvent,
  type RuntimeEventDraft,
} from '@shared/types/runtimeEvents';
import type { PiLeafCheckpoint, SessionTreeSnapshot } from '@shared/types/sessionHistory';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import type { SessionPermissionTier } from '@shared/types/sessionPermissionTier';
import {
  isWorkerDiscardForkResult,
  isWorkerExtensionUiResponseResult,
  isWorkerForkResult,
  isWorkerHistoryResult,
  isWorkerReloadResult,
  isWorkerRewindResult,
  isWorkerSendResult,
  isWorkerStopResult,
  isWorkerTreeResult,
  type WorkerDiscardForkPayload,
  type WorkerDiscardForkResult,
  type WorkerExtensionUiResponsePayload,
  type WorkerExtensionUiResponseResult,
  type WorkerForkPayload,
  type WorkerForkResult,
  type WorkerHistoryPayload,
  type WorkerHistoryResult,
  type WorkerReloadPayload,
  type WorkerReloadResult,
  type WorkerRewindPayload,
  type WorkerRewindResult,
  type WorkerRpcEvent,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerSetPermissionTierPayload,
  type WorkerSetPermissionTierResult,
  type WorkerStopPayload,
  type WorkerStopResult,
  type WorkerTreePayload,
  type WorkerTreeResult,
} from '@shared/types/workerRpc';
import { sessionIndexService } from '../chat/SessionIndexService';
import {
  type CreatedPiImport,
  createPiImport,
  inspectPiImport,
  reconcilePiImport,
} from '../legacyImport/PiImportProcess';
import { type CreatedPiWorkerSlot, createPiWorkerSlot } from './createPiWorkerSlot';
import { drainStderrLines, flushStderrPending, pushRecentStderr } from './hostStderr';
import type { WorkerSlot, WorkerSlotLifecycleEvent } from './WorkerSlot';
import { normalizeWorkerPath, sessionWorkerKey, workspaceWorkerKey } from './workerSessionKey';

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
  bootstrap: CreatedPiWorkerSlot['bootstrap'] | null;
  state: WorkerManagerEntryState;
  activeRequestId: string | null;
  ownerWebContentsId: number | null;
  acceptEvents: boolean;
  pendingBlockingRequests: Set<string>;
  extensionRuntimeIds: Set<string>;
  lastUsedAt: number;
  lastIdleAt: number;
  restartAttempts: number[];
  generation: number;
  configGeneration: number;
  error: string | null;
  leafCheckpoint: PiLeafCheckpoint | null;
  branchRevision: number;
  mutationInFlight: 'rewind' | 'fork' | 'reload' | null;
  /** Bytes after the last newline of this worker's stderr; see hostStderr.ts. */
  stderrPending: string;
  /** Last RECENT_STDERR_LIMIT stderr lines, replayed when the worker dies. */
  recentStderr: string[];
}

interface BlockingRequestOrigin {
  entry: ManagedSlot;
  generation: number;
  ownerWebContentsId: number | null;
  runtimeId: string;
}

export interface WorkerManagerOptions {
  createSlot?: typeof createPiWorkerSlot;
  bindRuntimeIdentity?: (sessionId: string, sessionFile: string) => Promise<void>;
  commitResumed?: (input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
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
  createImport?: typeof createPiImport;
  inspectImport?: typeof inspectPiImport;
  reconcileImport?: typeof reconcilePiImport;
  onEvent?: (event: RuntimeEvent) => void;
  log?: (...args: unknown[]) => void;
  now?: () => number;
  createToken?: () => string;
  capacity?: number;
  idleTimeoutMs?: number;
  idleSweepIntervalMs?: number;
  maxRestartAttempts?: number;
  restartWindowMs?: number;
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
  pendingBlockingRequests: number;
  lastUsedAt: number;
  lastIdleAt: number;
  error: string | null;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_RESTART_ATTEMPTS = 2;
const DEFAULT_RESTART_WINDOW_MS = 60_000;

let commandSequence = 0;
function nextRequestId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}-${Date.now()}-${commandSequence}`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer, received ${value}`);
  }
  return value;
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

/** Product default: 4 normally, 3 on mid-range hosts, 2 on <=4 GiB hosts. */
export function resolveDefaultWorkerCapacity(totalMemoryBytes = os.totalmem()): number {
  if (totalMemoryBytes <= 4 * 1024 ** 3) return 2;
  if (totalMemoryBytes <= 8 * 1024 ** 3) return 3;
  return 4;
}

/** Startup-only product configuration; the wire protocol never fixes capacity. */
export function resolveWorkerCapacity(
  env: NodeJS.ProcessEnv = process.env,
  totalMemoryBytes = os.totalmem()
): number {
  const configured = env.AICLIENT_PI_WORKER_CAPACITY?.trim();
  if (!configured) return resolveDefaultWorkerCapacity(totalMemoryBytes);
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 8) {
    throw new Error(
      `AICLIENT_PI_WORKER_CAPACITY must be an integer from 1 to 8, received ${configured}`
    );
  }
  return parsed;
}

function readString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}

function readStringArray(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

export class WorkerManager {
  private readonly createSlot: typeof createPiWorkerSlot;
  private readonly bindRuntimeIdentity: (sessionId: string, sessionFile: string) => Promise<void>;
  private readonly commitResumed: NonNullable<WorkerManagerOptions['commitResumed']>;
  private readonly commitPiLeaf: NonNullable<WorkerManagerOptions['commitPiLeaf']>;
  private readonly createForked: NonNullable<WorkerManagerOptions['createForked']>;
  private readonly sessionFileExists: (sessionFile: string) => Promise<boolean>;
  private readonly createImport: typeof createPiImport;
  private readonly inspectImport: typeof inspectPiImport;
  private readonly reconcileImport: typeof reconcilePiImport;
  private readonly handlers = new Set<(event: RuntimeEvent) => void>();
  private importSlotActive = false;
  private activeImport: CreatedPiImport | null = null;
  private activeImportSlot: WorkerSlot | null = null;
  private readonly log: (...args: unknown[]) => void;
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly capacity: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRestartAttempts: number;
  private readonly restartWindowMs: number;
  private readonly entriesByKey = new Map<string, ManagedSlot>();
  private readonly entriesBySession = new Map<string, ManagedSlot>();
  private readonly blockingRequests = new Map<string, BlockingRequestOrigin>();
  private readonly closingBlockingRequests = new Set<string>();
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

  constructor(options: WorkerManagerOptions = {}) {
    this.createSlot = options.createSlot ?? createPiWorkerSlot;
    this.bindRuntimeIdentity = options.bindRuntimeIdentity ?? (async () => undefined);
    this.commitResumed = options.commitResumed ?? (async () => undefined);
    this.commitPiLeaf = options.commitPiLeaf ?? (async () => undefined);
    this.createForked = options.createForked ?? (async (entry) => entry);
    this.sessionFileExists = options.sessionFileExists ?? statSessionFileExists;
    this.createImport = options.createImport ?? createPiImport;
    this.inspectImport = options.inspectImport ?? inspectPiImport;
    this.reconcileImport = options.reconcileImport ?? reconcilePiImport;
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

  getSlotSnapshots(): WorkerManagerSlotSnapshot[] {
    return [...this.entriesBySession.values()].map((entry) => ({
      key: entry.key,
      logicalSessionId: entry.logicalSessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      state: entry.state,
      generation: entry.generation,
      active: entry.activeRequestId !== null,
      foreground: entry.ownerWebContentsId !== null,
      pendingBlockingRequests: entry.pendingBlockingRequests.size,
      lastUsedAt: entry.lastUsedAt,
      lastIdleAt: entry.lastIdleAt,
      error: entry.error,
    }));
  }

  async createLegacyImport(payload: WorkerImportConversationPayload): Promise<CreatedPiImport> {
    if (this.importSlotActive) {
      throw new WorkerManagerError(
        'worker_import_busy',
        'Another legacy import WorkerSlot is active',
        true
      );
    }
    this.importSlotActive = true;
    try {
      const created = await this.createImport(payload, {
        onSlotCreated: (slot) => {
          this.activeImportSlot = slot;
        },
      });
      if (
        !this.importSlotActive ||
        !this.activeImportSlot ||
        this.activeImportSlot.state !== 'running'
      ) {
        created.forceKillNow();
        throw new WorkerManagerError(
          'worker_import_superseded',
          'Legacy import lost WorkerManager lifecycle authority'
        );
      }
      this.activeImport = created;
      let released = false;
      return {
        result: created.result,
        pid: created.pid,
        discard: () => created.discard(),
        dispose: async () => {
          if (released) return;
          try {
            await created.dispose();
            released = true;
            if (this.activeImport === created) this.activeImport = null;
            if (this.activeImportSlot?.state === 'disposed') this.activeImportSlot = null;
            this.importSlotActive = false;
          } catch (error) {
            const killed = created.forceKillNow();
            if (killed) {
              released = true;
              if (this.activeImport === created) this.activeImport = null;
              this.activeImportSlot = null;
              this.importSlotActive = false;
            } else {
              this.activeImport = created;
              this.importSlotActive = true;
            }
            throw error;
          }
        },
        forceKillNow: () => {
          released = true;
          const killed = created.forceKillNow();
          if (this.activeImport === created) this.activeImport = null;
          this.activeImportSlot = null;
          this.importSlotActive = false;
          return killed;
        },
      };
    } catch (error) {
      if (!this.activeImportSlot || this.activeImportSlot.state === 'disposed') {
        this.activeImportSlot = null;
        this.importSlotActive = false;
      }
      throw error;
    }
  }

  async inspectLegacyImport(
    payload: WorkerInspectImportedSessionPayload
  ): Promise<WorkerInspectImportedSessionResult> {
    if (this.importSlotActive) {
      throw new WorkerManagerError(
        'worker_import_busy',
        'Legacy import inspection cannot run while an import WorkerSlot is active',
        true
      );
    }
    this.importSlotActive = true;
    try {
      const result = await this.inspectImport(payload, {
        onSlotCreated: (slot) => {
          this.activeImportSlot = slot;
        },
      });
      this.activeImportSlot = null;
      this.importSlotActive = false;
      return result;
    } catch (error) {
      const slot = this.activeImportSlot;
      const killed = !slot || slot.state === 'disposed' || slot.forceKillNow();
      if (killed) {
        this.activeImportSlot = null;
        this.importSlotActive = false;
      }
      throw error;
    }
  }

  async reconcileLegacyImport(
    payload: WorkerReconcileImportedSessionPayload
  ): Promise<WorkerReconcileImportedSessionResult> {
    if (this.importSlotActive) {
      throw new WorkerManagerError(
        'worker_import_busy',
        'Legacy import reconciliation cannot run while an import WorkerSlot is active',
        true
      );
    }
    this.importSlotActive = true;
    try {
      const result = await this.reconcileImport(payload, {
        onSlotCreated: (slot) => {
          this.activeImportSlot = slot;
        },
      });
      this.activeImportSlot = null;
      this.importSlotActive = false;
      return result;
    } catch (error) {
      const slot = this.activeImportSlot;
      const killed = !slot || slot.state === 'disposed' || slot.forceKillNow();
      if (killed) {
        this.activeImportSlot = null;
        this.importSlotActive = false;
      }
      throw error;
    }
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
              agent: PI_AGENT,
              ...(committed ? { runtimeIdentity: existing.sessionFile } : {}),
            },
          });
          this.dispatch({
            type: 'session.status',
            sessionId: existing.logicalSessionId,
            requestId,
            payload: { status: existing.activeRequestId ? 'running' : 'idle' },
          });
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
        await this.retireAndDispose(victim, 'slot-replace');
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
        sessionFile: null,
        identityCommitted: false,
        slot: null,
        bootstrap: null,
        state: 'creating',
        activeRequestId: null,
        ownerWebContentsId: null,
        acceptEvents: true,
        pendingBlockingRequests: new Set(),
        extensionRuntimeIds: new Set(),
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
        const created = await this.spawnForEntry(entry, {
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        });
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
            agent: PI_AGENT,
            ...(materialized ? { runtimeIdentity: sessionFile } : {}),
          },
        });
        this.dispatch({
          type: 'session.status',
          sessionId: entry.logicalSessionId,
          requestId,
          payload: { status: 'idle' },
        });
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
    leafCheckpoint?: PiLeafCheckpoint;
    ownerWebContentsId?: number;
    /** U05-c — `workspacePath` is a scratch directory; bootstrap untrusted. */
    unbound?: boolean;
    /** U12 fix — tier the worker starts on; omit for the default. */
    tier?: SessionPermissionTier;
  }): Promise<string> {
    const sessionFile = normalizeWorkerPath(input.sessionFile, 'Pi session file');
    const cwd = normalizeWorkerPath(input.workspacePath, 'Workspace path');
    const fingerprint = JSON.stringify([
      sessionFile,
      cwd,
      input.model ?? '',
      input.effort ?? '',
      input.leafCheckpoint?.activeEntryId ?? '',
      input.leafCheckpoint?.fileTailEntryId ?? '',
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
        if (entry.activeRequestId || entry.pendingBlockingRequests.size > 0) {
          throw new WorkerManagerError(
            'session_busy',
            `Session ${input.sessionId} cannot resume while active`,
            true
          );
        }
        this.claimEntry(entry, input.ownerWebContentsId);
        const history = await this.readHistory(entry, 0, 80);
        await this.commitResumed({
          sessionId: input.sessionId,
          workspacePath: cwd,
          runtimeIdentity: sessionFile,
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
        await this.retireAndDispose(victim, 'slot-replace');
      }

      const durableKey = sessionWorkerKey(sessionFile);
      const conflict = this.entriesByKey.get(durableKey);
      if (conflict) {
        throw new WorkerManagerError(
          'worker_session_identity_conflict',
          `Pi session file is already owned by logical session ${conflict.logicalSessionId}`
        );
      }
      const timestamp = this.now();
      entry = {
        key: durableKey,
        temporaryKey: durableKey,
        logicalSessionId: input.sessionId,
        cwd,
        unbound: input.unbound === true,
        tier: input.tier,
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
        pendingBlockingRequests: new Set(),
        extensionRuntimeIds: new Set(),
        lastUsedAt: timestamp,
        lastIdleAt: timestamp,
        restartAttempts: [],
        generation: 1,
        configGeneration: this.configGeneration,
        error: null,
        leafCheckpoint: input.leafCheckpoint ?? null,
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
        const created = await this.spawnForEntry(entry, {
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        });
        const reopenedFile = created.bootstrap.sessionFile
          ? normalizeWorkerPath(created.bootstrap.sessionFile, 'Pi session file')
          : null;
        if (!reopenedFile || sessionWorkerKey(reopenedFile) !== durableKey) {
          throw new WorkerManagerError(
            'worker_resume_identity_mismatch',
            'Pi worker did not open the requested exact session file'
          );
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
          runtimeIdentity: sessionFile,
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
        this.resetExtensionUi(entry, 'session_replaced');
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

  /**
   * Re-read a live session's JSONL and republish its history.
   *
   * The Pi TUI writes the same file this worker owns, and a live worker never
   * re-reads it: pi's SessionManager caches the file at open. So after the
   * terminal has appended, the worker is showing pre-handover history and would
   * branch its next turn off the pre-handover leaf, stranding the terminal's
   * messages on an abandoned path.
   *
   * `resumeSession` cannot do this job. Its warm path deliberately short-
   * circuits — same file, same cwd, worker already ready, so it re-publishes
   * the history the worker already had. Only the cold path (no live entry)
   * touches disk, and the whole point of the TUI handover is that the worker
   * stays alive across it.
   *
   * Returns `reloaded: false` when there is no live worker to reload; the
   * caller resumes instead, which spawns and therefore reads the file anyway.
   */
  async reloadSession(input: {
    sessionId: string;
    sessionFile: string;
    ownerWebContentsId?: number;
  }): Promise<{ requestId: string; reloaded: boolean }> {
    const requestId = nextRequestId('reload');
    return this.serialize(async () => {
      const entry = this.entriesBySession.get(input.sessionId);
      if (!entry || entry.state !== 'ready' || !entry.slot) {
        return { requestId, reloaded: false };
      }
      if (!entry.sessionFile || sessionWorkerKey(input.sessionFile) !== entry.key) {
        throw new WorkerManagerError(
          'worker_reload_identity_conflict',
          `Session ${input.sessionId} is bound to another Pi session file`
        );
      }
      this.assertIdleEntry(entry, 'reload');
      this.claimEntry(entry, input.ownerWebContentsId);
      entry.mutationInFlight = 'reload';
      try {
        const slot = entry.slot;
        const generation = entry.generation;
        const result = await slot.request<WorkerReloadResult, WorkerReloadPayload>(
          'worker.reload',
          { logicalSessionId: entry.logicalSessionId, sessionFile: entry.sessionFile }
        );
        if (!isWorkerReloadResult(result)) {
          throw new WorkerManagerError(
            'worker_invalid_reload_result',
            'Pi worker returned an invalid reload result'
          );
        }
        this.validateHistoryResult(entry, result.history);
        if (entry.slot !== slot || !this.isAuthoritative(entry, generation)) {
          throw new WorkerManagerError(
            'worker_reload_stale',
            `Reload for ${input.sessionId} arrived from a retired WorkerSlot`,
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
        // The active branch can have moved to whatever the other writer
        // appended, so any tree snapshot or history page still in flight is
        // describing a branch that is no longer current.
        entry.branchRevision += 1;
        entry.lastUsedAt = this.now();
        entry.lastIdleAt = this.now();
        this.resetExtensionUi(entry, 'session_replaced');
        // 'branch', not 'refresh': the file is the authority now, so the
        // timeline is replaced rather than merged with what the renderer was
        // showing before the handover.
        this.dispatchHistory(entry, requestId, result.history, 'branch');
        this.dispatch({
          type: 'session.status',
          sessionId: entry.logicalSessionId,
          requestId,
          payload: { status: 'idle' },
        });
        return { requestId, reloaded: true };
      } catch (error) {
        // worker.reload tears the old Pi session down before building the new
        // one, so a failure leaves the worker without a usable session. Retire
        // it: the next request spawns a clean one straight from the file.
        await this.retireAndDispose(entry, 'slot-dispose').catch(() => undefined);
        this.updateManagerState();
        throw error;
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
          await this.retireAndDispose(victim, 'slot-replace');
        }

        const sourceSlot = source.slot;
        const sourceGeneration = source.generation;
        const fork = await sourceSlot?.request<WorkerForkResult, WorkerForkPayload>('worker.fork', {
          logicalSessionId: source.logicalSessionId,
          entryId: input.entryId,
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

        const sessionId = `session-fork-${randomUUID()}`;
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
          pendingBlockingRequests: new Set(),
          extensionRuntimeIds: new Set(),
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
          const created = await this.spawnForEntry(target, {
            ...(input.model ? { model: input.model } : {}),
          });
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
            agent: PI_AGENT,
            workspacePath: source.cwd,
            title: `${input.sourceTitle || 'Session'} (fork)`,
            ...(input.model ? { model: input.model } : {}),
            updatedAt: this.now(),
            archived: false,
          });
          indexCommitted = true;
          target.state = 'ready';
          target.error = null;
          this.dispatch({
            type: 'session.created',
            sessionId,
            requestId,
            payload: { agent: PI_AGENT, runtimeIdentity: sessionFile },
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
    };
    entry.activeRequestId = requestId;
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
      throw error;
    }
  }

  async stop(sessionId: string): Promise<string> {
    const requestId = nextRequestId('stop');
    const entry = this.entriesBySession.get(sessionId);
    if (!entry?.slot || entry.state !== 'ready') return requestId;
    entry.lastUsedAt = this.now();
    const payload: WorkerStopPayload = { logicalSessionId: sessionId, reason: 'user' };
    const result = await entry.slot.request<WorkerStopResult, WorkerStopPayload>(
      'worker.stop',
      payload
    );
    if (!isWorkerStopResult(result)) {
      throw new WorkerManagerError(
        'worker_invalid_stop_ack',
        'Pi worker returned an invalid stop acknowledgement'
      );
    }
    return requestId;
  }

  async respondExtensionUi(
    response: ExtensionUiResponse,
    ownerWebContentsId?: number
  ): Promise<string> {
    const requestId = nextRequestId('extui');
    const origin = this.blockingRequests.get(response.uiRequestId);
    if (
      this.closingBlockingRequests.has(response.uiRequestId) ||
      !origin ||
      !this.isAuthoritative(origin.entry, origin.generation)
    ) {
      throw new WorkerManagerError(
        'extension_ui_request_not_found',
        `Extension UI request ${response.uiRequestId} is no longer active`
      );
    }
    if (
      origin.ownerWebContentsId !== null &&
      ownerWebContentsId !== undefined &&
      origin.ownerWebContentsId !== ownerWebContentsId
    ) {
      throw new WorkerManagerError(
        'extension_ui_owner_mismatch',
        `Window ${ownerWebContentsId} does not own Extension UI request ${response.uiRequestId}`
      );
    }
    if (response.runtimeId !== origin.runtimeId) {
      throw new WorkerManagerError(
        'extension_ui_runtime_mismatch',
        `Extension UI request ${response.uiRequestId} belongs to another runtime`
      );
    }
    const entry = origin.entry;
    const payload: WorkerExtensionUiResponsePayload = {
      logicalSessionId: entry.logicalSessionId,
      response,
    };
    const result = await entry.slot?.request<
      WorkerExtensionUiResponseResult,
      WorkerExtensionUiResponsePayload
    >('worker.extensionUi.respond', payload);
    if (!isWorkerExtensionUiResponseResult(result)) {
      throw new WorkerManagerError(
        'worker_invalid_extension_ui_ack',
        'Pi worker returned an invalid Extension UI acknowledgement'
      );
    }
    this.forgetBlockingRequest(response.uiRequestId);
    entry.lastUsedAt = this.now();
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
    if (entry) entry.tier = tier;
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
    for (const [uiRequestId, origin] of [...this.blockingRequests]) {
      if (origin.ownerWebContentsId !== ownerWebContentsId) continue;
      this.closingBlockingRequests.add(uiRequestId);
      void this.dismissBlockingRequestForClosedOwner(uiRequestId, origin);
    }
  }

  releaseSession(sessionId: string): void {
    const entry = this.entriesBySession.get(sessionId);
    if (entry) entry.ownerWebContentsId = null;
  }

  reclaimIdle(): Promise<void> {
    return this.serialize(() => this.reclaimIdleInternal());
  }

  invalidateAll(): Promise<void> {
    return this.serialize(async () => {
      this.configGeneration += 1;
      await this.disposeEntries([...this.entriesBySession.values()], 'slot-replace');
      this.updateManagerState();
    });
  }

  disposeAll(reason: 'app-shutdown' | 'slot-dispose' = 'app-shutdown'): Promise<void> {
    return this.serialize(async () => {
      if (reason === 'app-shutdown' && this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }
      const activeImport = this.activeImport;
      const activeImportSlot = this.activeImportSlot;
      if (activeImport) await activeImport.dispose();
      else if (activeImportSlot) await activeImportSlot.dispose(reason);
      this.activeImport = null;
      this.activeImportSlot = null;
      this.importSlotActive = false;
      await this.disposeEntries([...this.entriesBySession.values()], reason);
      this.state = 'stopped';
    });
  }

  forceKillAllNow(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const entries = [...this.entriesBySession.values()];
    const slots = [...this.ownedSlots];
    this.activeImport?.forceKillNow();
    this.activeImportSlot?.forceKillNow();
    this.activeImport = null;
    this.activeImportSlot = null;
    this.importSlotActive = false;
    this.entriesByKey.clear();
    this.entriesBySession.clear();
    this.blockingRequests.clear();
    this.closingBlockingRequests.clear();
    this.state = 'stopped';
    for (const entry of entries) {
      entry.acceptEvents = false;
      entry.state = 'disposing';
    }
    for (const slot of slots) {
      if (slot.forceKillNow()) this.ownedSlots.delete(slot);
    }
  }

  private async spawnForEntry(
    entry: ManagedSlot,
    selection: { model?: string; effort?: SessionEffortLevel } = {},
    /**
     * Spawn a brand-new Pi session and ignore whatever file the entry names.
     * Used by the re-materialization path, which must not clear
     * `entry.sessionFile` up front: a failed spawn has to leave the entry
     * exactly as it found it so the next restart attempt sees the same state.
     */
    options: { fresh?: boolean } = {}
  ): Promise<CreatedPiWorkerSlot> {
    let expectedSlot: WorkerSlot | null = null;
    const created = await this.createSlot({
      slotKey: entry.key,
      logicalSessionId: entry.logicalSessionId,
      cwd: entry.cwd,
      generation: entry.generation,
      ...(entry.sessionFile && !options.fresh ? { sessionFile: entry.sessionFile } : {}),
      ...(entry.leafCheckpoint && !options.fresh ? { leafCheckpoint: entry.leafCheckpoint } : {}),
      ...(entry.unbound ? { unbound: true } : {}),
      ...(entry.tier ? { tier: entry.tier } : {}),
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
      throw error;
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
   */
  private absorbStderr(entry: ManagedSlot, generation: number, chunk: string): void {
    const drained = drainStderrLines(entry.stderrPending, chunk);
    entry.stderrPending = drained.pending;
    entry.recentStderr = pushRecentStderr(entry.recentStderr, drained.lines);
    const prefix = `[pi-worker:${entry.logicalSessionId}:g${generation}:stderr]`;
    for (const line of drained.lines) this.log(prefix, line);
  }

  /** Replay the dead worker's own diagnostics; clears the buffer. */
  private dumpWorkerStderr(entry: ManagedSlot, reason: string): void {
    const lines = [...entry.recentStderr, ...flushStderrPending(entry.stderrPending)];
    entry.stderrPending = '';
    entry.recentStderr = [];
    if (lines.length === 0) return;
    // console.error, not this.log: electron-log keeps error level even when
    // file logging is off, which is the configuration nearly everyone runs.
    console.error(
      `[pi-worker:${entry.logicalSessionId}:g${entry.generation}] ${reason}; last ${lines.length} stderr line(s):\n${lines.join('\n')}`
    );
  }

  private assertIdleEntry(entry: ManagedSlot, action: string): void {
    if (
      entry.activeRequestId ||
      entry.pendingBlockingRequests.size > 0 ||
      entry.mutationInFlight !== null
    ) {
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
      },
    });
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
      payload: { agent: PI_AGENT, runtimeIdentity: history.sessionFile },
    });
    this.dispatchHistory(entry, requestId, history, mode);
    this.dispatch({
      type: 'session.status',
      sessionId: entry.logicalSessionId,
      requestId,
      payload: { status: 'idle' },
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
    const candidates = [...this.entriesBySession.values()].filter((entry) =>
      this.isSafeToEvict(entry)
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
   */
  private isSafeToEvict(entry: ManagedSlot): boolean {
    return (
      (entry.state === 'ready' || entry.state === 'error') &&
      entry.ownerWebContentsId === null &&
      entry.activeRequestId === null &&
      entry.pendingBlockingRequests.size === 0 &&
      entry.mutationInFlight === null
    );
  }

  private async reclaimIdleInternal(): Promise<void> {
    if (this.idleTimeoutMs === 0) return;
    const cutoff = this.now() - this.idleTimeoutMs;
    const victims = [...this.entriesBySession.values()].filter(
      (entry) => this.isSafeToEvict(entry) && entry.lastIdleAt <= cutoff
    );
    await this.disposeEntries(victims, 'slot-replace');
    this.updateManagerState();
  }

  private async disposeEntries(
    entries: ManagedSlot[],
    reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace'
  ): Promise<void> {
    const unique = [...new Set(entries)];
    for (const entry of unique) this.retireEntry(entry, reason);
    const results = await Promise.allSettled(
      unique.map(async (entry) => {
        const slot = entry.slot;
        await slot?.dispose(reason);
        if (slot) this.ownedSlots.delete(slot);
      })
    );
    for (const result of results) {
      if (result.status === 'rejected')
        this.log('[worker-manager] slot disposal failed', result.reason);
    }
  }

  private async retireAndDispose(
    entry: ManagedSlot,
    reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace'
  ): Promise<void> {
    this.retireEntry(entry, reason);
    const slot = entry.slot;
    await slot?.dispose(reason);
    if (slot) this.ownedSlots.delete(slot);
  }

  private retireEntry(
    entry: ManagedSlot,
    reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace'
  ): void {
    this.resetExtensionUi(
      entry,
      reason === 'app-shutdown'
        ? 'host_shutdown'
        : reason === 'slot-dispose'
          ? 'session_closed'
          : 'session_replaced'
    );
    entry.acceptEvents = false;
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
  }

  private handleWorkerEvent(entry: ManagedSlot, slot: WorkerSlot, message: WorkerRpcEvent): void {
    if (!this.isAuthoritative(entry, message.generation) || entry.slot !== slot) return;
    if (entry.state !== 'ready' || message.type !== 'runtime.event') return;
    const event = message.payload as RuntimeEvent;
    if (!event || typeof event.type !== 'string') return;
    if (event.sessionId && event.sessionId !== entry.logicalSessionId) return;

    entry.lastUsedAt = this.now();
    const extensionRuntimeId = readString(event.payload, 'runtimeId');
    if (extensionRuntimeId && event.type.startsWith('extensionUi.')) {
      entry.extensionRuntimeIds.add(extensionRuntimeId);
    }
    if (event.type === 'extensionUi.request') {
      const method = readString(event.payload, 'method');
      const uiRequestId = readString(event.payload, 'uiRequestId');
      const runtimeId = extensionRuntimeId;
      if (uiRequestId && runtimeId && isExtensionUiDialogMethod(method)) {
        entry.pendingBlockingRequests.add(uiRequestId);
        this.blockingRequests.set(uiRequestId, {
          entry,
          generation: message.generation,
          ownerWebContentsId: entry.ownerWebContentsId,
          runtimeId,
        });
      }
    } else if (event.type === 'extensionUi.cancelled') {
      for (const id of readStringArray(event.payload, 'uiRequestIds')) {
        this.forgetBlockingRequest(id);
      }
    } else if (event.type === 'extensionUi.reset') {
      this.clearBlockingRequests(entry);
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
    if (
      event.type === 'session.completed' ||
      event.type === 'session.failed' ||
      event.type === 'session.stopped'
    ) {
      entry.activeRequestId = null;
      entry.lastIdleAt = this.now();
      void this.syncLeafCheckpoint(entry, message.generation);
    }
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
    entry.state = 'crashed';
    entry.error = event.error.message;
    this.dumpWorkerStderr(entry, `crashed: ${event.error.message}`);
    this.resetExtensionUi(entry, 'host_shutdown');
    const activeRequestId = entry.activeRequestId;
    entry.activeRequestId = null;
    entry.lastIdleAt = this.now();
    if (activeRequestId) {
      this.dispatch({
        type: 'session.status',
        sessionId: entry.logicalSessionId,
        requestId: activeRequestId,
        payload: { status: 'disconnected' },
      });
      this.dispatch({
        type: 'session.failed',
        sessionId: entry.logicalSessionId,
        requestId: activeRequestId,
        payload: { error: event.error.message },
      });
    }
    this.updateManagerState();
    void this.serialize(() => this.restartEntry(entry));
  }

  private async restartEntry(entry: ManagedSlot): Promise<void> {
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
      this.updateManagerState();
      return;
    }
    const now = this.now();
    entry.restartAttempts = entry.restartAttempts.filter(
      (attempt) => now - attempt <= this.restartWindowMs
    );
    if (entry.restartAttempts.length >= this.maxRestartAttempts) {
      entry.state = 'error';
      entry.error = `Worker restart budget exhausted (${this.maxRestartAttempts} attempts per ${this.restartWindowMs}ms)`;
      console.error(`[worker-manager] ${entry.logicalSessionId}: ${entry.error}`);
      this.updateManagerState();
      return;
    }
    entry.restartAttempts.push(now);
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
    try {
      if (oldSlot) {
        // Never open the same JSONL in a replacement until old-process exit is
        // confirmed. A failed disposal remains physically owned for app-close
        // force kill and consumes the bounded restart budget.
        await oldSlot.dispose('slot-replace');
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

  private async dismissBlockingRequestForClosedOwner(
    uiRequestId: string,
    origin: BlockingRequestOrigin
  ): Promise<void> {
    try {
      if (this.isAuthoritative(origin.entry, origin.generation)) {
        await origin.entry.slot?.request<
          WorkerExtensionUiResponseResult,
          WorkerExtensionUiResponsePayload
        >('worker.extensionUi.respond', {
          logicalSessionId: origin.entry.logicalSessionId,
          response: {
            runtimeId: origin.runtimeId,
            uiRequestId,
            ok: false,
            error: 'Owning window closed',
          },
        });
      }
    } catch (error) {
      this.log('[worker-manager] failed to dismiss closed-window Extension UI', error);
    } finally {
      if (this.blockingRequests.get(uiRequestId) === origin) {
        this.dispatch({
          type: 'extensionUi.cancelled',
          sessionId: origin.entry.logicalSessionId,
          payload: { runtimeId: origin.runtimeId, uiRequestIds: [uiRequestId], reason: 'aborted' },
        });
        this.forgetBlockingRequest(uiRequestId);
      }
    }
  }

  private forgetBlockingRequest(uiRequestId: string): void {
    const origin = this.blockingRequests.get(uiRequestId);
    this.blockingRequests.delete(uiRequestId);
    this.closingBlockingRequests.delete(uiRequestId);
    origin?.entry.pendingBlockingRequests.delete(uiRequestId);
  }

  private clearBlockingRequests(entry: ManagedSlot): void {
    for (const uiRequestId of [...entry.pendingBlockingRequests]) {
      this.blockingRequests.delete(uiRequestId);
      this.closingBlockingRequests.delete(uiRequestId);
      entry.pendingBlockingRequests.delete(uiRequestId);
    }
  }

  private resetExtensionUi(
    entry: ManagedSlot,
    reason: 'session_replaced' | 'session_closed' | 'host_shutdown'
  ): void {
    const requestsByRuntime = new Map<string, string[]>();
    for (const uiRequestId of entry.pendingBlockingRequests) {
      const origin = this.blockingRequests.get(uiRequestId);
      if (!origin) continue;
      const ids = requestsByRuntime.get(origin.runtimeId) ?? [];
      ids.push(uiRequestId);
      requestsByRuntime.set(origin.runtimeId, ids);
    }
    for (const [runtimeId, uiRequestIds] of requestsByRuntime) {
      this.dispatch({
        type: 'extensionUi.cancelled',
        sessionId: entry.logicalSessionId,
        payload: { runtimeId, uiRequestIds, reason },
      });
    }
    for (const runtimeId of entry.extensionRuntimeIds) {
      this.dispatch({
        type: 'extensionUi.reset',
        sessionId: entry.logicalSessionId,
        payload: { runtimeId, reason },
      });
    }
    this.clearBlockingRequests(entry);
    entry.extensionRuntimeIds.clear();
  }

  /**
   * Recompute the manager-level state from the pool.
   *
   * An EMPTY pool deliberately leaves the state alone. Workers are spawned
   * lazily — a freshly created session has no worker until its first send — so
   * "no entries" is the idle state of a perfectly healthy manager, not a
   * stopped one. Deriving `stopped` from it made the renderer show
   * "Pi session service 已停止 · 点击 Retry" on a service that answered the
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
  bindRuntimeIdentity: (sessionId, sessionFile) =>
    sessionIndexService.bindRuntimeIdentity(sessionId, sessionFile),
  commitResumed: (input) => sessionIndexService.commitResumed(input),
  commitPiLeaf: (input) => sessionIndexService.commitPiLeaf(input),
  createForked: (entry) => sessionIndexService.createForked(entry),
});
