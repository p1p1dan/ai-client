// Explicit `.ts` for the same reason as `./sessionHistory.ts` below: this is a
// VALUE import and the DSH bridge loads this file as source under Node's
// strip-types mode, where the ESM resolver does no extension search.
import {
  isSessionEffortLevel,
  type SessionAttachment,
  type SessionEffortLevel,
} from './agentHost.ts';
import type {
  PermissionDecisionId,
  RuntimeEvent,
  SessionProjectionKey,
  SessionProjectionPayload,
} from './runtimeEvents';
import {
  isPermissionGear,
  isRuntimePermissionSettings,
  type PermissionGear,
  type RuntimePermissionSettings,
} from './runtimePermission.ts';
// Explicit `.ts`: the DSH bridge loads this file as SOURCE under Node's type
// stripping in dev (as the native worker's source entry did), and Node's ESM
// resolver has no extension search. Type-only imports above are
// erased before that matters; a VALUE import without the suffix is what made
// every dev-mode session die with ERR_MODULE_NOT_FOUND. Keep any future value
// import from this file suffixed too.
import {
  type HistoryMessage,
  PI_SESSION_TREE_BACKEND_LIMIT,
  type PiLeafCheckpoint,
  type SessionHistoryPage,
  type SessionTreeSnapshot,
  type SubagentHistorySummary,
} from './sessionHistory.ts';
import type { SessionPermissionTier } from './sessionPermissionTier';

/**
 * Main ↔ utility worker RPC protocol.
 *
 * The generation is owned by a single Main-side WorkerSlot. Every request,
 * response, and event is tagged so messages from a retired utility process can
 * never be accepted by a replacement process attached to the same slot.
 */
export const WORKER_RPC_PROTOCOL_VERSION = 1 as const;

export interface WorkerRpcRequest<TType extends string = string, TPayload = unknown> {
  protocolVersion: typeof WORKER_RPC_PROTOCOL_VERSION;
  kind: 'request';
  generation: number;
  requestId: string;
  type: TType;
  payload: TPayload;
}

export interface WorkerRpcErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface WorkerRpcSuccessResponse<TResult = unknown> {
  protocolVersion: typeof WORKER_RPC_PROTOCOL_VERSION;
  kind: 'response';
  generation: number;
  requestId: string;
  ok: true;
  result: TResult;
}

export interface WorkerRpcErrorResponse {
  protocolVersion: typeof WORKER_RPC_PROTOCOL_VERSION;
  kind: 'response';
  generation: number;
  requestId: string;
  ok: false;
  error: WorkerRpcErrorPayload;
}

export type WorkerRpcResponse<TResult = unknown> =
  | WorkerRpcSuccessResponse<TResult>
  | WorkerRpcErrorResponse;

export interface WorkerRpcEvent<TType extends string = string, TPayload = unknown> {
  protocolVersion: typeof WORKER_RPC_PROTOCOL_VERSION;
  kind: 'event';
  generation: number;
  type: TType;
  payload: TPayload;
}

export type WorkerRpcMessage = WorkerRpcResponse | WorkerRpcEvent;

export type WorkerRuntimeEventMessage = WorkerRpcEvent<'runtime.event', RuntimeEvent>;

export interface WorkerBootstrapPayload {
  logicalSessionId: string;
  cwd: string;
  /** Reopen this exact durable Pi session after a worker-generation restart. */
  sessionFile?: string;
  model?: string;
  effort?: SessionEffortLevel;
  /**
   * T025 removed `leafCheckpoint` from this payload. Main persisted the active
   * leaf, sent it back on every spawn, and the RPC server compared it for
   * bootstrap idempotence — but the only engine that ever read it went with
   * P6-5. The native runtime records the active leaf as a `kind: 'lane'` row in
   * the session file itself and resolves it on open, so the field carried no
   * information in either direction while still being able to make a repeat
   * bootstrap look like a different session. Main still keeps its own copy for
   * the session index (`piLeaf`); it just no longer crosses the wire.
   */
  /**
   * U05-c — this session runs in a throwaway scratch directory, not a project
   * the user chose. Set by Main (never by the renderer) and one-way: it can
   * only WITHDRAW project trust, never grant it, so a scratch session cannot
   * accumulate persistent project-scoped permission grants.
   */
  unbound?: boolean;
  /**
   * concurrency-02 — open the session even though its writer lock still looks
   * held.
   *
   * Set by Main, never by a worker, and only ever sent as `true`: absent is the
   * default open, the one that REFUSES a session another writer holds. Only
   * meaningful alongside `sessionFile` (a resume) — a freshly created session
   * has no lock to take from anyone. This is what an explicit "open it anyway"
   * acts through, for the one case no automatic rule can settle: a pid recycled
   * on a machine that has not rebooted since (see `writerLock.ts`).
   */
  forceTakeover?: boolean;
  /**
   * U12 fix — the session permission tier this worker must START on.
   *
   * `worker.setPermissionTier` can only reach a worker that already exists, so
   * a tier the user picked BEFORE the first send had nowhere to go, and a
   * worker respawned after a crash came back on the hardcoded default. Both
   * left the composer chip claiming a tier the runtime was not enforcing, and
   * both erred towards the more permissive side. Seeding it here closes the
   * window entirely: there is no gate the worker can answer before this value
   * is in place. Absent = the default tier.
   */
  tier?: SessionPermissionTier;
  permissions?: RuntimePermissionSettings;
}

export interface WorkerHistoryResult {
  logicalSessionId: string;
  sessionFile: string;
  workspacePath: string;
  page: SessionHistoryPage;
  /**
   * P5-2-6 — delegations recorded on this branch.
   *
   * Rides the history read rather than a channel of its own because it answers
   * the same question at the same moment: what did this conversation contain.
   * Absent on the legacy backend, which records no delegations of its own.
   */
  subagents?: SubagentHistorySummary[];
}

/**
 * T026 — what this session's own runtime brought up, for the sidebar panel.
 *
 * ## Why this replaced the pi extension list
 *
 * The panel used to show `extensions`: what pi loaded from the user's
 * `settings.json`. P6-5 retired the engine that loaded them, so the field had
 * no producer left and the panel reported "0 plugins" for every session
 * (cutover-03) while the user's installed extensions kept working in the
 * built-in terminal. This reports OUR capabilities instead — the ones a session
 * really has.
 *
 * ## Every member is optional, and absent is not zero
 *
 * A graph built without MCP has no MCP producer at all, which is a different
 * statement from "MCP ran and found no servers". The first must render as "not
 * reported", the second as "none configured"; collapsing them is how a panel
 * tells someone their working setup is empty. Consumers get that distinction
 * from `undefined` vs `[]` / `0`.
 *
 * The DSH engine reports `skills` alone (dsh-rebase decisions 099 rule 12 and
 * 113): it has no MCP bridge yet (decision 090), no prompt templates (decision
 * 103) and loads no custom sub-agent definitions (decisions 062 / 070). The
 * `mcpServers`, `promptTemplates` and `subagents` members only the 1.0.x
 * runtime produced left with it (P1-12 step 3, decision 116 rule 21).
 */
export interface WorkerCapabilityInventory {
  /** Discovered skills. Absent when discovery never ran. */
  skills?: number;
}

/**
 * R02-a — one slash command available in a session.
 *
 * Three kinds arrive as one list because pi dispatches all three from the same
 * place: `session.prompt()` expands skills and prompt templates and dispatches
 * extension commands, and it does so by default (we never pass
 * `expandPromptTemplates: false`). So the execution path is already live; this
 * type exists so the UI can *show* what is available.
 *
 * Named without the leading slash, matching pi's own `invocationName`. Skills
 * carry pi's `skill:` prefix in the name itself — that prefix is what
 * `_expandSkillCommand` matches on, so stripping it here would produce a
 * command the runtime does not recognise.
 *
 * The DSH engine (dsh-rebase P1-4d2, decisions 099 rule 9 and 101) lists its
 * own commands (`command`) and the user-invocable skills by their bare name
 * (`skill`): DSH runs a skill for `/<name>` anywhere in a message, and has no
 * `skill:` spelling and no prompt templates (decision 103).
 */
export interface WorkerSlashCommandInfo {
  /** Invocation name without the leading slash; pi's skills read `skill:<name>`, DSH's `<name>`. */
  name: string;
  description?: string;
  /**
   * Deliberately `string` and not a union: this crosses a version boundary (an
   * older build must survive a value a newer runtime introduces), and a second
   * copy of the runtime's vocabulary here is how a layer starts rejecting words
   * the runtime accepts. Known values: `command` (DSH), `skill`, and 1.0.x's
   * `extension`, `prompt`.
   */
  source: string;
  /** Absolute path pi resolved it from, when it reported one. */
  path?: string;
  /** `sourceInfo.scope` — user / project / temporary. */
  scope?: string;
}

/**
 * Cap so a pathological configuration cannot push an unbounded list over RPC.
 *
 * Set well above the 64 the retired pi extension inventory used, because skills
 * legitimately outnumber plugins — one package can publish many, and
 * `~/.agents/skills` is shared across every agent on the machine.
 */
export const WORKER_COMMAND_INVENTORY_MAX = 256;

export interface WorkerCommandsPayload {
  logicalSessionId: string;
}

/**
 * R02-c — manual context compaction, the `/compact` command.
 *
 * pi's own `compact()` aborts the running turn first and never resumes it, so
 * this is a mutation like rewind, not a read.
 */
export interface WorkerCompactPayload {
  logicalSessionId: string;
  /** The DSH engine takes none: see {@link WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED}. */
  instructions?: string;
}

/**
 * dsh-rebase decisions 099 rule 10 and 113: DSH's `/compact` takes no
 * arguments, so a `worker.compact` carrying non-empty `instructions` is
 * refused before anything runs. Nothing was compacted; the same request is
 * refused the same way every time.
 */
export const WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED = 'WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED';

/**
 * The two halves of `/compact`'s clock, kept together so they cannot drift.
 *
 * Compaction is one full provider request made inside the worker's serialized
 * RPC chain, so it needs a budget of the same order as a cold start rather than
 * the 10s warm-request default. The order of the two numbers is the contract:
 * the worker aborts its own summary FIRST, and only then does Main stop
 * waiting. If Main gave up first it would tell the user the compaction failed
 * while the worker was still on its way to writing the summary to the session
 * file — a disagreement between the screen and the disk that survives into the
 * next resume.
 */
export const WORKER_COMPACT_BUDGET_MS = 45_000;
export const WORKER_COMPACT_REQUEST_TIMEOUT_MS = 60_000;

export interface WorkerCompactResult {
  compacted: true;
  /**
   * dsh-rebase P1-7e (decision 140): the context-summary row the compaction
   * wrote, exactly as the session's history shows it (same `h:` id), so the
   * window can show it the moment `/compact` succeeds instead of on the next
   * reopen; a later history replay replaces it by that id. Absent when the
   * worker could not read it back. Optional-field addition.
   */
  summary?: HistoryMessage;
}

/**
 * dsh-rebase P1-7a (decisions 072 rule 2, 118): one DSH command run out of
 * band — the goal bar's pause, resume, edit and clear are `/goal …` lines.
 * Unlike a command send (`worker.send`, decision 113) it opens no turn, emits
 * no event and is not refused while a turn runs: a pause is meant for the
 * round that is running. Only a line naming a command the session offers is
 * run; hidden and window-owned ones (`/compact`) are refused.
 */
export interface WorkerCommandPayload {
  logicalSessionId: string;
  /** The whole command line, `/name` first (`/goal pause`). */
  line: string;
}

/** Longest command line `worker.command` takes (a goal objective can be long). */
export const WORKER_COMMAND_LINE_MAX = 16_384;

/**
 * DSH's answer: `ok` with the text it printed, or not `ok` with its reason
 * (a goal in the wrong state, say). Either way the command ran to its end.
 */
export type WorkerCommandResult = { ok: true; output?: string } | { ok: false; error: string };

/** `worker.command`: the line names no command this session offers (or one it may not run). */
export const WORKER_COMMAND_UNKNOWN = 'WORKER_COMMAND_UNKNOWN';
/** `worker.command`: the command outlived {@link WORKER_COMMAND_BUDGET_MS} and was cancelled. */
export const WORKER_COMMAND_TIMEOUT = 'WORKER_COMMAND_TIMEOUT';
/** The worker's own budget for one command, inside Main's warm 10 s request timeout. */
export const WORKER_COMMAND_BUDGET_MS = 8_000;

/**
 * dsh-rebase P1-7a (decisions 113, 118): the panels' current values, asked by
 * a renderer that was not listening when the bridge sent them — a reload, a
 * chat switched to, a session reopened with no event since (the bootstrap's
 * snapshot waits for the first event, decision 113 rule 12). A read: no turn,
 * no event, never refused for a running turn.
 */
export interface WorkerPanelsPayload {
  logicalSessionId: string;
}

export interface WorkerPanelsResult {
  /**
   * One entry per key the host has; `goalActivation` always (`null` with no
   * goal) and `jobs` always (empty with none).
   */
  projections: SessionProjectionPayload[];
}

/**
 * dsh-rebase P1-7b (decisions 069, 119): stop one background job of the
 * session from its window — a command, a one-shot subagent, a workflow. DSH's
 * own `job_kill` path (`ctx.jobs.kill`), fenced by the session's ownership;
 * the job settles `killed` once its work actually stops. A continuable
 * subagent is interrupted instead ({@link WorkerSubagentInterruptPayload}).
 */
export interface WorkerJobKillPayload {
  logicalSessionId: string;
  /** The registry's id (`bash-3`). */
  jobId: string;
}

export interface WorkerJobKillResult {
  /** `requested` for live work; `already-finished` for a job that had settled. */
  outcome: 'requested' | 'already-finished';
}

/**
 * dsh-rebase P1-7b (decision 119): output of one job of the session, read
 * without moving the model's cursor (`ctx.jobs.readAt`). Without `from`, the
 * newest `maxBytes`; with it, what came after `from` (a previous `next`),
 * newest `maxBytes` at most.
 */
export interface WorkerJobReadPayload {
  logicalSessionId: string;
  jobId: string;
  /** Absolute byte offset to read from; omitted for the tail. */
  from?: number;
  /** At most this many bytes (default {@link WORKER_JOB_READ_DEFAULT_BYTES}). */
  maxBytes?: number;
}

export interface WorkerJobReadResult {
  /** The output from `from` to `next`, as the job wrote it. */
  text: string;
  /** Absolute offset of the first byte of `text`. */
  from: number;
  /** The offset to ask from next time: the job's total so far. */
  next: number;
  /** Bytes before `from` that were asked for (or retained) and are not here. */
  omittedBytes: number;
  /** The ring had dropped bytes the read asked for. */
  lossy: boolean;
  /** Files that keep the job's complete output, when its sources keep any. */
  spillPaths?: string[];
}

/** Default and ceiling of one `worker.job.read` (UTF-8 bytes). */
export const WORKER_JOB_READ_DEFAULT_BYTES = 16_384;
export const WORKER_JOB_READ_MAX_BYTES = 65_536;

/**
 * dsh-rebase P1-7b (decisions 069, 119): interrupt the current run of one
 * continuable subagent of the session, as its human parent (DSH's
 * `subagents.interrupt(childId, {kind: 'user'})`). The child keeps its
 * session and can be continued; an idle or unknown child is a no-op.
 */
export interface WorkerSubagentInterruptPayload {
  logicalSessionId: string;
  /** The child's DSH session id. */
  childId: string;
}

export interface WorkerSubagentInterruptResult {
  /** The cancel signal went out (the child may take a moment to stop). */
  interrupted: boolean;
}

/** `worker.job.kill` / `worker.job.read`: no job of this session has the id. */
export const WORKER_JOB_UNKNOWN = 'WORKER_JOB_UNKNOWN';
/** `worker.job.*` / `worker.subagent.interrupt`: the host composes no job registry or subagent service. */
export const WORKER_JOBS_UNAVAILABLE = 'WORKER_JOBS_UNAVAILABLE';

export interface WorkerCommandsResult {
  commands: WorkerSlashCommandInfo[];
  /** True when the list was truncated at {@link WORKER_COMMAND_INVENTORY_MAX}. */
  truncated: boolean;
}

export interface WorkerBootstrapResult {
  bootstrapped: true;
  logicalSessionId: string;
  piSessionId: string;
  cwd: string;
  agentDir: string;
  sessionFile?: string;
  /**
   * The file this session was converted from, when bootstrap could not open the
   * requested file in place.
   *
   * A pre-v4 session is not writable as-is: the native runtime converts it and
   * opens the copy, so `sessionFile` is legitimately not the file Main asked
   * for. This names the source so Main can tell that declared redirect apart
   * from a worker that silently opened the wrong session — see
   * `worker_resume_identity_mismatch`.
   *
   * Not validated by `isWorkerBootstrapResult`, for the reason given on
   * `capabilities`: the consumer already rejects anything it cannot normalize,
   * and a malformed value should fail one legacy resume rather than make the
   * whole bootstrap payload illegal.
   */
  sessionSourceFile?: string;
  /** Present only when bootstrap opened an existing exact Pi session file. */
  initialHistory?: WorkerHistoryResult;
  leaf: PiLeafCheckpoint;
  model?: string;
  effort?: SessionEffortLevel;
  projectTrusted: boolean;
  permissionGate: 'bundled' | 'user_configured';
  /**
   * T026 — what this session's own runtime brought up.
   *
   * Optional, and NOT validated by `isWorkerBootstrapResult` below. That guard
   * is release-critical: it decides whether an entire bootstrap payload is
   * legal, so a strict check here would turn a malformed panel list into a
   * session that cannot start at all (the failure mode U08-2 hit with
   * `isWorkerEffort`). {@link normalizeWorkerCapabilities} is the check
   * instead: it runs where the value is READ, drops anything it cannot make
   * sense of, and leaves the session alone.
   */
  capabilities?: WorkerCapabilityInventory;
}

export type WorkerBootstrapRequest = WorkerRpcRequest<'worker.bootstrap', WorkerBootstrapPayload>;
export interface WorkerSendPayload {
  logicalSessionId: string;
  /** Product turn identity. Distinct from the transport RPC requestId. */
  requestId: string;
  /** Renderer-owned identity for pending-user reconciliation. */
  attemptId: string;
  text: string;
  attachments?: SessionAttachment[];
  model?: string;
  effort?: SessionEffortLevel;
  /**
   * T135 / decision 045 — `'retry'` re-runs the last turn from the context
   * before its failure instead of sending `text`: no user message is added.
   * `text` must then be empty and `attachments` absent. A worker with no
   * cut-short turn to re-run refuses with {@link WORKER_RETRY_UNAVAILABLE}.
   */
  mode?: 'retry';
}

/**
 * The worker's refusal of a `mode: 'retry'` send that found nothing to re-run:
 * the branch's last turn completed, or was never recorded. No run started and
 * no event was emitted — the session is exactly as it was.
 */
export const WORKER_RETRY_UNAVAILABLE = 'WORKER_RETRY_UNAVAILABLE';

/**
 * dsh-rebase P1-4c2 (decision 096): the engine refused an attachment of a
 * send or an interjection — an image DSH will not admit (format, size, pixels,
 * bytes that are not the declared type), or a file it could not store. Nothing
 * was sent and no event was emitted. The message reads
 * `<DSH code> "<file name>": <DSH sentence>`, the name JSON-quoted and absent
 * when no single attachment is to blame (too many images, too many bytes).
 */
export const WORKER_ATTACHMENT_REJECTED = 'WORKER_ATTACHMENT_REJECTED';

export interface WorkerSendResult {
  accepted: true;
  requestId: string;
}

export interface WorkerHistoryPayload {
  logicalSessionId: string;
  offset?: number;
  limit?: number;
}

export interface WorkerTreePayload {
  logicalSessionId: string;
}

export interface WorkerTreeResult {
  snapshot: SessionTreeSnapshot;
}

export interface WorkerRewindPayload {
  logicalSessionId: string;
  targetEntryId: string;
  confirmed: true;
}

/**
 * dsh-rebase P1-4b (decision 027 rule 3): a DSH rewind retires the agent the
 * session runs on, and a background job of that agent would end with it, so
 * the worker refuses while one runs. Nothing changed; retry once it settles.
 */
export const WORKER_REWIND_JOBS_RUNNING = 'WORKER_REWIND_JOBS_RUNNING';

export interface WorkerRewindResult {
  logicalSessionId: string;
  sessionFile: string;
  workspacePath: string;
  targetEntryId: string;
  editorText?: string;
  leaf: PiLeafCheckpoint;
  history: WorkerHistoryResult;
  tree: WorkerTreeResult;
}

export interface WorkerForkPayload {
  logicalSessionId: string;
  entryId: string;
  /**
   * dsh-rebase P1-4b (decision 027 rule 4): the logical id Main minted for the
   * fork before asking, so a DSH worker names the child session after it
   * (`aiclient-<id>`) and a lost stub can still be found from the id. The
   * native runtime ignores it.
   */
  targetLogicalSessionId?: string;
}

export interface WorkerForkResult {
  logicalSessionId: string;
  sourceSessionFile: string;
  sessionFile: string;
  piSessionId: string;
  workspacePath: string;
  leaf: PiLeafCheckpoint;
  history: WorkerHistoryResult;
}

export interface WorkerDiscardForkPayload {
  logicalSessionId: string;
  sessionFile: string;
}

export interface WorkerDiscardForkResult {
  discarded: boolean;
}

/**
 * The commit half of the fork state machine (session-index-04).
 *
 * A fork's transcript is written by the SOURCE worker before Main knows whether
 * it will become a session, so the source keeps it in an "uncommitted artifact"
 * table that authorises `worker.fork.discard` to delete it. Once the index row
 * lands, the file belongs to a real session and that authorisation has to be
 * withdrawn — otherwise any later discard caller is free to delete a chat the
 * user is already using.
 */
export interface WorkerAcceptForkPayload {
  logicalSessionId: string;
  sessionFile: string;
}

export interface WorkerAcceptForkResult {
  /** False when this worker did not stage that file — a no-op, not an error. */
  accepted: boolean;
}

/**
 * Suffix of the sidecar file that marks a fork transcript as staged
 * (session-index-09).
 *
 * The in-memory tables above die with the process, so a crash between "the
 * transcript exists" and "the index row exists" used to leave a full copy of a
 * conversation in the session directory that nothing pointed at and no surface
 * could delete. The marker is written BEFORE the transcript and removed when
 * the fork is adopted or discarded, which lets Main's startup sweep recognise
 * the leftovers. Deliberately not `.jsonl`, so nothing that lists session files
 * picks it up.
 */
export const STAGED_FORK_MARKER_SUFFIX = '.staged' as const;

export interface WorkerStopPayload {
  logicalSessionId: string;
  reason: 'user' | 'dispose';
}

export interface WorkerStopResult {
  stopped: boolean;
}

/**
 * Ctrl+Enter while a turn runs (dsh-rebase decision 093): the message itself.
 * The worker hands it to the running turn, which takes it in at its next step
 * boundary and carries on — nothing is stopped. Its user echo
 * (`message.started`, role user) carries `attemptId` once the turn took it in;
 * until then the renderer shows it as awaiting delivery.
 */
export interface WorkerInterjectPayload {
  logicalSessionId: string;
  /** Renderer-owned identity of this message, echoed on its `message.started`. */
  attemptId: string;
  text: string;
  /**
   * Same shape as a send's, admitted through the same entry (P1-4c2): an
   * attachment the engine refuses answers {@link WORKER_ATTACHMENT_REJECTED}
   * and nothing is steered.
   */
  attachments?: SessionAttachment[];
}

export interface WorkerInterjectResult {
  /**
   * The running turn took the message. False when no turn was running: nothing
   * was sent, and the caller sends it the ordinary way.
   */
  interjected: boolean;
  /**
   * decision 046 — whether the worker holds a turn at all. `false` lets Main
   * drop a busy latch the worker no longer backs; absent means "not reported".
   */
  turnActive?: boolean;
}

/**
 * GitHub issue #8 (dsh-rebase decision 172 §4): take back a Ctrl+Enter
 * message before a turn takes it in — including one a Stop left waiting
 * (decision 094). The worker removes it from DSH's inbox
 * (`Agent.inbox.remove`); the turn's next-step claim cannot race that, as
 * both run on the host's one thread.
 */
export interface WorkerInterjectWithdrawPayload {
  logicalSessionId: string;
  /** The attempt id the interjection was sent with. */
  attemptId: string;
}

/**
 * - `withdrawn`: it left the inbox; it never reaches the model and never echoes.
 * - `delivered`: a turn took it in already; its echo is out or on its way.
 * - `not_found`: this worker does not know it — the engine connection it was
 *   handed to is gone (a restart, a release), or a rewind moved the chat on.
 */
export type WorkerInterjectWithdrawOutcome = 'withdrawn' | 'delivered' | 'not_found';

export interface WorkerInterjectWithdrawResult {
  outcome: WorkerInterjectWithdrawOutcome;
}

/**
 * The user's answer to one `permission.requested` event.
 *
 * Keyed by the `permissionId` the timeline block and the pending queue already
 * carry, because a permission is the runtime's own gate. It used to share this
 * lane with the Extension UI dialog channel (retired by decision 012), and
 * routing permissions through that channel is what made the card a field dump —
 * see the permission card work of 2026-09-10.
 */
export interface WorkerPermissionRespondPayload {
  logicalSessionId: string;
  permissionId: string;
  decision: PermissionDecisionId;
}

export interface WorkerPermissionRespondResult {
  /**
   * `false` when nothing was waiting on this id — an answer that arrived after
   * the gate timed out, was aborted, or was already settled. Not an error: the
   * renderer's card can legitimately be a moment behind the runtime.
   */
  handled: boolean;
}

/**
 * F5 — the user's answer to one `question.requested`.
 *
 * A separate channel from the permission answer, for the same reason the two
 * are separate: different question, different lifetime, different id space. A
 * question is the `ask` tool's own, keyed by the `questionId` the card and the
 * timeline block already carry.
 *
 * `answers` and `response` are exclusive, and `cancel` beats both — the card's
 * Skip is not a refusal, it is "decide this yourself", which is why it has to
 * be distinguishable from an empty answers map.
 */
export interface WorkerQuestionRespondPayload {
  logicalSessionId: string;
  questionId: string;
  /** Opaque agent-supplied key -> answer; multi-select joined with ", ". */
  answers?: Record<string, string>;
  /** Freeform text typed instead of picking options. */
  response?: string;
  /** The card's Skip. Settles the question without an answer. */
  cancel?: boolean;
}

export interface WorkerQuestionRespondResult {
  /** `false` when nothing was waiting on this id. Same meaning as above. */
  handled: boolean;
}

/**
 * P5-2-3 — Main telling the worker what happened to one `preview.requested`.
 *
 * The only one of these three answers that no human sees: Main opens the window
 * and reports. `ok: false` with a reason is a real outcome rather than an edge
 * case — a host with no preview surface, a window the user just closed, a file
 * Chromium refused — and the reason becomes the tool error the model reads, so
 * it can stop retrying a preview that cannot work here.
 */
export interface WorkerPreviewRespondPayload {
  logicalSessionId: string;
  previewId: string;
  ok: boolean;
  /** Why it could not be shown. Required in spirit whenever `ok` is false. */
  error?: string;
}

export interface WorkerPreviewRespondResult {
  /** `false` when nothing was waiting on this id. Same meaning as above. */
  handled: boolean;
}

export interface WorkerSetPermissionTierPayload {
  logicalSessionId: string;
  tier: SessionPermissionTier;
}

export interface WorkerSetPermissionTierResult {
  applied: boolean;
}

export type WorkerSendRequest = WorkerRpcRequest<'worker.send', WorkerSendPayload>;

export type WorkerHistoryRequest = WorkerRpcRequest<'worker.history', WorkerHistoryPayload>;
export type WorkerTreeRequest = WorkerRpcRequest<'worker.tree', WorkerTreePayload>;
export type WorkerCommandsRequest = WorkerRpcRequest<'worker.commands', WorkerCommandsPayload>;
export type WorkerCompactRequest = WorkerRpcRequest<'worker.compact', WorkerCompactPayload>;
export type WorkerCommandRequest = WorkerRpcRequest<'worker.command', WorkerCommandPayload>;
export type WorkerPanelsRequest = WorkerRpcRequest<'worker.panels', WorkerPanelsPayload>;
export type WorkerJobKillRequest = WorkerRpcRequest<'worker.job.kill', WorkerJobKillPayload>;
export type WorkerJobReadRequest = WorkerRpcRequest<'worker.job.read', WorkerJobReadPayload>;
export type WorkerSubagentInterruptRequest = WorkerRpcRequest<
  'worker.subagent.interrupt',
  WorkerSubagentInterruptPayload
>;
export type WorkerRewindRequest = WorkerRpcRequest<'worker.rewind', WorkerRewindPayload>;
export type WorkerForkRequest = WorkerRpcRequest<'worker.fork', WorkerForkPayload>;
export type WorkerDiscardForkRequest = WorkerRpcRequest<
  'worker.fork.discard',
  WorkerDiscardForkPayload
>;
export type WorkerAcceptForkRequest = WorkerRpcRequest<
  'worker.fork.accept',
  WorkerAcceptForkPayload
>;
export type WorkerStopRequest = WorkerRpcRequest<'worker.stop', WorkerStopPayload>;
export type WorkerInterjectRequest = WorkerRpcRequest<'worker.interject', WorkerInterjectPayload>;
export type WorkerInterjectWithdrawRequest = WorkerRpcRequest<
  'worker.interject.withdraw',
  WorkerInterjectWithdrawPayload
>;
export type WorkerPermissionRespondRequest = WorkerRpcRequest<
  'worker.permission.respond',
  WorkerPermissionRespondPayload
>;
export type WorkerPreviewRespondRequest = WorkerRpcRequest<
  'worker.preview.respond',
  WorkerPreviewRespondPayload
>;
export type WorkerSetPermissionTierRequest = WorkerRpcRequest<
  'worker.setPermissionTier',
  WorkerSetPermissionTierPayload
>;

export type WorkerDisposeRequest = WorkerRpcRequest<
  'worker.dispose',
  { reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace' }
>;

export interface WorkerDisposeResult {
  disposed: true;
}

/**
 * U08-2: this used to restate the level words, so a payload carrying Pi's `off`
 * or `minimal` failed the whole bootstrap guard and the worker never started.
 * The vocabulary now has exactly one definition.
 */
const isWorkerEffort = isSessionEffortLevel;

export function isWorkerBootstrapPayload(value: unknown): value is WorkerBootstrapPayload {
  if (!isRecord(value)) return false;
  if (
    typeof value.logicalSessionId !== 'string' ||
    value.logicalSessionId.trim().length === 0 ||
    typeof value.cwd !== 'string' ||
    value.cwd.trim().length === 0
  ) {
    return false;
  }
  if (
    value.sessionFile !== undefined &&
    (typeof value.sessionFile !== 'string' || value.sessionFile.trim().length === 0)
  ) {
    return false;
  }
  if (
    value.model !== undefined &&
    (typeof value.model !== 'string' || value.model.trim().length === 0)
  ) {
    return false;
  }
  if (value.effort !== undefined && !isWorkerEffort(value.effort)) return false;
  if (value.permissions !== undefined && !isRuntimePermissionSettings(value.permissions))
    return false;
  if (value.unbound !== undefined && typeof value.unbound !== 'boolean') return false;
  if (value.forceTakeover !== undefined && typeof value.forceTakeover !== 'boolean') return false;
  if (
    value.tier !== undefined &&
    (typeof value.tier !== 'string' || !VALID_TIERS.has(value.tier))
  ) {
    return false;
  }
  return true;
}

function isSessionHistoryPage(value: unknown): value is SessionHistoryPage {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false;
  if (
    !Number.isSafeInteger(value.offset) ||
    Number(value.offset) < 0 ||
    !Number.isSafeInteger(value.limit) ||
    Number(value.limit) < 1 ||
    Number(value.limit) > 500 ||
    !Number.isSafeInteger(value.totalCount) ||
    Number(value.totalCount) < 0 ||
    typeof value.hasMore !== 'boolean'
  ) {
    return false;
  }
  return value.messages.every(
    (message) =>
      isRecord(message) &&
      typeof message.id === 'string' &&
      message.id.startsWith('h:') &&
      (message.role === 'user' || message.role === 'assistant' || message.role === 'system') &&
      Array.isArray(message.blocks)
  );
}

export function isWorkerHistoryResult(value: unknown): value is WorkerHistoryResult {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    value.logicalSessionId.trim().length > 0 &&
    typeof value.sessionFile === 'string' &&
    value.sessionFile.trim().length > 0 &&
    typeof value.workspacePath === 'string' &&
    value.workspacePath.trim().length > 0 &&
    isSessionHistoryPage(value.page)
  );
}

export function isWorkerBootstrapResult(value: unknown): value is WorkerBootstrapResult {
  if (!isRecord(value)) return false;
  if (
    value.bootstrapped !== true ||
    typeof value.logicalSessionId !== 'string' ||
    value.logicalSessionId.trim().length === 0 ||
    typeof value.piSessionId !== 'string' ||
    value.piSessionId.trim().length === 0 ||
    typeof value.cwd !== 'string' ||
    value.cwd.trim().length === 0 ||
    typeof value.agentDir !== 'string' ||
    value.agentDir.trim().length === 0 ||
    typeof value.projectTrusted !== 'boolean' ||
    (value.permissionGate !== 'bundled' && value.permissionGate !== 'user_configured') ||
    !isPiLeafCheckpoint(value.leaf)
  ) {
    return false;
  }
  if (
    value.sessionFile !== undefined &&
    (typeof value.sessionFile !== 'string' || value.sessionFile.trim().length === 0)
  ) {
    return false;
  }
  if (
    value.model !== undefined &&
    (typeof value.model !== 'string' || value.model.trim().length === 0)
  ) {
    return false;
  }
  if (value.effort !== undefined && !isWorkerEffort(value.effort)) return false;
  if (value.initialHistory !== undefined && !isWorkerHistoryResult(value.initialHistory)) {
    return false;
  }
  // `capabilities` is deliberately not checked here — see the field's own note.
  // A panel list that cannot be parsed must cost the panel, not the session.
  return true;
}

function normalizeCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

/**
 * T026 — read a bootstrap result's capability inventory, or `null`.
 *
 * `null` means "nothing reported one", which every consumer renders as "not
 * reported" rather than as an empty setup. A count that cannot be parsed is
 * dropped rather than allowed to abort the session — which is why this lives
 * here and not in {@link isWorkerBootstrapResult}. Members the 1.0.x runtime
 * also reported (MCP servers, templates, sub-agent definitions) are ignored.
 */
export function normalizeWorkerCapabilities(value: unknown): WorkerCapabilityInventory | null {
  if (!isRecord(value)) return null;
  const skills = normalizeCount(value.skills);
  const inventory: WorkerCapabilityInventory = {
    ...(skills !== undefined ? { skills } : {}),
  };
  // An object with nothing readable in it is not a report.
  return Object.keys(inventory).length > 0 ? inventory : null;
}

function isAttachment(value: unknown): value is SessionAttachment {
  if (!isRecord(value)) return false;
  if (value.kind !== 'image' && value.kind !== 'text') return false;
  if (typeof value.mediaType !== 'string' || typeof value.data !== 'string') return false;
  return value.name === undefined || typeof value.name === 'string';
}

export function isWorkerSendPayload(value: unknown): value is WorkerSendPayload {
  if (!isRecord(value)) return false;
  if (
    typeof value.logicalSessionId !== 'string' ||
    value.logicalSessionId.trim().length === 0 ||
    typeof value.requestId !== 'string' ||
    value.requestId.trim().length === 0 ||
    typeof value.attemptId !== 'string' ||
    value.attemptId.trim().length === 0 ||
    typeof value.text !== 'string'
  ) {
    return false;
  }
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || !value.attachments.every(isAttachment)) return false;
  }
  if (
    value.model !== undefined &&
    (typeof value.model !== 'string' || value.model.trim().length === 0)
  ) {
    return false;
  }
  // T135: a retry carries no prompt of its own, so one that does is malformed
  // rather than a send the worker would have to pick a meaning for.
  if (
    value.mode !== undefined &&
    (value.mode !== 'retry' || value.text !== '' || value.attachments !== undefined)
  ) {
    return false;
  }
  return value.effort === undefined || isWorkerEffort(value.effort);
}

export function isWorkerSendResult(value: unknown): value is WorkerSendResult {
  return (
    isRecord(value) &&
    value.accepted === true &&
    typeof value.requestId === 'string' &&
    value.requestId.trim().length > 0
  );
}

function isPiLeafCheckpoint(value: unknown): value is PiLeafCheckpoint {
  return (
    isRecord(value) &&
    (value.activeEntryId === null || typeof value.activeEntryId === 'string') &&
    (value.fileTailEntryId === null || typeof value.fileTailEntryId === 'string')
  );
}

function isLogicalSessionPayload(
  value: unknown
): value is Record<string, unknown> & { logicalSessionId: string } {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    value.logicalSessionId.trim().length > 0
  );
}

function isSessionTreeSnapshot(value: unknown): value is SessionTreeSnapshot {
  if (
    !isRecord(value) ||
    typeof value.logicalSessionId !== 'string' ||
    typeof value.sessionFile !== 'string' ||
    typeof value.workspacePath !== 'string' ||
    !isPiLeafCheckpoint(value.leaf) ||
    !Array.isArray(value.nodes) ||
    !Number.isSafeInteger(value.totalNodes) ||
    Number(value.totalNodes) < 0 ||
    !Number.isSafeInteger(value.returnedNodes) ||
    Number(value.returnedNodes) < 0 ||
    Number(value.returnedNodes) > PI_SESSION_TREE_BACKEND_LIMIT ||
    typeof value.truncated !== 'boolean'
  ) {
    return false;
  }
  return (
    value.nodes.length === value.returnedNodes &&
    value.nodes.every((node) => {
      if (!isRecord(node)) return false;
      return (
        typeof node.id === 'string' &&
        (node.parentId === null || typeof node.parentId === 'string') &&
        Number.isSafeInteger(node.depth) &&
        Number(node.depth) >= 0 &&
        typeof node.entryType === 'string' &&
        Number.isSafeInteger(node.childCount) &&
        Number(node.childCount) >= 0 &&
        typeof node.forkable === 'boolean' &&
        typeof node.active === 'boolean' &&
        typeof node.leaf === 'boolean'
      );
    })
  );
}

export function isWorkerTreeResult(value: unknown): value is WorkerTreeResult {
  return isRecord(value) && isSessionTreeSnapshot(value.snapshot);
}

/**
 * R02-a — shape check for a command list.
 *
 * Rows are validated individually and bad ones are DROPPED, not made to fail
 * the whole response: this list is decoration for a completion menu, and one
 * malformed entry from a plugin should cost that entry, not the menu.
 */
export function isWorkerCommandsResult(value: unknown): value is WorkerCommandsResult {
  return isRecord(value) && Array.isArray(value.commands) && typeof value.truncated === 'boolean';
}

export function sanitizeWorkerCommandRows(value: unknown): WorkerSlashCommandInfo[] {
  if (!Array.isArray(value)) return [];
  const rows: WorkerSlashCommandInfo[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { name, source, description, path, scope } = entry;
    if (typeof name !== 'string' || name.trim().length === 0) continue;
    if (typeof source !== 'string' || source.trim().length === 0) continue;
    rows.push({
      name,
      source,
      ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
      ...(typeof path === 'string' && path.length > 0 ? { path } : {}),
      ...(typeof scope === 'string' && scope.length > 0 ? { scope } : {}),
    });
  }
  return rows.slice(0, WORKER_COMMAND_INVENTORY_MAX);
}

export function isWorkerHistoryPayload(value: unknown): value is WorkerHistoryPayload {
  if (
    !isRecord(value) ||
    typeof value.logicalSessionId !== 'string' ||
    value.logicalSessionId.trim().length === 0
  ) {
    return false;
  }
  if (
    value.offset !== undefined &&
    (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0)
  ) {
    return false;
  }
  if (
    value.limit !== undefined &&
    (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 500)
  ) {
    return false;
  }
  return true;
}

export function isWorkerTreePayload(value: unknown): value is WorkerTreePayload {
  return isLogicalSessionPayload(value);
}

export function isWorkerCommandsPayload(value: unknown): value is WorkerCommandsPayload {
  return isLogicalSessionPayload(value);
}

/** A command line: `/` first, within {@link WORKER_COMMAND_LINE_MAX}; the worker parses the rest. */
export function isWorkerCommandPayload(value: unknown): value is WorkerCommandPayload {
  return (
    isLogicalSessionPayload(value) &&
    typeof value.line === 'string' &&
    value.line.startsWith('/') &&
    value.line.length <= WORKER_COMMAND_LINE_MAX
  );
}

export function isWorkerCommandResult(value: unknown): value is WorkerCommandResult {
  if (!isRecord(value)) return false;
  if (value.ok === true) return value.output === undefined || typeof value.output === 'string';
  return value.ok === false && typeof value.error === 'string';
}

export function isWorkerPanelsPayload(value: unknown): value is WorkerPanelsPayload {
  return isLogicalSessionPayload(value);
}

/** Every key `worker.panels` may answer; a key added to the union must be added here. */
const PANEL_PROJECTION_KEYS: Readonly<Record<SessionProjectionKey, true>> = {
  todos: true,
  goal: true,
  subagentCatalog: true,
  goalActivation: true,
  jobs: true,
};

/**
 * The entries of a `worker.panels` answer Main passes on: a known key with a
 * view. A malformed answer costs the panels, never the session — the views
 * themselves are read defensively by the renderer, as the live events are.
 */
export function sanitizeWorkerPanels(value: unknown): WorkerPanelsResult {
  if (!isRecord(value) || !Array.isArray(value.projections)) return { projections: [] };
  const projections = value.projections.filter(
    (entry): entry is SessionProjectionPayload =>
      isRecord(entry) &&
      typeof entry.key === 'string' &&
      Object.hasOwn(PANEL_PROJECTION_KEYS, entry.key) &&
      'view' in entry
  );
  return { projections };
}

/** A job id as the registry mints them: `<kind>-N`, bounded. */
function isJobId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/u.test(value);
}

export function isWorkerJobKillPayload(value: unknown): value is WorkerJobKillPayload {
  return isLogicalSessionPayload(value) && isJobId(value.jobId);
}

export function isWorkerJobKillResult(value: unknown): value is WorkerJobKillResult {
  return isRecord(value) && (value.outcome === 'requested' || value.outcome === 'already-finished');
}

export function isWorkerJobReadPayload(value: unknown): value is WorkerJobReadPayload {
  if (!isLogicalSessionPayload(value) || !isJobId(value.jobId)) return false;
  if (value.from !== undefined && (!Number.isSafeInteger(value.from) || Number(value.from) < 0)) {
    return false;
  }
  return (
    value.maxBytes === undefined ||
    (Number.isSafeInteger(value.maxBytes) &&
      Number(value.maxBytes) >= 1 &&
      Number(value.maxBytes) <= WORKER_JOB_READ_MAX_BYTES)
  );
}

function isOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/**
 * A `worker.job.read` answer Main passes on, or null for a malformed one. The
 * text is clamped to twice the read ceiling (a worker never sends more; a
 * character can take up to four bytes, so this is generous) — a wrong answer
 * costs the output pane, never the window.
 */
export function sanitizeWorkerJobRead(value: unknown): WorkerJobReadResult | null {
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    !isOffset(value.from) ||
    !isOffset(value.next) ||
    !isOffset(value.omittedBytes) ||
    typeof value.lossy !== 'boolean'
  ) {
    return null;
  }
  const spillPaths = Array.isArray(value.spillPaths)
    ? value.spillPaths.filter((path): path is string => typeof path === 'string').slice(0, 8)
    : [];
  return {
    text: value.text.slice(-2 * WORKER_JOB_READ_MAX_BYTES),
    from: value.from,
    next: value.next,
    omittedBytes: value.omittedBytes,
    lossy: value.lossy,
    ...(spillPaths.length > 0 ? { spillPaths } : {}),
  };
}

export function isWorkerSubagentInterruptPayload(
  value: unknown
): value is WorkerSubagentInterruptPayload {
  return (
    isLogicalSessionPayload(value) &&
    typeof value.childId === 'string' &&
    value.childId.trim().length > 0 &&
    value.childId.length <= 256
  );
}

export function isWorkerSubagentInterruptResult(
  value: unknown
): value is WorkerSubagentInterruptResult {
  return isRecord(value) && typeof value.interrupted === 'boolean';
}

export function isWorkerCompactPayload(value: unknown): value is WorkerCompactPayload {
  return (
    isLogicalSessionPayload(value) &&
    (value.instructions === undefined || typeof value.instructions === 'string')
  );
}

export function isWorkerRewindPayload(value: unknown): value is WorkerRewindPayload {
  return (
    isLogicalSessionPayload(value) &&
    typeof value.targetEntryId === 'string' &&
    value.targetEntryId.trim().length > 0 &&
    value.confirmed === true
  );
}

export function isWorkerRewindResult(value: unknown): value is WorkerRewindResult {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    typeof value.sessionFile === 'string' &&
    typeof value.workspacePath === 'string' &&
    typeof value.targetEntryId === 'string' &&
    (value.editorText === undefined || typeof value.editorText === 'string') &&
    isPiLeafCheckpoint(value.leaf) &&
    isWorkerHistoryResult(value.history) &&
    isWorkerTreeResult(value.tree)
  );
}

export function isWorkerForkPayload(value: unknown): value is WorkerForkPayload {
  return (
    isLogicalSessionPayload(value) &&
    typeof value.entryId === 'string' &&
    value.entryId.trim().length > 0 &&
    (value.targetLogicalSessionId === undefined ||
      (typeof value.targetLogicalSessionId === 'string' &&
        value.targetLogicalSessionId.trim().length > 0))
  );
}

export function isWorkerForkResult(value: unknown): value is WorkerForkResult {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    typeof value.sourceSessionFile === 'string' &&
    typeof value.sessionFile === 'string' &&
    typeof value.piSessionId === 'string' &&
    typeof value.workspacePath === 'string' &&
    isPiLeafCheckpoint(value.leaf) &&
    isWorkerHistoryResult(value.history)
  );
}

export function isWorkerDiscardForkPayload(value: unknown): value is WorkerDiscardForkPayload {
  return (
    isLogicalSessionPayload(value) &&
    typeof value.sessionFile === 'string' &&
    value.sessionFile.trim().length > 0
  );
}

export function isWorkerDiscardForkResult(value: unknown): value is WorkerDiscardForkResult {
  return isRecord(value) && typeof value.discarded === 'boolean';
}

export function isWorkerAcceptForkPayload(value: unknown): value is WorkerAcceptForkPayload {
  return (
    isLogicalSessionPayload(value) &&
    typeof value.sessionFile === 'string' &&
    value.sessionFile.trim().length > 0
  );
}

export function isWorkerAcceptForkResult(value: unknown): value is WorkerAcceptForkResult {
  return isRecord(value) && typeof value.accepted === 'boolean';
}

export function isWorkerStopPayload(value: unknown): value is WorkerStopPayload {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    value.logicalSessionId.trim().length > 0 &&
    (value.reason === 'user' || value.reason === 'dispose')
  );
}

export function isWorkerStopResult(value: unknown): value is WorkerStopResult {
  return isRecord(value) && typeof value.stopped === 'boolean';
}

export function isWorkerInterjectPayload(value: unknown): value is WorkerInterjectPayload {
  if (!isRecord(value)) return false;
  if (
    typeof value.logicalSessionId !== 'string' ||
    value.logicalSessionId.trim().length === 0 ||
    typeof value.attemptId !== 'string' ||
    value.attemptId.trim().length === 0 ||
    typeof value.text !== 'string'
  ) {
    return false;
  }
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || !value.attachments.every(isAttachment)) return false;
  }
  // Something to say: the text, or at least one attachment.
  return value.text.trim().length > 0 || (value.attachments?.length ?? 0) > 0;
}

export function isWorkerInterjectResult(value: unknown): value is WorkerInterjectResult {
  return (
    isRecord(value) &&
    typeof value.interjected === 'boolean' &&
    (value.turnActive === undefined || typeof value.turnActive === 'boolean')
  );
}

export function isWorkerInterjectWithdrawPayload(
  value: unknown
): value is WorkerInterjectWithdrawPayload {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    value.logicalSessionId.trim().length > 0 &&
    typeof value.attemptId === 'string' &&
    value.attemptId.trim().length > 0
  );
}

const WITHDRAW_OUTCOMES: ReadonlySet<unknown> = new Set<WorkerInterjectWithdrawOutcome>([
  'withdrawn',
  'delivered',
  'not_found',
]);

export function isWorkerInterjectWithdrawResult(
  value: unknown
): value is WorkerInterjectWithdrawResult {
  return isRecord(value) && WITHDRAW_OUTCOMES.has(value.outcome);
}

const PERMISSION_DECISIONS = new Set(['allow', 'allow_session', 'deny', 'cancel']);

export function isWorkerPermissionRespondPayload(
  value: unknown
): value is WorkerPermissionRespondPayload {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    typeof value.permissionId === 'string' &&
    value.permissionId.trim().length > 0 &&
    typeof value.decision === 'string' &&
    PERMISSION_DECISIONS.has(value.decision)
  );
}

export function isWorkerPermissionRespondResult(
  value: unknown
): value is WorkerPermissionRespondResult {
  return isRecord(value) && typeof value.handled === 'boolean';
}

export function isWorkerQuestionRespondPayload(
  value: unknown
): value is WorkerQuestionRespondPayload {
  if (!isRecord(value)) return false;
  if (typeof value.logicalSessionId !== 'string') return false;
  if (typeof value.questionId !== 'string' || value.questionId.trim().length === 0) return false;
  if (value.cancel !== undefined && typeof value.cancel !== 'boolean') return false;
  if (value.response !== undefined && typeof value.response !== 'string') return false;
  if (value.answers === undefined) return true;
  // Values only: the KEYS are the agent's own ids, deliberately opaque, and a
  // shape check on them would be this layer inventing a second id vocabulary.
  return (
    isRecord(value.answers) &&
    Object.values(value.answers).every((entry) => typeof entry === 'string')
  );
}

export function isWorkerPreviewRespondPayload(
  value: unknown
): value is WorkerPreviewRespondPayload {
  if (!isRecord(value)) return false;
  if (typeof value.logicalSessionId !== 'string') return false;
  if (typeof value.previewId !== 'string' || value.previewId.trim().length === 0) return false;
  if (typeof value.ok !== 'boolean') return false;
  return value.error === undefined || typeof value.error === 'string';
}

export function isWorkerPreviewRespondResult(value: unknown): value is WorkerPreviewRespondResult {
  return isRecord(value) && typeof value.handled === 'boolean';
}

export function isWorkerQuestionRespondResult(
  value: unknown
): value is WorkerQuestionRespondResult {
  return isRecord(value) && typeof value.handled === 'boolean';
}

const VALID_TIERS = new Set(['readonly', 'pragmatic', 'handsoff', 'fullopen']);

export function isWorkerSetPermissionTierPayload(
  value: unknown
): value is WorkerSetPermissionTierPayload {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    typeof value.tier === 'string' &&
    VALID_TIERS.has(value.tier)
  );
}

export function isWorkerSetPermissionTierResult(
  value: unknown
): value is WorkerSetPermissionTierResult {
  return isRecord(value) && typeof value.applied === 'boolean';
}

export function isWorkerDisposeResult(value: unknown): value is WorkerDisposeResult {
  return isRecord(value) && value.disposed === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasRpcBase(value: Record<string, unknown>): boolean {
  return value.protocolVersion === WORKER_RPC_PROTOCOL_VERSION && isGeneration(value.generation);
}

export function isWorkerRpcRequest(value: unknown): value is WorkerRpcRequest {
  if (!isRecord(value) || !hasRpcBase(value)) return false;
  return (
    value.kind === 'request' &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    typeof value.type === 'string' &&
    value.type.length > 0 &&
    'payload' in value
  );
}

export function isWorkerRpcResponse(value: unknown): value is WorkerRpcResponse {
  if (!isRecord(value) || !hasRpcBase(value)) return false;
  if (
    value.kind !== 'response' ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    typeof value.ok !== 'boolean'
  ) {
    return false;
  }
  if (value.ok) return 'result' in value;
  if (!isRecord(value.error)) return false;
  return (
    typeof value.error.code === 'string' &&
    value.error.code.length > 0 &&
    typeof value.error.message === 'string' &&
    (value.error.retryable === undefined || typeof value.error.retryable === 'boolean')
  );
}

export function isWorkerRpcEvent(value: unknown): value is WorkerRpcEvent {
  if (!isRecord(value) || !hasRpcBase(value)) return false;
  return (
    value.kind === 'event' &&
    typeof value.type === 'string' &&
    value.type.length > 0 &&
    'payload' in value
  );
}

export function isWorkerRpcMessage(value: unknown): value is WorkerRpcMessage {
  return isWorkerRpcResponse(value) || isWorkerRpcEvent(value);
}

export interface WorkerSetPermissionsPayload {
  logicalSessionId: string;
  permissions: RuntimePermissionSettings;
}
export function isWorkerSetPermissionsPayload(
  value: unknown
): value is WorkerSetPermissionsPayload {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    isRuntimePermissionSettings(value.permissions)
  );
}

/**
 * Change the approval gear ALONE, mid-turn included.
 *
 * Separate from `worker.setPermissions` because the two calls are locked
 * differently, and one payload carrying both axes could not say which lock it
 * was asking for. `worker.setPermissions` rebuilds the posture: it clears the
 * session's remembered grants, invalidates every request already parked at the
 * gate and is refused while a turn runs. This one only slides the gear the
 * running turn is judged against — grants survive, parked requests survive, and
 * a widened gear is re-applied to the requests still waiting for an answer.
 *
 * `mode` is deliberately absent rather than optional: plan mode decides which
 * tools the model was given at the start of the turn, so changing it halfway is
 * not a setting change, it is a different session.
 */
export interface WorkerSetPermissionGearPayload {
  logicalSessionId: string;
  gear: PermissionGear;
}
export function isWorkerSetPermissionGearPayload(
  value: unknown
): value is WorkerSetPermissionGearPayload {
  return (
    isRecord(value) && typeof value.logicalSessionId === 'string' && isPermissionGear(value.gear)
  );
}
