// Moved from src/agent-host/piWorkerRpcServer.ts (dsh-rebase P1-12 step 4,
// decision 147): the bridge is its only user.
import type {
  PermissionDecisionId,
  RuntimeEvent,
  RuntimeEventDraft,
} from '../../shared/types/runtimeEvents.ts';
import type {
  PermissionGear,
  RuntimePermissionSettings,
} from '../../shared/types/runtimePermission.ts';
import type { SessionPermissionTier } from '../../shared/types/sessionPermissionTier.ts';
import {
  isWorkerAcceptForkPayload,
  isWorkerBootstrapPayload,
  isWorkerCommandPayload,
  isWorkerCommandsPayload,
  isWorkerCompactPayload,
  isWorkerDiscardForkPayload,
  isWorkerForkPayload,
  isWorkerHistoryPayload,
  isWorkerInterjectPayload,
  isWorkerJobKillPayload,
  isWorkerJobReadPayload,
  isWorkerPanelsPayload,
  isWorkerPermissionRespondPayload,
  isWorkerPreviewRespondPayload,
  isWorkerQuestionRespondPayload,
  isWorkerRewindPayload,
  isWorkerRpcRequest,
  isWorkerSendPayload,
  isWorkerSetPermissionGearPayload,
  isWorkerSetPermissionsPayload,
  isWorkerSetPermissionTierPayload,
  isWorkerStopPayload,
  isWorkerSubagentInterruptPayload,
  isWorkerTreePayload,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerAcceptForkPayload,
  type WorkerAcceptForkResult,
  type WorkerBootstrapPayload,
  type WorkerBootstrapResult,
  type WorkerCommandPayload,
  type WorkerCommandResult,
  type WorkerCommandsPayload,
  type WorkerCommandsResult,
  type WorkerCompactPayload,
  type WorkerCompactResult,
  type WorkerDiscardForkPayload,
  type WorkerDiscardForkResult,
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
  type WorkerPermissionRespondResult,
  type WorkerPreviewRespondResult,
  type WorkerQuestionRespondResult,
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
  type WorkerSubagentInterruptPayload,
  type WorkerSubagentInterruptResult,
  type WorkerTreePayload,
  type WorkerTreeResult,
} from '../../shared/types/workerRpc.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';

export interface PiWorkerMessagePort {
  postMessage(message: unknown): void;
}

/**
 * Everything a worker runtime must answer.
 *
 * T025 made every method required. Twelve of them used to be optional so a
 * second backend could omit what it did not implement, and each RPC handler
 * carried a `WORKER_*_UNAVAILABLE` arm for that case. Required here means the
 * next runtime that forgets `fork` fails to compile instead of failing at the
 * moment a user clicks "fork from here". Since dsh-rebase P1-12 the only
 * implementation is the DSH bridge's `DshSessionRuntime`; `reload` left the
 * interface with the native runtime (decision 127).
 */
export interface PiWorkerRuntime {
  bootstrap(): Promise<WorkerBootstrapResult>;
  startSend(input: WorkerSendPayload): Promise<WorkerSendResult>;
  history(input: WorkerHistoryPayload): Promise<WorkerHistoryResult>;
  tree(input: WorkerTreePayload): Promise<WorkerTreeResult>;
  commands(input: WorkerCommandsPayload): Promise<WorkerCommandsResult>;
  compact(input: WorkerCompactPayload): Promise<WorkerCompactResult>;
  /**
   * dsh-rebase P1-7a — one engine command run out of band (the goal bar's
   * `/goal …`): no turn, no event, not refused while a turn runs.
   */
  command(input: WorkerCommandPayload): Promise<WorkerCommandResult>;
  /** dsh-rebase P1-7a — the panels' current projections, for a renderer that missed them. */
  panels(input: WorkerPanelsPayload): Promise<WorkerPanelsResult>;
  /** dsh-rebase P1-7b — stop one background job of the session (the jobs window). */
  killJob(input: WorkerJobKillPayload): Promise<WorkerJobKillResult>;
  /** dsh-rebase P1-7b — one job's output, read without moving the model's cursor. */
  readJob(input: WorkerJobReadPayload): Promise<WorkerJobReadResult>;
  /** dsh-rebase P1-7b — interrupt one continuable subagent's current run. */
  interruptSubagent(input: WorkerSubagentInterruptPayload): Promise<WorkerSubagentInterruptResult>;
  rewind(input: WorkerRewindPayload): Promise<WorkerRewindResult>;
  fork(input: WorkerForkPayload): Promise<WorkerForkResult>;
  discardFork(input: WorkerDiscardForkPayload): Promise<WorkerDiscardForkResult>;
  /** session-index-04 — the fork became a real session; stop claiming it. */
  acceptFork(input: WorkerAcceptForkPayload): Promise<WorkerAcceptForkResult>;
  stop(input: WorkerStopPayload): Promise<WorkerStopResult>;
  /**
   * Ctrl+Enter — hand the message to the live run (dsh-rebase decision 093:
   * the DSH bridge steers it into the running turn). `interjected: false` is
   * the answer for "no run was live", not a failure. The bridge answers a
   * promise when the message carries attachments, which it admits through the
   * engine first (P1-4c2), and answers synchronously otherwise.
   */
  interject(input: WorkerInterjectPayload): WorkerInterjectResult | Promise<WorkerInterjectResult>;
  /** Answer one `permission.requested`. */
  respondPermission(input: { permissionId: string; decision: PermissionDecisionId }): boolean;
  /** F5 — answer one `question.requested`. */
  respondQuestion(input: {
    questionId: string;
    answers?: Record<string, string>;
    response?: string;
    cancel?: boolean;
  }): boolean;
  /** P5-2-3 — report what Main did with one `preview.requested`. */
  respondPreview(input: { previewId: string; ok: boolean; error?: string }): boolean;
  setPermissions(permissions: RuntimePermissionSettings): void;
  /** The gear alone, which a running turn does not lock. */
  setPermissionGear(gear: PermissionGear): void;
  setPermissionTier(tier: SessionPermissionTier): void;
  dispose(): Promise<void>;
}

/**
 * What a worker runtime is constructed with.
 *
 * P6-5: this used to be `PiWorkerSessionOptions`, exported by the legacy engine
 * that no longer exists. The two legacy-only fields went with it — `loadSdk`
 * (the pi-coding-agent import) and `decidePermissionGate` (that engine's plugin
 * arbitration).
 *
 * cutover-10: `optInExtensions` went the same way. It named which bundled pi
 * extensions to inject, which nothing has injected since P6-5 — Main filled it,
 * the entry forwarded it, this file passed it on, and the runtime never
 * declared it. A parameter no implementation reads is not a contract, it is a
 * claim that something is being configured.
 */
export interface PiWorkerRuntimeOptions extends WorkerBootstrapPayload {
  projectTrusted: boolean;
  emit: (event: RuntimeEventDraft) => void;
  log?: (...args: unknown[]) => void;
}

export interface PiWorkerRpcServerOptions {
  port: PiWorkerMessagePort;
  generation: number;
  projectTrusted: boolean;
  /**
   * The engine this worker runs, supplied by the DSH bridge's channel mux so
   * this file and the engine never import each other.
   *
   * dsh-rebase P1-12 step 3 (decision 147): the import writer and one-shot
   * utility factories went with the native worker. Imports produce DSH sessions
   * in Main (decision 124) and one-shot completions run on the host's own
   * control channel (decision 125), so `worker.import*`, `utility.*` and
   * `worker.reload` are now unknown methods here.
   */
  createRuntime: (options: PiWorkerRuntimeOptions) => PiWorkerRuntime;
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
    // U05-c: a re-bootstrap that flips the trust posture is a DIFFERENT
    // session, not the same one — otherwise the second call would be answered
    // by a runtime already built with the first call's trust.
    a.unbound === b.unbound &&
    // concurrency-02: a re-bootstrap that forces the writer lock is likewise a
    // different request — the first runtime was built without the takeover.
    a.forceTakeover === b.forceTakeover &&
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
 * EVERY request is serialized on one chain, read-only ones included: `receive`
 * appends to a single promise. Worth stating plainly (this comment used to say
 * "mutating requests are serialized", which reads as though `worker.history`
 * or `worker.commands` could overtake) because it sets the worst case — a large
 * history read delays the `worker.stop` queued behind it.
 *
 * The first bootstrap owns the process for its lifetime; an identical duplicate
 * is idempotent and a different bootstrap is rejected without constructing a
 * second AgentSession.
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
        case 'worker.commands':
          await this.handleCommands(request);
          break;
        case 'worker.compact':
          await this.handleCompact(request);
          break;
        case 'worker.command':
          await this.handleCommand(request);
          break;
        case 'worker.panels':
          await this.handlePanels(request);
          break;
        case 'worker.job.kill':
          await this.handleJobKill(request);
          break;
        case 'worker.job.read':
          await this.handleJobRead(request);
          break;
        case 'worker.subagent.interrupt':
          await this.handleSubagentInterrupt(request);
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
        case 'worker.fork.accept':
          await this.handleAcceptFork(request);
          break;
        case 'worker.stop':
          await this.handleStop(request);
          break;
        case 'worker.interject':
          await this.handleInterject(request);
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
        case 'worker.setPermissionGear':
          this.handleSetPermissionGear(request);
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
      this.runtime = this.options.createRuntime({
        ...request.payload,
        // U05-c: `unbound` may only take trust AWAY. Written as an AND rather
        // than a ternary so no future payload field can hand a scratch session
        // the trusted posture the process was not started with.
        projectTrusted: this.options.projectTrusted && request.payload.unbound !== true,
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
    if (!this.runtime) {
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
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    this.respondSuccess(request, await this.runtime.compact(request.payload));
  }

  private async handleCommand(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerCommandPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.command requires logicalSessionId and a /command line',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    this.respondSuccess(request, await this.runtime.command(request.payload));
  }

  /**
   * A worker that is not bootstrapped answers with no panels, as
   * `worker.commands` answers an empty menu: the renderer asks on every chat
   * it shows, and a session that has not started is the ordinary case there.
   */
  private async handlePanels(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerPanelsPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.panels requires logicalSessionId',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      this.respondSuccess(request, { projections: [] });
      return;
    }
    this.respondSuccess(request, await this.runtime.panels(request.payload));
  }

  /**
   * dsh-rebase P1-7b — the jobs and subagents windows act on a live session:
   * each needs a bootstrapped runtime, as `worker.command` does.
   */
  private async handleJobKill(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerJobKillPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.job.kill requires logicalSessionId and jobId',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    this.respondSuccess(request, await this.runtime.killJob(request.payload));
  }

  private async handleJobRead(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerJobReadPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.job.read requires logicalSessionId, jobId and a valid from / maxBytes',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    this.respondSuccess(request, await this.runtime.readJob(request.payload));
  }

  private async handleSubagentInterrupt(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerSubagentInterruptPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.subagent.interrupt requires logicalSessionId and childId',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    this.respondSuccess(request, await this.runtime.interruptSubagent(request.payload));
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
    this.respondSuccess(request, await this.runtime.discardFork(request.payload));
  }

  private async handleAcceptFork(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerAcceptForkPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.fork.accept requires logicalSessionId and sessionFile',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    this.respondSuccess(request, await this.runtime.acceptFork(request.payload));
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

  private async handleInterject(request: WorkerRpcRequest): Promise<void> {
    if (!isWorkerInterjectPayload(request.payload)) {
      this.respondError(request, {
        code: 'WORKER_INVALID_PAYLOAD',
        message: 'worker.interject requires logicalSessionId, attemptId and a message',
        retryable: false,
      });
      return;
    }
    if (!this.runtime) {
      this.respondSuccess(request, {
        interjected: false,
        turnActive: false,
      } satisfies WorkerInterjectResult);
      return;
    }
    this.respondSuccess(request, await this.runtime.interject(request.payload));
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
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
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
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
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
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
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
    if (!this.runtime)
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    this.runtime.setPermissions(request.payload.permissions);
    this.respondSuccess(request, { applied: true });
  }

  /**
   * The gear-only change, which is the one a running turn still accepts.
   *
   * Same three guards as its neighbour above — a valid payload, the right
   * session, a runtime to apply it to — and the same `applied: true` contract:
   * Main records the gear and the composer chip shows it, so claiming it landed
   * without an engine behind it would put a posture on screen that nothing is
   * enforcing.
   */
  private handleSetPermissionGear(request: WorkerRpcRequest): void {
    if (!isWorkerSetPermissionGearPayload(request.payload))
      throw new PiWorkerSessionError('WORKER_INVALID_PAYLOAD', 'Invalid permission gear');
    if (request.payload.logicalSessionId !== this.bootstrapPayload?.logicalSessionId)
      throw new PiWorkerSessionError(
        'WORKER_SESSION_MISMATCH',
        'Permission gear change targets another session'
      );
    if (!this.runtime)
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    this.runtime.setPermissionGear(request.payload.gear);
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
    // `applied: true` has to mean it. The tier is a security axis: Main records
    // it and the composer chip shows it, so answering "applied" without a
    // runtime to apply it to would leave the UI claiming a posture the engine
    // never took. Same answer `worker.setPermissions` gives for the same
    // situation.
    if (!this.runtime) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    }
    this.runtime.setPermissionTier(request.payload.tier);
    const result: WorkerSetPermissionTierResult = { applied: true };
    this.respondSuccess(request, result);
  }

  /**
   * Tear the worker down, then say so.
   *
   * Two orderings matter here and both used to be wrong.
   *
   * `disposed` goes up AFTER the runtime is torn down, not before: it is the
   * gate on `emitRuntimeEvent`, and the engine emits while it drains parked
   * permission gates, questions and previews. Setting it first dropped exactly
   * the events those drains exist to deliver, so Main never learned that the
   * dialogs it was showing had been answered for it.
   *
   * A rejecting dispose must not skip the null-out or the exit hook.
   * `onDisposed` is the channel's only way to close, and skipping it used to
   * turn a cleanup error into a worker that stays alive forever. The error
   * still reaches Main, as the response to this request.
   */
  private async handleDispose(request: WorkerRpcRequest): Promise<void> {
    let failure: unknown;
    if (!this.disposed) {
      try {
        await this.runtime?.dispose();
      } catch (error) {
        failure = error;
      }
      this.disposed = true;
      this.runtime = null;
    }
    if (failure) this.respondError(request, errorPayload(failure));
    else this.respondSuccess(request, { disposed: true } satisfies WorkerDisposeResult);
    this.options.onDisposed?.();
  }

  /**
   * Put one runtime event on the wire.
   *
   * `seq` and `timestamp` are filled because `RuntimeEvent` requires them, not
   * because anything downstream reads these values: `WorkerManager.dispatch`
   * re-stamps every event with its own counter and clock on the way out of
   * Main, which is where the sequence is defined to be monotonic. Nothing —
   * renderer, trace, contract fixtures — ever sees the numbers written here, so
   * they are no use for telling worker-side ordering or timing apart.
   */
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
