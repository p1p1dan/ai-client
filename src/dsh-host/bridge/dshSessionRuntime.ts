/**
 * One DSH session behind our worker RPC (P0-3 bridge, hardened for P1-1).
 *
 * `DshSessionRuntime` implements the `PiWorkerRuntime` contract 1.0.x's native
 * worker runtime implemented (the only implementation since dsh-rebase P1-12),
 * so the unmodified `PiWorkerRpcServer` can drive it and
 * Main / the renderer see ordinary worker RPC and RuntimeEvents. It runs inside
 * the shared DSH host, one per channel of the `aiclient-bridge` row of
 * @aiclient/dsh-app (P1-3a), and talks to DSH services in-process:
 *
 *   durable `session/event`        -> message.* / tool.* / usage / session.* events
 *   live `agent/assistant-stream`  -> message.* / thinking.* / streaming tool rows
 *                                     (both translated by `liveEvents.ts`, P1-4d1)
 *   this session's PermissionGate  -> permission.requested / permission.resolved,
 *                                     answered by worker.permission.respond;
 *                                     permission.activity for a call a
 *                                     session grant let through (P1-7e e5)
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
 * Mapped: text, thinking, tool rows (streamed by size, flagged, with the
 * review of DSH's diff card), usage, the retry banner, failures and the step
 * ceiling, notices and the heads of turns the engine started itself
 * (P1-4d1, decision 099; `liveEvents.ts`), approvals, stop, the session
 * identity (create, resume, crash restart), the history, tree and leaf,
 * projected from the DSH log (P1-4a, decision 026; `historyCache.ts`), and
 * rewind and fork (P1-4b, decision 027). Attachments (P1-4c2, decisions 096 and
 * 097) go through DSH's attachment service, a send's and an interjection's
 * alike (`attachments.ts`): images as image blocks, text files as file blocks
 * the model reads on demand; a refusal is `WORKER_ATTACHMENT_REJECTED`.
 *
 * Commands and state (P1-4d2, decisions 099 rules 9-12 and 113): the menu
 * lists DSH's commands and the user-invocable skills (`commands.ts`); a send
 * that is a known command line runs through `ctx.commands.execute` with no
 * model turn; `worker.compact` is DSH's `/compact`, without instructions; the
 * `todos`, `goal` and `subagentCatalog` projections go out as
 * `session.projection`; the capability inventory reports the skill count.
 *
 * Panels (P1-7a, decisions 072 rules 1-2, 118; `panels.ts`): the goal bar's
 * buttons run `/goal …` through `worker.command`, out of band — no turn, no
 * event, not refused while a turn runs; `worker.panels` answers the current
 * projections for a renderer that missed them; and the bridge adds the key
 * DSH's `goal` projection leaves out, `goalActivation` (armed or not).
 *
 * Questions (P1-4d3, decisions 098 and 114): DSH's `ask_user_question` (and
 * `exit_plan_mode`) ask through `ctx.userQuestions`; this runtime answers the
 * `user-questions/request` waterfall for its own root agent on 1.0.x's
 * question card (`questions.ts`): `question.requested`, answered by
 * `worker.question.respond`, settled with `question.resolved`; the asker's
 * abort (a Stop) and a closing session take the card down.
 *
 * Turn semantics (P1-4c1, decisions 093-095): Ctrl+Enter steers the running
 * turn (`agent.steer`): the message waits in DSH's inbox and the turn takes it
 * in at its next step boundary, echoed with the renderer's attempt id; with no
 * turn running the bridge answers `turnActive: false` and sends nothing. Stop
 * is DSH's stop button, `cancel({kind:'user'}, {keepInbox:true})`: input the
 * turn has not taken in yet stays for the next one. The failure card's
 * Continue follows up a hidden continuation prompt (`aiclient-retry`), only
 * after a turn that ended in error, was interrupted or was stopped.
 *
 * Model and effort (P1-5a, decisions 033, 035, 040): each turn resolves the
 * model and effort Main sent (or the session's current model) against the
 * host's model plan (`modelRoute.ts`) and hands the DSH selection to the
 * agent through `installModelSelection`, installed when the agent is opened;
 * a model the plan cannot serve refuses the send with `MODEL_NOT_CONFIGURED`.
 * A turn DSH ends in error carries DSH's sentence and our failure code
 * (`dshFailureCodes.ts`).
 *
 * Identity (decisions 006 and 007): Main's durable `sessionFile` is a small
 * stub, `$DSH_HOME/aiclient-sessions/<dshSessionId>.dsh.json`, naming the DSH
 * session `aiclient-<logical id>`. A new session is flushed to disk BEFORE the
 * stub is written, so a committed identity always names a log that exists.
 *
 * Rewind and fork (decision 027): DSH has no rewind and no tree inside a
 * session, so both cut a seeded child session (`forkSeed.ts`). A rewind
 * repoints the stub at the child (`aiclient-<logical id>_r<n>`; `.r<n>` before P1-9c) and appends
 * it to the stub's lineage; the session it leaves is retired and stays in the
 * tree (`lineage.ts`). A fork writes a new stub for the child
 * (`aiclient-<id Main minted>`) and releases it for the slot Main opens next.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { paginateHistory } from '../../shared/dshHistory/page.ts';
import { projectDshHistory } from '../../shared/dshHistory/projection.ts';
import { dshLeafCheckpoint, dshTreeNodeId } from '../../shared/dshHistory/tree.ts';
import {
  DSH_RETRY_CONTINUATION_TEXT,
  DSH_SOURCE_AICLIENT_RETRY,
  type DshLogEvent,
  isDshSummaryRow,
} from '../../shared/dshHistory/types.ts';
import { permissionActivityEvent } from '../../shared/permissions/activity.ts';
import {
  createPermissionPrompt,
  type PermissionPrompt,
} from '../../shared/permissions/cardEmitter.ts';
import { type PermissionActivityRecord, PermissionGate } from '../../shared/permissions/gate.ts';
import type { PersistedGrants } from '../../shared/permissions/grants.ts';
import {
  loadPermissionPolicy,
  type PermissionPolicyFiles,
} from '../../shared/permissions/policy.ts';
import { type SyncRealpath, workspaceSpellings } from '../../shared/permissions/workspace.ts';
import { resolveSettingSources } from '../../shared/settingSources.ts';
import {
  type DshGoalActivation,
  type PermissionDecisionId,
  type RuntimeEventDraft,
  SESSION_PROJECTION_KEYS,
  type SessionProjectionPayload,
} from '../../shared/types/runtimeEvents.ts';
import {
  migratePermissionTier,
  type PermissionGear,
  type RuntimePermissionSettings,
} from '../../shared/types/runtimePermission.ts';
import type { HistoryMessage, SessionTreeSnapshot } from '../../shared/types/sessionHistory.ts';
import type { SessionPermissionTier } from '../../shared/types/sessionPermissionTier.ts';
import {
  STAGED_FORK_MARKER_SUFFIX,
  WORKER_COMMAND_BUDGET_MS,
  WORKER_COMMAND_TIMEOUT,
  WORKER_COMMAND_UNKNOWN,
  WORKER_COMPACT_BUDGET_MS,
  WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED,
  WORKER_RETRY_UNAVAILABLE,
  WORKER_REWIND_JOBS_RUNNING,
  type WorkerAcceptForkPayload,
  type WorkerAcceptForkResult,
  type WorkerBootstrapResult,
  type WorkerCommandPayload,
  type WorkerCommandResult,
  type WorkerCommandsPayload,
  type WorkerCommandsResult,
  type WorkerCompactPayload,
  type WorkerCompactResult,
  type WorkerDiscardForkPayload,
  type WorkerDiscardForkResult,
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
  type WorkerRewindPayload,
  type WorkerRewindResult,
  type WorkerSendPayload,
  type WorkerSendResult,
  type WorkerStopPayload,
  type WorkerStopResult,
  type WorkerSubagentInterruptPayload,
  type WorkerSubagentInterruptResult,
  type WorkerTreeResult,
} from '../../shared/types/workerRpc.ts';
import type { AttachedGate, DshPermissionHost } from '../permissions/permissionHost.ts';
import { admitUserContent, type DshAttachmentStore, type DshUserContent } from './attachments.ts';
import {
  compactOutcome,
  DSH_COMMAND_ERROR_TYPE,
  DSH_COMMAND_MESSAGE_PREFIX,
  type DshCommandDescriptor,
  type DshCommandExecution,
  type DshCommandsView,
  type DshSkillSummary,
  type DshSkillsView,
  dshCommandName,
  HIDDEN_DSH_COMMANDS,
  slashCommandRows,
  WORKER_COMPACT_TIMEOUT,
  WORKER_COMPACT_UNAVAILABLE,
} from './commands.ts';
import { buildDshForkSeed, type DshCutPlan, planDshCut } from './forkSeed.ts';
import { copyGrantSidecar, readGrantSidecar, writeGrantSidecar } from './grantStore.ts';
import { DshHistoryCache, type DshSessionQuery } from './historyCache.ts';
import { DshJobsTracker, type DshJobsView } from './jobs.ts';
import {
  DshRetiredHistory,
  readSessionEvents,
  retiredSessionIds,
  rewindSessionId,
} from './lineage.ts';
import {
  type BridgeDraft,
  DshLiveEvents,
  type DshSessionEvent,
  type DshUsageView,
  type LiveTurn,
  type StreamFrame,
} from './liveEvents.ts';
import {
  type DshBridgeModelPlan,
  DshModelRouter,
  type DshModelSelection,
  type DshRoutedModel,
} from './modelRoute.ts';
import {
  commandResultOf,
  type DshGoalActivationChanged,
  type DshGoalsView,
  goalActivationFromEdge,
  goalActivationOf,
  outOfBandCommandName,
} from './panels.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';
import type { PiWorkerRuntime, PiWorkerRuntimeOptions } from './piWorkerRpcServer.ts';
import {
  createDshQuestionPrompt,
  DSH_QUESTION_ID_PREFIX,
  type DshQuestionAnswer,
  type DshQuestionPrompt,
  type DshQuestionRequest,
  type DshQuestionResponse,
} from './questions.ts';
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
import {
  type DshChildEvent,
  type DshSubagentRunInfo,
  DshSubagentsTracker,
  type DshSubagentsView,
} from './subagents.ts';
import { type DshToolRegistryView, dshToolPresenter } from './toolPresentation.ts';

// P1-7b: the job registry's slice moved to `jobs.ts`; plugin.ts still names it from here.
export type { DshJobsView } from './jobs.ts';

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
  /**
   * Input for the nearest step boundary of the running turn (P1-4c1). An idle
   * agent would start a turn for it; the bridge only steers a running one.
   * Must not be called from inside a `session/event` listener: DSH refuses a
   * re-entrant append (measured, P1-4c1 experiment E2s).
   */
  steer(message: unknown): void;
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

/**
 * `ctx.sessionProjections` (dsh-session-projection), narrowed to the reads
 * the bridge takes: dsh-token-meter's `tokenUsage` and `contextPressure` views
 * of a session (P1-4d1, decision 099 rule 1), and the `todos`, `goal` and
 * `subagentCatalog` values with their change feed (P1-4d2, rule 11).
 */
export interface DshSessionProjectionsView {
  snapshot(session: unknown, keys?: readonly string[]): { values: Record<string, unknown> };
  /**
   * Called inside DSH's projection drive, once per key whose view changed,
   * with the schema-checked value. The listener must not read a snapshot
   * there: that would advance units the drive has not reached yet.
   */
  onChanged?(listener: (session: { id: string }, key: string, value: unknown) => void): () => void;
}

/** Services the runtime reads without injecting them; a host without one leaves it undefined. */
export interface DshBridgeOptionalServices {
  /** `ctx.jobs`: `busy`, and (P1-7b, `jobs.ts`) the `jobs` projection, live output, kill and read. */
  jobs: DshJobsView;
  /** `ctx.subagents` (P1-7b, `subagents.ts`): the human parent's interrupt. */
  subagents: DshSubagentsView;
  /** `ctx.sessionProjections`, for usage and the three forwarded projections. */
  sessionProjections: DshSessionProjectionsView;
  /** `ctx.commands` (P1-4d2): the menu, command sends and `worker.compact`. */
  commands: DshCommandsView;
  /** `ctx.skills` (P1-4d2): the menu's skills and the capability count. */
  skills: DshSkillsView;
  /** `ctx.goals` (P1-7a): the live goal's activation, which no projection carries. */
  goals: DshGoalsView;
  /** `ctx.tools` (decision 131): a plugin tool's own title for a call (`toolPresentation.ts`). */
  tools: DshToolRegistryView;
}

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
  /**
   * dsh-user-questions' answerer waterfall (P1-4d3): scope-filtered to the
   * asking agent, which untagged listeners such as this row's also receive.
   * Return an answer to claim the request, or `next()` to pass it on.
   */
  /**
   * dsh-goal's process-local activation edges (P1-7a): every session's, so
   * each runtime picks its own by `sessionId`.
   */
  on(
    name: 'goal/activation-changed',
    listener: (payload: DshGoalActivationChanged) => void
  ): Dispose;
  /**
   * dsh-tools' around-dispatch waterfall (P1-7b): every call of every agent,
   * after its approval; `next()` runs the tool. The runtime stamps its own
   * agent's calls (`execStartedAt`) and follows their jobs and children.
   */
  on(
    name: 'tools/execute',
    listener: (
      exec: DshToolDispatch,
      next: () => Promise<DshToolOutcome>
    ) => Promise<DshToolOutcome>
  ): Dispose;
  /** dsh-subagent's lifecycle edges (P1-7b): every session's; each runtime keeps its children's. */
  on(
    name: 'subagent/start' | 'subagent/end',
    listener: (info: DshSubagentRunInfo) => void
  ): Dispose;
  on(
    name: 'user-questions/request',
    listener: (
      request: DshQuestionRequest,
      next: () => Promise<DshQuestionAnswer>
    ) => Promise<DshQuestionAnswer>
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
  /**
   * `ctx.attachments` (dsh-attachment-local): where a send's and an
   * interjection's images are admitted and its text files stored (P1-4c2,
   * `attachments.ts`).
   */
  attachments: DshAttachmentStore;
  /** A service the row does not inject, when it is there. */
  get?<K extends keyof DshBridgeOptionalServices>(
    name: K
  ): DshBridgeOptionalServices[K] | undefined;
  /**
   * `ctx.aiclientPermissions` (P1-6b, decision 042): the permission row every
   * session attaches its gate to. Injected by the bridge row; a runtime
   * without it refuses to bootstrap (`WORKER_PERMISSIONS_UNAVAILABLE`).
   */
  aiclientPermissions?: DshPermissionHost;
}

/**
 * The sources this bridge writes: what the user typed, and the hidden retry
 * continuation (decisions 028 and 095), a notice the timeline never shows.
 */
export type DshUserMessageSource =
  | { kind: 'user' }
  | { kind: typeof DSH_SOURCE_AICLIENT_RETRY; form: 'notice'; summary: string };

/** DSH's `AgentSetup`: runs on the agent's own scope before it is published. */
export type DshAgentSetup = (agentCtx: unknown) => void;

/** `ModelSelectionRef` of `@deepseek-ai/dsh-agent`: the selection the next step routes to. */
export interface DshModelSelectionRef {
  current: DshModelSelection | undefined;
  assembled: DshModelSelection | undefined;
}

/** One call inside `tools/execute` (dsh-tools' `ToolDispatchExecution`), narrowed. */
export interface DshToolDispatch {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: { readonly id: string };
  /** Set on a transport sub-dispatch (a `run_code` program's call): not the model's own. */
  readonly parent?: unknown;
}

/** What `tools/execute` answers (dsh-tools' `ToolExecutionResult`), narrowed. */
export interface DshToolOutcome {
  readonly isError: boolean;
  /** Execution-local; never in the log (`{kind: 'promoted', jobId}`, `{kind: 'continuable', …}`). */
  readonly value?: unknown;
}

/** What the bridge takes besides the Cordis context, injected so it can run without DSH installed. */
export interface DshBridgeDeps {
  /** `createUserMessage` from `@deepseek-ai/dsh-llm`: the id its durable echo carries. */
  createUserMessage(input: { content: DshUserContent[]; source: DshUserMessageSource }): {
    id: string;
  };
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
  /**
   * How long `worker.compact` lets DSH's `/compact` run before it cancels it
   * (`WORKER_COMPACT_BUDGET_MS`, inside Main's own wait); tests shorten it.
   */
  compactTimeoutMs?: number;
  /** The same for `worker.command` (`WORKER_COMMAND_BUDGET_MS`); tests shorten it. */
  commandTimeoutMs?: number;
  /**
   * How the gate canonicalizes the workspace (decision 134): `realpathSync.native`,
   * the twin of the permission row's target resolver. Tests stand in a
   * Windows 8.3 expansion here.
   */
  realpathSync?: SyncRealpath;
}

/**
 * A send that carried a known command line (P1-4d2): its request, the
 * renderer's attempt, and the command DSH bound it to at `command/run`.
 */
interface CommandSend {
  readonly requestId: string;
  readonly attemptId: string;
  readonly controller: AbortController;
  commandId?: string;
  /** Its `command/done` reached the live translation (whose notice is the answer). */
  settledInLog: boolean;
}

// ---- helpers ----------------------------------------------------------------

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

/**
 * How the last turn must have ended for the failure card's Continue to be
 * taken (decisions 028 and 095): it failed, the host died under it, or it was
 * stopped. A turn that completed — or was blocked, or ran out of tokens — has
 * nothing to re-run.
 */
const RETRYABLE_TURN_ENDS: ReadonlySet<string> = new Set(['error', 'interrupted', 'aborted']);

/** Ours, not DSH's in-process counter, so a lost stub can be found again (decision 006). */
export function dshSessionIdFor(logicalSessionId: string): string {
  return `${DSH_SESSION_ID_PREFIX}${logicalSessionId}`;
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

// ---- the runtime -------------------------------------------------------------

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
  private turn: LiveTurn | null = null;
  /** The live translation of this session's events (P1-4d1, `liveEvents.ts`). */
  private readonly live: DshLiveEvents;
  private readonly disposers: Dispose[] = [];
  /** The session's approval cards (1.0.x's emitter): `permission.requested` / `resolved`. */
  private readonly prompt: PermissionPrompt;
  /** P1-4d3: the root agent's questions on 1.0.x's card: `question.requested` / `resolved`. */
  private readonly questions: DshQuestionPrompt;
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
  /**
   * Ctrl+Enter messages steered in and not yet taken in by a turn: message id
   * -> the renderer's attempt id, for the echo (P1-4c1). One that a Stop left
   * in the inbox waits here until a later turn takes it in.
   */
  private readonly steered = new Map<string, { attemptId: string }>();
  /** P1-4d2: a command send whose line DSH is admitting now; its `command/run` claims it. */
  private pendingCommand: CommandSend | null = null;
  /** Command sends DSH admitted and `execute` has not settled, by DSH's command id. */
  private readonly commandSends = new Map<string, CommandSend>();
  /**
   * P1-4d2: the forwarded projections as a bootstrap found them, sent ahead of
   * the next event this runtime emits — by then Main has the slot ready, and
   * it drops whatever a slot sends before that (`WorkerManager.handleWorkerEvent`).
   */
  private projectionBaseline: SessionProjectionPayload[] | null = null;
  /** P1-7b: the session's background jobs and its running commands' output (`jobs.ts`). */
  private readonly jobs: DshJobsTracker;
  /** P1-7b: the session's children on the timeline (`subagents.ts`). */
  private readonly children: DshSubagentsTracker;
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
    // Decision 131: one presenter for the live rows and the replayed ones,
    // asked through the session's own agent once it is open.
    const presentCall = dshToolPresenter(
      () => this.ctx.get?.('tools'),
      () => this.handle?.agent
    );
    this.historyCache = new DshHistoryCache(this.query, options.log, presentCall);
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
    this.questions = createDshQuestionPrompt({
      // Through `emit` as well: a card raised inside a turn carries its requestId.
      emit: (event) => this.emit(event as BridgeDraft),
      newId: () => `${DSH_QUESTION_ID_PREFIX}${randomUUID()}`,
    });
    this.live = new DshLiveEvents({
      emit: (event) => this.emit(event),
      route: () => this.route,
      dshSessionId: () => this.dshSessionId,
      turn: () => this.turn,
      openSyntheticTurn: (turn) => {
        // A turn the bridge did not start (goal round, job or subagent wake-up): give it an id.
        this.turn = { requestId: `dsh-turn-${this.dshSessionId}-${String(turn)}`, synthetic: true };
        this.emit({ type: 'session.status', payload: { status: 'running' } });
      },
      closeTurn: () => {
        this.turn = null;
      },
      takeSteered: (messageId) => {
        const steered = this.steered.get(messageId);
        this.steered.delete(messageId);
        return steered;
      },
      usageView: () => this.usageView(),
      usageSteps: () => this.historyCache.usageSteps(),
      goalMaxRounds: () => this.historyCache.goalMaxRounds(),
      claimCommand: (commandId) => {
        const send = this.pendingCommand;
        if (!send) return undefined;
        this.pendingCommand = null;
        send.commandId = commandId;
        this.commandSends.set(commandId, send);
        return send;
      },
      commandSend: (commandId) => {
        const send = this.commandSends.get(commandId);
        if (send) send.settledInLog = true;
        return send;
      },
      now: this.now,
      presentCall,
    });
    this.jobs = new DshJobsTracker({
      owner: () => this.dshSessionId,
      registry: () => this.ctx.get?.('jobs'),
      projectJobs: (jobs) => {
        if (!this.disposed && this.result) this.forwardProjection({ key: 'jobs', view: jobs });
      },
      emitOutput: (output) => {
        if (!this.disposed) this.live.emitToolOutput(output);
      },
      log: options.log,
      now: this.now,
    });
    this.children = new DshSubagentsTracker({
      owner: () => this.dshSessionId,
      subagents: () => this.ctx.get?.('subagents'),
      emitActivity: (payload) => {
        if (!this.disposed) this.emit({ type: 'subagent.activity', payload });
      },
      log: options.log,
      now: this.now,
    });
  }

  /**
   * dsh-token-meter's usage views of the open session (decision 099 rule 1):
   * a snapshot advances them to the session's last event, so a view read
   * inside `session/event` already counts that event. Absent when the host
   * composes no projections, and on a failed read, which only costs the
   * occupancy ring and the running total of one event.
   */
  private usageView(): DshUsageView | undefined {
    const session = this.handle?.agent.session;
    if (!session) return undefined;
    try {
      const projections = this.ctx.get?.('sessionProjections');
      return projections?.snapshot(session, ['tokenUsage', 'contextPressure']).values as
        | DshUsageView
        | undefined;
    } catch (error) {
      this.options.log?.('[dsh-bridge] usage projections unreadable', error);
      return undefined;
    }
  }

  /**
   * The agent is not idle: a turn this bridge started, one it did not (a goal
   * round, a job notice), other agent work, a background job of this session
   * still running after its turn ended, or (P1-7b) a run of one of its
   * subagents — a continuable child keeps working after the parent's turn.
   * Reported to Main in each pong; Main never reclaims a busy session
   * (decision 025): reclaiming it would end that work.
   */
  get busy(): boolean {
    if (this.disposed) return false;
    if (this.turn !== null || (this.handle !== null && this.handle.agent.status !== 'idle')) {
      return true;
    }
    return this.commandSends.size > 0 || this.hasLiveJobs() || this.children.hasRunning();
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
    if (!this.gate) {
      this.gate = await this.buildGate();
      this.disposers.push(this.gate.onActivity((record) => this.onGateActivity(record)));
    }
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
    const skills = await this.skillCount();
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
      // Decisions 099 rule 12, 113: the skill count alone; MCP, templates and
      // custom sub-agents have no producer on this engine, so they stay absent.
      capabilities: skills === undefined ? {} : { skills },
    };
    this.syncSandboxMode();
    // P1-7b: the session's jobs from now on (a resumed session's live ones included).
    this.jobs.follow();
    this.projectionBaseline = this.readProjections();
    return this.result;
  }

  /**
   * Every skill the agent's catalog has (`ctx.skills`, the agent's scope and
   * workspace), model- or user-invocable. Undefined — "not reported" — when
   * the host has no skill registry or the read fails; never a failed bootstrap.
   */
  private async skillCount(): Promise<number | undefined> {
    const agent = this.handle?.agent;
    if (!agent) return undefined;
    try {
      const skills = this.ctx.get?.('skills');
      return skills ? (await skills.list(this.skillLookup(agent))).length : undefined;
    } catch (error) {
      this.options.log?.('[dsh-bridge] skill catalog unreadable', error);
      return undefined;
    }
  }

  /** The lookup dsh-tool-skill makes for this agent: its workspace, its scope. */
  private skillLookup(agent: DshAgent): { cwd: string; scope: unknown } {
    return { cwd: agent.session.header?.cwd ?? this.cwd, scope: agent };
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
   * sees has been resolved to, canonicalized by the same (native) resolver
   * the permission row resolves targets with; the spelling the session was
   * opened with stays an alias of it (decision 134).
   */
  private async buildGate(): Promise<PermissionGate> {
    const { cwd, cwdAliases } = workspaceSpellings(
      this.cwd,
      this.deps.realpathSync ?? ((path) => realpathSync.native(path))
    );
    const policy = await loadPermissionPolicy(POLICY_FILES, {
      cwd,
      agentDir: this.deps.permissionAgentDir ?? null,
      sources: resolveSettingSources({ projectTrusted: this.options.projectTrusted }),
    });
    return new PermissionGate(
      {
        cwd,
        ...(cwdAliases.length > 0 ? { cwdAliases } : {}),
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

  /**
   * P1-7e e5 (problem 30, decision 143; decision 129 rule 16): a call that a
   * remembered "allow for this session" let through raises no card, so the
   * timeline said nothing about it being gated at all. It goes out as the
   * 1.0.x runtime sent it, `permission.activity` built by the same
   * `permissionActivityEvent` (the tool call id as `requestId`, `surface` =
   * the tool, `value` = what was matched, `resolution: 'session_grant'`),
   * and the renderer draws its activity row ("Allowed bash … · session
   * grant"). Only these: a card's own answer already shows on its tool row,
   * and the gate's other records stay off the stream, as they were on DSH.
   */
  private onGateActivity(record: PermissionActivityRecord): void {
    if (this.disposed) return;
    if (record.phase !== 'decision' || record.source !== 'session-grant') return;
    const { sessionId: _sessionId, ...draft } = permissionActivityEvent(
      this.logicalSessionId,
      record
    );
    this.emit(draft as BridgeDraft);
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
    // The same for a question: its card goes, and the tool call waiting on it
    // is refused rather than left parked.
    this.questions.drain('the chat session closed before the user answered');
    this.disposed = true;
    this.steered.clear();
    for (const send of this.commandSends.values()) send.controller.abort();
    this.commandSends.clear();
    this.projectionBaseline = null;
    this.jobs.dispose();
    this.children.reset();
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
    if (input.mode === 'retry') return this.startRetry(input);
    this.assertNoOwnTurn();
    await this.bootstrap();
    // Decisions 033, 040: this turn's model and effort, or a refusal before anything is sent.
    const routed = this.router.session(
      input.model ?? this.modelId,
      input.effort ?? this.options.effort
    );
    // Decisions 099 rule 9, 113: a known command line runs as DSH's command,
    // with no model turn. With attachments it is a message, as the window's
    // own commands treat it.
    const commands = input.attachments?.length ? undefined : this.commandFor(input.text);
    if (commands) {
      this.applyRoute(routed);
      const accepted = await this.startCommand(input, commands);
      if (accepted) return accepted;
    }
    // Decisions 096, 097: attachments through the engine's own admission; a
    // refusal (`WORKER_ATTACHMENT_REJECTED`) comes before any event.
    const content = await admitUserContent(this.ctx.attachments, input.text, input.attachments);
    // The admission awaited the store: a send that came in meanwhile won.
    this.assertNoOwnTurn();
    const agent = this.requireAgent();
    this.applyRoute(routed);
    const message = this.deps.createUserMessage({ content, source: { kind: 'user' } });
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

  /**
   * A turn this bridge sent is running, or a command it sent has not settled:
   * a second send is busy (a turn DSH started is not).
   */
  private assertNoOwnTurn(): void {
    if ((this.turn && !this.turn.synthetic) || this.commandSends.size > 0) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        'Session already has an active turn',
        true
      );
    }
  }

  // ---- commands (P1-4d2, decisions 099 rules 9-10, 113) ---------------------------

  /**
   * `ctx.commands`, when `text` is a line naming a command this session's
   * agent has and the menu may run; undefined for anything else, which goes
   * to the model as typed.
   */
  private commandFor(text: string): DshCommandsView | undefined {
    const name = dshCommandName(text);
    const agent = this.handle?.agent;
    if (!name || HIDDEN_DSH_COMMANDS.has(name) || !agent) return undefined;
    try {
      const commands = this.ctx.get?.('commands');
      return commands?.find(agent, name) !== undefined ? commands : undefined;
    } catch (error) {
      this.options.log?.('[dsh-bridge] command registry unreadable', error);
      return undefined;
    }
  }

  /**
   * A command send: DSH runs the line against the agent and records it
   * (`command/run`, `command/done`); the live translation echoes the line
   * with the attempt id and shows the answer, and the send ends once
   * `execute` settles. Nothing is emitted unless DSH admitted the line: a
   * command gone from the registry since `commandFor` makes this undefined
   * (the caller sends the text as a prompt), and a refused admission is the
   * send's refusal.
   */
  private async startCommand(
    input: WorkerSendPayload,
    commands: DshCommandsView
  ): Promise<WorkerSendResult | undefined> {
    const agent = this.requireAgent();
    const send: CommandSend = {
      requestId: input.requestId,
      attemptId: input.attemptId,
      controller: new AbortController(),
      settledInLog: false,
    };
    this.pendingCommand = send;
    let execution: Promise<DshCommandExecution | undefined>;
    try {
      execution = commands.execute(agent, input.text, [], send.controller.signal);
    } finally {
      this.pendingCommand = null;
    }
    if (send.commandId === undefined) {
      // DSH logged no `command/run` for it, so nothing went out.
      if ((await execution) === undefined) return undefined;
      this.options.log?.('[dsh-bridge] a command ran without its command/run reaching the bridge');
    }
    void execution
      .then(
        () => this.finishCommand(send),
        (error: unknown) => this.finishCommand(send, error)
      )
      .catch((error: unknown) => {
        this.options.log?.('[dsh-bridge] command send could not end', error);
      });
    return { accepted: true, requestId: input.requestId };
  }

  /**
   * The command settled: the send completes (a command's error is its
   * answer, not a failed turn). A turn DSH started meanwhile — a goal round
   * the command armed — keeps the session running; otherwise it is idle.
   */
  private finishCommand(send: CommandSend, error?: unknown): void {
    if (send.commandId !== undefined) this.commandSends.delete(send.commandId);
    if (this.disposed) return;
    if (error !== undefined) {
      this.options.log?.('[dsh-bridge] command failed', error);
      if (!send.settledInLog) {
        this.emit({
          type: 'custom.message',
          requestId: send.requestId,
          payload: {
            messageId: `${DSH_COMMAND_MESSAGE_PREFIX}${send.requestId}`,
            customType: DSH_COMMAND_ERROR_TYPE,
            content: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    this.emit({ type: 'session.completed', requestId: send.requestId, payload: {} });
    if (this.turn) {
      this.emit({ type: 'session.status', payload: { status: 'running' } });
    } else if (this.idle() && this.commandSends.size === 0) {
      this.emit({ type: 'session.status', requestId: send.requestId, payload: { status: 'idle' } });
    }
  }

  async commands(input: WorkerCommandsPayload): Promise<WorkerCommandsResult> {
    this.assertLogicalSession(input.logicalSessionId);
    const agent = this.handle?.agent;
    if (!agent || this.disposed) return { commands: [], truncated: false };
    return slashCommandRows(this.listedCommands(agent), await this.userSkills(agent));
  }

  private listedCommands(agent: DshAgent): readonly DshCommandDescriptor[] {
    try {
      return this.ctx.get?.('commands')?.list(agent) ?? [];
    } catch (error) {
      this.options.log?.('[dsh-bridge] command registry unreadable', error);
      return [];
    }
  }

  private async userSkills(agent: DshAgent): Promise<readonly DshSkillSummary[]> {
    try {
      return (await this.ctx.get?.('skills')?.list(this.skillLookup(agent))) ?? [];
    } catch (error) {
      this.options.log?.('[dsh-bridge] skill catalog unreadable', error);
      return [];
    }
  }

  /**
   * `/compact` (decisions 099 rule 10, 113): DSH's command, which takes no
   * arguments, so instructions are refused before anything runs. Bounded as
   * the native runtime bounded its summary: the command is cancelled at
   * `compactTimeoutMs`, before Main's own wait ends, so Main's answer is
   * what the log has. Compacted only when DSH names the summary it wrote.
   */
  async compact(input: WorkerCompactPayload): Promise<WorkerCompactResult> {
    this.assertLogicalSession(input.logicalSessionId);
    if (input.instructions !== undefined && input.instructions.trim().length > 0) {
      throw new PiWorkerSessionError(
        WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED,
        '/compact takes no instructions on the DSH engine; nothing was compacted'
      );
    }
    await this.bootstrap();
    this.assertIdle('compact the conversation');
    const agent = this.requireAgent();
    const commands = this.ctx.get?.('commands');
    if (!commands || commands.find(agent, 'compact') === undefined) {
      throw new PiWorkerSessionError(
        WORKER_COMPACT_UNAVAILABLE,
        'This host has no /compact command'
      );
    }
    const budgetMs = this.deps.compactTimeoutMs ?? WORKER_COMPACT_BUDGET_MS;
    // Decision 140: the summary row already on the timeline, so the one this
    // command writes is told apart from it.
    const summaryBefore = (await this.historyCache.ready()) ? this.lastSummaryRow()?.id : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let execution: DshCommandExecution | undefined;
    try {
      execution = await commands.execute(agent, '/compact', [], controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (controller.signal.aborted) {
      throw new PiWorkerSessionError(
        WORKER_COMPACT_TIMEOUT,
        `summarizing the conversation took longer than ${budgetMs}ms; it was cancelled`,
        true
      );
    }
    const outcome = compactOutcome(execution);
    if (!('compacted' in outcome)) throw new PiWorkerSessionError(outcome.code, outcome.message);
    // Decision 140: the row the history will show for it, handed back with the
    // answer (no live event: decision 113 rule 8 stands). A cache that cannot
    // read it back costs the row only; the compaction itself succeeded.
    const summary = (await this.historyCache.ready()) ? this.lastSummaryRow() : undefined;
    return summary && summary.id !== summaryBefore ? { ...outcome, summary } : outcome;
  }

  /** The newest context-summary row of the timeline (`isDshSummaryRow`), if any. */
  private lastSummaryRow(): HistoryMessage | undefined {
    const messages = this.historyCache.messages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && isDshSummaryRow(message)) return message;
    }
    return undefined;
  }

  // ---- panels (P1-7a, decisions 072 rules 1-2, 113 rule 12, 118) ------------------

  /**
   * `worker.command`: one DSH command, out of band. No turn is opened and no
   * event is sent — DSH logs its `command/run` / `command/done`, which the
   * live translation only shows for a send's command — and a running turn
   * does not refuse it: the goal bar's pause is meant for the round that is
   * running, and DSH's own pause cancels that round. The answer is DSH's
   * text; a command DSH answered with an error (a goal in the wrong state)
   * is `ok: false`, not a failed request. Bounded like `/compact`, inside
   * Main's warm request timeout.
   */
  async command(input: WorkerCommandPayload): Promise<WorkerCommandResult> {
    this.assertLogicalSession(input.logicalSessionId);
    await this.bootstrap();
    const agent = this.requireAgent();
    const name = outOfBandCommandName(input.line);
    const commands = name ? this.ctx.get?.('commands') : undefined;
    if (!name || !commands || commands.find(agent, name) === undefined) {
      throw new PiWorkerSessionError(
        WORKER_COMMAND_UNKNOWN,
        `${input.line.split(/\s/u, 1)[0] ?? ''} is not a command this session runs out of band`
      );
    }
    const budgetMs = this.deps.commandTimeoutMs ?? WORKER_COMMAND_BUDGET_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let execution: DshCommandExecution | undefined;
    try {
      execution = await commands.execute(agent, input.line, [], controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
    if (controller.signal.aborted) {
      throw new PiWorkerSessionError(
        WORKER_COMMAND_TIMEOUT,
        `/${name} took longer than ${budgetMs}ms; it was cancelled`,
        true
      );
    }
    if (!execution) {
      // Gone from the registry between the lookup and the run: nothing was logged.
      throw new PiWorkerSessionError(WORKER_COMMAND_UNKNOWN, `/${name} is no longer available`);
    }
    return commandResultOf(execution);
  }

  /**
   * `worker.panels`: the panels' current values, the same the bridge sends
   * as `session.projection`, for a renderer that was not listening then (a
   * reload, a chat switched to, a session reopened with no event since —
   * decision 113 rule 12). A read of an open session only: nothing before a
   * bootstrap, never a bootstrap of its own.
   */
  async panels(input: WorkerPanelsPayload): Promise<WorkerPanelsResult> {
    this.assertLogicalSession(input.logicalSessionId);
    if (!this.result || this.disposed) return { projections: [] };
    return { projections: this.readProjections({ activation: true, jobs: true }) };
  }

  // ---- the jobs and subagents windows (P1-7b, decisions 069, 119) -----------------------

  /** `worker.job.kill`: DSH's own kill of one of this session's jobs. */
  async killJob(input: WorkerJobKillPayload): Promise<WorkerJobKillResult> {
    this.assertLogicalSession(input.logicalSessionId);
    this.requireOpen();
    return this.jobs.kill(input.jobId);
  }

  /** `worker.job.read`: one job's output, read without moving the model's cursor. */
  async readJob(input: WorkerJobReadPayload): Promise<WorkerJobReadResult> {
    this.assertLogicalSession(input.logicalSessionId);
    this.requireOpen();
    return this.jobs.read(input.jobId, input.from, input.maxBytes);
  }

  /** `worker.subagent.interrupt`: one child's current run, as its human parent. */
  async interruptSubagent(
    input: WorkerSubagentInterruptPayload
  ): Promise<WorkerSubagentInterruptResult> {
    this.assertLogicalSession(input.logicalSessionId);
    this.requireOpen();
    return this.children.interrupt(input.childId);
  }

  /** A bootstrapped, live session: what the windows' controls act on. */
  private requireOpen(): void {
    if (!this.result || this.disposed || !this.handle) {
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'No open DSH session');
    }
  }

  /**
   * The failure card's Continue (decisions 028 and 095). Taken only when the
   * session is idle and its last turn ended in error, was interrupted (the
   * host died under it) or was stopped; anything else is refused with
   * `WORKER_RETRY_UNAVAILABLE` before a single event goes out, and the
   * renderer puts the prompt back in the composer.
   *
   * Taken, it follows up one continuation prompt the model reads and the user
   * never sees (source `aiclient-retry`: no echo live, hidden in the history)
   * and reports `running`, the renderer's evidence of admission. Nothing is
   * forked: DSH kept the failed attempt out of the model's context
   * (`assistant/attempt`), and the turn's finished tool rounds stay.
   */
  private async startRetry(input: WorkerSendPayload): Promise<WorkerSendResult> {
    await this.bootstrap();
    const current = await this.historyCache.ready();
    const lastEnd = current ? this.historyCache.lastTurnEnd() : undefined;
    if (!this.idle() || this.commandSends.size > 0) {
      throw new PiWorkerSessionError(
        WORKER_RETRY_UNAVAILABLE,
        'A turn is running; there is nothing to retry'
      );
    }
    if (lastEnd === undefined || !RETRYABLE_TURN_ENDS.has(lastEnd)) {
      throw new PiWorkerSessionError(
        WORKER_RETRY_UNAVAILABLE,
        lastEnd === undefined
          ? 'No ended turn is on record; there is nothing to retry'
          : `The last turn ended ${lastEnd}; there is nothing to retry`
      );
    }
    const agent = this.requireAgent();
    this.applyRoute(
      this.router.session(input.model ?? this.modelId, input.effort ?? this.options.effort)
    );
    const message = this.deps.createUserMessage({
      content: [{ type: 'text', text: DSH_RETRY_CONTINUATION_TEXT }],
      source: {
        kind: DSH_SOURCE_AICLIENT_RETRY,
        form: 'notice',
        summary: 'Retry after a failed request',
      },
    });
    // No `userMessageId`: the continuation is not the user's, so nothing echoes.
    this.turn = { requestId: input.requestId, attemptId: input.attemptId, synthetic: false };
    this.emit({ type: 'session.status', payload: { status: 'running' } });
    agent.followup(message);
    return { accepted: true, requestId: input.requestId };
  }

  /**
   * DSH's stop button (decision 094): the turn ends, and input it has not
   * taken in yet — a Ctrl+Enter message, a job's completion notice — stays in
   * the inbox for the next turn. The Stop opens no turn by itself.
   *
   * A command send (P1-4d2) has no turn: Stop cancels the wait on it, and
   * DSH settles it as cancelled; the send then completes as any command does.
   */
  async stop(_input: WorkerStopPayload): Promise<WorkerStopResult> {
    if (!this.turn && this.commandSends.size > 0) {
      // The reason is what the command's error notice reads.
      for (const send of this.commandSends.values()) {
        send.controller.abort(new Error('Stopped by the user'));
      }
      return { stopped: true };
    }
    if (!this.turn || !this.handle) return { stopped: false };
    this.emit({ type: 'session.status', payload: { status: 'stopping' } });
    // Decision 069 rule 1 (U3): the Stop reaches the session's subagents —
    // each running continuable child's current run is interrupted (it keeps
    // its session) and its one-shot background children are killed — but
    // never its background commands, which their window stops one by one.
    // Before the turn's own cancel: a child's settlement notice that lands
    // while the turn still runs waits in the inbox (`keepInbox`) instead of
    // waking the session after the Stop (it may still wake it; decision 119).
    this.children.interruptAll();
    this.jobs.stopSubagentJobs('the user pressed Stop');
    this.handle.agent.cancel({ kind: 'user' }, { keepInbox: true });
    return { stopped: true };
  }

  /**
   * Ctrl+Enter (decision 093): the message goes to the running turn, which
   * takes it in at its next step boundary and carries on — nothing stops,
   * and a goal keeps running. A turn DSH started itself (a goal round, a job
   * or subagent wake-up) counts as running. Its echo carries `attemptId` once
   * the turn took it in (`liveEvents.ts`); a Stop before then leaves it in the
   * inbox for the next turn (decision 094).
   *
   * With no turn running nothing is sent: `turnActive: false`, and the
   * renderer sends the message the ordinary way (runtime-hardening decision
   * 046: the worker is the authority on whether a turn exists).
   *
   * Attachments go through a send's admission (P1-4c2, decisions 093, 096,
   * 097): a refusal is `WORKER_ATTACHMENT_REJECTED` and nothing is steered.
   * Only then is the answer a promise; the turn is asked again once the store
   * answered, since it may have ended meanwhile.
   */
  interject(input: WorkerInterjectPayload): WorkerInterjectResult | Promise<WorkerInterjectResult> {
    this.assertLogicalSession(input.logicalSessionId);
    if (!this.steerable()) return { interjected: false, turnActive: false };
    if (!input.attachments || input.attachments.length === 0) {
      return this.steer(input.attemptId, [{ type: 'text', text: input.text }]);
    }
    return this.interjectWithAttachments(input);
  }

  private async interjectWithAttachments(
    input: WorkerInterjectPayload
  ): Promise<WorkerInterjectResult> {
    const content = await admitUserContent(this.ctx.attachments, input.text, input.attachments);
    if (!this.steerable()) return { interjected: false, turnActive: false };
    return this.steer(input.attemptId, content);
  }

  /** A turn of any origin is running on a live agent: what Ctrl+Enter joins. */
  private steerable(): boolean {
    return !this.disposed && this.handle !== null && !this.idle();
  }

  /** The message into the running turn's inbox, remembered for its echo. */
  private steer(attemptId: string, content: DshUserContent[]): WorkerInterjectResult {
    const handle = this.requireHandle();
    const message = this.deps.createUserMessage({ content, source: { kind: 'user' } });
    this.steered.set(message.id, { attemptId });
    try {
      handle.agent.steer(message);
    } catch (error) {
      this.steered.delete(message.id);
      throw error;
    }
    return { interjected: true, turnActive: true };
  }

  /** A card's answer, keyed by the tool call id; false when nothing waits on it. */
  respondPermission(input: { permissionId: string; decision: PermissionDecisionId }): boolean {
    return this.prompt.respond(input);
  }

  /**
   * A question card's answer, Skip or Continue (P1-4d3, decision 098); false
   * when nothing waits on the id: answered already, or taken down by a Stop.
   */
  respondQuestion(input: DshQuestionResponse): boolean {
    return this.questions.respond(input);
  }

  /**
   * A `user-questions/request` of this session's root agent (P1-4d3). DSH
   * lets only a live runtime root ask (a delegate gets `DELEGATED_CALLER`
   * before any waterfall). Another chat's request goes on to that chat's
   * runtime; an agentless one is no session's card and ends in DSH's
   * `NO_PROVIDER`.
   */
  private ownsQuestion(request: DshQuestionRequest): boolean {
    const agent = this.handle?.agent;
    return !this.disposed && agent !== undefined && request.agent?.id === agent.id;
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
    // P1-7b: the jobs and children of the session the rewind left are not
    // the child's (a rewind waits for jobs; the retired agent's children go
    // with its dispose).
    this.children.reset();
    this.jobs.follow();
    // The child's projections replace the retired session's at once: the slot
    // is ready, so they reach the renderer ahead of the rewind's history. The
    // jobs go too, empty or not: the retired session's list must not linger.
    this.projectionBaseline = this.readProjections({ jobs: true });
    this.flushProjectionBaseline();
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
    this.live.reset();
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
    if (this.idle() && this.commandSends.size === 0) return;
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

  /** One event; a bootstrap's projection baseline goes out first (P1-4d2). */
  private emit(event: BridgeDraft): void {
    if (this.projectionBaseline) this.flushProjectionBaseline();
    this.emitNow(event);
  }

  /** The turn's requestId, unless the event names its own (a command send's, P1-4d2). */
  private emitNow(event: BridgeDraft): void {
    const requestId = event.requestId ?? this.turn?.requestId;
    this.options.emit({
      sessionId: this.logicalSessionId,
      ...(requestId ? { requestId } : {}),
      ...event,
    } as RuntimeEventDraft);
  }

  // ---- session.projection (P1-4d2, decisions 031, 099 rule 11, 113) -----------------

  /**
   * The forwarded keys the open session has now, in one consistent cut, and
   * the bridge's own two: `goalActivation` (P1-7a) while a goal is current,
   * `jobs` (P1-7b) while the session has a job — or each always (`null`,
   * empty) when `always` says so: `worker.panels`, whose answer replaces what
   * the renderer holds, and a rewind's `jobs`. A key whose unit (or service)
   * the host does not compose is absent; a failed read costs the baseline,
   * never the session.
   */
  private readProjections(
    always: { activation?: boolean; jobs?: boolean } = {}
  ): SessionProjectionPayload[] {
    const projections = this.readDshProjections();
    const activation = this.readGoalActivation();
    if (activation !== undefined && (activation !== null || always.activation)) {
      projections.push({ key: 'goalActivation', view: activation });
    }
    if (this.ctx.get?.('jobs')) {
      const jobs = this.jobs.current();
      if (jobs.length > 0 || always.jobs) projections.push({ key: 'jobs', view: jobs });
      // The session's events are what later changes compare against (a
      // `worker.panels` answer goes to one window, not to the stream).
      if (!always.activation) this.jobs.noteProjected(jobs);
    }
    return projections;
  }

  private readDshProjections(): SessionProjectionPayload[] {
    const session = this.handle?.agent.session;
    if (!session) return [];
    try {
      const values = this.ctx
        .get?.('sessionProjections')
        ?.snapshot(session, SESSION_PROJECTION_KEYS).values;
      if (!values) return [];
      return SESSION_PROJECTION_KEYS.filter((key) => key in values).map(
        (key) => ({ key, view: values[key] }) as SessionProjectionPayload
      );
    } catch (error) {
      this.options.log?.('[dsh-bridge] session projections unreadable', error);
      return [];
    }
  }

  /** The open agent's goal activation; undefined without a goal service or on a failed read. */
  private readGoalActivation(): DshGoalActivation | null | undefined {
    const agent = this.handle?.agent;
    const goals = agent ? this.ctx.get?.('goals') : undefined;
    if (!agent || !goals) return undefined;
    try {
      return goalActivationOf(goals.get(agent));
    } catch (error) {
      this.options.log?.('[dsh-bridge] goal activation unreadable', error);
      return undefined;
    }
  }

  private flushProjectionBaseline(): void {
    const baseline = this.projectionBaseline ?? [];
    this.projectionBaseline = null;
    for (const payload of baseline) this.emitNow({ type: 'session.projection', payload });
  }

  /**
   * DSH's change feed, inside its projection drive: this session's forwarded
   * keys only, once bootstrapped (the baseline covers what came before). A
   * change that finds the baseline still waiting joins it and sends it.
   */
  private onProjectionChanged(
    session: { id: string } | undefined,
    key: string,
    value: unknown
  ): void {
    if (this.disposed || !this.result || session?.id !== this.dshSessionId) return;
    if (!(SESSION_PROJECTION_KEYS as readonly string[]).includes(key)) return;
    this.forwardProjection({ key, view: value } as SessionProjectionPayload);
  }

  /**
   * dsh-goal's activation edge (P1-7a): this session's only, once
   * bootstrapped — the baseline read covers what came before.
   */
  private onGoalActivationChanged(edge: DshGoalActivationChanged | undefined): void {
    if (this.disposed || !this.result || !edge || edge.sessionId !== this.dshSessionId) return;
    this.forwardProjection({ key: 'goalActivation', view: goalActivationFromEdge(edge) });
  }

  /** One key's new value; a change that finds the baseline still waiting joins it and sends it. */
  private forwardProjection(payload: SessionProjectionPayload): void {
    const baseline = this.projectionBaseline;
    if (baseline) {
      this.projectionBaseline = baseline.some((entry) => entry.key === payload.key)
        ? baseline.map((entry) => (entry.key === payload.key ? payload : entry))
        : [...baseline, payload];
      this.flushProjectionBaseline();
      return;
    }
    this.emitNow({ type: 'session.projection', payload });
  }

  /**
   * P1-7b: `tools/execute` for a call of this session's own agent (not a
   * delegate's, not a program's sub-dispatch). On the way in: the row's
   * `execStartedAt` — the approval is behind it, so the clock no longer
   * counts the wait (decision 099 rule 15, T146) — and the call's shell job
   * or delegation opens; on the way out, DSH's execution-local value (never
   * logged) says what became of them. Nothing here may fail the call.
   */
  private async aroundExecute(
    exec: DshToolDispatch,
    next: () => Promise<DshToolOutcome>
  ): Promise<DshToolOutcome> {
    if (
      this.disposed ||
      !exec ||
      exec.agent?.id !== this.dshSessionId ||
      exec.parent !== undefined ||
      typeof exec.callId !== 'string'
    ) {
      return next();
    }
    const { callId, name } = exec;
    try {
      this.live.onExecStarted(callId, this.now());
      this.jobs.beginCall(callId, name, exec.arguments);
      this.children.beginCall(callId, name, exec.arguments);
    } catch (error) {
      this.options.log?.('[dsh-bridge] call start not followed', name, error);
    }
    let outcome: DshToolOutcome | undefined;
    try {
      outcome = await next();
      return outcome;
    } finally {
      const value = outcome && !outcome.isError ? outcome.value : undefined;
      try {
        // P1-7c: the job a background or promoted call left, for its row.
        this.live.onExecEnded(callId, value);
        this.jobs.endCall(callId, value);
        this.children.endCall(callId, value);
      } catch (error) {
        this.options.log?.('[dsh-bridge] call end not followed', name, error);
      }
    }
  }

  private listen(): void {
    // Once per runtime: a bootstrap retried after a failure must not double every event.
    if (this.listening) return;
    this.listening = true;
    const unsubscribe = this.ctx.get?.('sessionProjections')?.onChanged?.((session, key, value) => {
      // Called inside DSH's projection drive, which does not contain a throw.
      try {
        this.onProjectionChanged(session, key, value);
      } catch (error) {
        this.options.log?.('[dsh-bridge] projection change failed', key, error);
      }
    });
    if (unsubscribe) this.disposers.push(unsubscribe);
    this.disposers.push(
      this.ctx.on('session/event', (session, event) => {
        if (this.disposed || !session) return;
        if (session.id !== this.dshSessionId) {
          // P1-7b: a child of this session's, as lane rows (any other session's is ignored there).
          try {
            this.children.onChildEvent(session.id, event as DshChildEvent);
          } catch (error) {
            this.options.log?.('[dsh-bridge] subagent event failed', event.type, error);
          }
          return;
        }
        // The history first: the live translation reads the fold (usage steps, goal budget).
        try {
          this.historyCache.push(event);
        } catch (error) {
          this.options.log?.('[dsh-bridge] history fold failed', event.type, error);
        }
        try {
          this.live.onSessionEvent(event);
        } catch (error) {
          this.options.log?.('[dsh-bridge] session event failed', event.type, error);
        }
        try {
          this.children.onParentEvent(event as DshChildEvent);
        } catch (error) {
          this.options.log?.('[dsh-bridge] subagent catalog failed', error);
        }
      }),
      // P1-7b (decision 099 rule 15): around each call of the session's own
      // agent, past its approval — the stamp that starts the row's clock, the
      // job a shell call runs as, the child a delegation starts.
      this.ctx.on('tools/execute', (exec, next) => this.aroundExecute(exec, next)),
      // P1-7b: every session's subagent runs; each runtime keeps its children's.
      this.ctx.on('subagent/start', (info) => {
        try {
          if (!this.disposed) this.children.onRunStart(info);
        } catch (error) {
          this.options.log?.('[dsh-bridge] subagent start failed', error);
        }
      }),
      this.ctx.on('subagent/end', (info) => {
        try {
          if (!this.disposed) this.children.onRunEnd(info);
        } catch (error) {
          this.options.log?.('[dsh-bridge] subagent end failed', error);
        }
      }),
      this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent?.id !== this.dshSessionId || this.disposed) return;
        try {
          this.live.onStreamFrame(frame);
        } catch (error) {
          this.options.log?.('[dsh-bridge] stream frame failed', frame.type, error);
        }
      }),
      // P1-4d3: every runtime of the row hears every request; each claims its own.
      this.ctx.on('user-questions/request', (request, next) =>
        this.ownsQuestion(request) ? this.questions.ask(request) : next()
      ),
      // P1-7a: every session's activation edges; each runtime keeps its own.
      this.ctx.on('goal/activation-changed', (edge) => {
        try {
          this.onGoalActivationChanged(edge);
        } catch (error) {
          this.options.log?.('[dsh-bridge] goal activation change failed', error);
        }
      })
    );
  }
}
