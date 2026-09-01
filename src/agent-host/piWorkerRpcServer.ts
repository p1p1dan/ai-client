import type { RuntimeEvent, RuntimeEventDraft } from '../shared/types/runtimeEvents.ts';
import {
  isWorkerBootstrapPayload,
  isWorkerDiscardForkPayload,
  isWorkerExtensionUiResponsePayload,
  isWorkerForkPayload,
  isWorkerHistoryPayload,
  isWorkerRewindPayload,
  isWorkerRpcRequest,
  isWorkerSendPayload,
  isWorkerStopPayload,
  isWorkerTreePayload,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerBootstrapPayload,
  type WorkerBootstrapResult,
  type WorkerDiscardForkPayload,
  type WorkerDiscardForkResult,
  type WorkerDisposeResult,
  type WorkerExtensionUiResponseResult,
  type WorkerForkPayload,
  type WorkerForkResult,
  type WorkerHistoryPayload,
  type WorkerHistoryResult,
  type WorkerRewindPayload,
  type WorkerRewindResult,
  type WorkerRpcErrorPayload,
  type WorkerRpcErrorResponse,
  type WorkerRpcEvent,
  type WorkerRpcRequest,
  type WorkerRpcSuccessResponse,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerStopPayload,
  type WorkerStopResult,
  type WorkerTreePayload,
  type WorkerTreeResult,
} from '../shared/types/workerRpc.ts';
import { PermissionGateUnavailableError } from './piAgentSessionBootstrap.ts';
import {
  PiWorkerSession,
  PiWorkerSessionError,
  type PiWorkerSessionOptions,
} from './piWorkerSession.ts';

export interface PiWorkerMessagePort {
  postMessage(message: unknown): void;
}

export interface PiWorkerRuntime {
  bootstrap(): Promise<WorkerBootstrapResult>;
  startSend(input: WorkerSendPayload): Promise<WorkerSendResult>;
  history(input: WorkerHistoryPayload): Promise<WorkerHistoryResult>;
  tree?(input: WorkerTreePayload): Promise<WorkerTreeResult>;
  rewind?(input: WorkerRewindPayload): Promise<WorkerRewindResult>;
  fork?(input: WorkerForkPayload): Promise<WorkerForkResult>;
  discardFork?(input: WorkerDiscardForkPayload): Promise<WorkerDiscardForkResult>;
  stop(input: WorkerStopPayload): Promise<WorkerStopResult>;
  respondExtensionUi(response: Parameters<PiWorkerSession['respondExtensionUi']>[0]): boolean;
  dispose(): Promise<void>;
}

export interface PiWorkerRpcServerOptions {
  port: PiWorkerMessagePort;
  generation: number;
  projectTrusted: boolean;
  createRuntime?: (options: PiWorkerSessionOptions) => PiWorkerRuntime;
  loadSdk?: () => Promise<unknown>;
  log?: (...args: unknown[]) => void;
  onDisposed?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface CorrelatedRequest {
  generation: number;
  requestId: string;
}

function correlatedRequest(value: unknown): CorrelatedRequest | null {
  if (!isRecord(value)) return null;
  if (
    value.kind !== 'request' ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) <= 0 ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    typeof value.type !== 'string' ||
    value.type.length === 0 ||
    !('payload' in value)
  ) {
    return null;
  }
  return {
    generation: Number(value.generation),
    requestId: value.requestId,
  };
}

function sameBootstrap(a: WorkerBootstrapPayload, b: WorkerBootstrapPayload): boolean {
  return (
    a.logicalSessionId === b.logicalSessionId &&
    a.cwd === b.cwd &&
    a.sessionFile === b.sessionFile &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.leafCheckpoint?.activeEntryId === b.leafCheckpoint?.activeEntryId &&
    a.leafCheckpoint?.fileTailEntryId === b.leafCheckpoint?.fileTailEntryId
  );
}

function errorPayload(error: unknown): WorkerRpcErrorPayload {
  if (error instanceof PermissionGateUnavailableError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof PiWorkerSessionError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; retryable?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : 'WORKER_REQUEST_FAILED',
      message: error.message,
      ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    };
  }
  return { code: 'WORKER_REQUEST_FAILED', message: String(error) };
}

/**
 * Correlated, generation-bound worker-side dispatcher.
 *
 * Mutating requests are serialized. The first bootstrap owns the process for
 * its lifetime; an identical duplicate is idempotent and a different bootstrap
 * is rejected without constructing a second AgentSession.
 */
export class PiWorkerRpcServer {
  private readonly options: PiWorkerRpcServerOptions;
  private readonly log: (...args: unknown[]) => void;
  private chain = Promise.resolve();
  private bootstrapPayload: WorkerBootstrapPayload | null = null;
  private runtime: PiWorkerRuntime | null = null;
  private disposed = false;
  private eventSequence = 0;

  constructor(options: PiWorkerRpcServerOptions) {
    if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
      throw new Error(
        `Pi worker generation must be a positive safe integer: ${options.generation}`
      );
    }
    this.options = options;
    this.log = options.log ?? (() => undefined);
  }

  receive(value: unknown): void {
    if (!isWorkerRpcRequest(value)) {
      const request = correlatedRequest(value);
      if (request && isRecord(value) && value.protocolVersion !== WORKER_RPC_PROTOCOL_VERSION) {
        this.respondError(request, {
          code: 'WORKER_PROTOCOL_MISMATCH',
          message: `Expected protocolVersion ${WORKER_RPC_PROTOCOL_VERSION}, got ${String(value.protocolVersion)}`,
          retryable: false,
        });
      } else {
        this.log('ignored malformed worker request');
      }
      return;
    }
    const request = value;
    this.chain = this.chain
      .then(() => this.dispatch(request))
      .catch((error) => this.log('worker request dispatch failed:', error));
  }

  private async dispatch(request: WorkerRpcRequest): Promise<void> {
    if (request.generation !== this.options.generation) {
      this.respondError(request, {
        code: 'WORKER_STALE_GENERATION',
        message: `Expected generation ${this.options.generation}, got ${request.generation}`,
        retryable: false,
      });
      return;
    }
    if (this.disposed && request.type !== 'worker.dispose') {
      this.respondError(request, {
        code: 'WORKER_DISPOSED',
        message: 'Pi utility worker is disposed',
        retryable: false,
      });
      return;
    }

    try {
      switch (request.type) {
        case 'worker.bootstrap':
          await this.handleBootstrap(request);
          break;
        case 'worker.send':
          await this.handleSend(request);
          break;
        case 'worker.history':
          await this.handleHistory(request);
          break;
        case 'worker.tree':
          await this.handleTree(request);
          break;
        case 'worker.rewind':
          await this.handleRewind(request);
          break;
        case 'worker.fork':
          await this.handleFork(request);
          break;
        case 'worker.fork.discard':
          await this.handleDiscardFork(request);
          break;
        case 'worker.stop':
          await this.handleStop(request);
          break;
        case 'worker.extensionUi.respond':
          this.handleExtensionUiResponse(request);
          break;
        case 'worker.dispose':
          await this.handleDispose(request);
          break;
        default:
          this.respondError(request, {
            code: 'WORKER_METHOD_NOT_FOUND',
            message: `Unknown worker method: ${request.type}`,
            retryable: false,
          });
      }
    } catch (error) {
      this.respondError(request, errorPayload(error));
    }
  }

  private async handleBootstrap(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerBootstrapPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.bootstrap requires logicalSessionId, cwd, and valid model/effort values',
        retryable: false,
      });
      return;
    }
    if (this.bootstrapPayload && !sameBootstrap(this.bootstrapPayload, request.payload)) {
      this.respondError(request, {
        code: 'WORKER_ALREADY_BOOTSTRAPPED',
        message: 'This utility worker already owns a different Pi AgentSession',
        retryable: false,
      });
      return;
    }

    if (!this.runtime) {
      this.bootstrapPayload = { ...request.payload };
      const createRuntime =
        this.options.createRuntime ?? ((options) => new PiWorkerSession(options));
      this.runtime = createRuntime({
        ...request.payload,
        projectTrusted: this.options.projectTrusted,
        emit: (event) => this.emitRuntimeEvent(event),
        loadSdk: this.options.loadSdk,
        log: this.log,
      });
    }
    const result = await this.runtime.bootstrap();
    this.respondSuccess(request, result);
  }

  private async handleSend(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerSendPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message:
          'worker.send requires logicalSessionId, product requestId, text, and valid options',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    // startSend only awaits admission/setup. The long-running prompt continues
    // out of band so the serialized RPC chain remains available to worker.stop.
    const result = await this.runtime.startSend(request.payload);
    this.respondSuccess(request, result);
  }

  private async handleHistory(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerHistoryPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.history requires logicalSessionId and valid offset/limit values',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    this.respondSuccess(request, await this.runtime.history(request.payload));
  }

  private async handleTree(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerTreePayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.tree requires logicalSessionId',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    if (!this.runtime.tree) {
      throw new PiWorkerSessionError(
        'WORKER_TREE_UNAVAILABLE',
        'Worker tree method is unavailable'
      );
    }
    this.respondSuccess(request, await this.runtime.tree(request.payload));
  }

  private async handleRewind(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerRewindPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.rewind requires logicalSessionId, targetEntryId, and confirmed=true',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    if (!this.runtime.rewind) {
      throw new PiWorkerSessionError(
        'WORKER_REWIND_UNAVAILABLE',
        'Worker rewind method is unavailable'
      );
    }
    this.respondSuccess(request, await this.runtime.rewind(request.payload));
  }

  private async handleFork(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerForkPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.fork requires logicalSessionId and entryId',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    if (!this.runtime.fork) {
      throw new PiWorkerSessionError(
        'WORKER_FORK_UNAVAILABLE',
        'Worker fork method is unavailable'
      );
    }
    this.respondSuccess(request, await this.runtime.fork(request.payload));
  }

  private async handleDiscardFork(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerDiscardForkPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.fork.discard requires logicalSessionId and sessionFile',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    if (!this.runtime.discardFork) {
      throw new PiWorkerSessionError(
        'WORKER_FORK_UNAVAILABLE',
        'Worker fork discard method is unavailable'
      );
    }
    this.respondSuccess(request, await this.runtime.discardFork(request.payload));
  }

  private async handleStop(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerStopPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.stop requires logicalSessionId and a valid reason',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      this.respondSuccess(request, { stopped: false } satisfies WorkerStopResult);
      return;
    }
    this.respondSuccess(request, await this.runtime.stop(request.payload));
  }

  private handleExtensionUiResponse(request: WorkerRpcRequest): void {
    if (!isWorkerExtensionUiResponsePayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.extensionUi.respond requires logicalSessionId and a valid response',
        retryable: false,
      });
      return;
    }
    if (request.payload.logicalSessionId !== this.bootstrapPayload?.logicalSessionId) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_MISMATCH',
        'Extension UI response targets another session'
      );
    }
    const result: WorkerExtensionUiResponseResult = {
      handled: this.runtime?.respondExtensionUi(request.payload.response) ?? false,
    };
    this.respondSuccess(request, result);
  }

  private async handleDispose(request: WorkerRpcRequest): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      await this.runtime?.dispose();
      this.runtime = null;
    }
    const result: WorkerDisposeResult = { disposed: true };
    this.respondSuccess(request, result);
    this.options.onDisposed?.();
  }

  private emitRuntimeEvent(event: RuntimeEventDraft): void {
    if (this.disposed) return;
    const payload = {
      ...event,
      seq: ++this.eventSequence,
      timestamp: Date.now(),
    } as RuntimeEvent;
    const message: WorkerRpcEvent<'runtime.event', RuntimeEvent> = {
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'event',
      generation: this.options.generation,
      type: 'runtime.event',
      payload,
    };
    this.options.port.postMessage(message);
  }

  private respondSuccess<TResult>(request: CorrelatedRequest, result: TResult): void {
    const response: WorkerRpcSuccessResponse<TResult> = {
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'response',
      generation: request.generation,
      requestId: request.requestId,
      ok: true,
      result,
    };
    this.options.port.postMessage(response);
  }

  private respondError(request: CorrelatedRequest, error: WorkerRpcErrorPayload): void {
    const response: WorkerRpcErrorResponse = {
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'response',
      generation: request.generation,
      requestId: request.requestId,
      ok: false,
      error,
    };
    this.options.port.postMessage(response);
  }
}
