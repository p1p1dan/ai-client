/**
 * One DSH session behind our worker RPC (P0-3 bridge, hardened for P1-1).
 *
 * `DshSessionRuntime` implements the same `PiWorkerRuntime` contract as
 * `NativeWorkerRuntime`, so the unmodified `PiWorkerRpcServer` can drive it and
 * Main / the renderer see ordinary worker RPC and RuntimeEvents. It runs inside
 * the shared DSH host, one per channel of the `aiclient-bridge` row of
 * @aiclient/dsh-app (P1-3a), and talks to DSH services in-process:
 *
 *   durable `session/event`        -> message.* / tool.* / session.* events
 *   live `agent/assistant-stream`  -> message.started / message.delta / thinking.delta
 *   `approval/request` waterfall   -> permission.requested, answered by
 *                                     worker.permission.respond
 *
 * Mapped: text, tool rows, approvals, stop, and the session identity (create,
 * resume, crash restart). History and tree answer a legal empty page, and
 * fork, rewind, compact, retry and attachments refuse; P1-4 fills those in
 * (dsh-rebase decision 010).
 *
 * Identity (decisions 006 and 007): Main's durable `sessionFile` is a small
 * stub, `$DSH_HOME/aiclient-sessions/<dshSessionId>.dsh.json`, naming the DSH
 * session `aiclient-<logical id>`. A new session is flushed to disk BEFORE the
 * stub is written, so a committed identity always names a log that exists.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
import {
  WORKER_RETRY_UNAVAILABLE,
  type WorkerAcceptForkResult,
  type WorkerBootstrapResult,
  type WorkerCommandsResult,
  type WorkerCompactResult,
  type WorkerDiscardForkResult,
  type WorkerForkResult,
  type WorkerHistoryPayload,
  type WorkerHistoryResult,
  type WorkerInterjectResult,
  type WorkerReloadResult,
  type WorkerRewindResult,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerStopPayload,
  type WorkerStopResult,
  type WorkerTreeResult,
} from '../../shared/types/workerRpc.ts';

// ---- the slice of the DSH host this bridge uses ----------------------------

type Dispose = () => void;

/** The slice of a DSH `Session` read here; the object itself goes back to `ctx.sessions`. */
interface DshSession {
  readonly header?: { readonly cwd?: string };
}

interface DshAgent {
  readonly id: string;
  readonly status: unknown;
  readonly session: DshSession;
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
  /** `ctx.sessions` (dsh-session): `flush` is the one official durability barrier. */
  sessions: { flush(session: DshSession): Promise<boolean> };
}

/** What the bridge takes besides the Cordis context, injected so it can run without DSH installed. */
export interface DshBridgeDeps {
  /** `createUserMessage` from `@deepseek-ai/dsh-llm`: the id its durable echo carries. */
  createUserMessage(input: {
    content: Array<{ type: 'text'; text: string }>;
    source: { kind: 'user' };
  }): { id: string };
  /** `$DSH_HOME`; defaults to the host's environment. */
  home?: string;
  now?: () => number;
}

// ---- helpers ----------------------------------------------------------------

/** A RuntimeEventDraft without its session id, which `emit` fills in. */
type BridgeDraft = RuntimeEventDraft extends infer E
  ? E extends unknown
    ? Omit<E, 'sessionId'>
    : never
  : never;

/** The file Main keeps as this session's durable identity (`sessionFile`, decision 006). */
export interface SessionStub {
  engine: 'dsh';
  version: 1;
  dshSessionId: string;
  logicalSessionId: string;
  cwd: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** Directory under `$DSH_HOME` holding the identity stubs, and their suffix. */
export const DSH_STUB_DIR = 'aiclient-sessions';
export const DSH_STUB_SUFFIX = '.dsh.json';

/** Error codes this bridge answers with; Main and the renderer match on them. */
export const DSH_SESSION_MISSING = 'dsh_session_missing';
export const SESSION_LOCKED = 'session_locked';
export const SESSION_CWD_MISMATCH = 'session_cwd_mismatch';
export const SESSION_INVALID = 'session_invalid';

/** The page size Main asks for when it reads a resumed session (`readHistory(entry, 0, 80)`). */
export const INITIAL_HISTORY_LIMIT = 80;

/** Ours, not DSH's in-process counter, so a lost stub can be found again (decision 006). */
export function dshSessionIdFor(logicalSessionId: string): string {
  return `aiclient-${logicalSessionId}`;
}

export function stubPathFor(home: string, dshSessionId: string): string {
  return join(home, DSH_STUB_DIR, `${dshSessionId}${DSH_STUB_SUFFIX}`);
}

const EMPTY_LEAF = { activeEntryId: null, fileTailEntryId: null };
const DECISIONS: PermissionDecisionId[] = ['allow', 'deny'];
/** The id becomes a file name, so nothing that could leave the stub directory. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function unsupported(operation: string): never {
  throw new PiWorkerSessionError(
    'WORKER_DSH_UNSUPPORTED',
    `${operation} is not bridged to the DSH engine yet`
  );
}

/**
 * DSH persistence errors carry no `code`; they are told apart by `name`, and a
 * loader may wrap them (`cause`, `AggregateError`).
 */
function hasNamedError(error: unknown, name: string, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 4) return false;
  const record = error as { name?: unknown; cause?: unknown; errors?: unknown };
  if (record.name === name) return true;
  if (hasNamedError(record.cause, name, depth + 1)) return true;
  return Array.isArray(record.errors)
    ? record.errors.some((inner) => hasNamedError(inner, name, depth + 1))
    : false;
}

/** decision 010: DSH's refusals in our vocabulary. The kernel lock has no forced takeover. */
function mapOpenError(error: unknown, dshSessionId: string): unknown {
  if (hasNamedError(error, 'SessionPersistenceNotFoundError')) {
    return new PiWorkerSessionError(
      DSH_SESSION_MISSING,
      `DSH session ${dshSessionId} is not on disk`
    );
  }
  if (hasNamedError(error, 'SessionAlreadyOwnedError')) {
    return new PiWorkerSessionError(
      SESSION_LOCKED,
      `DSH session ${dshSessionId} is held by another process`,
      true
    );
  }
  return error;
}

function sameCwd(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isSessionStub(value: unknown): value is SessionStub {
  const stub = value as Partial<SessionStub> | null;
  return (
    typeof stub === 'object' &&
    stub !== null &&
    stub.engine === 'dsh' &&
    stub.version === 1 &&
    typeof stub.dshSessionId === 'string' &&
    SAFE_ID.test(stub.dshSessionId) &&
    typeof stub.logicalSessionId === 'string' &&
    typeof stub.cwd === 'string' &&
    stub.cwd.length > 0
  );
}

function readStub(file: string): SessionStub {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new PiWorkerSessionError(
        DSH_SESSION_MISSING,
        `DSH session identity is missing: ${file}`
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isSessionStub(parsed)) {
    throw new PiWorkerSessionError(SESSION_INVALID, `Not a DSH session identity: ${file}`);
  }
  return parsed;
}

/** Temp file + fsync + rename: a reader sees the old stub or the whole new one, never half. */
function writeStubAtomically(file: string, stub: SessionStub): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(stub, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
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
  private readonly deps: DshBridgeDeps;
  private readonly logicalSessionId: string;
  private readonly cwd: string;
  private readonly home: string;
  private readonly now: () => number;
  private listening = false;
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

  constructor(ctx: DshBridgeContext, options: PiWorkerRuntimeOptions, deps: DshBridgeDeps) {
    this.ctx = ctx;
    this.options = options;
    this.deps = deps;
    this.logicalSessionId = options.logicalSessionId;
    this.cwd = options.cwd;
    this.home = deps.home ?? process.env.DSH_HOME ?? '';
    this.now = deps.now ?? Date.now;
  }

  /**
   * The agent is not idle: a turn this bridge started, one it did not (a goal
   * round, a job notice), or other agent work. Reported to Main in each pong.
   */
  get busy(): boolean {
    if (this.disposed) return false;
    return this.turn !== null || (this.handle !== null && this.handle.agent.status !== 'idle');
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
    if (!this.home) throw new Error('DSH_HOME is not set for the DSH bridge');
    const selection = this.ctx.agentDefaultModel.currentSelection();
    this.route = `${selection.provider}/${selection.model}`;
    this.listen();
    const requested = this.options.sessionFile;
    let stubFile: string;
    try {
      stubFile = requested ?? (await this.createSession(selection));
      if (requested) await this.resumeSession(requested, selection);
    } catch (error) {
      // Nothing half-open survives a failed bootstrap: the session's write lock
      // goes with the handle.
      const handle = this.handle;
      this.handle = null;
      await handle?.dispose().catch(() => undefined);
      throw error;
    }
    this.result = {
      bootstrapped: true,
      logicalSessionId: this.logicalSessionId,
      piSessionId: this.dshSessionId,
      cwd: this.cwd,
      agentDir: this.home,
      sessionFile: stubFile,
      leaf: EMPTY_LEAF,
      // Main requires the first page of a reopened session (resume, crash
      // restart). Empty and legal until P1-4 projects the log; the renderer
      // keeps what it already shows when a page is empty.
      ...(requested
        ? { initialHistory: this.emptyHistory(stubFile, 0, INITIAL_HISTORY_LIMIT) }
        : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      projectTrusted: this.options.projectTrusted,
      permissionGate: 'bundled',
      capabilities: {},
    };
    return this.result;
  }

  /**
   * decision 007: create, flush the header to disk, then write the stub. Main
   * commits the identity as soon as the stub exists, so the log must already
   * be there — or a host that dies before the first turn leaves an identity
   * that can never be opened.
   */
  private async createSession(selection: { provider: string; model: string }): Promise<string> {
    this.dshSessionId = dshSessionIdFor(this.logicalSessionId);
    if (!SAFE_ID.test(this.dshSessionId)) {
      throw new PiWorkerSessionError(
        'WORKER_INVALID_PAYLOAD',
        `Logical session id cannot name a DSH session: ${this.logicalSessionId}`
      );
    }
    const stubFile = stubPathFor(this.home, this.dshSessionId);
    try {
      this.handle = await this.ctx.agents.create({
        sessionId: this.dshSessionId,
        meta: { cwd: this.cwd },
        agentOptions: selection,
      });
      await this.ctx.sessions.flush(this.handle.agent.session);
    } catch (error) {
      if (!hasNamedError(error, 'SessionAlreadyExistsError')) throw error;
      // An earlier create of this same logical session reached the disk but
      // never became Main's identity (its stub, its index commit or its reply
      // was lost). The id is deterministic, so failing here would fail every
      // retry forever; the log is this chat's own, so reopen it instead.
      await this.openDshSession(this.dshSessionId, selection);
      const cwd = this.handle?.agent.session.header?.cwd;
      if (cwd !== undefined && !sameCwd(cwd, this.cwd)) {
        throw new PiWorkerSessionError(
          SESSION_CWD_MISMATCH,
          `DSH session ${this.dshSessionId} belongs to ${cwd}, not ${this.cwd}`
        );
      }
    }
    writeStubAtomically(stubFile, {
      engine: 'dsh',
      version: 1,
      dshSessionId: this.dshSessionId,
      logicalSessionId: this.logicalSessionId,
      cwd: this.cwd,
      createdAt: this.now(),
    });
    return stubFile;
  }

  /** Resume and crash restart: the stub names the DSH session and its fixed cwd. */
  private async resumeSession(
    stubFile: string,
    selection: { provider: string; model: string }
  ): Promise<void> {
    const stub = readStub(stubFile);
    // DSH keeps the cwd in the session header and every tool reads it from
    // there, so a different workspace cannot be honoured — only refused.
    if (!sameCwd(stub.cwd, this.cwd)) {
      throw new PiWorkerSessionError(
        SESSION_CWD_MISMATCH,
        `DSH session ${stub.dshSessionId} belongs to ${stub.cwd}, not ${this.cwd}`
      );
    }
    if (this.options.forceTakeover) {
      this.options.log?.('[dsh-bridge] forceTakeover ignored: DSH write locks are kernel locks');
    }
    this.dshSessionId = stub.dshSessionId;
    await this.openDshSession(stub.dshSessionId, selection);
  }

  private async openDshSession(
    dshSessionId: string,
    selection: { provider: string; model: string }
  ): Promise<void> {
    try {
      this.handle = await this.ctx.agents.resume({
        resumeSessionId: dshSessionId,
        agentOptions: selection,
      });
    } catch (error) {
      throw mapOpenError(error, dshSessionId);
    }
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
    // decision 010: refuse what is not bridged yet instead of sending something
    // else — a retry used to go out as an empty new message, and images were
    // silently dropped.
    if (input.mode === 'retry') {
      throw new PiWorkerSessionError(
        WORKER_RETRY_UNAVAILABLE,
        'Retrying the last turn is not bridged to the DSH engine yet'
      );
    }
    if (input.attachments && input.attachments.length > 0) {
      unsupported('Sending attachments');
    }
    if (this.turn && !this.turn.synthetic) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        'Session already has an active turn',
        true
      );
    }
    await this.bootstrap();
    const agent = this.requireAgent();
    const message = this.deps.createUserMessage({
      content: [{ type: 'text', text: input.text }],
      source: { kind: 'user' },
    });
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
    return this.emptyHistory(boot.sessionFile ?? '', input.offset ?? 0, input.limit ?? 100);
  }

  /** A legal empty page for this session; P1-4 replaces it with the projected log. */
  private emptyHistory(sessionFile: string, offset: number, limit: number): WorkerHistoryResult {
    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile,
      workspacePath: this.cwd,
      page: { messages: [], offset, limit, totalCount: 0, hasMore: false },
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
    // Once per runtime: a bootstrap retried after a failure must not double every event.
    if (this.listening) return;
    this.listening = true;
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
