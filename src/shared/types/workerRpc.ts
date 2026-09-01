import type { SessionAttachment, SessionEffortLevel } from './agentHost';
import type { ExtensionUiResponse, RuntimeEvent } from './runtimeEvents';
import type { SessionHistoryPage } from './sessionHistory';

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
  model?: string;
  effort?: SessionEffortLevel;
  projectTrusted: boolean;
  permissionGate: 'bundled' | 'user_configured';
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

export type WorkerSendRequest = WorkerRpcRequest<'worker.send', WorkerSendPayload>;
export type WorkerHistoryRequest = WorkerRpcRequest<'worker.history', WorkerHistoryPayload>;
export type WorkerStopRequest = WorkerRpcRequest<'worker.stop', WorkerStopPayload>;
export type WorkerExtensionUiResponseRequest = WorkerRpcRequest<
  'worker.extensionUi.respond',
  WorkerExtensionUiResponsePayload
>;

export type WorkerDisposeRequest = WorkerRpcRequest<
  'worker.dispose',
  { reason: 'app-shutdown' | 'slot-dispose' | 'slot-replace' }
>;

export interface WorkerDisposeResult {
  disposed: true;
}

function isWorkerEffort(value: unknown): value is SessionEffortLevel {
  return typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value);
}

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
    (value.permissionGate !== 'bundled' && value.permissionGate !== 'user_configured')
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
