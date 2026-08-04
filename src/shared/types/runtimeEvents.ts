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

/**
 * a1 (2026-07-30 net-visibility batch): the CLI's OWN transport-retry loop
 * (Agent SDK query() default max_retries: 10, exponential backoff) for the
 * in-flight turn. Previously this was the one piece of data that explained a
 * "hung" turn (see docs — investigation report §4.1 gap C / §0) and
 * eventNormalizer dropped it entirely on the floor.
 *
 * Riding on `SessionStatusEvent.payload.retry` (an optional field) instead of
 * a new top-level RuntimeEventType: every consumer that already switches on
 * `session.status` (chatSessions.ts's reducer, ChatComposer's event log)
 * gets this for free without a new case, and status legitimately stays
 * `'running'` — the turn has not stalled, the CLI is actively retrying.
 */
export interface SessionRetryInfo {
  /** 1-based attempt number, mirrors the SDK's own `attempt` field. */
  attempt: number;
  /** SDK's configured ceiling (currently 10, not configurable by the Host). */
  maxRetries: number;
  /** Backoff delay before the NEXT attempt, in ms. */
  delayMs: number;
  /** HTTP status when known; `null` for a transport-layer failure (typical). */
  errorStatus: string | null;
  /** SDK's own error label, e.g. `"unknown"` for a socket-level failure. */
  error: string;
}

export interface SessionStatusEvent extends RuntimeEventBase {
  type: 'session.status';
  sessionId: string;
  payload: { status: SessionRuntimeStatus; retry?: SessionRetryInfo };
}

/**
 * Lightweight attachment metadata for the user-turn echo (round-2 P0).
 * Deliberately excludes `data` — the timeline chip only needs to say WHAT was
 * attached, never re-carries the bytes the Host already sent to the model.
 */
export interface MessageAttachmentMeta {
  kind: 'image' | 'text';
  mediaType: string;
  name?: string;
}

export interface MessageStartedEvent extends RuntimeEventBase {
  type: 'message.started';
  sessionId: string;
  payload: {
    messageId: string;
    role: 'user' | 'assistant' | 'system' | 'error';
    /**
     * Round-2 P0 (optional-field addition, protocol version unchanged): user
     * turn's attachment metadata, when the turn carried any. Old
     * Renderers/Hosts simply ignore an unknown key — backward compatible.
     */
    attachments?: MessageAttachmentMeta[];
    /**
     * Round-2 P0 (optional-field addition, protocol version unchanged): the
     * SDK assistant message's actual model id, when known. Only ever set on
     * `role: 'assistant'` — lets the renderer show the model that really
     * answered instead of the locally-selected one it might silently differ
     * from. Old Renderers/Hosts simply ignore an unknown key.
     */
    model?: string;
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

/** One selectable option within an AskUserQuestion item. */
export interface QuestionOption {
  label: string;
  description?: string;
  /** Optional preview content rendered when the option is focused. */
  preview?: string;
}

/** One question within an AskUserQuestion tool call (SDK contract: 1-4 items). */
export interface QuestionItem {
  question: string;
  /** Short chip/tag label (~12 chars per SDK contract). */
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/**
 * Emitted when the model calls AskUserQuestion (parked via canUseTool, same
 * mechanism as permission.requested). Answered by the question.respond command.
 */
export interface QuestionRequestedEvent extends RuntimeEventBase {
  type: 'question.requested';
  sessionId: string;
  payload: {
    questionId: string;
    questions: QuestionItem[];
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
    outcome: 'answered' | 'cancelled' | 'rejected';
    /** question text (verbatim key) -> answer; multiSelect joined with ", ". */
    answers?: Record<string, string>;
    /**
     * Freeform text typed instead of picking a structured option. When both
     * are sent the CLI shows the model only response — treat as exclusive.
     */
    response?: string;
  };
}

/**
 * T-14 (Codex precedent T-20, optional-field addition, no protocol version
 * bump): the CLI permission mode this Host session actually runs with.
 * Mirrors the Agent SDK's own `PermissionMode` union — `claudeRuntime.ts`'s
 * `CHAT_PERMISSION_MODE` constant is the single source of truth that feeds
 * both the SDK query() options and this payload, so the renderer can never
 * report a mode the Host did not actually send to the SDK.
 */
export type SessionPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan';

export interface SessionCreatedEvent extends RuntimeEventBase {
  type: 'session.created' | 'session.resumed';
  sessionId: string;
  payload?: { runtimeIdentity?: string; permissionMode?: SessionPermissionMode };
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
