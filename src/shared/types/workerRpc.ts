// Explicit `.ts` for the same reason as `./sessionHistory.ts` below: this is a
// VALUE import and the Pi worker loads this file as source under Node's
// strip-types mode, where the ESM resolver does no extension search.
import {
  isSessionEffortLevel,
  type SessionAttachment,
  type SessionEffortLevel,
} from './agentHost.ts';
// Value import (not type-only): isLegacyImportPathSegment below is a runtime
// check, so this file needs the explicit `.ts` suffix (see the note further
// down about the Pi worker loading this file as source).
import {
  isLegacyImportPathSegment,
  type WorkerDiscardImportedSessionPayload,
  type WorkerDiscardImportedSessionResult,
  type WorkerImportConversationPayload,
  type WorkerImportConversationResult,
  type WorkerInspectImportedSessionPayload,
  type WorkerInspectImportedSessionResult,
  type WorkerReconcileImportedSessionPayload,
  type WorkerReconcileImportedSessionResult,
} from './legacyImport.ts';
// Value imports (`isPromptCacheTtl`, `isProviderIdleTimeoutMs`), so the
// explicit `.ts` applies to both for the reason stated above.
import { isPromptCacheTtl, type PromptCacheTtl } from './promptCacheTtl.ts';
import { isProviderIdleTimeoutMs } from './providerTimeout.ts';
import type { PermissionDecisionId, RuntimeEvent } from './runtimeEvents';
import {
  isPermissionGear,
  isRuntimePermissionSettings,
  type PermissionGear,
  type RuntimePermissionSettings,
} from './runtimePermission.ts';
// Explicit `.ts`: in dev the Pi worker loads this file as SOURCE under Node's
// --experimental-strip-types (PiWorkerProcess.resolvePiWorkerEntryPath), and
// Node's ESM resolver has no extension search. Type-only imports above are
// erased before that matters; a VALUE import without the suffix is what made
// every dev-mode session die with ERR_MODULE_NOT_FOUND. Keep any future value
// import from this file suffixed too.
import {
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
export const PI_WORKER_GENERATION_ENV = 'AICLIENT_PI_WORKER_GENERATION';

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
  /**
   * P5-2-5 — whether this worker offers delegation, and which definitions the
   * user switched off.
   *
   * Absent means "the host did not say", which the native runtime reads as ON
   * with the full builtin catalog: that is the P5-2 contract's default for an
   * install with no prior choice. Only an explicit `enabled: false` removes the
   * `Task*` tools, because the legacy plugin's opt-in default is about ITS
   * prompt cost and is not a statement about native delegation.
   *
   * `disabled` is per-install app state, keyed by definition name. It is
   * deliberately not written into the Markdown: a definition document is a
   * shareable artifact and the switch is this machine's.
   */
  subagents?: { enabled: boolean; disabled?: readonly string[] };
  /**
   * How long the provider should keep this session's prompt cache entries.
   *
   * Two separate values because the two loops have opposite cache economics:
   * the main conversation re-reads one growing prefix for as long as the tab is
   * open, a delegate writes a prefix that nothing reads again. Absent means the
   * runtime's own defaults (`1h` main, `5m` delegate), so an install that never
   * touched the setting sends a payload identical to a pre-TTL build's and
   * `sameBootstrap` keeps comparing undefined === undefined.
   */
  promptCacheTtl?: PromptCacheTtl;
  subagentPromptCacheTtl?: PromptCacheTtl;
  /**
   * T093 / decision 029 — how long a provider request may stay silent, in ms.
   *
   * One number that becomes three things in the worker: undici's
   * `headersTimeout`, its `bodyTimeout`, and the SDK's per-request `timeout`.
   * `0` is the user's "off". Absent means the runtime's own default (120 s), so
   * an install that never touched the setting sends a payload identical to a
   * pre-T093 build's and `sameBootstrap` keeps comparing undefined === undefined
   * — the same rule the two TTLs above follow.
   */
  providerIdleTimeoutMs?: number;
  /**
   * P5-5 — the model catalog, handed over rather than read off disk.
   *
   * Until this node the native runtime read `models.json` + `auth.json` from
   * the agent directory. Those two files exist for the LEGACY backend: pi can
   * only be configured through files, so the app has to decrypt the user's keys
   * and write them out at 0600 for it. The native backend has no such
   * constraint, and keeping it on the files meant a coexistence-period measure
   * (H/17's fifth decision, due for removal in P6-2) was silently load-bearing
   * for the backend that is supposed to outlive it.
   *
   * The shape is `models.json`'s, not a new one, so both paths go through the
   * same parser and cannot drift. Absent means "read the directory", which is
   * what the smoke and probe lanes do — they point at a fixture directory and
   * have no Main to assemble anything.
   */
  modelCatalog?: WorkerModelCatalog;
}

/**
 * The two documents the catalog is made of, in the exact shape they take on
 * disk. `auth` is separate for the same reason the file is: `models.json` is a
 * configuration a user may reasonably look at, and it must never come to hold
 * a key.
 */
export interface WorkerModelCatalog {
  models: Record<string, unknown>;
  auth?: Record<string, unknown>;
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
 * T026 — one MCP server this session's OWN bridge declared.
 *
 * Reported from `runtimeMcp.connections`, which is the same list the tools were
 * registered from, so a server named here is a server whose tools the model can
 * actually call. A failed one is kept rather than dropped: "declared and did
 * not come up" is the fact a user needs, and omitting it would render the same
 * as never having configured it.
 */
export interface WorkerMcpServerInfo {
  /** The name the server is declared under; also the `mcp__<name>__` prefix. */
  name: string;
  /** False when the server never started or never introduced itself. */
  ok: boolean;
  /** Tools it published. `0` for a server that failed. */
  toolCount: number;
  /** Present only when `ok` is false. */
  error?: string;
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
 */
export interface WorkerCapabilityInventory {
  /** Absent when this graph has no MCP bridge; `[]` when it found no servers. */
  mcpServers?: WorkerMcpServerInfo[];
  /** Discovered skills. Absent when discovery never ran. */
  skills?: number;
  /** Discovered prompt templates. Absent when discovery never ran. */
  promptTemplates?: number;
  /** Sub-agent definitions. Absent when delegation is switched off. */
  subagents?: number;
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
 */
export interface WorkerSlashCommandInfo {
  /** Invocation name without the leading slash; skills read `skill:<name>`. */
  name: string;
  description?: string;
  /**
   * Deliberately `string` and not a union: this crosses a version boundary (an
   * older build must survive a value a newer runtime introduces), and a second
   * copy of the runtime's vocabulary here is how a layer starts rejecting words
   * the runtime accepts. Known values: `extension`, `prompt`, `skill`.
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
  instructions?: string;
}

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
}

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
export type WorkerImportConversationRequest = WorkerRpcRequest<
  'worker.import',
  WorkerImportConversationPayload
>;
export type WorkerInspectImportedSessionRequest = WorkerRpcRequest<
  'worker.import.inspect',
  WorkerInspectImportedSessionPayload
>;
export type WorkerReconcileImportedSessionRequest = WorkerRpcRequest<
  'worker.import.reconcile',
  WorkerReconcileImportedSessionPayload
>;
export type WorkerDiscardImportedSessionRequest = WorkerRpcRequest<
  'worker.import.discard',
  WorkerDiscardImportedSessionPayload
>;

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
}

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

/**
 * Re-open this worker's own session file from disk.
 *
 * Exists because a live worker never re-reads its JSONL: pi's SessionManager
 * caches the whole file at open, so `worker.history` projects whatever was on
 * disk when the worker started. When the Pi TUI has appended to the same file
 * in the meantime, the worker is both showing stale history and still pointing
 * its leaf at the pre-TUI entry — the next turn would branch off there and
 * strand the terminal's messages on an abandoned path.
 *
 * `sessionFile` is the caller's assertion about which file it expects to be
 * reloaded; the worker refuses when that is not the file it owns.
 */
export interface WorkerReloadPayload {
  logicalSessionId: string;
  sessionFile: string;
}

export interface WorkerReloadResult {
  logicalSessionId: string;
  sessionFile: string;
  workspacePath: string;
  /** Leaf after the reload — pi resets it to the file's last entry. */
  leaf: PiLeafCheckpoint;
  history: WorkerHistoryResult;
}

export interface WorkerForkPayload {
  logicalSessionId: string;
  entryId: string;
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

/**
 * Stateless, one-shot completion request. It never creates a Pi SessionManager,
 * session JSONL, or logical chat-session identity.
 */
export interface WorkerUtilityStartPayload {
  operationId: string;
  cwd: string;
  prompt: string;
  model?: string;
  effort?: SessionEffortLevel;
  timeoutMs: number;
  /**
   * P5-5 — the same handed-over catalog a session worker bootstraps with.
   *
   * Without it this path was the last one still reading `models.json` and
   * `auth.json` out of the agent directory: those two files exist for the
   * legacy backend, and leaving the "AI features" on them made a coexistence
   * measure load-bearing for the backend meant to outlive it. Absent still
   * means "read the directory", which is what a smoke lane with no Main does.
   */
  modelCatalog?: WorkerModelCatalog;
}

export interface WorkerUtilityStartResult {
  accepted: true;
  operationId: string;
}

export interface WorkerUtilityCancelPayload {
  operationId: string;
  reason: 'user' | 'timeout' | 'dispose';
}

export interface WorkerUtilityCancelResult {
  cancelled: boolean;
}

export interface WorkerUtilityDeltaPayload {
  operationId: string;
  delta: string;
}

export interface WorkerUtilityTerminalPayload {
  operationId: string;
  state: 'completed' | 'cancelled' | 'failed';
  text: string;
  model?: string;
  error?: string;
}

export type WorkerUtilityStartRequest = WorkerRpcRequest<
  'utility.start',
  WorkerUtilityStartPayload
>;
export type WorkerUtilityCancelRequest = WorkerRpcRequest<
  'utility.cancel',
  WorkerUtilityCancelPayload
>;
export type WorkerUtilityDeltaEvent = WorkerRpcEvent<'utility.delta', WorkerUtilityDeltaPayload>;
export type WorkerUtilityTerminalEvent = WorkerRpcEvent<
  'utility.terminal',
  WorkerUtilityTerminalPayload
>;

export type WorkerHistoryRequest = WorkerRpcRequest<'worker.history', WorkerHistoryPayload>;
export type WorkerTreeRequest = WorkerRpcRequest<'worker.tree', WorkerTreePayload>;
export type WorkerCommandsRequest = WorkerRpcRequest<'worker.commands', WorkerCommandsPayload>;
export type WorkerCompactRequest = WorkerRpcRequest<'worker.compact', WorkerCompactPayload>;
export type WorkerRewindRequest = WorkerRpcRequest<'worker.rewind', WorkerRewindPayload>;
export type WorkerReloadRequest = WorkerRpcRequest<'worker.reload', WorkerReloadPayload>;
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
  // Rejected rather than coerced: a worker that silently fell back would run a
  // TTL the settings page is not showing, which is the failure this guard exists
  // to make impossible for every other field too.
  if (value.promptCacheTtl !== undefined && !isPromptCacheTtl(value.promptCacheTtl)) return false;
  if (
    value.subagentPromptCacheTtl !== undefined &&
    !isPromptCacheTtl(value.subagentPromptCacheTtl)
  ) {
    return false;
  }
  // Same rule as the TTLs above: rejected rather than coerced. A worker that
  // fell back silently would be more (or less) patient than the settings page
  // claims, and "why did it give up after 30 seconds" has no other answer.
  if (
    value.providerIdleTimeoutMs !== undefined &&
    !isProviderIdleTimeoutMs(value.providerIdleTimeoutMs)
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

function normalizeMcpServer(value: unknown): WorkerMcpServerInfo | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  const ok = value.ok === true;
  // A failed server publishes nothing, whatever it claimed. Trusting the number
  // would put "9 tools" next to a Failed badge and leave a reader to decide
  // which half of one row to believe.
  const declared =
    typeof value.toolCount === 'number' && Number.isFinite(value.toolCount)
      ? Math.max(0, Math.trunc(value.toolCount))
      : 0;
  const error =
    typeof value.error === 'string' && value.error.trim().length > 0 ? value.error : undefined;
  return { name, ok, toolCount: ok ? declared : 0, ...(!ok && error ? { error } : {}) };
}

function normalizeCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

/**
 * T026 — read a bootstrap result's capability inventory, or `null`.
 *
 * `null` means "nothing reported one", which every consumer renders as "not
 * reported" rather than as an empty setup. Members that cannot be parsed are
 * dropped INDIVIDUALLY: a garbled server row must not take the skill count with
 * it, and neither may abort the session — which is why this lives here and not
 * in {@link isWorkerBootstrapResult}.
 */
export function normalizeWorkerCapabilities(value: unknown): WorkerCapabilityInventory | null {
  if (!isRecord(value)) return null;
  const servers = Array.isArray(value.mcpServers)
    ? value.mcpServers
        .map(normalizeMcpServer)
        .filter((item): item is WorkerMcpServerInfo => item !== null)
    : undefined;
  const skills = normalizeCount(value.skills);
  const promptTemplates = normalizeCount(value.promptTemplates);
  const subagents = normalizeCount(value.subagents);
  const inventory: WorkerCapabilityInventory = {
    ...(servers ? { mcpServers: servers } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(promptTemplates !== undefined ? { promptTemplates } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
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

export function isWorkerUtilityStartPayload(value: unknown): value is WorkerUtilityStartPayload {
  if (!isRecord(value)) return false;
  if (
    !nonEmptyString(value.operationId) ||
    !nonEmptyString(value.cwd) ||
    !nonEmptyString(value.prompt) ||
    !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 ||
    Number(value.timeoutMs) > 10 * 60_000
  ) {
    return false;
  }
  if (value.model !== undefined && !nonEmptyString(value.model)) return false;
  return value.effort === undefined || isWorkerEffort(value.effort);
}

export function isWorkerUtilityStartResult(value: unknown): value is WorkerUtilityStartResult {
  return isRecord(value) && value.accepted === true && nonEmptyString(value.operationId);
}

export function isWorkerUtilityCancelPayload(value: unknown): value is WorkerUtilityCancelPayload {
  return (
    isRecord(value) &&
    nonEmptyString(value.operationId) &&
    (value.reason === 'user' || value.reason === 'timeout' || value.reason === 'dispose')
  );
}

export function isWorkerUtilityCancelResult(value: unknown): value is WorkerUtilityCancelResult {
  return isRecord(value) && typeof value.cancelled === 'boolean';
}

export function isWorkerUtilityDeltaPayload(value: unknown): value is WorkerUtilityDeltaPayload {
  return isRecord(value) && nonEmptyString(value.operationId) && typeof value.delta === 'string';
}

export function isWorkerUtilityTerminalPayload(
  value: unknown
): value is WorkerUtilityTerminalPayload {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.operationId) ||
    (value.state !== 'completed' && value.state !== 'cancelled' && value.state !== 'failed') ||
    typeof value.text !== 'string'
  ) {
    return false;
  }
  return (
    (value.model === undefined || nonEmptyString(value.model)) &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

export function isWorkerUtilityDeltaEvent(value: unknown): value is WorkerUtilityDeltaEvent {
  return (
    isWorkerRpcEvent(value) &&
    value.type === 'utility.delta' &&
    isWorkerUtilityDeltaPayload(value.payload)
  );
}

export function isWorkerUtilityTerminalEvent(value: unknown): value is WorkerUtilityTerminalEvent {
  return (
    isWorkerRpcEvent(value) &&
    value.type === 'utility.terminal' &&
    isWorkerUtilityTerminalPayload(value.payload)
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

export function isWorkerReloadPayload(value: unknown): value is WorkerReloadPayload {
  return (
    isLogicalSessionPayload(value) &&
    typeof value.sessionFile === 'string' &&
    value.sessionFile.trim().length > 0
  );
}

export function isWorkerReloadResult(value: unknown): value is WorkerReloadResult {
  return (
    isRecord(value) &&
    typeof value.logicalSessionId === 'string' &&
    typeof value.sessionFile === 'string' &&
    typeof value.workspacePath === 'string' &&
    isPiLeafCheckpoint(value.leaf) &&
    isWorkerHistoryResult(value.history)
  );
}

export function isWorkerForkPayload(value: unknown): value is WorkerForkPayload {
  return (
    isLogicalSessionPayload(value) &&
    typeof value.entryId === 'string' &&
    value.entryId.trim().length > 0
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

export function isWorkerImportResult(value: unknown): value is WorkerImportConversationResult {
  return (
    isRecord(value) &&
    nonEmptyString(value.logicalSessionId) &&
    nonEmptyString(value.piSessionId) &&
    nonEmptyString(value.workspacePath) &&
    nonEmptyString(value.stagedSessionFile) &&
    nonEmptyString(value.finalSessionFile) &&
    isPiLeafCheckpoint(value.leaf) &&
    isWorkerHistoryResult(value.history)
  );
}

export function isWorkerInspectImportedSessionPayload(
  value: unknown
): value is WorkerInspectImportedSessionPayload {
  return (
    isLogicalSessionPayload(value) &&
    nonEmptyString(value.workspacePath) &&
    // import-catalog-07: see the matching note on isWorkerImportConversationPayload.
    isLegacyImportPathSegment(value.targetPiSessionId)
  );
}

export function isWorkerInspectImportedSessionResult(
  value: unknown
): value is WorkerInspectImportedSessionResult {
  return (
    isRecord(value) && Array.isArray(value.sessionFiles) && value.sessionFiles.every(nonEmptyString)
  );
}

export function isWorkerReconcileImportedSessionPayload(
  value: unknown
): value is WorkerReconcileImportedSessionPayload {
  return (
    isLogicalSessionPayload(value) &&
    nonEmptyString(value.workspacePath) &&
    // import-catalog-07: see the matching note on isWorkerImportConversationPayload.
    isLegacyImportPathSegment(value.targetPiSessionId)
  );
}

export function isWorkerReconcileImportedSessionResult(
  value: unknown
): value is WorkerReconcileImportedSessionResult {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.removedFiles) &&
    Number(value.removedFiles) >= 0 &&
    Number.isSafeInteger(value.remainingFiles) &&
    Number(value.remainingFiles) >= 0
  );
}

export function isWorkerDiscardImportedSessionPayload(
  value: unknown
): value is WorkerDiscardImportedSessionPayload {
  return (
    isLogicalSessionPayload(value) &&
    typeof value.sessionFile === 'string' &&
    value.sessionFile.trim().length > 0
  );
}

export function isWorkerDiscardImportedSessionResult(
  value: unknown
): value is WorkerDiscardImportedSessionResult {
  return isRecord(value) && typeof value.discarded === 'boolean';
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
