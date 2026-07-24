/**
 * Runtime Events emitted by Agent Host → Main → Renderer.
 * AiClient's own protocol — not @opencode-ai/sdk Event.
 * See docs/plans/2026-07-23-openchamber-chat-refactor-ard.md §5.3 / §6
 */

import type {
  HistoryMessage,
  HistoryParseStats,
  HistoryReadError,
  HistorySessionSummary,
} from './sessionHistory';

export type RuntimeEventType =
  | 'host.ready'
  | 'host.error'
  | 'session.created'
  | 'session.resumed'
  | 'session.updated'
  | 'session.history'
  | 'session.historyListed'
  | 'session.status'
  | 'message.started'
  | 'message.delta'
  | 'message.completed'
  | 'thinking.started'
  | 'thinking.delta'
  | 'thinking.completed'
  | 'tool.started'
  | 'tool.updated'
  | 'tool.completed'
  | 'permission.requested'
  | 'permission.resolved'
  | 'question.requested'
  | 'question.resolved'
  | 'usage.updated'
  | 'session.completed'
  | 'session.failed'
  | 'session.stopped';

export type SessionRuntimeStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_permission'
  | 'waiting_question'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'disconnected';

export interface RuntimeEventBase {
  type: RuntimeEventType;
  /** Monotonic sequence within the Host process (for out-of-order handling). */
  seq: number;
  /** Present on all session-scoped events. */
  sessionId?: string;
  /** Correlates to a command requestId when applicable. */
  requestId?: string;
  timestamp: number;
}

export interface HostReadyEvent extends RuntimeEventBase {
  type: 'host.ready';
  payload: {
    protocolVersion: number;
    driver: 'agent-sdk' | 'stream-json';
    nodeVersion: string;
    cometixVersion?: string;
    nodeExecPath?: string;
    shuttingDown?: boolean;
    /** Desensitized Claude settings diagnostics from Host initialize. */
    settings?: {
      loaded: boolean;
      hasAuthToken: boolean;
      hasBaseUrl: boolean;
      baseHost: string | null;
      model: string | null;
    } | null;
    /** Host capability flags — Main degrades gracefully when absent (old Host). */
    capabilities?: {
      history?: boolean;
      /** Extended thinking enabled on this Host (CP3 decision: default on). */
      thinking?: boolean;
    };
  };
}

export interface HostErrorEvent extends RuntimeEventBase {
  type: 'host.error';
  payload: {
    code: string;
    message: string;
    fatal?: boolean;
  };
}

export interface SessionStatusEvent extends RuntimeEventBase {
  type: 'session.status';
  sessionId: string;
  payload: { status: SessionRuntimeStatus };
}

export interface MessageStartedEvent extends RuntimeEventBase {
  type: 'message.started';
  sessionId: string;
  payload: {
    messageId: string;
    role: 'user' | 'assistant' | 'system' | 'error';
  };
}

export interface MessageDeltaEvent extends RuntimeEventBase {
  type: 'message.delta';
  sessionId: string;
  payload: {
    messageId: string;
    blockId: string;
    text: string;
  };
}

export interface MessageCompletedEvent extends RuntimeEventBase {
  type: 'message.completed';
  sessionId: string;
  payload: { messageId: string };
}

export interface ThinkingDeltaEvent extends RuntimeEventBase {
  type: 'thinking.delta';
  sessionId: string;
  payload: {
    messageId: string;
    blockId: string;
    text: string;
  };
}

export interface ToolStartedEvent extends RuntimeEventBase {
  type: 'tool.started';
  sessionId: string;
  payload: {
    messageId: string;
    toolCallId: string;
    name: string;
    input?: unknown;
  };
}

export interface ToolCompletedEvent extends RuntimeEventBase {
  type: 'tool.completed';
  sessionId: string;
  payload: {
    messageId: string;
    toolCallId: string;
    ok: boolean;
    output?: unknown;
    error?: string;
  };
}

export interface PermissionRequestedEvent extends RuntimeEventBase {
  type: 'permission.requested';
  sessionId: string;
  payload: {
    permissionId: string;
    toolName: string;
    description?: string;
    input?: unknown;
  };
}

export interface QuestionRequestedEvent extends RuntimeEventBase {
  type: 'question.requested';
  sessionId: string;
  payload: {
    questionId: string;
    prompt: string;
    options?: string[];
  };
}

export interface SessionTerminalEvent extends RuntimeEventBase {
  type: 'session.completed' | 'session.failed' | 'session.stopped';
  sessionId: string;
  payload?: { error?: string };
}

export interface PermissionResolvedEvent extends RuntimeEventBase {
  type: 'permission.resolved';
  sessionId: string;
  payload: {
    permissionId: string;
    allow: boolean;
  };
}

export interface QuestionResolvedEvent extends RuntimeEventBase {
  type: 'question.resolved';
  sessionId: string;
  payload: {
    questionId: string;
    answers: string[];
  };
}

export interface SessionCreatedEvent extends RuntimeEventBase {
  type: 'session.created' | 'session.resumed';
  sessionId: string;
  payload?: { runtimeIdentity?: string };
}

/**
 * Emitted when the SDK-reported session id differs from the session's current
 * runtimeIdentity (first discovery on initial send; defensively covers forks).
 */
export interface SessionUpdatedEvent extends RuntimeEventBase {
  type: 'session.updated';
  sessionId: string;
  payload: { runtimeIdentity: string };
}

/**
 * Batch history replay emitted during session.resume handling:
 * session.resumed → session.history → session.status(idle).
 * Read failure is non-fatal: empty messages + error, session stays usable.
 */
export interface SessionHistoryEvent extends RuntimeEventBase {
  type: 'session.history';
  sessionId: string;
  requestId: string;
  payload: {
    runtimeIdentity: string;
    workspacePath: string;
    /** Chronological. Message ids carry the `h:` contract prefix. */
    messages: HistoryMessage[];
    /** True when messages were dropped by input/output caps. */
    truncated: boolean;
    omittedCount: number;
    error?: HistoryReadError;
    parseStats?: HistoryParseStats;
  };
}

/** Response to the session.listHistory command, correlated by requestId. Not session-scoped. */
export interface SessionHistoryListedEvent extends RuntimeEventBase {
  type: 'session.historyListed';
  requestId: string;
  payload: {
    workspacePath: string;
    /** Sorted lastMessageAt desc. */
    sessions: HistorySessionSummary[];
    error?: HistoryReadError;
  };
}

export interface ThinkingStartedEvent extends RuntimeEventBase {
  type: 'thinking.started' | 'thinking.completed';
  sessionId: string;
  payload: {
    messageId: string;
    blockId: string;
  };
}

export interface ToolUpdatedEvent extends RuntimeEventBase {
  type: 'tool.updated';
  sessionId: string;
  payload: {
    messageId: string;
    toolCallId: string;
    input?: unknown;
  };
}

export interface UsageUpdatedEvent extends RuntimeEventBase {
  type: 'usage.updated';
  sessionId?: string;
  payload: Record<string, unknown>;
}

/** Union of events Host may emit. */
export type RuntimeEvent =
  | HostReadyEvent
  | HostErrorEvent
  | SessionStatusEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionHistoryEvent
  | SessionHistoryListedEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ThinkingStartedEvent
  | ThinkingDeltaEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolCompletedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | QuestionRequestedEvent
  | QuestionResolvedEvent
  | UsageUpdatedEvent
  | SessionTerminalEvent;
