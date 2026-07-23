/**
 * Agent Host protocol types (Main ↔ Node 24 Host over stdio NDJSON).
 * See docs/plans/2026-07-23-openchamber-chat-refactor-ard.md §5.3
 */

export const AGENT_HOST_PROTOCOL_VERSION = 1 as const;

export type AgentHostCommandType =
  | 'host.initialize'
  | 'host.shutdown'
  | 'session.create'
  | 'session.resume'
  | 'session.send'
  | 'session.stop'
  | 'session.close'
  | 'permission.respond'
  | 'question.respond';

export interface AgentHostCommandBase {
  protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION;
  requestId: string;
  type: AgentHostCommandType;
}

export interface HostInitializeCommand extends AgentHostCommandBase {
  type: 'host.initialize';
  payload?: {
    /** Preferred Cometix package root; Host may fall back to bundled path. */
    cometixRoot?: string;
    /** Driver route selected after Phase 0. */
    driver?: AgentHostDriver;
  };
}

export interface HostShutdownCommand extends AgentHostCommandBase {
  type: 'host.shutdown';
}

export interface SessionCreateCommand extends AgentHostCommandBase {
  type: 'session.create';
  payload: {
    sessionId: string;
    workspacePath: string;
    model?: string;
  };
}

export interface SessionResumeCommand extends AgentHostCommandBase {
  type: 'session.resume';
  payload: {
    sessionId: string;
    /** Claude runtime / resume identity (not AiClient sessionId). */
    runtimeIdentity: string;
    workspacePath: string;
  };
}

export interface SessionSendCommand extends AgentHostCommandBase {
  type: 'session.send';
  payload: {
    sessionId: string;
    text: string;
  };
}

export interface SessionStopCommand extends AgentHostCommandBase {
  type: 'session.stop';
  payload: { sessionId: string };
}

export interface SessionCloseCommand extends AgentHostCommandBase {
  type: 'session.close';
  payload: { sessionId: string };
}

export interface PermissionRespondCommand extends AgentHostCommandBase {
  type: 'permission.respond';
  payload: {
    sessionId: string;
    permissionId: string;
    allow: boolean;
  };
}

export interface QuestionRespondCommand extends AgentHostCommandBase {
  type: 'question.respond';
  payload: {
    sessionId: string;
    questionId: string;
    answers: string[];
  };
}

export type AgentHostCommand =
  | HostInitializeCommand
  | HostShutdownCommand
  | SessionCreateCommand
  | SessionResumeCommand
  | SessionSendCommand
  | SessionStopCommand
  | SessionCloseCommand
  | PermissionRespondCommand
  | QuestionRespondCommand;

/** Host driver selected in Phase 0. */
export type AgentHostDriver = 'agent-sdk' | 'stream-json';

export interface NodeRuntimeInfo {
  /** Absolute path to node.exe / node binary. */
  execPath: string;
  /** e.g. "v24.18.0" */
  version: string;
  /** Parsed major, e.g. 24 */
  major: number;
  /** Where the resolver found this binary. */
  source: NodeRuntimeSource;
}

export type NodeRuntimeSource = 'env' | 'nvm' | 'fnm' | 'volta' | 'path' | 'explicit';

export interface NodeRuntimeResolveResult {
  ok: boolean;
  runtime?: NodeRuntimeInfo;
  error?: string;
  /** Candidates inspected (for diagnostics UI). */
  candidates: Array<{ path: string; reason: string }>;
}

/** Pinned Cometix release metadata (Phase 0 evidence). */
export interface CometixPinInfo {
  name: '@cometix/claude-code';
  version: string;
  npmIntegrity: string;
  /** SHA-256 of the npm tarball (hex, lowercase). */
  tarballSha256: string;
  tarballUrl: string;
}
