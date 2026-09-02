import { randomUUID } from 'node:crypto';
import {
  isWorkerUtilityCancelResult,
  isWorkerUtilityDeltaEvent,
  isWorkerUtilityStartResult,
  isWorkerUtilityTerminalEvent,
} from '@shared/types';
import type { SessionEffortLevel } from '@shared/types/agentHost';
import type { WorkerUtilityTerminalPayload } from '@shared/types/workerRpc';
import { forkPiWorkerProcess } from './PiWorkerProcess';
import { WorkerSlot, type WorkerSlotLifecycleEvent } from './WorkerSlot';

export class PiUtilityServiceError extends Error {
  constructor(
    readonly code:
      | 'PI_UTILITY_CAPACITY_EXCEEDED'
      | 'PI_UTILITY_CANCELLED'
      | 'PI_UTILITY_FAILED'
      | 'PI_UTILITY_TIMEOUT'
      | 'PI_UTILITY_TRANSPORT_FAILED',
    message: string
  ) {
    super(message);
    this.name = 'PiUtilityServiceError';
  }
}

export interface PiUtilityCompletionInput {
  /** Optional client identity for explicit cancellation of a streamed operation. */
  operationId?: string;
  cwd: string;
  prompt: string;
  model?: string;
  effort?: SessionEffortLevel;
  timeoutMs: number;
  onDelta?: (delta: string) => void;
}

export interface PiUtilityCompletionResult {
  text: string;
  model?: string;
}

interface ActiveUtilityOperation {
  id: string;
  slot: WorkerSlot;
  onDelta?: (delta: string) => void;
  resolve: (result: PiUtilityCompletionResult) => void;
  reject: (error: PiUtilityServiceError) => void;
  timeout: NodeJS.Timeout;
  timedOut: boolean;
  settled: boolean;
}

export interface PiUtilityServiceOptions {
  capacity?: number;
  createOperationId?: () => string;
  createSlot?: (input: {
    generation: number;
    cwd: string;
    onEvent: (event: unknown) => void;
    onLifecycle: (event: WorkerSlotLifecycleEvent) => void;
  }) => WorkerSlot;
  log?: (...args: unknown[]) => void;
}

const CANCEL_ACK_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer, received ${value}`);
  }
  return value;
}

/**
 * Main-owned supervisor for bounded, non-restarting one-shot Pi workers.
 *
 * It intentionally owns a separate operation map rather than WorkerManager's
 * logical-session slots, so a completion cannot produce a SessionIndex entry.
 */
export class PiUtilityService {
  private readonly capacity: number;
  private readonly createOperationId: () => string;
  private readonly createSlot: NonNullable<PiUtilityServiceOptions['createSlot']>;
  private readonly log: (...args: unknown[]) => void;
  private readonly operations = new Map<string, ActiveUtilityOperation>();
  private readonly ownedSlots = new Set<WorkerSlot>();
  private nextGeneration = 1;
  private disposed = false;

  constructor(options: PiUtilityServiceOptions = {}) {
    this.capacity = positiveInteger(options.capacity ?? 2, 'Pi utility capacity');
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.log = options.log ?? (() => undefined);
    this.createSlot =
      options.createSlot ??
      ((input) => {
        const forked = forkPiWorkerProcess({ generation: input.generation, cwd: input.cwd });
        return new WorkerSlot({
          slotKey: `utility:${input.generation}`,
          cwd: input.cwd,
          transport: forked.transport,
          generation: input.generation,
          requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
          onEvent: input.onEvent,
          onLifecycle: input.onLifecycle,
        });
      });
  }

  get activeCount(): number {
    return this.operations.size;
  }

  async complete(input: PiUtilityCompletionInput): Promise<PiUtilityCompletionResult> {
    if (this.disposed) {
      throw new PiUtilityServiceError(
        'PI_UTILITY_TRANSPORT_FAILED',
        'Pi utility service is disposed'
      );
    }
    if (this.operations.size >= this.capacity) {
      throw new PiUtilityServiceError(
        'PI_UTILITY_CAPACITY_EXCEEDED',
        'Too many AI utility operations are already running'
      );
    }
    if (!input.cwd.trim() || !input.prompt.trim()) {
      throw new PiUtilityServiceError(
        'PI_UTILITY_FAILED',
        'Pi utility requires a workspace and prompt'
      );
    }
    positiveInteger(input.timeoutMs, 'Pi utility timeout');

    const id = input.operationId ?? this.createOperationId();
    if (!id.trim() || this.operations.has(id)) {
      throw new PiUtilityServiceError(
        'PI_UTILITY_FAILED',
        'Pi utility generated an invalid operation id'
      );
    }
    const generation = this.nextGeneration++;
    let record: ActiveUtilityOperation | null = null;
    const slot = this.createSlot({
      generation,
      cwd: input.cwd,
      onEvent: (event) => this.handleEvent(id, event),
      onLifecycle: (event) => this.handleLifecycle(id, event),
    });
    this.ownedSlots.add(slot);

    const result = new Promise<PiUtilityCompletionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!record || record.settled) return;
        record.timedOut = true;
        void this.cancelRecord(record, 'timeout');
      }, input.timeoutMs);
      timeout.unref?.();
      record = {
        id,
        slot,
        onDelta: input.onDelta,
        resolve,
        reject,
        timeout,
        timedOut: false,
        settled: false,
      };
      this.operations.set(id, record);
    });

    try {
      const acknowledgement = await slot.request('utility.start', {
        operationId: id,
        cwd: input.cwd,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        timeoutMs: input.timeoutMs,
      });
      if (!isWorkerUtilityStartResult(acknowledgement) || acknowledgement.operationId !== id) {
        throw new PiUtilityServiceError(
          'PI_UTILITY_TRANSPORT_FAILED',
          'Invalid Pi utility start acknowledgement'
        );
      }
    } catch (error) {
      this.settleFailure(
        record,
        error instanceof PiUtilityServiceError
          ? error
          : new PiUtilityServiceError(
              'PI_UTILITY_TRANSPORT_FAILED',
              error instanceof Error ? error.message : String(error)
            )
      );
    }
    return result;
  }

  async cancel(operationId: string): Promise<boolean> {
    const record = this.operations.get(operationId);
    if (!record || record.settled) return false;
    return this.cancelRecord(record, 'user');
  }

  /**
   * Credential-change teardown (logout), mirroring `WorkerManager.invalidateAll()`:
   * cancel every in-flight operation and drop the workers running them WITHOUT
   * marking the service disposed, so utility completions work again after the
   * next sign-in. Logout must call this before the vault is cleared — a running
   * one-shot otherwise keeps issuing requests with credentials the user revoked.
   */
  async invalidateAll(): Promise<void> {
    await Promise.allSettled(
      [...this.operations.values()].map((record) => this.cancelRecord(record, 'dispose'))
    );
    const slots = [...this.ownedSlots];
    this.ownedSlots.clear();
    this.operations.clear();
    await Promise.allSettled(slots.map((slot) => slot.dispose('slot-dispose')));
  }

  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled(
      [...this.operations.values()].map((record) => this.cancelRecord(record, 'dispose'))
    );
    await Promise.allSettled([...this.ownedSlots].map((slot) => slot.dispose('app-shutdown')));
    this.operations.clear();
    this.ownedSlots.clear();
  }

  forceKillAllNow(): void {
    this.disposed = true;
    for (const record of this.operations.values()) {
      this.settleFailure(
        record,
        new PiUtilityServiceError(
          'PI_UTILITY_TRANSPORT_FAILED',
          'Pi utility worker was force-killed'
        )
      );
    }
    for (const slot of this.ownedSlots) slot.forceKillNow();
    this.operations.clear();
    this.ownedSlots.clear();
  }

  private async cancelRecord(
    record: ActiveUtilityOperation,
    reason: 'user' | 'timeout' | 'dispose'
  ): Promise<boolean> {
    if (record.settled) return false;
    try {
      const result = await record.slot.request(
        'utility.cancel',
        { operationId: record.id, reason },
        { timeoutMs: CANCEL_ACK_TIMEOUT_MS }
      );
      if (!isWorkerUtilityCancelResult(result)) {
        throw new PiUtilityServiceError(
          'PI_UTILITY_TRANSPORT_FAILED',
          'Invalid Pi utility cancel acknowledgement'
        );
      }
      if (!result.cancelled && !record.settled) {
        throw new PiUtilityServiceError(
          'PI_UTILITY_TRANSPORT_FAILED',
          'Pi utility worker did not acknowledge the active operation'
        );
      }
      if (!record.settled) {
        const code = reason === 'timeout' ? 'PI_UTILITY_TIMEOUT' : 'PI_UTILITY_CANCELLED';
        this.settleFailure(
          record,
          new PiUtilityServiceError(
            code,
            reason === 'timeout'
              ? 'Pi utility operation timed out'
              : 'Pi utility operation cancelled'
          )
        );
      }
      return result.cancelled;
    } catch (error) {
      this.settleFailure(
        record,
        error instanceof PiUtilityServiceError
          ? error
          : new PiUtilityServiceError(
              'PI_UTILITY_TRANSPORT_FAILED',
              error instanceof Error ? error.message : String(error)
            )
      );
      return false;
    }
  }

  private handleEvent(operationId: string, event: unknown): void {
    const record = this.operations.get(operationId);
    if (!record || record.settled) return;
    if (isWorkerUtilityDeltaEvent(event)) {
      if (event.payload.operationId === operationId) record.onDelta?.(event.payload.delta);
      return;
    }
    if (isWorkerUtilityTerminalEvent(event) && event.payload.operationId === operationId) {
      this.handleTerminal(record, event.payload);
    }
  }

  private handleLifecycle(operationId: string, event: WorkerSlotLifecycleEvent): void {
    if (event.type !== 'crashed') return;
    const record = this.operations.get(operationId);
    if (!record || record.settled) return;
    this.settleFailure(
      record,
      new PiUtilityServiceError('PI_UTILITY_TRANSPORT_FAILED', event.error.message)
    );
  }

  private handleTerminal(
    record: ActiveUtilityOperation,
    terminal: WorkerUtilityTerminalPayload
  ): void {
    if (terminal.state === 'completed') {
      this.settleSuccess(record, {
        text: terminal.text,
        ...(terminal.model ? { model: terminal.model } : {}),
      });
      return;
    }
    const code = record.timedOut
      ? 'PI_UTILITY_TIMEOUT'
      : terminal.state === 'cancelled'
        ? 'PI_UTILITY_CANCELLED'
        : 'PI_UTILITY_FAILED';
    this.settleFailure(
      record,
      new PiUtilityServiceError(
        code,
        record.timedOut ? 'timeout' : terminal.error || `Pi utility ${terminal.state}`
      )
    );
  }

  private settleSuccess(record: ActiveUtilityOperation, result: PiUtilityCompletionResult): void {
    if (record.settled) return;
    record.settled = true;
    clearTimeout(record.timeout);
    this.operations.delete(record.id);
    record.resolve(result);
    this.disposeRecordSlot(record);
  }

  private settleFailure(record: ActiveUtilityOperation | null, error: PiUtilityServiceError): void {
    if (!record || record.settled) return;
    record.settled = true;
    clearTimeout(record.timeout);
    this.operations.delete(record.id);
    record.reject(error);
    this.disposeRecordSlot(record);
  }

  private disposeRecordSlot(record: ActiveUtilityOperation): void {
    this.ownedSlots.delete(record.slot);
    void record.slot.dispose('slot-dispose').catch((error: unknown) => {
      this.log('Pi utility slot disposal failed:', error);
    });
  }
}

export const piUtilityService = new PiUtilityService();
