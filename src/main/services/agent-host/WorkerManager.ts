import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { SessionAttachment, SessionEffortLevel } from '@shared/types/agentHost';
import { PI_AGENT } from '@shared/types/agentWire';
import {
  type ExtensionUiResponse,
  isExtensionUiDialogMethod,
  type RuntimeEvent,
  type RuntimeEventDraft,
} from '@shared/types/runtimeEvents';
import {
  isWorkerExtensionUiResponseResult,
  isWorkerSendResult,
  isWorkerStopResult,
  type WorkerExtensionUiResponsePayload,
  type WorkerExtensionUiResponseResult,
  type WorkerRpcEvent,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerStopPayload,
  type WorkerStopResult,
} from '@shared/types/workerRpc';
import { sessionIndexService } from '../chat/SessionIndexService';
import { type CreatedPiWorkerSlot, createPiWorkerSlot } from './createPiWorkerSlot';
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
  sessionFile: string | null;
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
  private readonly handlers = new Set<(event: RuntimeEvent) => void>();
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
    capabilities: { history: false; thinking: true; permissionPolicy: true };
    capacity: number;
    slots: number;
    active: number;
    restarting: number;
    errors: number;
  } {
    const entries = [...this.entriesBySession.values()];
    return {
      state: this.state,
      capabilities: { history: false, thinking: true, permissionPolicy: true },
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

  createSession(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    effort?: SessionEffortLevel;
    ownerWebContentsId?: number;
  }): Promise<string> {
    const requestId = nextRequestId('create');
    return this.serialize(async () => {
      const existing = this.entriesBySession.get(input.sessionId);
      if (existing && existing.state !== 'disposing') {
        this.claimEntry(existing, input.ownerWebContentsId);
        existing.lastUsedAt = this.now();
        if (existing.state === 'ready' && existing.sessionFile) {
          this.dispatch({
            type: 'session.created',
            sessionId: existing.logicalSessionId,
            requestId,
            payload: { agent: PI_AGENT, runtimeIdentity: existing.sessionFile },
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
        sessionFile: null,
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
        entry.bootstrap = { ...created.bootstrap, sessionFile };
        entry.lastIdleAt = this.now();
        this.entriesByKey.set(durableKey, entry);

        // The map has one authority before persistence, but remains non-ready:
        // send/stop cannot observe it until the durable index commit succeeds.
        // If persistence fails, the catch path removes and disposes it; no
        // success event or turn side effect is published.
        await this.bindRuntimeIdentity(entry.logicalSessionId, sessionFile);
        entry.state = 'ready';
        this.dispatch({
          type: 'session.created',
          sessionId: entry.logicalSessionId,
          requestId,
          payload: { agent: PI_AGENT, runtimeIdentity: sessionFile },
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
    if (entry.activeRequestId) {
      throw new WorkerManagerError(
        'session_busy',
        `Session ${input.sessionId} already has active turn ${entry.activeRequestId}`,
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
    selection: { model?: string; effort?: SessionEffortLevel } = {}
  ): Promise<CreatedPiWorkerSlot> {
    let expectedSlot: WorkerSlot | null = null;
    const created = await this.createSlot({
      slotKey: entry.key,
      logicalSessionId: entry.logicalSessionId,
      cwd: entry.cwd,
      generation: entry.generation,
      ...(entry.sessionFile ? { sessionFile: entry.sessionFile } : {}),
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
      onStderr: (chunk, generation) =>
        this.log(`[pi-worker:${entry.logicalSessionId}:g${generation}:stderr]`, chunk),
    });
    this.ownedSlots.add(created.slot);
    expectedSlot = created.slot;
    entry.slot = created.slot;
    entry.bootstrap = created.bootstrap;
    entry.generation = created.slot.generation;
    return created;
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

  private serialize(work: () => Promise<void>): Promise<void> {
    const run = this.lifecycleChain.then(work);
    this.lifecycleChain = run.catch(() => undefined);
    return run;
  }

  private selectEvictionCandidate(): ManagedSlot | null {
    const candidates = [...this.entriesBySession.values()].filter((entry) =>
      this.isSafeToEvict(entry)
    );
    candidates.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    return candidates[0] ?? null;
  }

  private isSafeToEvict(entry: ManagedSlot): boolean {
    return (
      entry.state === 'ready' &&
      entry.ownerWebContentsId === null &&
      entry.activeRequestId === null &&
      entry.pendingBlockingRequests.size === 0
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

    if (
      event.type === 'session.completed' ||
      event.type === 'session.failed' ||
      event.type === 'session.stopped'
    ) {
      entry.activeRequestId = null;
      entry.lastIdleAt = this.now();
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
      this.updateManagerState();
      return;
    }
    entry.restartAttempts.push(now);
    entry.state = 'restarting';
    const oldSlot = entry.slot;
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
      const created = await this.spawnForEntry(entry, {
        ...(entry.bootstrap?.model ? { model: entry.bootstrap.model } : {}),
        ...(entry.bootstrap?.effort ? { effort: entry.bootstrap.effort } : {}),
      });
      const reopenedFile = created.bootstrap.sessionFile
        ? normalizeWorkerPath(created.bootstrap.sessionFile, 'Pi session file')
        : null;
      if (!reopenedFile || sessionWorkerKey(reopenedFile) !== entry.key) {
        try {
          await created.slot.dispose('slot-dispose');
          this.ownedSlots.delete(created.slot);
        } catch {
          // Retain physical ownership for forceKillAllNow().
        }
        throw new WorkerManagerError(
          'worker_restart_identity_mismatch',
          'Restarted worker did not reopen the authoritative Pi session file'
        );
      }
      entry.bootstrap = { ...created.bootstrap, sessionFile: reopenedFile };
      entry.state = 'ready';
      entry.error = null;
      entry.lastIdleAt = this.now();
      this.state = 'ready';
      this.dispatch({
        type: 'session.status',
        sessionId: entry.logicalSessionId,
        payload: { status: 'idle' },
      });
    } catch (error) {
      entry.state = 'crashed';
      entry.error = error instanceof Error ? error.message : String(error);
      this.updateManagerState();
      void this.serialize(() => this.restartEntry(entry));
    }
  }

  private isAuthoritative(entry: ManagedSlot, generation: number): boolean {
    return (
      entry.acceptEvents &&
      this.entriesBySession.get(entry.logicalSessionId) === entry &&
      this.entriesByKey.get(entry.key) === entry &&
      entry.generation === generation
    );
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

  private updateManagerState(): void {
    const entries = [...this.entriesBySession.values()];
    if (entries.length === 0) this.state = 'stopped';
    else if (entries.some((entry) => entry.state === 'error' || entry.state === 'crashed')) {
      this.state = 'degraded';
    } else this.state = 'ready';
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
});
