import type {
  WorkerDiscardImportedSessionPayload,
  WorkerDiscardImportedSessionResult,
  WorkerImportConversationPayload,
  WorkerImportConversationResult,
  WorkerInspectImportedSessionPayload,
  WorkerInspectImportedSessionResult,
  WorkerReconcileImportedSessionPayload,
  WorkerReconcileImportedSessionResult,
} from '../shared/types/legacyImport.ts';
import { isWorkerImportConversationPayload } from '../shared/types/legacyImport.ts';
import type {
  ExtensionUiResponse,
  PermissionDecisionId,
  RuntimeEvent,
  RuntimeEventDraft,
} from '../shared/types/runtimeEvents.ts';
import type { RuntimePermissionSettings } from '../shared/types/runtimePermission.ts';
import type { SessionPermissionTier } from '../shared/types/sessionPermissionTier.ts';
import {
  isWorkerBootstrapPayload,
  isWorkerCommandsPayload,
  isWorkerCompactPayload,
  isWorkerDiscardForkPayload,
  isWorkerDiscardImportedSessionPayload,
  isWorkerExtensionUiResponsePayload,
  isWorkerForkPayload,
  isWorkerHistoryPayload,
  isWorkerInspectImportedSessionPayload,
  isWorkerPermissionRespondPayload,
  isWorkerPreviewRespondPayload,
  isWorkerQuestionRespondPayload,
  isWorkerReconcileImportedSessionPayload,
  isWorkerReloadPayload,
  isWorkerRewindPayload,
  isWorkerRpcRequest,
  isWorkerSendPayload,
  isWorkerSetPermissionsPayload,
  isWorkerSetPermissionTierPayload,
  isWorkerStopPayload,
  isWorkerTreePayload,
  isWorkerUtilityCancelPayload,
  isWorkerUtilityStartPayload,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerBootstrapPayload,
  type WorkerBootstrapResult,
  type WorkerCommandsPayload,
  type WorkerCommandsResult,
  type WorkerCompactPayload,
  type WorkerCompactResult,
  type WorkerDiscardForkPayload,
  type WorkerDiscardForkResult,
  type WorkerDisposeResult,
  type WorkerExtensionUiResponseResult,
  type WorkerForkPayload,
  type WorkerForkResult,
  type WorkerHistoryPayload,
  type WorkerHistoryResult,
  type WorkerPermissionRespondResult,
  type WorkerPreviewRespondResult,
  type WorkerQuestionRespondResult,
  type WorkerReloadPayload,
  type WorkerReloadResult,
  type WorkerRewindPayload,
  type WorkerRewindResult,
  type WorkerRpcErrorPayload,
  type WorkerRpcErrorResponse,
  type WorkerRpcEvent,
  type WorkerRpcRequest,
  type WorkerRpcSuccessResponse,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerSetPermissionTierResult,
  type WorkerStopPayload,
  type WorkerStopResult,
  type WorkerTreePayload,
  type WorkerTreeResult,
  type WorkerUtilityCancelPayload,
  type WorkerUtilityCancelResult,
  type WorkerUtilityDeltaPayload,
  type WorkerUtilityStartPayload,
  type WorkerUtilityStartResult,
  type WorkerUtilityTerminalPayload,
} from '../shared/types/workerRpc.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';

export interface PiWorkerMessagePort {
  postMessage(message: unknown): void;
}

export interface PiWorkerRuntime {
  bootstrap(): Promise<WorkerBootstrapResult>;
  startSend(input: WorkerSendPayload): Promise<WorkerSendResult>;
  history(input: WorkerHistoryPayload): Promise<WorkerHistoryResult>;
  tree?(input: WorkerTreePayload): Promise<WorkerTreeResult>;
  commands?(input: WorkerCommandsPayload): Promise<WorkerCommandsResult>;
  compact?(input: WorkerCompactPayload): Promise<WorkerCompactResult>;
  rewind?(input: WorkerRewindPayload): Promise<WorkerRewindResult>;
  reload?(input: WorkerReloadPayload): Promise<WorkerReloadResult>;
  fork?(input: WorkerForkPayload): Promise<WorkerForkResult>;
  discardFork?(input: WorkerDiscardForkPayload): Promise<WorkerDiscardForkResult>;
  stop(input: WorkerStopPayload): Promise<WorkerStopResult>;
  respondExtensionUi(response: ExtensionUiResponse): boolean;
  /**
   * Answer one `permission.requested`. Optional: only a backend that ASKS
   * through that event implements it, and a backend that does not must reject
   * the method rather than silently report the gate as answered.
   */
  respondPermission?(input: { permissionId: string; decision: PermissionDecisionId }): boolean;
  /**
   * F5 — answer one `question.requested`. Optional for the same reason as
   * `respondPermission`: only a backend that registers the `ask` tool can have
   * a question parked, and the others must reject rather than report an answer
   * that went nowhere.
   */
  respondQuestion?(input: {
    questionId: string;
    answers?: Record<string, string>;
    response?: string;
    cancel?: boolean;
  }): boolean;
  /**
   * P5-2-3 — report what Main did with one `preview.requested`. Optional for
   * the same reason again: only a backend that registers `browser_preview` can
   * have a preview parked.
   */
  respondPreview?(input: { previewId: string; ok: boolean; error?: string }): boolean;
  setPermissions?(permissions: RuntimePermissionSettings): void;
  setPermissionTier?(tier: SessionPermissionTier): void;
  dispose(): Promise<void>;
}

/**
 * What a worker runtime is constructed with.
 *
 * P6-5: this used to be `PiWorkerSessionOptions`, exported by the legacy engine
 * that no longer exists. The two legacy-only fields went with it — `loadSdk`
 * (the pi-coding-agent import) and `decidePermissionGate` (that engine's plugin
 * arbitration).
 */
export interface PiWorkerRuntimeOptions extends WorkerBootstrapPayload {
  projectTrusted: boolean;
  /** Comma-separated feature ids of the OPT-IN bundled extensions to inject. */
  optInExtensions?: string;
  emit: (event: RuntimeEventDraft) => void;
  log?: (...args: unknown[]) => void;
}

export interface PiUtilityRuntime {
  start(input: WorkerUtilityStartPayload): Promise<WorkerUtilityStartResult>;
  cancel(input: WorkerUtilityCancelPayload): Promise<WorkerUtilityCancelResult>;
  dispose(): Promise<void>;
}

export interface PiUtilityRuntimeOptions {
  projectTrusted: boolean;
  emitDelta: (payload: WorkerUtilityDeltaPayload) => void;
  emitTerminal: (payload: WorkerUtilityTerminalPayload) => void;
  log?: (...args: unknown[]) => void;
}

export interface PiWorkerRpcServerOptions {
  port: PiWorkerMessagePort;
  generation: number;
  projectTrusted: boolean;
  /**
   * Comma-separated feature ids of the bundled OPT-IN extensions this user
   * turned on. Process-level like `projectTrusted`: it is a preference about
   * this installation, not about one conversation. Absent enables none of them.
   */
  optInExtensions?: string;
  /**
   * The engine this worker runs. Required since P6-5: the legacy fallback was
   * the other backend, and it is gone. Supplied by the worker entry so this
   * file and the runtime never import each other.
   */
  createRuntime: (options: PiWorkerRuntimeOptions) => PiWorkerRuntime;
  /**
   * P5-4 — the writer a conversation import goes through.
   *
   * Supplied by the worker entry for the same structural reason as
   * `createRuntime` above: this file must not import the runtime, and the
   * runtime must not import this file, so the choice is made once at the entry
   * point and travels as a factory.
   *
   * It was optional until P6-5, defaulting to pi's writer. An import is a pure
   * write job — no model, no tools, no turn — and leaving it on that writer
   * loaded `pi-coding-agent` for a job that had nothing to do with it. With the
   * legacy engine retired there is nothing to default to, so it is required.
   */
  createImportWriter: () => PiImportWriter;
  /**
   * P6-2 — the engine behind a one-shot completion, same seam as the two above.
   *
   * Takes the emitters rather than reaching for them: the runtime that streams
   * the answer lives on the other side of the backend boundary and cannot know
   * how this server frames an event.
   */
  createUtilityRuntime: (options: PiUtilityRuntimeOptions) => PiUtilityRuntime;
  log?: (...args: unknown[]) => void;
  onDisposed?: () => void;
}

/**
 * What an import job needs from a backend, and nothing more.
 *
 * Both implementations already had exactly these four methods; naming the shape
 * is what lets this dispatcher stay one implementation while the write side
 * differs. Both implementations satisfied it structurally; since P6-5 the only
 * one left is the native writer.
 */
export interface PiImportWriter {
  create(input: WorkerImportConversationPayload): Promise<WorkerImportConversationResult>;
  inspectInterrupted(
    workspacePath: string,
    targetPiSessionId: string
  ): Promise<WorkerInspectImportedSessionResult>;
  reconcileInterrupted(
    workspacePath: string,
    targetPiSessionId: string
  ): Promise<WorkerReconcileImportedSessionResult>;
  discard(sessionFile: string): Promise<WorkerDiscardImportedSessionResult>;
  /**
   * Release whatever the writer had to start up. Optional: the pi writer holds
   * only the SDK module, while the native one brings up a host IO service that
   * owns a subprocess on the encrypted-Windows fallback path.
   */
  dispose?(): Promise<void>;
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
    a.leafCheckpoint?.fileTailEntryId === b.leafCheckpoint?.fileTailEntryId &&
    // U05-c: a re-bootstrap that flips the trust posture is a DIFFERENT
    // session, not the same one — otherwise the second call would be answered
    // by a runtime already built with the first call's trust.
    a.unbound === b.unbound &&
    a.tier === b.tier &&
    a.permissions?.mode === b.permissions?.mode &&
    a.permissions?.gear === b.permissions?.gear
  );
}

function errorPayload(error: unknown): WorkerRpcErrorPayload {
  // P6-5 removed a branch for the legacy engine's PermissionGateUnavailableError.
  // Nothing is lost: it carried a string `code` and no `retryable`, which is
  // exactly what the generic Error branch below reports.
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
  private utilityRuntime: PiUtilityRuntime | null = null;
  private importWriter: PiImportWriter | null = null;
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
        case 'worker.import':
          await this.handleImport(request);
          break;
        case 'worker.import.discard':
          await this.handleDiscardImport(request);
          break;
        case 'worker.import.inspect':
          await this.handleInspectImport(request);
          break;
        case 'worker.import.reconcile':
          await this.handleReconcileImport(request);
          break;
        case 'worker.send':
          await this.handleSend(request);
          break;
        case 'utility.start':
          await this.handleUtilityStart(request);
          break;
        case 'utility.cancel':
          await this.handleUtilityCancel(request);
          break;
        case 'worker.history':
          await this.handleHistory(request);
          break;
        case 'worker.tree':
          await this.handleTree(request);
          break;
        case 'worker.commands':
          await this.handleCommands(request);
          break;
        case 'worker.compact':
          await this.handleCompact(request);
          break;
        case 'worker.rewind':
          await this.handleRewind(request);
          break;
        case 'worker.reload':
          await this.handleReload(request);
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
        case 'worker.permission.respond':
          this.handlePermissionResponse(request);
          break;
        case 'worker.question.respond':
          this.handleQuestionResponse(request);
          break;
        case 'worker.preview.respond':
          this.handlePreviewResponse(request);
          break;
        case 'worker.setPermissions':
          this.handleSetPermissions(request);
          break;
        case 'worker.setPermissionTier':
          this.handleSetPermissionTier(request);
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

  private async handleImport(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerImportConversationPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.import requires a valid versioned ImportedConversation',
        retryable: false,
      });
      return;
    }
    if (this.utilityRuntime) {
      throw new PiWorkerSessionError(
        'WORKER_UTILITY_SLOT_CONFLICT',
        'A one-shot utility worker cannot import a durable Pi session'
      );
    }
    if (this.runtime || this.bootstrapPayload) {
      throw new PiWorkerSessionError(
        'WORKER_IMPORT_SLOT_CONFLICT',
        'A bootstrapped AgentSession worker cannot also perform an import job'
      );
    }
    const result: WorkerImportConversationResult = await this.requireImportWriter().create(
      request.payload as WorkerImportConversationPayload
    );
    this.respondSuccess(request, result);
  }

  /** The import writer, created on first use — most workers never import. */
  private requireImportWriter(): PiImportWriter {
    if (!this.importWriter) this.importWriter = this.options.createImportWriter();
    return this.importWriter;
  }

  private async handleInspectImport(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerInspectImportedSessionPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.import.inspect requires workspacePath and targetPiSessionId',
        retryable: false,
      });
      return;
    }
    const payload = request.payload as WorkerInspectImportedSessionPayload;
    const result: WorkerInspectImportedSessionResult =
      await this.requireImportWriter().inspectInterrupted(
        payload.workspacePath,
        payload.targetPiSessionId
      );
    this.respondSuccess(request, result);
  }

  private async handleReconcileImport(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerReconcileImportedSessionPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.import.reconcile requires workspacePath and targetPiSessionId',
        retryable: false,
      });
      return;
    }
    const payload = request.payload as WorkerReconcileImportedSessionPayload;
    const result: WorkerReconcileImportedSessionResult =
      await this.requireImportWriter().reconcileInterrupted(
        payload.workspacePath,
        payload.targetPiSessionId
      );
    this.respondSuccess(request, result);
  }

  private async handleDiscardImport(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerDiscardImportedSessionPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.import.discard requires logicalSessionId and sessionFile',
        retryable: false,
      });
      return;
    }
    const payload = request.payload as WorkerDiscardImportedSessionPayload;
    if (!this.importWriter) {
      this.respondSuccess(request, {
        discarded: false,
      } satisfies WorkerDiscardImportedSessionResult);
      return;
    }
    this.respondSuccess(request, await this.importWriter.discard(payload.sessionFile));
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
    if (this.utilityRuntime) {
      throw new PiWorkerSessionError(
        'WORKER_UTILITY_SLOT_CONFLICT',
        'A one-shot utility worker cannot bootstrap a durable Pi AgentSession'
      );
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
      this.runtime = this.options.createRuntime({
        ...request.payload,
        // U05-c: `unbound` may only take trust AWAY. Written as an AND rather
        // than a ternary so no future payload field can hand a scratch session
        // the trusted posture the process was not started with.
        projectTrusted: this.options.projectTrusted && request.payload.unbound !== true,
        // NOT withdrawn by `unbound`. Project trust is about what a cloned repo
        // may configure; an opt-in bundled extension is about what this user
        // turned on, which a scratch directory has no bearing on.
        ...(this.options.optInExtensions ? { optInExtensions: this.options.optInExtensions } : {}),
        emit: (event) => this.emitRuntimeEvent(event),
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

  private async handleUtilityStart(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerUtilityStartPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'utility.start requires an operation id, cwd, prompt, and valid timeout',
        retryable: false,
      });
      return;
    }
    if (this.runtime || this.bootstrapPayload || this.importWriter) {
      throw new PiWorkerSessionError(
        'WORKER_UTILITY_SLOT_CONFLICT',
        'A session or import worker cannot run a one-shot utility operation'
      );
    }
    if (!this.utilityRuntime) {
      const utilityOptions: PiUtilityRuntimeOptions = {
        projectTrusted: this.options.projectTrusted,
        emitDelta: (payload) => this.emitUtilityEvent('utility.delta', payload),
        emitTerminal: (payload) => this.emitUtilityEvent('utility.terminal', payload),
        ...(this.log ? { log: this.log } : {}),
      };
      this.utilityRuntime = this.options.createUtilityRuntime(utilityOptions);
    }
    this.respondSuccess(request, await this.utilityRuntime.start(request.payload));
  }

  private async handleUtilityCancel(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerUtilityCancelPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'utility.cancel requires an operation id and valid reason',
        retryable: false,
      });
      return;
    }
    if (!this.utilityRuntime) {
      this.respondSuccess(request, { cancelled: false } satisfies WorkerUtilityCancelResult);
      return;
    }
    this.respondSuccess(request, await this.utilityRuntime.cancel(request.payload));
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

  /**
   * R02-a — list the slash commands available in this session.
   *
   * A worker that is not bootstrapped answers with an EMPTY list rather than an
   * error. This is asked by the composer as the user types `/`, and a session
   * that has not started yet is the ordinary case there, not a fault — the
   * caller would have to translate the error back into "no commands" anyway.
   */
  private async handleCommands(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerCommandsPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.commands requires logicalSessionId',
        retryable: false,
      });
      return;
    }
    if (!this.runtime?.commands) {
      this.respondSuccess(request, { commands: [], truncated: false });
      return;
    }
    this.respondSuccess(request, await this.runtime.commands(request.payload));
  }

  private async handleCompact(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerCompactPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.compact requires logicalSessionId',
        retryable: false,
      });
      return;
    }
    if (!this.runtime?.compact) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    this.respondSuccess(request, await this.runtime.compact(request.payload));
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

  private async handleReload(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerReloadPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.reload requires logicalSessionId and sessionFile',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    if (!this.runtime.reload) {
      throw new PiWorkerSessionError(
        'WORKER_RELOAD_UNAVAILABLE',
        'Worker reload method is unavailable'
      );
    }
    this.respondSuccess(request, await this.runtime.reload(request.payload));
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

  private handlePermissionResponse(request: WorkerRpcRequest): void {
    if (!isWorkerPermissionRespondPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.permission.respond requires logicalSessionId, permissionId and a decision',
        retryable: false,
      });
      return;
    }
    if (request.payload.logicalSessionId !== this.bootstrapPayload?.logicalSessionId) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_MISMATCH',
        'Permission response targets another session'
      );
    }
    if (!this.runtime?.respondPermission) {
      // The legacy backend asks through the extension UI bridge, so a
      // permission answer arriving here means the two ends disagree about which
      // channel is in use — saying so beats reporting `handled: false`, which
      // reads as "too late" and would hide the mismatch.
      throw new PiWorkerSessionError(
        'WORKER_PERMISSION_RESPOND_UNAVAILABLE',
        'This backend does not answer permissions through worker.permission.respond'
      );
    }
    const result: WorkerPermissionRespondResult = {
      handled: this.runtime.respondPermission({
        permissionId: request.payload.permissionId,
        decision: request.payload.decision,
      }),
    };
    this.respondSuccess(request, result);
  }

  /**
   * F5 — answer one `question.requested`.
   *
   * Rejects rather than reporting `handled: false` on a backend with no `ask`
   * tool, for the same reason the permission handler above does: `false` reads
   * as "too late", and a backend mismatch is not lateness. The legacy backend
   * has no producer for this event at all, so an answer reaching it means the
   * two ends disagree about which runtime is running.
   */
  private handleQuestionResponse(request: WorkerRpcRequest): void {
    if (!isWorkerQuestionRespondPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.question.respond requires logicalSessionId and questionId',
        retryable: false,
      });
      return;
    }
    if (request.payload.logicalSessionId !== this.bootstrapPayload?.logicalSessionId) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_MISMATCH',
        'Question response targets another session'
      );
    }
    if (!this.runtime?.respondQuestion) {
      throw new PiWorkerSessionError(
        'WORKER_QUESTION_RESPOND_UNAVAILABLE',
        'This backend has no question tool to answer'
      );
    }
    const result: WorkerQuestionRespondResult = {
      handled: this.runtime.respondQuestion({
        questionId: request.payload.questionId,
        ...(request.payload.answers ? { answers: request.payload.answers } : {}),
        ...(request.payload.response ? { response: request.payload.response } : {}),
        ...(request.payload.cancel ? { cancel: true } : {}),
      }),
    };
    this.respondSuccess(request, result);
  }

  /**
   * P5-2-3 — report the outcome of one `preview.requested`.
   *
   * Same rejection rule as the two handlers above: a backend with no
   * `browser_preview` tool cannot have a preview parked, so an answer arriving
   * at one means the ends disagree about which runtime is running, and that is
   * worth an error rather than a quiet `handled: false`.
   */
  private handlePreviewResponse(request: WorkerRpcRequest): void {
    if (!isWorkerPreviewRespondPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.preview.respond requires logicalSessionId, previewId and ok',
        retryable: false,
      });
      return;
    }
    if (request.payload.logicalSessionId !== this.bootstrapPayload?.logicalSessionId) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_MISMATCH',
        'Preview response targets another session'
      );
    }
    if (!this.runtime?.respondPreview) {
      throw new PiWorkerSessionError(
        'WORKER_PREVIEW_RESPOND_UNAVAILABLE',
        'This backend has no preview tool to answer'
      );
    }
    const result: WorkerPreviewRespondResult = {
      handled: this.runtime.respondPreview({
        previewId: request.payload.previewId,
        ok: request.payload.ok,
        ...(request.payload.error ? { error: request.payload.error } : {}),
      }),
    };
    this.respondSuccess(request, result);
  }

  private handleSetPermissions(request: WorkerRpcRequest): void {
    if (!isWorkerSetPermissionsPayload(request.payload))
      throw new PiWorkerSessionError('WORKER_INVALID_PAYLOAD', 'Invalid mode or permission gear');
    if (request.payload.logicalSessionId !== this.bootstrapPayload?.logicalSessionId)
      throw new PiWorkerSessionError(
        'WORKER_SESSION_MISMATCH',
        'Permission settings target another session'
      );
    if (!this.runtime?.setPermissions)
      throw new PiWorkerSessionError(
        'WORKER_UNSUPPORTED',
        'Runtime does not support mode and permission gear'
      );
    this.runtime.setPermissions(request.payload.permissions);
    this.respondSuccess(request, { applied: true });
  }

  private handleSetPermissionTier(request: WorkerRpcRequest): void {
    if (!isWorkerSetPermissionTierPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.setPermissionTier requires logicalSessionId and a valid tier',
        retryable: false,
      });
      return;
    }
    if (request.payload.logicalSessionId !== this.bootstrapPayload?.logicalSessionId) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_MISMATCH',
        'Permission tier change targets another session'
      );
    }
    this.runtime?.setPermissionTier?.(request.payload.tier);
    const result: WorkerSetPermissionTierResult = { applied: true };
    this.respondSuccess(request, result);
  }

  private async handleDispose(request: WorkerRpcRequest): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      await this.runtime?.dispose();
      await this.utilityRuntime?.dispose();
      await this.importWriter?.dispose?.();
      this.runtime = null;
      this.utilityRuntime = null;
      this.importWriter = null;
    }
    const result: WorkerDisposeResult = { disposed: true };
    this.respondSuccess(request, result);
    this.options.onDisposed?.();
  }

  private emitUtilityEvent(type: 'utility.delta' | 'utility.terminal', payload: unknown): void {
    if (this.disposed) return;
    const event: WorkerRpcEvent = {
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'event',
      generation: this.options.generation,
      type,
      payload,
    };
    this.options.port.postMessage(event);
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
