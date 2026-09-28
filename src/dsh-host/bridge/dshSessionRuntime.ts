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
 *   this session's PermissionGate  -> permission.requested / permission.resolved,
 *                                     answered by worker.permission.respond
 *
 * Permissions (P1-6b, decisions 041, 042): every tool call of the session and
 * its delegates is judged by one `PermissionGate` (the 1.0.x gate, from
 * src/shared/permissions) that this runtime builds at bootstrap and attaches
 * to the `aiclient-permissions` row before it opens the agent; a host without
 * that row refuses the bootstrap. The gate starts on the mode and gear Main
 * sent; its cards are 1.0.x's (`cardEmitter.ts`), keyed by the tool call id.
 * P1-6c (decision 092): the gate judges against 1.0.x's policy layers (the
 * bundled table, the user's under AICLIENT_PERMISSION_AGENT_DIR, the
 * project's when trusted), starts on the grants the sidecar beside the stub
 * kept (`grantStore.ts`, decision 043) and writes every change back there,
 * and Main's three setters act on it.
 *
 * Mapped: text, tool rows, approvals, stop, the session identity (create,
 * resume, crash restart), the history, tree and leaf, projected from the
 * DSH log (P1-4a, decision 026; `historyCache.ts`), and rewind and fork
 * (P1-4b, decision 027). Compact, retry and attachments refuse until the rest
 * of P1-4 fills them in (dsh-rebase decision 010).
 *
 * Model and effort (P1-5a, decisions 033, 035, 040): each turn resolves the
 * model and effort Main sent (or the session's current model) against the
 * host's model plan (`modelRoute.ts`) and hands the DSH selection to the
 * agent through `installModelSelection`, installed when the agent is opened;
 * a model the plan cannot serve refuses the send with `MODEL_NOT_CONFIGURED`.
 * A turn DSH ends in error carries our failure code (`dshFailureCodes.ts`).
 *
 * Identity (decisions 006 and 007): Main's durable `sessionFile` is a small
 * stub, `$DSH_HOME/aiclient-sessions/<dshSessionId>.dsh.json`, naming the DSH
 * session `aiclient-<logical id>`. A new session is flushed to disk BEFORE the
 * stub is written, so a committed identity always names a log that exists.
 *
 * Rewind and fork (decision 027): DSH has no rewind and no tree inside a
 * session, so both cut a seeded child session (`forkSeed.ts`). A rewind
 * repoints the stub at the child (`aiclient-<logical id>.r<n>`) and appends
 * it to the stub's lineage; the session it leaves is retired and stays in the
 * tree (`lineage.ts`). A fork writes a new stub for the child
 * (`aiclient-<id Main minted>`) and releases it for the slot Main opens next.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PiWorkerSessionError } from '../../agent-host/piWorkerErrors.ts';
import type {
  PiWorkerRuntime,
  PiWorkerRuntimeOptions,
} from '../../agent-host/piWorkerRpcServer.ts';
import { mapDshFailureCode } from '../../shared/dshFailureCodes.ts';
import { paginateHistory } from '../../shared/dshHistory/page.ts';
import { projectDshHistory } from '../../shared/dshHistory/projection.ts';
import { parseToolArguments, toolRowInput } from '../../shared/dshHistory/toolInput.ts';
import { dshLeafCheckpoint, dshTreeNodeId } from '../../shared/dshHistory/tree.ts';
import type { DshLogEvent } from '../../shared/dshHistory/types.ts';
import {
  createPermissionPrompt,
  type PermissionPrompt,
} from '../../shared/permissions/cardEmitter.ts';
import { PermissionGate } from '../../shared/permissions/gate.ts';
import type { PersistedGrants } from '../../shared/permissions/grants.ts';
import {
  loadPermissionPolicy,
  type PermissionPolicyFiles,
} from '../../shared/permissions/policy.ts';
import { resolveSettingSources } from '../../shared/settingSources.ts';
import type { PermissionDecisionId, RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import {
  migratePermissionTier,
  type PermissionGear,
  type RuntimePermissionSettings,
} from '../../shared/types/runtimePermission.ts';
import type { SessionTreeSnapshot } from '../../shared/types/sessionHistory.ts';
import type { SessionPermissionTier } from '../../shared/types/sessionPermissionTier.ts';
import {
  STAGED_FORK_MARKER_SUFFIX,
  WORKER_RETRY_UNAVAILABLE,
  WORKER_REWIND_JOBS_RUNNING,
  type WorkerAcceptForkPayload,
  type WorkerAcceptForkResult,
  type WorkerBootstrapResult,
  type WorkerCommandsResult,
  type WorkerCompactResult,
  type WorkerDiscardForkPayload,
  type WorkerDiscardForkResult,
  type WorkerForkPayload,
  type WorkerForkResult,
  type WorkerHistoryPayload,
  type WorkerHistoryResult,
  type WorkerInterjectResult,
  type WorkerReloadResult,
  type WorkerRewindPayload,
  type WorkerRewindResult,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerStopPayload,
  type WorkerStopResult,
  type WorkerTreeResult,
} from '../../shared/types/workerRpc.ts';
import type { AttachedGate, DshPermissionHost } from '../permissions/permissionHost.ts';
import { buildDshForkSeed, type DshCutPlan, planDshCut } from './forkSeed.ts';
import { copyGrantSidecar, readGrantSidecar, writeGrantSidecar } from './grantStore.ts';
import { DshHistoryCache, type DshSessionQuery } from './historyCache.ts';
import {
  DshRetiredHistory,
  readSessionEvents,
  retiredSessionIds,
  rewindSessionId,
} from './lineage.ts';
import {
  type DshBridgeModelPlan,
  DshModelRouter,
  type DshModelSelection,
  type DshRoutedModel,
} from './modelRoute.ts';
import { type ApplySandboxMode, dshSandboxModeFor } from './sandboxMode.ts';
import {
  DSH_SESSION_MISSING,
  grantsSidecarFor,
  readStub,
  SAFE_SESSION_ID,
  SESSION_INVALID,
  SESSION_STUB_VERSION,
  type SessionLineageEntry,
  type SessionStub,
  stubLineage,
  stubPathFor,
  writeStubAtomically,
} from './stub.ts';

// The stub moved to `stub.ts` (P1-4a, shared with the host's `readPage`); its
// names stay reachable from here, where the bridge's error codes are listed.
export {
  DSH_SESSION_MISSING,
  DSH_STUB_DIR,
  DSH_STUB_SUFFIX,
  SESSION_INVALID,
  type SessionLineageEntry,
  type SessionStub,
  stubPathFor,
} from './stub.ts';

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
  cancel(cause: { kind: 'user' | 'disposed' }, options?: { keepInbox?: boolean }): void;
  /**
   * Holds the idle agent for `task`: input that would wake it waits in the
   * inbox and is replayed when the task ends — unless the task cancelled it
   * with the `disposed` cause (measured, P1-4b E2). Throws synchronously when
   * the agent is not idle.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
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
  agents: {
    create(options: {
      sessionId: string;
      meta: { cwd: string; parentSession?: string; isSeeded?: boolean };
      /** A cut of another session (`buildDshForkSeed`), with the length it inherited. */
      seed?: readonly DshLogEvent[];
      inheritedEventCount?: number;
      agentOptions: { provider: string; model: string };
      /** Composes the unpublished agent's scope (here: its model selection). */
      setup?: DshAgentSetup;
    }): Promise<DshAgentHandle>;
    resume(options: {
      resumeSessionId: string;
      agentOptions: { provider: string; model: string };
      setup?: DshAgentSetup;
    }): Promise<DshAgentHandle>;
  };
  agentDefaultModel: { currentSelection(): { provider: string; model: string } };
  /** `ctx.sessions` (dsh-session): `flush` is the one official durability barrier. */
  sessions: { flush(session: DshSession): Promise<boolean> };
  /** `ctx.sessionQuery` (dsh-session-query): the lock-free exact read the history cache folds. */
  sessionQuery: DshSessionQuery;
  /** A service the row does not inject, when it is there (`ctx.jobs`, for `busy`). */
  get?(name: 'jobs'): DshJobsView | undefined;
  /**
   * `ctx.aiclientPermissions` (P1-6b, decision 042): the permission row every
   * session attaches its gate to. Injected by the bridge row; a runtime
   * without it refuses to bootstrap (`WORKER_PERMISSIONS_UNAVAILABLE`).
   */
  aiclientPermissions?: DshPermissionHost;
}

/** DSH's `AgentSetup`: runs on the agent's own scope before it is published. */
export type DshAgentSetup = (agentCtx: unknown) => void;

/** `ModelSelectionRef` of `@deepseek-ai/dsh-agent`: the selection the next step routes to. */
export interface DshModelSelectionRef {
  current: DshModelSelection | undefined;
  assembled: DshModelSelection | undefined;
}

/** The slice of `ctx.jobs` (dsh-jobs) `busy` reads. */
export interface DshJobsView {
  list(caller?: string): Array<{ readonly owner?: string; readonly status: string }>;
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
  /** The stub writer; tests inject failures here. */
  writeStub?: (file: string, stub: SessionStub) => void;
  /** How long a retired agent may take to dispose before the rewind moves on (3 s). */
  disposeTimeoutMs?: number;
  /**
   * Decision 033: the host's model plan (`aiclientModelPlan`), read per turn.
   * Without one no turn can be routed, and every send is refused.
   */
  modelPlan?: () => DshBridgeModelPlan | undefined;
  /**
   * `installModelSelection` from `@deepseek-ai/dsh-agent`: couples `selection`
   * to the agent's prompt assembly and requests. Without it the agent keeps
   * the model it was opened with.
   */
  installModelSelection?: (agentCtx: unknown, selection: DshModelSelectionRef) => () => void;
  /**
   * P1-6c: the app's pi-agent directory (1.0.x's `agentDir`), which holds the
   * user layer of the permission policy. Main hands it to the host as
   * AICLIENT_PERMISSION_AGENT_DIR; null or absent reads no user layer.
   */
  permissionAgentDir?: string | null;
  /**
   * P1-6e's writer of a session's DSH sandbox mode (`sandboxMode.ts`, decision
   * 044). Absent in the product: every session keeps the bundle's
   * danger-full-access and nothing is written.
   */
  applySandboxMode?: ApplySandboxMode;
}

// ---- helpers ----------------------------------------------------------------

/** A RuntimeEventDraft without its session id, which `emit` fills in. */
type BridgeDraft = RuntimeEventDraft extends infer E
  ? E extends unknown
    ? Omit<E, 'sessionId'>
    : never
  : never;

/**
 * Error codes this bridge answers with, besides the stub's own
 * (`dsh_session_missing`, `session_invalid`); Main and the renderer match on them.
 */
export const SESSION_LOCKED = 'session_locked';
export const SESSION_CWD_MISMATCH = 'session_cwd_mismatch';

/** The page size Main asks for when it reads a resumed session (`readHistory(entry, 0, 80)`). */
export const INITIAL_HISTORY_LIMIT = 80;

/** Every DSH session this bridge creates is named with it; nothing else is ever collected (decision 024). */
export const DSH_SESSION_ID_PREFIX = 'aiclient-';

/** No permission gate can be attached (the native runtime's code for a missing gate). */
export const WORKER_PERMISSIONS_UNAVAILABLE = 'WORKER_PERMISSIONS_UNAVAILABLE';

/** A tree node no session of the lineage has (the native runtime's code). */
export const SESSION_ENTRY_NOT_FOUND = 'session_entry_not_found';
/** A fork whose path holds no model answer (the native runtime's code). */
export const SESSION_FORK_UNMATERIALIZED = 'session_fork_unmaterialized';

/** Plan P1-4 shard 03 §4: a retired agent that will not dispose is left to the host's restart. */
const DISPOSE_TIMEOUT_MS = 3_000;
/** A failed rewind may leave its child under the next id; skip that many at most. */
const REWIND_ID_ATTEMPTS = 20;

/** Ours, not DSH's in-process counter, so a lost stub can be found again (decision 006). */
export function dshSessionIdFor(logicalSessionId: string): string {
  return `${DSH_SESSION_ID_PREFIX}${logicalSessionId}`;
}

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
export function hasNamedError(error: unknown, name: string, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 4) return false;
  const record = error as { name?: unknown; cause?: unknown; errors?: unknown };
  if (record.name === name) return true;
  if (hasNamedError(record.cause, name, depth + 1)) return true;
  return Array.isArray(record.errors)
    ? record.errors.some((inner) => hasNamedError(inner, name, depth + 1))
    : false;
}

/** decision 010: DSH's refusals in our vocabulary. The kernel lock has no forced takeover. */
export function mapOpenError(error: unknown, dshSessionId: string): unknown {
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

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Removes `file`; a file that is already gone is not a failure. */
function removeQuietly(file: string, log?: (...args: unknown[]) => void): void {
  try {
    rmSync(file, { force: true });
  } catch (error) {
    log?.('[dsh-bridge] could not remove', file, error);
  }
}

/**
 * How the policy loader reads a layer (1.0.x's HostIo contract): a missing
 * file rejects `ENOENT` and is skipped; one past `maxBytes` fails the load as
 * 1.0.x's `io_limit` did, and so does any other read error.
 */
const POLICY_FILES: PermissionPolicyFiles = {
  async readFile(path, { maxBytes }) {
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      if (size > maxBytes) {
        throw Object.assign(new Error(`read exceeds ${maxBytes} bytes: ${path}`), {
          code: 'io_limit',
        });
      }
      return { bytes: new Uint8Array(await handle.readFile()) };
    } finally {
      await handle.close();
    }
  },
};

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
    .map((block) => block.text)
    .join('');
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
  /** Our `provider/modelId` of the current selection; `message.started` reports it. */
  private route = '';
  /** The model the session is on; a turn that names none keeps it. */
  private modelId: string | undefined;
  private readonly router: DshModelRouter;
  /** Read by the agent's prompt assembly and requests (`installModelSelection`). */
  private readonly selection: DshModelSelectionRef = { current: undefined, assembled: undefined };
  private turn: Turn | null = null;
  private readonly steps = new Map<string, StepMessage>();
  private readonly toolStep = new Map<string, string>();
  private readonly toolArgs = new Map<string, Record<string, unknown>>();
  private readonly startedTools = new Set<string>();
  private readonly disposers: Dispose[] = [];
  /** The session's approval cards (1.0.x's emitter): `permission.requested` / `resolved`. */
  private readonly prompt: PermissionPrompt;
  /** The session's gate (P1-6b), built at bootstrap; null before and after. */
  private gate: PermissionGate | null = null;
  /** Its routing in the permission row; re-pointed by a rewind. */
  private attachment: AttachedGate | null = null;
  /** This runtime's key in the permission row: unique, so a second open never re-points a live one. */
  private readonly gateChannel: string;
  /**
   * The grant sidecar beside the stub (decision 043), fixed at bootstrap: a
   * rewind repoints the stub, never renames it, so the grants stay put.
   */
  private grantsFile = '';
  private readonly historyCache: DshHistoryCache;
  /** The sessions earlier rewinds retired, for the tree (P1-4b). */
  private readonly retired: DshRetiredHistory;
  private readonly query: DshSessionQuery;
  private readonly writeStub: (file: string, stub: SessionStub) => void;
  private readonly disposeTimeoutMs: number;
  /** Main's `sessionFile`: the stub path never changes, what it names does. */
  private stubFile = '';
  /** Every DSH session of this chat, oldest first, the current one last. */
  private lineage: SessionLineageEntry[] = [];
  /** Fork stubs written here that Main has not adopted yet -> their DSH session. */
  private readonly stagedForks = new Map<string, string>();
  private disposed = false;

  constructor(ctx: DshBridgeContext, options: PiWorkerRuntimeOptions, deps: DshBridgeDeps) {
    this.ctx = ctx;
    this.options = options;
    this.deps = deps;
    this.logicalSessionId = options.logicalSessionId;
    this.cwd = options.cwd;
    this.home = deps.home ?? process.env.DSH_HOME ?? '';
    this.now = deps.now ?? Date.now;
    this.writeStub = deps.writeStub ?? writeStubAtomically;
    this.disposeTimeoutMs = deps.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS;
    // Looked up per read: the service belongs to the Cordis context, not to this runtime.
    this.query = {
      observeSession: (sessionId, query) => this.ctx.sessionQuery.observeSession(sessionId, query),
    };
    this.historyCache = new DshHistoryCache(this.query, options.log);
    this.retired = new DshRetiredHistory(this.query, options.log);
    this.router = new DshModelRouter(() => deps.modelPlan?.(), options.log);
    this.modelId = options.model;
    this.gateChannel = `${options.logicalSessionId}:${randomUUID()}`;
    this.prompt = createPermissionPrompt({
      sessionId: this.logicalSessionId,
      cwd: this.cwd,
      // Through `emit`, so a card raised inside a turn carries its requestId.
      emit: (event) => {
        const { sessionId: _sessionId, ...draft } = event;
        this.emit(draft as BridgeDraft);
      },
    });
  }

  /**
   * The agent is not idle: a turn this bridge started, one it did not (a goal
   * round, a job notice), other agent work, or a background job of this
   * session still running after its turn ended. Reported to Main in each pong;
   * Main never reclaims a busy session (decision 025).
   */
  get busy(): boolean {
    if (this.disposed) return false;
    if (this.turn !== null || (this.handle !== null && this.handle.agent.status !== 'idle')) {
      return true;
    }
    return this.hasLiveJobs();
  }

  /** Jobs this session owns that have not settled; the agent reads idle meanwhile. */
  private hasLiveJobs(): boolean {
    if (!this.dshSessionId || !this.ctx.get) return false;
    try {
      return (
        this.ctx
          .get('jobs')
          ?.list(this.dshSessionId)
          .some(
            (job) =>
              job.owner === this.dshSessionId &&
              (job.status === 'running' || job.status === 'stopping')
          ) === true
      );
    } catch {
      return false;
    }
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
    if (!this.ctx.aiclientPermissions) {
      throw new PiWorkerSessionError(
        WORKER_PERMISSIONS_UNAVAILABLE,
        'The aiclient-permissions row is not composed in this host; no tool call could be judged'
      );
    }
    const selection = this.openingSelection();
    this.listen();
    const requested = this.options.sessionFile;
    this.grantsFile ||= this.grantsSidecarPath(requested);
    this.gate ??= await this.buildGate();
    let stubFile: string;
    let permissionGate: WorkerBootstrapResult['permissionGate'];
    try {
      stubFile = requested ?? (await this.createSession(selection));
      if (requested) await this.resumeSession(requested, selection);
      permissionGate = this.reportedGate();
    } catch (error) {
      // Nothing half-open survives a failed bootstrap: the session's write lock
      // goes with the handle, and its calls stop resolving to this gate.
      const handle = this.handle;
      this.handle = null;
      await handle?.dispose().catch(() => undefined);
      this.attachment?.detach();
      this.attachment = null;
      throw error;
    }
    this.stubFile = stubFile;
    // Folded once from the open session, then kept current from session/event.
    // A failed read leaves an empty, legal page and is retried by the next one.
    this.historyCache.reset(this.dshSessionId);
    await this.historyCache.load();
    this.result = {
      bootstrapped: true,
      logicalSessionId: this.logicalSessionId,
      piSessionId: this.dshSessionId,
      cwd: this.cwd,
      agentDir: this.home,
      sessionFile: stubFile,
      leaf: this.historyCache.leaf(),
      // Main requires the first page of a reopened session (resume, crash restart).
      ...(requested
        ? { initialHistory: this.historyResult(stubFile, 0, INITIAL_HISTORY_LIMIT) }
        : {}),
      ...(this.options.model ? { model: this.options.model } : {}),
      projectTrusted: this.options.projectTrusted,
      permissionGate,
      capabilities: {},
    };
    this.syncSandboxMode();
    return this.result;
  }

  /**
   * Where this session's grants live (decision 043): beside the stub it
   * resumes, or beside the stub a create writes. Empty when the logical id
   * cannot name a session: the create refuses it before anything is read.
   */
  private grantsSidecarPath(requested: string | undefined): string {
    if (requested) return grantsSidecarFor(requested);
    const id = dshSessionIdFor(this.logicalSessionId);
    return SAFE_SESSION_ID.test(id) ? grantsSidecarFor(stubPathFor(this.home, id)) : '';
  }

  /**
   * The session's gate (design shard 03 §8), built as 1.0.x's bootstrap built
   * its permissions plugin:
   *   - the mode and gear Main sent, a legacy tier migrated (P1-6b);
   *   - the policy: the bundled table, then the user layer under the app's
   *     pi-agent directory, then the project's two when the workspace is
   *     trusted (decision 008, `resolveSettingSources`); a layer that is not
   *     valid policy fails the bootstrap, as it failed 1.0.x's;
   *   - the grants the sidecar kept, and every change to them written back.
   * It judges against the canonical workspace, the spelling every path it
   * sees has been resolved to.
   */
  private async buildGate(): Promise<PermissionGate> {
    let cwd: string;
    try {
      cwd = realpathSync(this.cwd);
    } catch {
      cwd = resolve(this.cwd);
    }
    const policy = await loadPermissionPolicy(POLICY_FILES, {
      cwd,
      agentDir: this.deps.permissionAgentDir ?? null,
      sources: resolveSettingSources({ projectTrusted: this.options.projectTrusted }),
    });
    return new PermissionGate(
      {
        cwd,
        ...(this.options.permissions?.mode ? { mode: this.options.permissions.mode } : {}),
        ...(this.options.permissions?.gear ? { gear: this.options.permissions.gear } : {}),
        ...(this.options.tier ? { tier: this.options.tier } : {}),
        projectTrusted: this.options.projectTrusted,
        policy,
        grants: this.grantsFile ? readGrantSidecar(this.grantsFile, this.options.log) : [],
        approve: this.prompt.approve,
        autoAllow: this.prompt.autoAllow,
      },
      { persistGrants: (record) => this.persistGrants(record) }
    );
  }

  /** The gate's `persistGrants`: the whole set, beside the stub, after every change. */
  private persistGrants(record: PersistedGrants): void {
    if (this.grantsFile) writeGrantSidecar(this.grantsFile, record, this.options.log);
  }

  /**
   * `permissionGate` as the session really has it: this runtime's own gate,
   * attached to the permission row. Asked, not assumed — a bootstrap that
   * reached this point without one is refused rather than reported gated.
   */
  private reportedGate(): WorkerBootstrapResult['permissionGate'] {
    if (!this.gateInstalled()) {
      throw new PiWorkerSessionError(
        WORKER_PERMISSIONS_UNAVAILABLE,
        'The session opened without its permission gate attached'
      );
    }
    return 'bundled';
  }

  /** The gate exists and the permission row routes this runtime's channel to it. */
  private gateInstalled(): boolean {
    return (
      !this.disposed &&
      this.gate !== null &&
      this.attachment !== null &&
      this.ctx.aiclientPermissions?.isAttached(this.gateChannel) === true
    );
  }

  /**
   * Route `dshSessionId`'s calls (and its delegates') to this session's gate,
   * before its agent is opened, so no call of it ever finds no gate. Called
   * again by a rewind, which re-points the same key at the seeded child.
   */
  private attachGate(dshSessionId: string): void {
    const host = this.ctx.aiclientPermissions;
    const gate = this.gate;
    if (!host || !gate) {
      throw new PiWorkerSessionError(
        WORKER_PERMISSIONS_UNAVAILABLE,
        'No permission gate to attach'
      );
    }
    try {
      this.attachment = host.attachGate(this.gateChannel, {
        dshSessionId,
        gate,
        cwd: this.cwd,
      });
    } catch (error) {
      // Another channel of this host has the session open: its lock, in our words.
      throw new PiWorkerSessionError(
        SESSION_LOCKED,
        `DSH session ${dshSessionId} is open in another channel of this host: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true
      );
    }
  }

  /**
   * The model an agent is opened on: the session's model when the plan serves
   * it, else the plan's default. Never a refusal: a chat whose model left the
   * plan still opens, to be read; its next send is refused instead.
   */
  private openingSelection(): { provider: string; model: string } {
    const routed = this.router.trySession(this.modelId, this.options.effort);
    if (routed) {
      this.applyRoute(routed);
      return { provider: routed.selection.provider, model: routed.selection.model };
    }
    const fallback =
      this.router.defaultSelection() ?? this.ctx.agentDefaultModel.currentSelection();
    this.route = this.modelId ?? `${fallback.provider}/${fallback.model}`;
    return { provider: fallback.provider, model: fallback.model };
  }

  /** The selection the next step routes to, and the id `message.started` reports. */
  private applyRoute(routed: DshRoutedModel): void {
    this.selection.current = { ...routed.selection };
    this.modelId = routed.modelId;
    this.route = routed.modelId;
  }

  /** `setup` for every agent this runtime opens: the model selection, per turn. */
  private readonly setupAgent: DshAgentSetup = (agentCtx) => {
    this.deps.installModelSelection?.(agentCtx, this.selection);
  };

  /** The agent options of the current selection, for an agent opened later (rewind, fork). */
  private currentAgentOptions(): { provider: string; model: string } {
    const current =
      this.selection.current ??
      this.router.defaultSelection() ??
      this.ctx.agentDefaultModel.currentSelection();
    return { provider: current.provider, model: current.model };
  }

  /**
   * decision 007: create, flush the header to disk, then write the stub. Main
   * commits the identity as soon as the stub exists, so the log must already
   * be there — or a host that dies before the first turn leaves an identity
   * that can never be opened.
   */
  private async createSession(selection: { provider: string; model: string }): Promise<string> {
    this.dshSessionId = dshSessionIdFor(this.logicalSessionId);
    if (!SAFE_SESSION_ID.test(this.dshSessionId)) {
      throw new PiWorkerSessionError(
        'WORKER_INVALID_PAYLOAD',
        `Logical session id cannot name a DSH session: ${this.logicalSessionId}`
      );
    }
    const stubFile = stubPathFor(this.home, this.dshSessionId);
    this.attachGate(this.dshSessionId);
    try {
      this.handle = await this.ctx.agents.create({
        sessionId: this.dshSessionId,
        meta: { cwd: this.cwd },
        agentOptions: selection,
        setup: this.setupAgent,
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
      if (cwd !== undefined && !samePath(cwd, this.cwd)) {
        throw new PiWorkerSessionError(
          SESSION_CWD_MISMATCH,
          `DSH session ${this.dshSessionId} belongs to ${cwd}, not ${this.cwd}`
        );
      }
    }
    const createdAt = this.now();
    this.lineage = [{ dshSessionId: this.dshSessionId, reason: 'create', at: createdAt }];
    this.writeStub(stubFile, {
      engine: 'dsh',
      version: SESSION_STUB_VERSION,
      dshSessionId: this.dshSessionId,
      logicalSessionId: this.logicalSessionId,
      cwd: this.cwd,
      createdAt,
      lineage: this.lineage,
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
    if (!samePath(stub.cwd, this.cwd)) {
      throw new PiWorkerSessionError(
        SESSION_CWD_MISMATCH,
        `DSH session ${stub.dshSessionId} belongs to ${stub.cwd}, not ${this.cwd}`
      );
    }
    if (this.options.forceTakeover) {
      this.options.log?.('[dsh-bridge] forceTakeover ignored: DSH write locks are kernel locks');
    }
    this.dshSessionId = stub.dshSessionId;
    this.lineage = stubLineage(stub);
    this.attachGate(stub.dshSessionId);
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
        setup: this.setupAgent,
      });
    } catch (error) {
      throw mapOpenError(error, dshSessionId);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    // Before the flag, as the native runtime does: the card on screen is
    // answered (denied, `session_closed`) and taken down, and the call it held
    // is refused rather than left parked.
    this.prompt.drain('session_closed');
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    try {
      await this.handle?.dispose();
    } finally {
      this.handle = null;
      this.attachment?.detach();
      this.attachment = null;
      this.gate?.dispose();
      this.gate = null;
    }
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
    // Decisions 033, 040: this turn's model and effort, or a refusal before anything is sent.
    this.applyRoute(
      this.router.session(input.model ?? this.modelId, input.effort ?? this.options.effort)
    );
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

  /** A card's answer, keyed by the tool call id; false when nothing waits on it. */
  respondPermission(input: { permissionId: string; decision: PermissionDecisionId }): boolean {
    return this.prompt.respond(input);
  }

  respondQuestion(): boolean {
    return false;
  }

  respondPreview(): boolean {
    return false;
  }

  // ---- the posture (P1-6c) ------------------------------------------------------

  /**
   * `worker.setPermissions`, a posture change. With the agent idle it is
   * 1.0.x's `configure`: mode and gear from scratch, every session grant
   * forgotten and the empty set written to the sidecar, every request still
   * parked at the gate voided. While the agent runs — a turn this bridge
   * started, or one DSH started itself (a goal round, a job notice), which
   * Main cannot see and so asks for the broad change — only the gear moves,
   * as `setPermissionGear` moves it, and a new mode is refused as busy: the
   * rule Main applies to the turns it knows of.
   */
  setPermissions(permissions: RuntimePermissionSettings): void {
    const gate = this.requireGate();
    if (this.idle()) {
      gate.configure(permissions);
    } else if (permissions.mode === gate.mode) {
      gate.setGear(permissions.gear);
    } else {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        'The mode cannot change while the agent runs; the permission level can',
        true
      );
    }
    this.syncSandboxMode();
  }

  /**
   * The gear alone, turn or no turn: grants and parked requests stay, and a
   * widened gear answers the card on screen when it would not have asked.
   */
  setPermissionGear(gear: PermissionGear): void {
    this.requireGate().setGear(gear);
    this.syncSandboxMode();
  }

  /** A legacy tier: migrated (D14), never carried through, then set as a posture. */
  setPermissionTier(tier: SessionPermissionTier): void {
    this.setPermissions(migratePermissionTier(tier));
  }

  /** This session's attached gate, or the native runtime's code for a missing one. */
  private requireGate(): PermissionGate {
    const gate = this.gate;
    if (!gate || !this.gateInstalled()) {
      throw new PiWorkerSessionError(
        WORKER_PERMISSIONS_UNAVAILABLE,
        'This session has no permission gate attached'
      );
    }
    return gate;
  }

  /**
   * P1-6e's hook (decision 044): hands the posture's DSH sandbox mode to the
   * writer, when there is one. The product has none, so every session stays
   * on the bundle's danger-full-access and nothing is written. A failed write
   * is logged; whether it should fail the change is P1-6e's to decide.
   */
  private syncSandboxMode(): void {
    const apply = this.deps.applySandboxMode;
    const gate = this.gate;
    if (!apply || !gate || !this.dshSessionId) return;
    try {
      apply(this.dshSessionId, dshSandboxModeFor({ mode: gate.mode, gear: gate.gear }));
    } catch (error) {
      this.options.log?.('[dsh-bridge] sandbox mode not applied', error);
    }
  }

  // ---- reads (the projected log, historyCache.ts) ---------------------------------

  async history(input: WorkerHistoryPayload): Promise<WorkerHistoryResult> {
    const boot = await this.bootstrap();
    await this.historyCache.ready();
    return this.historyResult(boot.sessionFile ?? '', input.offset, input.limit);
  }

  /** One page counted back from the newest message, as the pi projection pages. */
  private historyResult(sessionFile: string, offset?: number, limit?: number): WorkerHistoryResult {
    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile,
      workspacePath: this.cwd,
      page: this.historyCache.page(offset, limit),
    };
  }

  async tree(): Promise<WorkerTreeResult> {
    const boot = await this.bootstrap();
    await this.historyCache.ready();
    return { snapshot: await this.treeSnapshot(boot.sessionFile ?? '') };
  }

  /** This session's timeline merged with every session the lineage retired (decision 026). */
  private async treeSnapshot(sessionFile: string): Promise<SessionTreeSnapshot> {
    const retired = await this.retired.chains(retiredSessionIds(this.lineage, this.dshSessionId));
    return this.historyCache.tree(
      { logicalSessionId: this.logicalSessionId, sessionFile, workspacePath: this.cwd },
      retired.map((chain) => chain.messages)
    );
  }

  async commands(): Promise<WorkerCommandsResult> {
    return { commands: [], truncated: false };
  }

  async compact(): Promise<WorkerCompactResult> {
    return unsupported('compact');
  }
  async reload(): Promise<WorkerReloadResult> {
    return unsupported('reload');
  }

  // ---- rewind and fork (P1-4b, decision 027) ------------------------------------

  /**
   * The chat continues in a child cut from the target's session at the
   * target, and the stub is repointed at it. The order, and what a crash
   * between two steps leaves (plan P1-4 shard 03 §4):
   *
   *   1. the old agent is held idle (`runMaintenance`)
   *   2. the child is created from the seed and flushed    crash: the stub still
   *                                                          names the old session,
   *                                                          the child is an orphan
   *   3. the stub is rewritten, the lineage appended        atomic: old or new
   *   4. the old agent is cancelled as disposed, so a wake  crash: a restart resumes
   *      it held back cannot run on it; then disposed, and  the child; the old
   *      events are followed on the child                   lock died with the host
   *   5. history, tree and leaf of the child
   *
   * Refused while a turn runs, and while a background job of the session
   * runs: disposing its agent would end the job (decision 027 rule 3).
   */
  async rewind(input: WorkerRewindPayload): Promise<WorkerRewindResult> {
    this.assertLogicalSession(input.logicalSessionId);
    await this.bootstrap();
    this.assertIdle('rewind the session');
    if (this.hasLiveJobs()) {
      throw new PiWorkerSessionError(
        WORKER_REWIND_JOBS_RUNNING,
        'A background job of this session is still running; rewinding now would end it',
        true
      );
    }
    await this.historyCache.ready();
    const cut = await this.cutFor(input.targetEntryId, 'rewind');
    const previous = this.requireHandle();
    const previousId = this.dshSessionId;
    const stub = readStub(this.stubFile);
    if (stub.dshSessionId !== previousId) {
      throw new PiWorkerSessionError(
        SESSION_INVALID,
        `DSH session identity ${this.stubFile} names ${stub.dshSessionId}, not ${previousId}`
      );
    }
    const lineage = stubLineage(stub);
    const base = dshSessionIdFor(this.logicalSessionId);

    const switched = await this.holdIdle(previous.agent, async () => {
      const created = await this.createChild(
        (attempt) => rewindSessionId(base, lineage, attempt),
        REWIND_ID_ATTEMPTS,
        cut
      );
      const entry: SessionLineageEntry = {
        dshSessionId: created.id,
        reason: 'rewind',
        parentDshSessionId: cut.sourceId,
        ...(cut.plan.boundary !== null ? { cutSeq: cut.plan.boundary } : {}),
        at: this.now(),
      };
      try {
        await this.ctx.sessions.flush(created.handle.agent.session);
        this.writeStub(this.stubFile, {
          ...stub,
          version: SESSION_STUB_VERSION,
          dshSessionId: created.id,
          lineage: [...lineage, entry],
        });
      } catch (error) {
        await created.handle.dispose().catch(() => undefined);
        throw error;
      }
      // The stub names the child now: a wake this task held back must not
      // open a turn on the old agent when the task ends (P1-4b E2).
      previous.agent.cancel({ kind: 'disposed' }, { keepInbox: true });
      return { ...created, lineage: [...lineage, entry] };
    });

    // Past the pointer switch: nothing below may leave this runtime on the old session.
    // Its fold is the retired timeline, unless it missed an event: then it is read cold later.
    if (this.historyCache.isCurrent()) {
      this.retired.remember(previousId, this.historyCache.messages());
    }
    this.handle = switched.handle;
    this.dshSessionId = switched.id;
    this.lineage = switched.lineage;
    // The same gate, now routed from the child; the retired id keeps resolving
    // to it. Past the switch nothing may throw: a failure leaves the child's
    // calls refused (fail closed), and says so. The grants stay with the gate,
    // and on disk beside the stub the rewind kept (decision 043).
    try {
      this.attachGate(switched.id);
    } catch (error) {
      this.options.log?.('[dsh-bridge] rewind could not re-point the permission gate', error);
    }
    this.syncSandboxMode();
    this.resetLiveState();
    this.historyCache.reset(switched.id);
    await this.historyCache.load();
    const leaf = this.historyCache.leaf();
    const history = this.historyResult(this.stubFile, 0, INITIAL_HISTORY_LIMIT);
    if (this.result) {
      this.result = {
        ...this.result,
        piSessionId: switched.id,
        leaf,
        ...(this.result.initialHistory ? { initialHistory: history } : {}),
      };
    }
    await this.disposeWithin(previous, previousId);
    return {
      logicalSessionId: this.logicalSessionId,
      sessionFile: this.stubFile,
      workspacePath: this.cwd,
      targetEntryId: input.targetEntryId,
      ...(cut.plan.editorText !== undefined ? { editorText: cut.plan.editorText } : {}),
      leaf,
      history,
      tree: { snapshot: await this.treeSnapshot(this.stubFile) },
    };
  }

  /**
   * A child session for the logical id Main minted (`targetLogicalSessionId`),
   * cut at the target, with a stub of its own. It is released before this
   * returns: the slot Main opens for the fork resumes it. Until Main adopts
   * it (`acceptFork`) the stub carries a `.staged` marker, which Main's
   * startup sweep reads (session-index-09). The session's grants go with it:
   * the sidecar as it stands, copied beside the child's stub (decision 043).
   */
  async fork(input: WorkerForkPayload): Promise<WorkerForkResult> {
    this.assertLogicalSession(input.logicalSessionId);
    await this.bootstrap();
    this.assertIdle('fork the session');
    const target = input.targetLogicalSessionId;
    const childId = target ? dshSessionIdFor(target) : '';
    if (!target || !SAFE_SESSION_ID.test(childId)) {
      throw new PiWorkerSessionError(
        'WORKER_INVALID_PAYLOAD',
        'A DSH fork needs a usable logical id minted by Main (targetLogicalSessionId)'
      );
    }
    await this.historyCache.ready();
    const cut = await this.cutFor(input.entryId, 'fork');
    const boundary = cut.plan.boundary;
    if (
      boundary === null ||
      !projectDshHistory(cut.events.slice(0, boundary + 1)).some(
        (message) => message.role === 'assistant'
      )
    ) {
      throw new PiWorkerSessionError(
        SESSION_FORK_UNMATERIALIZED,
        'fork requires an assistant on the selected path'
      );
    }
    const childStub = stubPathFor(this.home, childId);
    const marker = `${childStub}${STAGED_FORK_MARKER_SUFFIX}`;
    mkdirSync(dirname(childStub), { recursive: true, mode: 0o700 });
    // The intent first: whatever a crash leaves, the marker names it.
    writeFileSync(
      marker,
      `${JSON.stringify({
        kind: 'staged-fork',
        sessionFile: childStub,
        parentSessionId: cut.sourceId,
        createdAt: new Date(this.now()).toISOString(),
      })}\n`,
      { mode: 0o600 }
    );
    let created: { handle: DshAgentHandle; id: string } | null = null;
    let result: WorkerForkResult;
    try {
      created = await this.createChild(() => childId, 1, cut);
      await this.ctx.sessions.flush(created.handle.agent.session);
      const events = await readSessionEvents(this.query, childId);
      const messages = projectDshHistory(events);
      const at = this.now();
      this.writeStub(childStub, {
        engine: 'dsh',
        version: SESSION_STUB_VERSION,
        dshSessionId: childId,
        logicalSessionId: target,
        cwd: this.cwd,
        createdAt: at,
        lineage: [
          {
            dshSessionId: childId,
            reason: 'fork',
            parentDshSessionId: cut.sourceId,
            cutSeq: boundary,
            at,
          },
        ],
      });
      // Best effort: a fork that could not take its grants starts with none (fail closed).
      copyGrantSidecar(
        grantsSidecarFor(this.stubFile),
        grantsSidecarFor(childStub),
        this.options.log
      );
      result = {
        logicalSessionId: this.logicalSessionId,
        sourceSessionFile: this.stubFile,
        sessionFile: childStub,
        piSessionId: childId,
        workspacePath: this.cwd,
        leaf: dshLeafCheckpoint(messages, childId, events.at(-1)?.seq ?? -1),
        history: {
          logicalSessionId: this.logicalSessionId,
          sessionFile: childStub,
          workspacePath: this.cwd,
          page: paginateHistory(messages, 0, INITIAL_HISTORY_LIMIT),
        },
      };
    } catch (error) {
      // The child's log, if it reached the disk, is left to the orphan collection (decision 024).
      this.removeForkFiles(childStub);
      throw error;
    } finally {
      // The write lock goes to the slot Main opens next (measured: a resume right after works).
      await created?.handle.dispose().catch((error: unknown) => {
        this.options.log?.('[dsh-bridge] fork child dispose failed', childId, error);
      });
    }
    this.stagedForks.set(childStub, childId);
    return result;
  }

  /** Main committed the fork's index row: the stub is a session now, not ours to delete. */
  async acceptFork(input: WorkerAcceptForkPayload): Promise<WorkerAcceptForkResult> {
    this.assertLogicalSession(input.logicalSessionId);
    const staged = this.stagedFork(input.sessionFile);
    if (!staged) return { accepted: false };
    this.stagedForks.delete(staged);
    removeQuietly(`${staged}${STAGED_FORK_MARKER_SUFFIX}`, this.options.log);
    return { accepted: true };
  }

  /**
   * Main did not adopt the fork: its stub, grants and marker go; its log is
   * left to the orphan collection (DSH has no delete). The slot Main opened
   * on the fork may be the one asking, for the stub it holds: it ends here.
   */
  async discardFork(input: WorkerDiscardForkPayload): Promise<WorkerDiscardForkResult> {
    this.assertLogicalSession(input.logicalSessionId);
    const staged = this.stagedFork(input.sessionFile);
    if (staged) {
      this.stagedForks.delete(staged);
      this.removeForkFiles(staged);
      return { discarded: true };
    }
    // Only a stub a fork wrote: never the identity of a chat of its own.
    if (
      !this.stubFile ||
      !samePath(this.stubFile, input.sessionFile) ||
      this.lineage[0]?.reason !== 'fork'
    ) {
      return { discarded: false };
    }
    try {
      await this.dispose();
    } finally {
      this.removeForkFiles(this.stubFile);
    }
    return { discarded: true };
  }

  private stagedFork(sessionFile: string): string | undefined {
    for (const file of this.stagedForks.keys()) if (samePath(file, sessionFile)) return file;
    return undefined;
  }

  /** The grants first and the marker last: whatever a crash leaves, the marker still names it. */
  private removeForkFiles(stubFile: string): void {
    for (const file of [
      grantsSidecarFor(stubFile),
      stubFile,
      `${stubFile}${STAGED_FORK_MARKER_SUFFIX}`,
    ]) {
      removeQuietly(file, this.options.log);
    }
  }

  /**
   * Where a rewind or a fork cuts: the newest session of the lineage whose
   * timeline has the node (the current one first), its events, and the cut.
   */
  private async cutFor(
    entryId: string,
    operation: 'rewind' | 'fork'
  ): Promise<{ sourceId: string; events: DshLogEvent[]; plan: DshCutPlan }> {
    let sourceId: string | undefined;
    if (this.historyCache.messages().some((message) => dshTreeNodeId(message) === entryId)) {
      sourceId = this.dshSessionId;
    } else {
      const chains = await this.retired.chains(retiredSessionIds(this.lineage, this.dshSessionId));
      sourceId = [...chains]
        .reverse()
        .find((chain) =>
          chain.messages.some((message) => dshTreeNodeId(message) === entryId)
        )?.dshSessionId;
    }
    const events = sourceId ? await readSessionEvents(this.query, sourceId) : [];
    const plan = sourceId ? planDshCut(events, entryId, operation) : undefined;
    if (!sourceId || !plan) {
      throw new PiWorkerSessionError(SESSION_ENTRY_NOT_FOUND, `entry not found: ${entryId}`);
    }
    return { sourceId, events, plan };
  }

  /** The child session a cut starts; `idOf(attempt)` names it, the next one when DSH already has one. */
  private async createChild(
    idOf: (attempt: number) => string,
    attempts: number,
    cut: { sourceId: string; events: readonly DshLogEvent[]; plan: DshCutPlan }
  ): Promise<{ handle: DshAgentHandle; id: string }> {
    const boundary = cut.plan.boundary;
    // Nothing before the first turn: an empty child, still naming where it came from.
    const seed = boundary !== null ? buildDshForkSeed(cut.events, boundary) : undefined;
    const selection = this.currentAgentOptions();
    for (let attempt = 0; ; attempt += 1) {
      const id = idOf(attempt);
      if (!SAFE_SESSION_ID.test(id)) {
        throw new PiWorkerSessionError('WORKER_INVALID_PAYLOAD', `Cannot name a DSH session ${id}`);
      }
      try {
        const handle = await this.ctx.agents.create({
          sessionId: id,
          meta: { cwd: this.cwd, parentSession: cut.sourceId, ...(seed ? { isSeeded: true } : {}) },
          ...(seed && boundary !== null ? { seed, inheritedEventCount: boundary + 1 } : {}),
          agentOptions: selection,
          setup: this.setupAgent,
        });
        return { handle, id };
      } catch (error) {
        if (attempt + 1 < attempts && hasNamedError(error, 'SessionAlreadyExistsError')) continue;
        throw error;
      }
    }
  }

  /** `runMaintenance`, answering an agent that turns out not to be idle as busy. */
  private holdIdle<T>(agent: DshAgent, task: () => Promise<T>): Promise<T> {
    try {
      return agent.runMaintenance(() => task());
    } catch (error) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        `The DSH agent is not idle: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
  }

  /** A retired agent's dispose, given `disposeTimeoutMs`; past it the host's next restart reclaims it. */
  private async disposeWithin(handle: DshAgentHandle, dshSessionId: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      handle.dispose().then(
        () => true,
        (error: unknown) => {
          this.options.log?.('[dsh-bridge] retired agent dispose failed', dshSessionId, error);
          return true;
        }
      ),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), this.disposeTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!settled) {
      this.options.log?.('[dsh-bridge] retired agent did not dispose in time', dshSessionId);
    }
  }

  /** Per-turn translation state; empty between turns, dropped when the session changes. */
  private resetLiveState(): void {
    this.turn = null;
    this.steps.clear();
    this.toolStep.clear();
    this.toolArgs.clear();
    this.startedTools.clear();
    this.currentStream = null;
  }

  private assertLogicalSession(id: string): void {
    if (id === this.logicalSessionId) return;
    throw new PiWorkerSessionError(
      'WORKER_SESSION_MISMATCH',
      `This worker owns ${this.logicalSessionId}, not ${id}`
    );
  }

  /**
   * No turn of any origin, and an idle agent: DSH marks its agent running
   * before a goal round or a job notice logs its `turn/start`.
   */
  private idle(): boolean {
    return this.turn === null && (this.handle === null || this.handle.agent.status === 'idle');
  }

  private assertIdle(action: string): void {
    if (this.idle()) return;
    throw new PiWorkerSessionError(
      'WORKER_SESSION_BUSY',
      `Cannot ${action} while a turn is active`,
      true
    );
  }

  private requireHandle(): DshAgentHandle {
    if (!this.handle) throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'No DSH agent');
    return this.handle;
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
          this.historyCache.push(event);
        } catch (error) {
          this.options.log?.('[dsh-bridge] history fold failed', event.type, error);
        }
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
      })
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
        const args = parseToolArguments(data.arguments) as Record<string, unknown>;
        this.toolArgs.set(callId, args);
        const messageId = this.stepMessage(Number(data.turn), Number(data.step)).messageId;
        this.toolStep.set(callId, messageId);
        if (!this.startedTools.has(callId)) {
          this.startedTools.add(callId);
          this.emit({
            type: 'tool.started',
            payload: { messageId, toolCallId: callId, name, input: toolRowInput(args) },
          });
        } else {
          this.emit({
            type: 'tool.updated',
            payload: { messageId, toolCallId: callId, input: toolRowInput(args) },
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
          // Design shard 03 §5: DSH's failure code in our vocabulary, beside its sentence.
          const errorCode = mapDshFailureCode(
            (reason.error as { code?: unknown } | undefined)?.code
          );
          this.emit({
            type: 'session.failed',
            payload: {
              error: `DSH turn ended: ${JSON.stringify(reason).slice(0, 500)}`,
              ...(errorCode ? { errorCode } : {}),
            },
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
}
