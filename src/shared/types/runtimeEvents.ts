/**
 * Runtime Events emitted by Agent Host → Main → Renderer.
 * AiClient's own protocol — not @opencode-ai/sdk Event.
 * See docs/plans/2026-07-23-openchamber-chat-refactor-ard.md §5.3 / §6
 */

import type { AgentWireName } from './agentWire';
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
  | 'session.stderr'
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
  | 'subagent.activity'
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
    /**
     * Host capability flags — Main degrades gracefully when absent (old Host).
     *
     * Doctrine (S2 C6): every key here describes what THIS HOST BUILD can do
     * (process-level), never what one agent supports. Per-agent differences go
     * through the `agents` list plus the per-session facts on `session.created`
     * — do not grow a `Partial<Record<AgentWireName, …>>` here.
     */
    capabilities?: {
      history?: boolean;
      /** Extended thinking enabled on this Host (CP3 decision: default on). */
      thinking?: boolean;
      /**
       * T-34: this Host segregates subagent traffic into `subagent.activity`
       * events. Absent on an old Host — an empty panel then means "not
       * supported", not "no subagent ran".
       */
      subagentActivity?: boolean;
      /**
       * S2: agents this Host build can actually run. Absent = an old Host,
       * which only knows Claude Code. The renderer disables (not hides) the
       * agents missing from this list.
       */
      agents?: AgentWireName[];
      /**
       * S2: this Host normalizes per-agent permission facts into
       * `SessionPermissionPolicy`. Absent = old Host, UI keeps the old
       * `permissionMode`-only behaviour.
       */
      permissionPolicy?: boolean;
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
 * T-35: one CLI stderr line, forwarded from the Host's SDK `stderr` callback
 * (`claudeRuntime.ts`). The line is REDACTED and length-clamped host-side
 * (`stderrRedaction.ts`) before it ever crosses IPC — the Main-process bridge
 * is a content-agnostic passthrough, so nothing downstream gets a second
 * chance at a secret. New event type, not a `session.status` rider: stderr is
 * an independent diagnostic stream, and per protocol convention (see
 * `SessionRetryInfo` above) old consumers simply ignore an unknown type.
 */
export interface SessionStderrEvent extends RuntimeEventBase {
  type: 'session.stderr';
  sessionId: string;
  payload: { line: string };
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

/**
 * S2 (c): what the card is asking about. Absent = `'tool'`, which is every
 * Claude request there has ever been, so old Hosts stay correct by omission.
 */
export type PermissionRequestKind = 'tool' | 'exec' | 'file_change';

/**
 * S2 (c): agent-neutral decision vocabulary, four wide. `decisions.ts`
 * (slice 4) maps each id onto the three measured dialects — v2
 * CommandExecution (`accept | acceptForSession | decline | cancel`), v2
 * FileChange (same four), and legacy `ReviewDecision`
 * (`approved | approved_for_session | {denied} | abort`). Claude only ever
 * uses `allow` / `deny`.
 *
 * `decline` vs `cancel` is a real distinction on the wire, not a synonym:
 * declining refuses the call and lets the turn continue, cancelling refuses it
 * and aborts the turn. Anything this build cannot map must resolve to a DENY —
 * never to an allow.
 */
export type PermissionDecisionId = 'allow' | 'allow_session' | 'deny' | 'cancel';

/**
 * S2 (c): why the client answered a request without a human deciding.
 * Doubles as the drain reason when the Host clears its pending server-request
 * table on session stop/close/shutdown (C10) — one vocabulary, not two.
 */
export type PermissionAutoReason = 'unsupported' | 'session_closed' | 'aborted' | 'timed_out';

/** One file touched by a `file_change` approval. */
export interface PermissionFileChange {
  path: string;
  change: 'add' | 'update' | 'delete' | 'rename';
  /**
   * Unified diff when the Host has it. Codex sends the diff on the `item/started`
   * frame that shares this request's itemId, NOT on the approval request — a
   * missing diff means it had not arrived, and is never a reason to delay the
   * reply (hard constraint 7).
   */
  diff?: string;
  /** The diff above was clamped to `PERMISSION_DIFF_MAX_BYTES`. */
  truncated?: boolean;
}

/**
 * S2 (c): the body a permission card renders under its header. Absent for a
 * plain tool request, whose `input` already carries everything.
 *
 * S3 slice 4 widened both arms. Every addition is OPTIONAL and the protocol
 * version is unchanged, so an older Host stays correct by omission. The one
 * non-additive change is `exec.command`, which went from required to optional:
 * the generated contract types it `["string","null"]` [契约], i.e. a command-less
 * approval is a declared shape (zsh-exec-bridge subcommand approvals), not a
 * malformed frame. Relaxing it is safe because the only producer is the Codex
 * approval path added in the same slice and the only consumer is the card body,
 * which must still render what the request DOES say (network host, extra
 * permissions, grant root) — an approval we cannot describe is still an
 * approval the user has to answer.
 */
export type PermissionDetail =
  | {
      kind: 'exec';
      /** Absent when codex reported no command; the card says so rather than rendering empty. */
      command?: string;
      cwd?: string;
      /** Managed-network approval context: the host this command wants to reach. */
      network?: { host: string; protocol: string };
      /**
       * Permissions this command asks for ON TOP of the session's posture.
       * Counted, never expanded: `AdditionalPermissionProfile` is a recursive
       * shape with zero captured samples, so listing entries would be invention.
       * "There are extras, how many, network or not" is enough for the user to
       * see this is not an ordinary exec.
       */
      extraPermissions?: { fileSystemEntries: number; networkRequested: boolean };
    }
  | {
      kind: 'file_change';
      changes: PermissionFileChange[];
      omittedFileCount?: number;
      /**
       * Allowing this patch ALSO allows writes anywhere under this root for the
       * remainder of the session [契约, marked UNSTABLE upstream]. Present only
       * when codex asked for it. The card has to state it, or an Allow meant
       * for one patch silently grants a directory.
       */
      grantRoot?: string;
    };

/**
 * Host-side clamps for `PermissionDetail`. Provisional numbers (U10): no real
 * large-patch sample yet, and an unbounded diff would sit in the red-line
 * message state forever. Named so the correction is a one-line edit.
 */
export const PERMISSION_DIFF_MAX_FILES = 20;
export const PERMISSION_DIFF_MAX_BYTES = 64 * 1024;

export interface PermissionRequestedEvent extends RuntimeEventBase {
  type: 'permission.requested';
  sessionId: string;
  payload: {
    permissionId: string;
    toolName: string;
    description?: string;
    input?: unknown;
    /**
     * T-34 (optional-field addition, protocol version unchanged): the
     * subagent that originated this request — canUseTool `options.agentID`,
     * same id family as `task_started.task_id` / `tool_use_result.agentId`.
     * The key is ABSENT (not undefined-valued) for main-agent requests.
     */
    agentId?: string;
    /** S2: absent = `'tool'`. */
    kind?: PermissionRequestKind;
    /**
     * S2: the buttons this request actually offers, already narrowed to ids
     * this build models. Absent = the historical pair, Allow / Deny.
     */
    decisions?: PermissionDecisionId[];
    /** S2: card body for exec / file_change requests. */
    detail?: PermissionDetail;
    /** S2: the agent's own justification, when it sent one. */
    reason?: string;
    /**
     * S2: how many offered decisions this build did not model and therefore
     * dropped from `decisions`. Shown at the bottom of the card so a narrowed
     * choice never looks like the whole choice.
     */
    omittedDecisionCount?: number;
  };
}

/** One selectable option within an AskUserQuestion item. */
export interface QuestionOption {
  label: string;
  description?: string;
  /** Optional preview content rendered when the option is focused. */
  preview?: string;
}

/**
 * One question within an AskUserQuestion tool call.
 *
 * Count/format contracts differ per agent — Claude's SDK says 1-4 items,
 * Codex's tool description says 1-3 questions with a ≤12-char header and 2-3
 * options. The renderer validates NEITHER: a check written to one contract
 * misjudges the other agent's payload.
 */
export interface QuestionItem {
  question: string;
  /** Short chip/tag label (~12 chars per SDK contract). */
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  /**
   * S2 (a, C8): the agent's own id for this question, when it sends one
   * (Codex does; Claude does not). When present it is the answers-map key —
   * see `QuestionResolvedEvent.payload.answers`. It exists because the
   * question TEXT is not a key: two questions in one turn may repeat verbatim,
   * and the renderer folds answers into a record before they ever reach the
   * Host, so a duplicate is already lost by then.
   */
  id?: string;
  /**
   * S2 (a): the answer is a credential (Codex marks API keys this way).
   * The card masks the free-text input — a key typed in plain sight would land
   * in the timeline permanently, which contradicts the Host-side stderr
   * redaction this repo already ships (T-35).
   */
  isSecret?: boolean;
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
    /**
     * S2 (a): the agent will resolve the question by itself after this many
     * ms. `null` / absent = never. NOT implemented client-side this round: the
     * question is rendered as an ordinary one, and the agent's own timeout
     * settles it — which is the same outcome as a user who does not answer.
     */
    autoResolutionMs?: number | null;
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
    /**
     * S2 (c): which button settled it, when the answer was richer than
     * allow/deny (`allow_session`, `cancel`). Absent = the boolean says it all.
     */
    decision?: PermissionDecisionId;
    /**
     * S2 (c): set when nobody was asked — the Host answered on the client's
     * behalf. Absent means a human decided, which is what the timeline has
     * always implied and could not previously prove.
     */
    autoReason?: PermissionAutoReason;
  };
}

export interface QuestionResolvedEvent extends RuntimeEventBase {
  type: 'question.resolved';
  sessionId: string;
  payload: {
    questionId: string;
    outcome: 'answered' | 'cancelled' | 'rejected';
    /**
     * Opaque key -> answer; multiSelect joined with ", ".
     *
     * S2 (C8): the key is `QuestionItem.id` when the item carried one and the
     * question text verbatim otherwise, so a replayed session mixes both key
     * spaces (Claude rows: text, Codex rows: id). Treat it as opaque — looking
     * a question up by its text is wrong for half the corpus.
     */
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

/**
 * Codex `approval_policy` (measured, S1 §1.5): `untrusted` = only trusted
 * commands run unattended and escalation is forbidden; `on-request` = the
 * model decides when to ask; `never` = never asks, failures go back to the
 * model. The object-shaped `granular` variant exists on the wire but is not
 * modelled this round.
 */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

/** Codex `sandbox_mode` (measured). Network is a separate dimension, below. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * S2 (c, C4): the permission posture a session actually runs with, per agent.
 *
 * A discriminated union rather than one widened enum, because the two agents
 * are not the same shape: Claude has a single mode, Codex is four orthogonal
 * dimensions of which three are modelled here. `SessionPermissionMode` above
 * stays FROZEN in Claude's own vocabulary — an old renderer reading a Codex
 * session gets `false` out of `isSessionPermissionMode` and keeps its previous
 * state, which is the correct degradation rather than a wrong reading.
 *
 * The discriminant is `agent`, valued with `AgentWireName`'s literals. Codex's
 * posture is always sent explicitly by the Host and is never inherited from
 * `~/.codex/config.toml` — a local config saying `danger-full-access` would
 * otherwise silently switch every approval off.
 */
export type SessionPermissionPolicy =
  | { agent: 'claude-code'; permissionMode: SessionPermissionMode }
  | {
      agent: 'codex';
      approvalPolicy: CodexApprovalPolicy;
      sandboxMode: CodexSandboxMode;
      /** Sub-dimension of the sandbox, not of the approval policy. */
      networkAccess: boolean;
    };

export interface SessionCreatedEvent extends RuntimeEventBase {
  type: 'session.created' | 'session.resumed';
  sessionId: string;
  payload?: {
    runtimeIdentity?: string;
    permissionMode?: SessionPermissionMode;
    /**
     * S2 (b): which runtime this session is bound to, echoed by the runtime
     * that hard-codes its own identity. Absent = an old Host, hence Claude
     * Code. The reducer keeps the session's existing binding when absent.
     */
    agent?: AgentWireName;
    /**
     * S2 (c): the posture the Host really handed the agent — the same constant
     * that fed `thread/start`, so the surface can never report a policy that
     * was not actually sent. Absent = fall back to the `permissionMode` row.
     */
    permissionPolicy?: SessionPermissionPolicy;
  };
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
    /**
     * S2 (d): which reader produced these messages. Absent = Claude Code, the
     * only reader that existed before. Pairs with `runtimeIdentity`, which is
     * opaque and only interpretable together with the agent that issued it.
     */
    agent?: AgentWireName;
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

/**
 * T-34: live subagent activity, segregated host-side from the main-agent
 * stream by the SDK's top-level `parent_tool_use_id` (probe: default mode
 * already forwards subagent tool_use/tool_result/prompt-echo; only
 * text/thinking need `forwardSubagentText`). ONE new event type with a
 * `kind`-discriminated payload rather than a family of types: the protocol
 * surface grows by a single member while the only consumer (the adjacent
 * subagent-activity store's reducer) branches on `kind` exactly as cheaply.
 * Old renderers ignore the unknown type — and that silence is the FIX for
 * the pre-T-34 defect of subagent tool calls rendering as the main agent's.
 *
 * Deliberately NOT carried (size/privacy/duplication):
 *  - the delegation prompt (already the Agent row's input body);
 *  - subagent tool OUTPUT bodies (only a clamped errorText on failure);
 *  - `task_notification.summary` (duplicates the Agent row's own output).
 */
export type SubagentRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Counters shared by `system/task_*` heartbeats and the structured report. */
export interface SubagentUsage {
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** `tool_use_result.toolStats`, passed through verbatim — no derivation. */
export interface SubagentToolStats {
  readCount?: number;
  searchCount?: number;
  bashCount?: number;
  editFileCount?: number;
  linesAdded?: number;
  linesRemoved?: number;
  otherToolCount?: number;
}

/**
 * Structured final report off the Agent tool_result's `tool_use_result`
 * (SDK: "render from it instead of parsing the tool_result text").
 * Excludes `content`/`prompt` — the protocol does not re-carry bodies.
 */
export interface SubagentReport {
  /**
   * Host-normalized (`normalizeSubagentRunStatus`) — never a raw CLI string.
   * `running` is legitimate here: an async (`run_in_background`) delegation's
   * report lands while the subagent is still working. Codex review round 1,
   * m6: an open string let every unknown value read as success downstream.
   */
  status?: SubagentRunStatus;
  agentType?: string;
  resolvedModel?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  toolStats?: SubagentToolStats;
}

/** Every activity must land on a delegation carrier. */
export interface SubagentActivityBase {
  /** The main agent's `Agent`/`Task` tool_use id — the timeline join key. */
  parentToolCallId: string;
  /** CLI-side id: `task_*.task_id` = `tool_use_result.agentId` = canUseTool `options.agentID`. */
  agentId?: string;
}

export type SubagentActivityPayload =
  | (SubagentActivityBase & {
      kind: 'started';
      agentType?: string;
      description?: string;
      taskType?: string;
    })
  /** Whole-message granularity (no char stream). Host drops empty bodies. */
  | (SubagentActivityBase & { kind: 'text' | 'thinking'; id: string; text: string })
  /** `input` is host-side whitelist-projected and per-field clamped — never file bodies. */
  | (SubagentActivityBase & {
      kind: 'tool.started';
      toolCallId: string;
      name: string;
      input?: Record<string, string | number>;
    })
  /** Success carries no output body; failure carries a clamped errorText. */
  | (SubagentActivityBase & {
      kind: 'tool.completed';
      toolCallId: string;
      ok: boolean;
      errorText?: string;
    })
  /** `task_progress` heartbeat — renderer folds into a single slot, not a log. */
  | (SubagentActivityBase & {
      kind: 'progress';
      description?: string;
      lastToolName?: string;
      usage?: SubagentUsage;
    })
  /** `task_updated` (endedAt) and `task_notification` (usage) merged terminal. */
  | (SubagentActivityBase & {
      kind: 'status';
      status: SubagentRunStatus;
      endedAt?: number;
      usage?: SubagentUsage;
    })
  | (SubagentActivityBase & { kind: 'report'; report: SubagentReport })
  /** Per-delegation event cap hit; the carrier goes silent after this. */
  | (SubagentActivityBase & { kind: 'capped'; limit: number });

export interface SubagentActivityEvent extends RuntimeEventBase {
  type: 'subagent.activity';
  sessionId: string;
  payload: SubagentActivityPayload;
}

/** Union of events Host may emit. */
export type RuntimeEvent =
  | HostReadyEvent
  | HostErrorEvent
  | SessionStatusEvent
  | SessionStderrEvent
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
  | SubagentActivityEvent
  | SessionTerminalEvent;
