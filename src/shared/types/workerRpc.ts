// Explicit `.ts` for the same reason as `./sessionHistory.ts` below: this is a
// VALUE import and the Pi worker loads this file as source under Node's
// strip-types mode, where the ESM resolver does no extension search.
import {
  isSessionEffortLevel,
  type SessionAttachment,
  type SessionEffortLevel,
} from './agentHost.ts';
import type {
  WorkerDiscardImportedSessionPayload,
  WorkerDiscardImportedSessionResult,
  WorkerImportConversationPayload,
  WorkerImportConversationResult,
  WorkerInspectImportedSessionPayload,
  WorkerInspectImportedSessionResult,
  WorkerReconcileImportedSessionPayload,
  WorkerReconcileImportedSessionResult,
} from './legacyImport';
import type { ExtensionUiResponse, RuntimeEvent } from './runtimeEvents';
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
  /** Reapply a durable branch only while its recorded physical tail still matches. */
  leafCheckpoint?: PiLeafCheckpoint;
  /**
   * U05-c — this session runs in a throwaway scratch directory, not a project
   * the user chose. Set by Main (never by the renderer) and one-way: it can
   * only WITHDRAW project trust, never grant it, so a scratch session cannot
   * accumulate persistent project-scoped permission grants.
   */
  unbound?: boolean;
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
}

export interface WorkerHistoryResult {
  logicalSessionId: string;
  sessionFile: string;
  workspacePath: string;
  page: SessionHistoryPage;
}

export interface WorkerBootstrapResult {
  bootstrapped: true;
  logicalSessionId: string;
  piSessionId: string;
  cwd: string;
  agentDir: string;
  sessionFile?: string;
  /** Present only when bootstrap opened an existing exact Pi session file. */
  initialHistory?: WorkerHistoryResult;
  leaf: PiLeafCheckpoint;
  model?: string;
  effort?: SessionEffortLevel;
  projectTrusted: boolean;
  permissionGate: 'bundled' | 'user_configured';
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

export interface WorkerStopPayload {
  logicalSessionId: string;
  reason: 'user' | 'dispose';
}

export interface WorkerStopResult {
  stopped: boolean;
}

export interface WorkerExtensionUiResponsePayload {
  logicalSessionId: string;
  response: ExtensionUiResponse;
}

export interface WorkerExtensionUiResponseResult {
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
export type WorkerRewindRequest = WorkerRpcRequest<'worker.rewind', WorkerRewindPayload>;
export type WorkerReloadRequest = WorkerRpcRequest<'worker.reload', WorkerReloadPayload>;
export type WorkerForkRequest = WorkerRpcRequest<'worker.fork', WorkerForkPayload>;
export type WorkerDiscardForkRequest = WorkerRpcRequest<
  'worker.fork.discard',
  WorkerDiscardForkPayload
>;
export type WorkerStopRequest = WorkerRpcRequest<'worker.stop', WorkerStopPayload>;
export type WorkerExtensionUiResponseRequest = WorkerRpcRequest<
  'worker.extensionUi.respond',
  WorkerExtensionUiResponsePayload
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
  if (value.leafCheckpoint !== undefined && !isPiLeafCheckpoint(value.leafCheckpoint)) {
    return false;
  }
  if (value.unbound !== undefined && typeof value.unbound !== 'boolean') return false;
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
  return true;
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
    nonEmptyString(value.targetPiSessionId)
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
    nonEmptyString(value.targetPiSessionId)
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

export function isWorkerExtensionUiResponsePayload(
  value: unknown
): value is WorkerExtensionUiResponsePayload {
  if (!isRecord(value) || typeof value.logicalSessionId !== 'string') return false;
  if (!isRecord(value.response)) return false;
  return (
    typeof value.response.runtimeId === 'string' &&
    typeof value.response.uiRequestId === 'string' &&
    typeof value.response.ok === 'boolean' &&
    (value.response.error === undefined || typeof value.response.error === 'string')
  );
}

export function isWorkerExtensionUiResponseResult(
  value: unknown
): value is WorkerExtensionUiResponseResult {
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
