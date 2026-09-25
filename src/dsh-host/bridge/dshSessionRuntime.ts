/**
 * P0-3 minimal bridge: one DSH session behind our worker RPC.
 *
 * `DshSessionRuntime` implements the same `PiWorkerRuntime` contract as
 * `NativeWorkerRuntime`, so the unmodified `PiWorkerRpcServer` can drive it and
 * Main / the renderer see ordinary worker RPC and RuntimeEvents. It runs inside
 * the DSH host (the `aiclient-bridge` row of @aiclient/dsh-app) and talks to
 * DSH services in-process:
 *
 *   durable `session/event`        -> message.* / tool.* / session.* events
 *   live `agent/assistant-stream`  -> message.started / message.delta / thinking.delta
 *   `approval/request` waterfall   -> permission.requested, answered by
 *                                     worker.permission.respond
 *
 * Only what P0-3 needs is mapped: text, tool rows, approvals, stop. History,
 * tree, fork, rewind, compact and the rest answer empty or refuse; the gaps are
 * listed in the P0-3 evidence document.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { PiWorkerSessionError } from '../../agent-host/piWorkerErrors.ts';
import type {
  PiWorkerRuntime,
  PiWorkerRuntimeOptions,
} from '../../agent-host/piWorkerRpcServer.ts';
import type {
  PermissionDecisionId,
  PermissionRequestAction,
  PermissionRequestKind,
  RuntimeEventDraft,
} from '../../shared/types/runtimeEvents.ts';
import type {
  WorkerAcceptForkResult,
  WorkerBootstrapResult,
  WorkerCommandsResult,
  WorkerCompactResult,
  WorkerDiscardForkResult,
  WorkerForkResult,
  WorkerHistoryPayload,
  WorkerHistoryResult,
  WorkerInterjectResult,
  WorkerReloadResult,
  WorkerRewindResult,
  WorkerSendPayload,
  WorkerSendResult,
  WorkerStopPayload,
  WorkerStopResult,
  WorkerTreeResult,
} from '../../shared/types/workerRpc.ts';

// ---- the slice of the DSH host this bridge uses ----------------------------

type Dispose = () => void;

interface DshAgent {
  readonly id: string;
  readonly status: unknown;
  followup(message: unknown): void;
  cancel(cause: { kind: 'user' }): void;
}

interface DshAgentHandle {
  readonly agent: DshAgent;
  dispose(): Promise<void>;
}

interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

type StreamFrame =
  | { type: 'start'; attemptId: string; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; index: number; chunk: StreamChunk }
  | { type: 'end'; attemptId: string };

type StreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: string; index?: number };

interface ApprovalRequest {
  agent: { id: string };
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** The Cordis context of the `aiclient-bridge` row, narrowed to what is used here. */
export interface DshBridgeContext {
  on(
    name: 'session/event',
    listener: (session: { id: string }, event: DshSessionEvent) => void
  ): Dispose;
  on(
    name: 'agent/assistant-stream',
    listener: (payload: { agent: { id: string }; frame: StreamFrame }) => void
  ): Dispose;
  on(
    name: 'approval/request',
    listener: (
      request: ApprovalRequest,
      next: () => Promise<ApprovalOutcome>
    ) => Promise<ApprovalOutcome>
  ): Dispose;
  agents: {
    create(options: {
      sessionId: string;
      meta: { cwd: string };
      agentOptions: { provider: string; model: string };
    }): Promise<DshAgentHandle>;
    resume(options: {
      resumeSessionId: string;
      agentOptions: { provider: string; model: string };
    }): Promise<DshAgentHandle>;
  };
  agentDefaultModel: { currentSelection(): { provider: string; model: string } };
}

// ---- helpers ----------------------------------------------------------------

/** A RuntimeEventDraft without its session id, which `emit` fills in. */
type BridgeDraft = RuntimeEventDraft extends infer E
  ? E extends unknown
    ? Omit<E, 'sessionId'>
    : never
  : never;

/** The file Main keeps as this session's durable identity (`sessionFile`). */
interface SessionStub {
  engine: 'dsh';
  version: 1;
  dshSessionId: string;
  logicalSessionId: string;
  cwd: string;
}

const EMPTY_LEAF = { activeEntryId: null, fileTailEntryId: null };
const DECISIONS: PermissionDecisionId[] = ['allow', 'deny'];

function unsupported(operation: string): never {
  throw new PiWorkerSessionError(
    'WORKER_DSH_UNSUPPORTED',
    `${operation} is not bridged to the DSH engine yet (P0-3 minimal bridge)`
  );
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
    .map((block) => block.text)
    .join('');
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function kindOf(tool: string): PermissionRequestKind {
  if (tool === 'bash' || tool === 'pwsh') return 'exec';
  if (tool === 'write' || tool === 'edit') return 'file_change';
  return 'tool';
}

function actionOf(tool: string): PermissionRequestAction | undefined {
  if (tool === 'bash' || tool === 'pwsh') return 'run_command';
  if (tool === 'write') return 'write_file';
  if (tool === 'edit') return 'edit_file';
  if (tool === 'read') return 'read_file';
  return undefined;
}

/**
 * DSH names the file argument `file_path`; our timeline rows and cards read
 * `path`. The alias is added, nothing is removed, so the raw call is intact.
 */
function rowInput(args: Record<string, unknown>): Record<string, unknown> {
  return typeof args.file_path === 'string' && args.path === undefined
    ? { ...args, path: args.file_path }
    : args;
}

/** The card body native requests carry (`permissionPrompt.ts` detailOf). */
function detailOf(tool: string, args: Record<string, unknown>, cwd: string) {
  const path = typeof args.file_path === 'string' ? args.file_path : args.path;
  if ((tool === 'bash' || tool === 'pwsh') && typeof args.command === 'string') {
    return { kind: 'exec' as const, command: args.command, cwd };
  }
  if ((tool === 'write' || tool === 'edit') && typeof path === 'string') {
    return {
      kind: 'file_change' as const,
      changes: [{ path, change: tool === 'write' ? ('add' as const) : ('update' as const) }],
    };
  }
  return undefined;
}

/** DSH tool arguments -> the fields our permission card reads (`path`, `command`). */
function cardInput(tool: string, args: Record<string, unknown>, cwd: string) {
  const path = typeof args.file_path === 'string' ? args.file_path : args.path;
  return {
    ...(typeof path === 'string' ? { path } : {}),
    ...(typeof args.command === 'string' ? { command: args.command } : {}),
    ...(tool === 'write' && typeof args.content === 'string'
      ? { content: args.content, contentLabel: 'Content' }
      : {}),
    workspace: cwd,
  };
}

// ---- the runtime -------------------------------------------------------------

interface Turn {
  requestId: string;
  attemptId?: string;
  /** Id of the user message this turn sent; its durable echo carries attemptId. */
  userMessageId?: string;
  /** Set when a DSH turn started without a worker.send (goal rounds, job notices). */
  synthetic: boolean;
}

interface StepMessage {
  messageId: string;
  closed: boolean;
  /** Text already streamed per content-block index, to top up from the durable message. */
  streamed: Map<number, string>;
}

export class DshSessionRuntime implements PiWorkerRuntime {
  private readonly ctx: DshBridgeContext;
  private readonly options: PiWorkerRuntimeOptions;
  private readonly logicalSessionId: string;
  private readonly cwd: string;
  private readonly home: string;
  private handle: DshAgentHandle | null = null;
  private result: WorkerBootstrapResult | null = null;
  private booting: Promise<WorkerBootstrapResult> | null = null;
  private dshSessionId = '';
  private route = '';
  private turn: Turn | null = null;
  private readonly steps = new Map<string, StepMessage>();
  private readonly toolStep = new Map<string, string>();
  private readonly toolArgs = new Map<string, Record<string, unknown>>();
  private readonly startedTools = new Set<string>();
  private readonly pendingApprovals = new Map<string, (decision: PermissionDecisionId) => void>();
  private readonly disposers: Dispose[] = [];
  private disposed = false;

  constructor(ctx: DshBridgeContext, options: PiWorkerRuntimeOptions) {
    this.ctx = ctx;
    this.options = options;
    this.logicalSessionId = options.logicalSessionId;
    this.cwd = options.cwd;
    this.home = process.env.DSH_HOME ?? '';
  }

  // ---- lifecycle -------------------------------------------------------------

  async bootstrap(): Promise<WorkerBootstrapResult> {
    if (this.result) return this.result;
    this.booting ??= this.bootstrapOnce();
    try {
      return await this.booting;
    } catch (error) {
      this.booting = null;
      throw error;
    }
  }

  private async bootstrapOnce(): Promise<WorkerBootstrapResult> {
    const selection = this.ctx.agentDefaultModel.currentSelection();
    this.route = `${selection.provider}/${selection.model}`;
    this.listen();
    let stubFile = this.options.sessionFile;
    if (stubFile) {
      const stub = JSON.parse(readFileSync(stubFile, 'utf8')) as SessionStub;
      if (stub.engine !== 'dsh') throw unsupported('Opening a native session on the DSH engine');
      this.dshSessionId = stub.dshSessionId;
      this.handle = await this.ctx.agents.resume({
        resumeSessionId: stub.dshSessionId,
        agentOptions: selection,
      });
    } else {
      this.dshSessionId = `aiclient-${this.logicalSessionId}`;
      this.handle = await this.ctx.agents.create({
        sessionId: this.dshSessionId,
        meta: { cwd: this.cwd },
        agentOptions: selection,
      });
      const dir = join(this.home, 'aiclient-sessions');
      mkdirSync(dir, { recursive: true });
      stubFile = join(dir, `${this.dshSessionId}.dsh.json`);
      const stub: SessionStub = {
        engine: 'dsh',
        version: 1,
        dshSessionId: this.dshSessionId,
        logicalSessionId: this.logicalSessionId,
        cwd: this.cwd,
      };
      writeFileSync(stubFile, `${JSON.stringify(stub, null, 2)}\n`);
    }
    this.result = {
      bootstrapped: true,
      logicalSessionId: this.logicalSessionId,
      piSessionId: this.dshSessionId,
      cwd: this.cwd,
      agentDir: this.home,
      sessionFile: stubFile,
      leaf: EMPTY_LEAF,
      ...(this.options.model ? { model: this.options.model } : {}),
      projectTrusted: this.options.projectTrusted,
      permissionGate: 'bundled',
      capabilities: {},
    };
    return this.result;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const settle of this.pendingApprovals.values()) settle('cancel');
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.handle?.dispose();
    this.handle = null;
  }

  // ---- turns -----------------------------------------------------------------

  async startSend(input: WorkerSendPayload): Promise<WorkerSendResult> {
    if (this.turn && !this.turn.synthetic) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        'Session already has an active turn',
        true
      );
    }
    await this.bootstrap();
    const agent = this.requireAgent();
    const message = createUserMessage({
      content: [{ type: 'text', text: input.text }],
      source: { kind: 'user' },
    }) as { id: string };
    this.turn = {
      requestId: input.requestId,
      attemptId: input.attemptId,
      userMessageId: message.id,
      synthetic: false,
    };
    this.emit({ type: 'session.status', payload: { status: 'running' } });
    agent.followup(message);
    return { accepted: true, requestId: input.requestId };
  }

  async stop(_input: WorkerStopPayload): Promise<WorkerStopResult> {
    if (!this.turn || !this.handle) return { stopped: false };
    this.emit({ type: 'session.status', payload: { status: 'stopping' } });
    this.handle.agent.cancel({ kind: 'user' });
    return { stopped: true };
  }

  interject(): WorkerInterjectResult {
    return { interjected: false };
  }

  respondPermission(input: { permissionId: string; decision: PermissionDecisionId }): boolean {
    const settle = this.pendingApprovals.get(input.permissionId);
    if (!settle) return false;
    settle(input.decision);
    return true;
  }

  respondQuestion(): boolean {
    return false;
  }

  respondPreview(): boolean {
    return false;
  }

  setPermissions(): void {}
  setPermissionGear(): void {}
  setPermissionTier(): void {}

  // ---- reads that answer empty -------------------------------------------------

  async history(input: WorkerHistoryPayload): Promise<WorkerHistoryResult> {
    const boot = await this.bootstrap();
    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile: boot.sessionFile ?? '',
      workspacePath: this.cwd,
      page: {
        messages: [],
        offset: input.offset ?? 0,
        limit: input.limit ?? 100,
        totalCount: 0,
        hasMore: false,
      },
    };
  }

  async tree(): Promise<WorkerTreeResult> {
    const boot = await this.bootstrap();
    return {
      snapshot: {
        logicalSessionId: this.logicalSessionId,
        sessionFile: boot.sessionFile ?? '',
        workspacePath: this.cwd,
        leaf: EMPTY_LEAF,
        nodes: [],
        totalNodes: 0,
        returnedNodes: 0,
        truncated: false,
      },
    };
  }

  async commands(): Promise<WorkerCommandsResult> {
    return { commands: [], truncated: false };
  }

  async compact(): Promise<WorkerCompactResult> {
    return unsupported('compact');
  }
  async rewind(): Promise<WorkerRewindResult> {
    return unsupported('rewind');
  }
  async reload(): Promise<WorkerReloadResult> {
    return unsupported('reload');
  }
  async fork(): Promise<WorkerForkResult> {
    return unsupported('fork');
  }
  async discardFork(): Promise<WorkerDiscardForkResult> {
    return unsupported('discardFork');
  }
  async acceptFork(): Promise<WorkerAcceptForkResult> {
    return unsupported('acceptFork');
  }

  // ---- translation -------------------------------------------------------------

  private requireAgent(): DshAgent {
    if (!this.handle) throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'No DSH agent');
    return this.handle.agent;
  }

  private emit(event: BridgeDraft): void {
    this.options.emit({
      sessionId: this.logicalSessionId,
      ...(this.turn ? { requestId: this.turn.requestId } : {}),
      ...event,
    } as RuntimeEventDraft);
  }

  private listen(): void {
    this.disposers.push(
      this.ctx.on('session/event', (session, event) => {
        if (session?.id !== this.dshSessionId || this.disposed) return;
        try {
          this.onSessionEvent(event);
        } catch (error) {
          this.options.log?.('[dsh-bridge] session event failed', event.type, error);
        }
      }),
      this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent?.id !== this.dshSessionId || this.disposed) return;
        try {
          this.onStreamFrame(frame);
        } catch (error) {
          this.options.log?.('[dsh-bridge] stream frame failed', frame.type, error);
        }
      }),
      this.ctx.on('approval/request', (request, next) =>
        request.agent?.id === this.dshSessionId && !this.disposed ? this.ask(request) : next()
      )
    );
  }

  private stepMessage(turn: number, step: number): StepMessage {
    const key = `${turn}:${step}`;
    let message = this.steps.get(key);
    if (!message) {
      message = {
        messageId: `dsh-${this.dshSessionId}-t${turn}-s${step}`,
        closed: false,
        streamed: new Map(),
      };
      this.steps.set(key, message);
      this.emit({
        type: 'message.started',
        payload: { messageId: message.messageId, role: 'assistant', model: this.route },
      });
    }
    return message;
  }

  private currentStream: { attemptId: string; message: StepMessage } | null = null;

  private onStreamFrame(frame: StreamFrame): void {
    if (frame.type === 'start') {
      this.currentStream = {
        attemptId: frame.attemptId,
        message: this.stepMessage(frame.turn, frame.step),
      };
      return;
    }
    const current = this.currentStream;
    if (!current || current.attemptId !== frame.attemptId) return;
    if (frame.type === 'end') {
      this.currentStream = null;
      return;
    }
    const chunk = frame.chunk;
    const { messageId, streamed } = current.message;
    if (chunk.type === 'text-delta' && 'text' in chunk && typeof chunk.text === 'string') {
      const index = chunk.index ?? 0;
      streamed.set(index, (streamed.get(index) ?? '') + chunk.text);
      this.emit({
        type: 'message.delta',
        payload: { messageId, blockId: `${messageId}-b${index}`, text: chunk.text },
      });
    } else if (
      chunk.type === 'reasoning-delta' &&
      'text' in chunk &&
      typeof chunk.text === 'string'
    ) {
      this.emit({
        type: 'thinking.delta',
        payload: { messageId, blockId: `${messageId}-r${chunk.index ?? 0}`, text: chunk.text },
      });
    } else if (chunk.type === 'tool-call-delta' && 'id' in chunk && typeof chunk.id === 'string') {
      if (!this.startedTools.has(chunk.id) && typeof chunk.name === 'string') {
        this.startedTools.add(chunk.id);
        this.toolStep.set(chunk.id, messageId);
        this.emit({
          type: 'tool.started',
          payload: {
            messageId,
            toolCallId: chunk.id,
            name: chunk.name,
            input: { __streaming: { bytes: 0, lines: 0 } },
          },
        });
      }
    }
  }

  private onSessionEvent(event: DshSessionEvent): void {
    const data = event.data;
    switch (event.type) {
      case 'turn/start': {
        if (!this.turn) {
          // A turn the bridge did not start (goal round, job notice): give it an id.
          this.turn = {
            requestId: `dsh-turn-${this.dshSessionId}-${String(data.turn)}`,
            synthetic: true,
          };
          this.emit({ type: 'session.status', payload: { status: 'running' } });
        }
        return;
      }
      case 'user/message': {
        const turn = this.turn;
        if (!turn || data.id !== turn.userMessageId) return;
        const messageId = `dsh-user-${String(event.seq)}`;
        this.emit({
          type: 'message.started',
          payload: {
            messageId,
            role: 'user',
            ...(turn.attemptId ? { attemptId: turn.attemptId } : {}),
          },
        });
        this.emit({
          type: 'message.delta',
          payload: { messageId, blockId: `${messageId}-text`, text: textOf(data.content) },
        });
        this.emit({ type: 'message.completed', payload: { messageId } });
        return;
      }
      case 'assistant/message': {
        const message = this.stepMessage(Number(data.turn), Number(data.step));
        const content = (data.message as { content?: unknown[] } | undefined)?.content ?? [];
        content.forEach((block, index) => {
          const record = block as Record<string, unknown>;
          if (record.type === 'text' && typeof record.text === 'string') {
            // Top up whatever the live stream did not deliver (e.g. a replayed attempt).
            const already = message.streamed.get(index) ?? '';
            if (record.text.length > already.length && record.text.startsWith(already)) {
              const rest = record.text.slice(already.length);
              message.streamed.set(index, record.text);
              this.emit({
                type: 'message.delta',
                payload: {
                  messageId: message.messageId,
                  blockId: `${message.messageId}-b${index}`,
                  text: rest,
                },
              });
            }
          }
        });
        return;
      }
      case 'tool/call': {
        const callId = String(data.callId);
        const name = String(data.name);
        const args = parseArguments(data.arguments) as Record<string, unknown>;
        this.toolArgs.set(callId, args);
        const messageId = this.stepMessage(Number(data.turn), Number(data.step)).messageId;
        this.toolStep.set(callId, messageId);
        if (!this.startedTools.has(callId)) {
          this.startedTools.add(callId);
          this.emit({
            type: 'tool.started',
            payload: { messageId, toolCallId: callId, name, input: rowInput(args) },
          });
        } else {
          this.emit({
            type: 'tool.updated',
            payload: { messageId, toolCallId: callId, input: rowInput(args) },
          });
        }
        return;
      }
      case 'tool/result': {
        const message = data.message as {
          toolCallId?: string;
          content?: unknown;
          isError?: boolean;
        };
        const callId = String(message?.toolCallId ?? '');
        const messageId =
          this.toolStep.get(callId) ??
          this.stepMessage(Number(data.turn), Number(data.step)).messageId;
        const text = textOf(message?.content);
        this.emit({
          type: 'tool.completed',
          payload: {
            messageId,
            toolCallId: callId,
            ok: message?.isError !== true,
            ...(message?.isError === true ? { error: text } : { output: text }),
          },
        });
        return;
      }
      case 'step/end': {
        const message = this.steps.get(`${String(data.turn)}:${String(data.step)}`);
        if (message && !message.closed) {
          message.closed = true;
          this.emit({ type: 'message.completed', payload: { messageId: message.messageId } });
        }
        return;
      }
      case 'turn/end': {
        const reason = (data.reason as { kind?: string; error?: unknown } | undefined) ?? {};
        for (const message of this.steps.values()) {
          if (!message.closed) {
            message.closed = true;
            this.emit({ type: 'message.completed', payload: { messageId: message.messageId } });
          }
        }
        if (reason.kind === 'completed') {
          this.emit({ type: 'session.completed', payload: {} });
        } else if (reason.kind === 'aborted') {
          this.emit({ type: 'session.stopped', payload: {} });
        } else {
          this.emit({
            type: 'session.failed',
            payload: { error: `DSH turn ended: ${JSON.stringify(reason).slice(0, 500)}` },
          });
        }
        this.emit({ type: 'session.status', payload: { status: 'idle' } });
        this.turn = null;
        this.steps.clear();
        this.currentStream = null;
        return;
      }
      default:
        return;
    }
  }

  /** One DSH approval question -> one permission card, answered by the user. */
  private ask(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const permissionId = request.callId ?? `dsh-approval-${Date.now()}`;
    const args = (request.callId ? this.toolArgs.get(request.callId) : undefined) ?? {};
    const action = actionOf(request.toolName);
    const detail = detailOf(request.toolName, args, this.cwd);
    this.emit({
      type: 'permission.requested',
      payload: {
        permissionId,
        toolName: request.toolName,
        ...(action ? { action } : {}),
        input: cardInput(request.toolName, args, this.cwd),
        kind: kindOf(request.toolName),
        decisions: DECISIONS,
        ...(detail ? { detail } : {}),
        ...(request.reason ? { reason: request.reason } : {}),
      },
    });
    return new Promise((resolve) => {
      const settle = (decision: PermissionDecisionId, autoReason?: 'aborted') => {
        if (!this.pendingApprovals.has(permissionId)) return;
        this.pendingApprovals.delete(permissionId);
        request.signal?.removeEventListener('abort', onAbort);
        const allow = decision === 'allow' || decision === 'allow_session';
        this.emit({
          type: 'permission.resolved',
          payload: { permissionId, allow, decision, ...(autoReason ? { autoReason } : {}) },
        });
        resolve(allow ? 'allowed-once' : decision === 'cancel' ? 'cancelled' : 'rejected');
      };
      const onAbort = () => settle('deny', 'aborted');
      this.pendingApprovals.set(permissionId, (decision) => settle(decision));
      if (request.signal?.aborted) onAbort();
      else request.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
