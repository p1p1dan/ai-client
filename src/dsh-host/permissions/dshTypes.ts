/**
 * Narrow structural views of the DSH shapes the `aiclient-permissions` row
 * reads (DSH 0.1.7-rc.2: dsh-tools, dsh-session, dsh-user-approval).
 *
 * Declared here instead of imported so the row's bundle takes in no DSH
 * package and its unit tests can build these objects by hand.
 */

export interface DshSessionHeaderView {
  readonly id: string;
  readonly cwd?: string;
  /** Seed lineage: the delegating parent for a subagent, the source for a fork. */
  readonly parentSession?: string;
  readonly origin?: 'subagent';
  readonly agentPreset?: string;
}

export interface DshSessionView {
  readonly id: string;
  readonly header?: DshSessionHeaderView;
}

/** `exec.agent` / `request.agent`: the session-backed agent a call runs for. */
export interface DshAgentView {
  readonly id: string;
  readonly session?: { readonly header?: DshSessionHeaderView };
}

/** `tools/pre-execute`'s `exec` (dsh-tools `ToolExecution`). */
export interface DshToolCall {
  readonly callId: string;
  readonly rootCallId?: string;
  readonly name: string;
  /** Parsed, deep-frozen model arguments. */
  readonly arguments: unknown;
  readonly agent?: DshAgentView;
  /** Set on PTC / program sub-dispatches only. */
  readonly parent?: unknown;
  readonly signal: AbortSignal;
}

export interface DshToolErrorInfo {
  name: string;
  code: string;
  reason?: string;
}

export type DshPreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: DshToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string };

/** `tools/post-execute`'s `result` (dsh-tools `ToolExecutionResult`), as read here. */
export interface DshToolResult {
  readonly isError: boolean;
  readonly value?: unknown;
}

export type DshPostToolDecision =
  | { kind: 'accept'; content?: unknown[]; value?: unknown; additionalContexts?: unknown[] }
  | { kind: 'block'; feedback: unknown[]; additionalContexts?: unknown[] };

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** `approval/request`'s request (dsh-user-approval): no tool arguments. */
export interface DshApprovalRequest {
  readonly agent?: DshAgentView;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string };
  readonly signal?: AbortSignal;
}
