import {
  isWorkerDisposeResult,
  isWorkerRpcEvent,
  isWorkerRpcResponse,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerDisposeResult,
  type WorkerRpcErrorPayload,
  type WorkerRpcEvent,
  type WorkerRpcRequest,
} from '@shared/types/workerRpc';
import type { WorkerTransport, WorkerTransportExit } from './WorkerTransport';

export type WorkerSlotState =
  | 'running'
  | 'replacing'
  | 'disposing'
  | 'crashed'
  | 'dispose-failed'
  | 'disposed';

export type WorkerSlotErrorCode =
  | 'WORKER_SLOT_NOT_RUNNING'
  | 'WORKER_SLOT_DISPOSING'
  | 'WORKER_SLOT_DISPOSED'
  | 'WORKER_RPC_TIMEOUT'
  | 'WORKER_RPC_REMOTE_ERROR'
  | 'WORKER_TRANSPORT_ERROR'
  | 'WORKER_EXITED'
  | 'WORKER_EXIT_TIMEOUT';

export class WorkerSlotError extends Error {
  constructor(
    readonly code: WorkerSlotErrorCode,
    message: string,
    readonly remoteError?: WorkerRpcErrorPayload
  ) {
    super(message);
    this.name = 'WorkerSlotError';
  }

  get remoteCode(): string | undefined {
    return this.remoteError?.code;
  }

  get remoteRetryable(): boolean | undefined {
    return this.remoteError?.retryable;
  }
}

export type WorkerSlotDiagnostic =
  | { type: 'malformed-message'; generation: number }
  | { type: 'protocol-mismatch'; generation: number; received: unknown }
  | { type: 'stale-generation'; generation: number; received: unknown }
  | { type: 'unknown-response'; generation: number; requestId: string }
  | { type: 'late-transport-event'; generation: number; event: 'message' | 'error' | 'exit' };

export type WorkerSlotLifecycleEvent =
  | {
      type: 'crashed';
      slotKey: string;
      generation: number;
      error: WorkerSlotError;
      exit?: WorkerTransportExit;
    }
  | { type: 'disposed'; slotKey: string; generation: number };

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: WorkerSlotError) => void;
  timer: NodeJS.Timeout;
}

export interface WorkerSlotOptions {
  slotKey: string;
  cwd: string;
  transport: WorkerTransport;
  generation?: number;
  requestTimeoutMs?: number;
  disposeTimeoutMs?: number;
  exitTimeoutMs?: number;
  onEvent?: (event: WorkerRpcEvent) => void;
  onDiagnostic?: (diagnostic: WorkerSlotDiagnostic) => void;
  onLifecycle?: (event: WorkerSlotLifecycleEvent) => void;
  onStderr?: (chunk: string, generation: number) => void;
}

export interface WorkerSlotRequestOptions {
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 3_000;
const DEFAULT_EXIT_TIMEOUT_MS = 3_000;
let slotInstanceSequence = 0;

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Worker timeout must be a positive finite number, received ${value}`);
  }
  return value;
}

function positiveGeneration(value: number | undefined): number {
  const generation = value ?? 1;
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`Worker generation must be a positive safe integer, received ${generation}`);
  }
  return generation;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Owns one utility process generation and its pending RPC lifecycle.
 *
 * Pool policy and worker creation deliberately live outside this class. T29-a
 * only establishes the single-slot authority used by the later WorkerManager.
 */
export class WorkerSlot {
  readonly cwd: string;

  private readonly instanceId = ++slotInstanceSequence;
  private currentSlotKey: string;
  private readonly requestTimeoutMs: number;
  private readonly disposeTimeoutMs: number;
  private readonly exitTimeoutMs: number;
  private readonly onEvent?: (event: WorkerRpcEvent) => void;
  private readonly onDiagnostic?: (diagnostic: WorkerSlotDiagnostic) => void;
  private readonly onLifecycle?: (event: WorkerSlotLifecycleEvent) => void;
  private readonly onStderr?: (chunk: string, generation: number) => void;
  private readonly pendingRequests = new Map<string, PendingRequest>();

  private transport: WorkerTransport;
  private currentGeneration: number;
  private currentState: WorkerSlotState = 'running';
  private requestSequence = 0;
  private detachTransportListeners: Array<() => void> = [];
  private transportKilled = false;
  private lastExit: {
    transport: WorkerTransport;
    generation: number;
    exit: WorkerTransportExit;
  } | null = null;
  private replacementPromise: Promise<number> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(options: WorkerSlotOptions) {
    this.currentSlotKey = options.slotKey;
    this.cwd = options.cwd;
    this.transport = options.transport;
    this.currentGeneration = positiveGeneration(options.generation);
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.disposeTimeoutMs = positiveTimeout(options.disposeTimeoutMs, DEFAULT_DISPOSE_TIMEOUT_MS);
    this.exitTimeoutMs = positiveTimeout(options.exitTimeoutMs, DEFAULT_EXIT_TIMEOUT_MS);
    this.onEvent = options.onEvent;
    this.onDiagnostic = options.onDiagnostic;
    this.onLifecycle = options.onLifecycle;
    this.onStderr = options.onStderr;
    this.attachTransport(this.transport, this.currentGeneration);
  }

  get slotKey(): string {
    return this.currentSlotKey;
  }

  /** Manager-only identity commit after workspace-key → session-file remap. */
  remapSlotKey(nextSlotKey: string): void {
    const normalized = nextSlotKey.trim();
    if (!normalized) throw new Error('Worker slot key must be non-empty');
    if (this.currentState !== 'running') {
      throw new WorkerSlotError(
        'WORKER_SLOT_NOT_RUNNING',
        `Worker slot ${this.currentSlotKey} cannot remap while ${this.currentState}`
      );
    }
    this.currentSlotKey = normalized;
  }

  get state(): WorkerSlotState {
    return this.currentState;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get pid(): number | undefined {
    return this.transport.pid;
  }

  get pendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  request<TResult = unknown, TPayload = unknown>(
    type: string,
    payload: TPayload,
    options?: WorkerSlotRequestOptions
  ): Promise<TResult> {
    if (this.currentState === 'disposing') {
      return Promise.reject(
        new WorkerSlotError('WORKER_SLOT_DISPOSING', `Worker slot ${this.slotKey} is disposing`)
      );
    }
    if (this.currentState === 'disposed') {
      return Promise.reject(
        new WorkerSlotError('WORKER_SLOT_DISPOSED', `Worker slot ${this.slotKey} is disposed`)
      );
    }
    if (this.currentState !== 'running') {
      return Promise.reject(
        new WorkerSlotError(
          'WORKER_SLOT_NOT_RUNNING',
          `Worker slot ${this.slotKey} is not running (${this.currentState})`
        )
      );
    }
    return this.sendRequest<TResult, TPayload>(type, payload, options?.timeoutMs);
  }

  /**
   * Attach a replacement process after a crash. Restart budgeting and policy are
   * owned by WorkerManager (T30); this method only advances the generation and
   * makes stale callbacks from the retired process harmless.
   */
  replaceCrashedTransport(transport: WorkerTransport): Promise<number> {
    if (this.currentState !== 'crashed' || this.replacementPromise) {
      return Promise.reject(
        new WorkerSlotError(
          'WORKER_SLOT_NOT_RUNNING',
          `Worker slot ${this.slotKey} can only replace one transport after a crash`
        )
      );
    }

    const previousTransport = this.transport;
    const previousGeneration = this.currentGeneration;
    const nextGeneration = positiveGeneration(previousGeneration + 1);
    this.currentState = 'replacing';
    const task = this.replaceTransportInternal(
      previousTransport,
      previousGeneration,
      nextGeneration,
      transport
    );
    this.replacementPromise = task;
    void task.then(
      () => {
        if (this.replacementPromise === task) this.replacementPromise = null;
      },
      () => {
        if (this.replacementPromise === task) this.replacementPromise = null;
      }
    );
    return task;
  }

  dispose(
    reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace' = 'slot-dispose'
  ): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.currentState === 'disposed') return Promise.resolve();

    const task = this.disposeInternal(reason);
    this.disposePromise = task;
    return task;
  }

  /** Signal-path fallback: detach routing and kill immediately without awaiting ACK. */
  forceKillNow(): boolean {
    if (this.currentState === 'disposed') return true;
    this.currentState = 'disposing';
    this.rejectPending(
      new WorkerSlotError('WORKER_SLOT_DISPOSING', `Worker slot ${this.slotKey} was force-killed`)
    );
    this.detachCurrentTransport();
    const killed = this.killCurrentTransport();
    this.currentState = killed ? 'disposed' : 'dispose-failed';
    if (killed) {
      this.onLifecycle?.({
        type: 'disposed',
        slotKey: this.slotKey,
        generation: this.currentGeneration,
      });
    }
    return killed;
  }

  private async replaceTransportInternal(
    previousTransport: WorkerTransport,
    previousGeneration: number,
    nextGeneration: number,
    replacementTransport: WorkerTransport
  ): Promise<number> {
    try {
      await this.waitForTransportExit(previousTransport, previousGeneration);
      if (
        this.currentState !== 'replacing' ||
        this.transport !== previousTransport ||
        this.currentGeneration !== previousGeneration
      ) {
        throw new WorkerSlotError(
          'WORKER_SLOT_NOT_RUNNING',
          `Worker slot ${this.slotKey} replacement lost lifecycle authority`
        );
      }

      this.detachCurrentTransport();
      this.transport = replacementTransport;
      this.currentGeneration = nextGeneration;
      this.requestSequence = 0;
      this.transportKilled = false;
      this.lastExit = null;
      this.currentState = 'running';
      this.attachTransport(replacementTransport, nextGeneration);
      return nextGeneration;
    } catch (error) {
      if (this.transport === replacementTransport) {
        this.killCurrentTransport();
      } else {
        try {
          replacementTransport.kill();
        } catch {
          // The rejected replacement never became authoritative.
        }
      }
      if (this.currentState === 'replacing' || this.currentState === 'running') {
        this.currentState = 'crashed';
      }
      throw error;
    }
  }

  private async disposeInternal(
    reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace'
  ): Promise<void> {
    if (this.replacementPromise) {
      try {
        await this.replacementPromise;
      } catch {
        // Replacement failure leaves the old crashed transport authoritative;
        // disposal still has to confirm that process has exited.
      }
    }

    const shouldRequestDispose = this.currentState === 'running';
    this.currentState = 'disposing';
    this.rejectPending(
      new WorkerSlotError('WORKER_SLOT_DISPOSING', `Worker slot ${this.slotKey} is disposing`)
    );

    let disposeError: unknown;
    if (shouldRequestDispose) {
      try {
        const result = await this.sendRequest<WorkerDisposeResult, { reason: typeof reason }>(
          'worker.dispose',
          { reason },
          this.disposeTimeoutMs,
          true
        );
        if (!isWorkerDisposeResult(result)) {
          throw new WorkerSlotError(
            'WORKER_RPC_REMOTE_ERROR',
            `Worker slot ${this.slotKey} returned an invalid dispose acknowledgement`
          );
        }
      } catch (error) {
        disposeError = error;
      }
    }

    await this.finalizeDisposed();
    if (disposeError) throw disposeError;
  }

  private sendRequest<TResult, TPayload>(
    type: string,
    payload: TPayload,
    timeoutOverride?: number,
    allowDisposing = false
  ): Promise<TResult> {
    if (this.currentState !== 'running' && !(allowDisposing && this.currentState === 'disposing')) {
      return Promise.reject(
        new WorkerSlotError(
          'WORKER_SLOT_NOT_RUNNING',
          `Worker slot ${this.slotKey} cannot send ${type} while ${this.currentState}`
        )
      );
    }

    const timeoutMs = positiveTimeout(timeoutOverride, this.requestTimeoutMs);
    const generation = this.currentGeneration;
    const requestId = `rpc-${this.instanceId}-${generation}-${++this.requestSequence}`;
    const request: WorkerRpcRequest<string, TPayload> = {
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'request',
      generation,
      requestId,
      type,
      payload,
    };

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending) return;
        this.pendingRequests.delete(requestId);
        pending.reject(
          new WorkerSlotError(
            'WORKER_RPC_TIMEOUT',
            `Worker request ${pending.method} timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
      timer.unref?.();

      this.pendingRequests.set(requestId, {
        method: type,
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });

      try {
        this.transport.postMessage(request);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        const transportError = new WorkerSlotError(
          'WORKER_TRANSPORT_ERROR',
          error instanceof Error ? error.message : String(error)
        );
        this.crash(transportError);
        reject(transportError);
      }
    });
  }

  private attachTransport(transport: WorkerTransport, generation: number): void {
    const onMessage = (message: unknown) => {
      if (!this.isCurrentTransport(transport, generation, 'message')) return;
      this.handleMessage(message, generation);
    };
    const onError = (error: Error) => {
      if (!this.isCurrentTransport(transport, generation, 'error')) return;
      this.crash(
        new WorkerSlotError('WORKER_TRANSPORT_ERROR', error.message || 'Worker transport error')
      );
    };
    const onExit = (exit: WorkerTransportExit) => {
      if (transport === this.transport && generation === this.currentGeneration) {
        this.lastExit = { transport, generation, exit };
      }
      if (!this.isCurrentTransport(transport, generation, 'exit')) return;
      this.crash(
        new WorkerSlotError(
          'WORKER_EXITED',
          `Worker exited (code=${exit.code} signal=${exit.signal})`
        ),
        exit
      );
    };
    const onStderr = (chunk: string) => {
      if (transport !== this.transport || generation !== this.currentGeneration) return;
      this.onStderr?.(chunk, generation);
    };

    this.detachTransportListeners = [
      transport.onMessage(onMessage),
      transport.onError(onError),
      transport.onExit(onExit),
      transport.onStderr(onStderr),
    ];
  }

  private isCurrentTransport(
    transport: WorkerTransport,
    generation: number,
    event: 'message' | 'error' | 'exit'
  ): boolean {
    if (transport !== this.transport || generation !== this.currentGeneration) {
      this.onDiagnostic?.({ type: 'late-transport-event', generation, event });
      return false;
    }
    if (
      this.currentState === 'replacing' ||
      this.currentState === 'crashed' ||
      this.currentState === 'dispose-failed' ||
      this.currentState === 'disposed'
    ) {
      this.onDiagnostic?.({ type: 'late-transport-event', generation, event });
      return false;
    }
    return true;
  }

  private handleMessage(message: unknown, generation: number): void {
    const record = recordOf(message);
    if (!record) {
      this.onDiagnostic?.({ type: 'malformed-message', generation });
      return;
    }
    if (record.protocolVersion !== WORKER_RPC_PROTOCOL_VERSION) {
      this.onDiagnostic?.({
        type: 'protocol-mismatch',
        generation,
        received: record.protocolVersion,
      });
      return;
    }
    if (record.generation !== generation) {
      this.onDiagnostic?.({ type: 'stale-generation', generation, received: record.generation });
      return;
    }

    if (isWorkerRpcEvent(message)) {
      this.onEvent?.(message);
      return;
    }
    if (!isWorkerRpcResponse(message)) {
      this.onDiagnostic?.({ type: 'malformed-message', generation });
      return;
    }

    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      this.onDiagnostic?.({
        type: 'unknown-response',
        generation,
        requestId: message.requestId,
      });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(
      new WorkerSlotError(
        'WORKER_RPC_REMOTE_ERROR',
        `${message.error.code}: ${message.error.message}`,
        message.error
      )
    );
  }

  private crash(error: WorkerSlotError, exit?: WorkerTransportExit): void {
    if (
      this.currentState === 'crashed' ||
      this.currentState === 'dispose-failed' ||
      this.currentState === 'disposed'
    ) {
      return;
    }
    if (this.currentState === 'replacing' || this.currentState === 'disposing') {
      this.rejectPending(error);
      return;
    }
    this.currentState = 'crashed';
    this.rejectPending(error);
    this.killCurrentTransport();
    this.onLifecycle?.({
      type: 'crashed',
      slotKey: this.slotKey,
      generation: this.currentGeneration,
      error,
      exit,
    });
  }

  private async finalizeDisposed(): Promise<void> {
    if (this.currentState === 'disposed') return;
    this.rejectPending(
      new WorkerSlotError('WORKER_SLOT_DISPOSED', `Worker slot ${this.slotKey} is disposed`)
    );

    const transport = this.transport;
    const generation = this.currentGeneration;
    const exitPromise = this.waitForTransportExit(transport, generation);
    this.detachCurrentTransport();
    this.killCurrentTransport();

    try {
      await exitPromise;
    } catch (error) {
      this.currentState = 'dispose-failed';
      throw error;
    }

    this.currentState = 'disposed';
    this.onLifecycle?.({
      type: 'disposed',
      slotKey: this.slotKey,
      generation: this.currentGeneration,
    });
  }

  private waitForTransportExit(
    transport: WorkerTransport,
    generation: number
  ): Promise<WorkerTransportExit> {
    if (this.lastExit?.transport === transport && this.lastExit.generation === generation) {
      return Promise.resolve(this.lastExit.exit);
    }

    return new Promise<WorkerTransportExit>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      let detach = () => {};
      const finish = (exit: WorkerTransportExit) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        detach();
        resolve(exit);
      };
      detach = transport.onExit(finish);
      if (settled) {
        detach();
        return;
      }

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        detach();
        reject(
          new WorkerSlotError(
            'WORKER_EXIT_TIMEOUT',
            `Worker slot ${this.slotKey} did not exit within ${this.exitTimeoutMs}ms`
          )
        );
      }, this.exitTimeoutMs);
      timer.unref?.();

      if (this.lastExit?.transport === transport && this.lastExit.generation === generation) {
        finish(this.lastExit.exit);
      }
    });
  }

  private rejectPending(error: WorkerSlotError): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private detachCurrentTransport(): void {
    for (const detach of this.detachTransportListeners) detach();
    this.detachTransportListeners = [];
  }

  private killCurrentTransport(): boolean {
    if (this.transportKilled) return true;
    try {
      const killed = this.transport.kill();
      if (killed) this.transportKilled = true;
      return killed;
    } catch {
      return false;
    }
  }
}
