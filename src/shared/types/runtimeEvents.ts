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
  | 'session.permissionUpdated'
  | 'session.settingsEcho'
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
  | 'extensionUi.request'
  | 'extensionUi.cancelled'
  | 'extensionUi.reset'
  | 'permission.activity'
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
      /** Precedence-resolved credential type in effect (never the value) — see claudeSettings.ts. Absent on an old Host build. */
      authTokenType?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' | 'none';
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

/**
 * F2 (2026-08-18 watchdog redesign): one Host watchdog window elapsed and the
 * watchdog DECLINED to abort. Status stays 'running' — the turn is alive.
 *
 * Optional-field addition; AGENT_HOST_PROTOCOL_VERSION stays 1 (same
 * precedent as SessionRetryInfo above). GUARD FOR LATER READERS: if you are
 * ever tempted to promote this to its own RuntimeEventType, you must FIRST
 * prove that the old renderer reducer is a no-op on unknown event types —
 * until that proof exists, an optional field on an already-consumed event is
 * the only shape whose compatibility is established rather than assumed.
 */
export interface SessionLivenessNote {
  /** Which watchdog spoke. */
  source: 'ttft' | 'stall';
  /** The budget that elapsed with no qualifying progress, ms. */
  budgetMs: number;
  /** Why it declined to abort — never a guess, always the branch that ran. */
  reason: 'awaiting_user' | 'tool_running' | 'insufficient_evidence';
  /** Whether the TTFT table was permanently closed by this note (§3.2 markDegraded). */
  degraded: boolean;
}

export interface SessionStatusEvent extends RuntimeEventBase {
  type: 'session.status';
  sessionId: string;
  payload: {
    status: SessionRuntimeStatus;
    retry?: SessionRetryInfo;
    liveness?: SessionLivenessNote;
  };
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
 * `CHAT_PERMISSION_MODE` constant is the DEFAULT that feeds both the SDK
 * query() options and this payload, so the renderer can never report a mode
 * the Host did not actually send to the SDK.
 *
 * D48 S3: the vocabulary became a `const` array because the request side now
 * has to VALIDATE an untrusted value against it (`isSessionPermissionMode`
 * lives in the renderer, the Host needs its own reader). The union is derived
 * from the array rather than written twice — a second copy is how the wire and
 * the validator end up disagreeing about `dontAsk`. Still frozen at five
 * values: SDK 0.3.218's own `PermissionMode` is these exact five
 * [实测 sdk.d.ts:1720, 06-probes P2(b)].
 */
export const SESSION_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
  'plan',
] as const;

export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number];

/**
 * Codex `approval_policy` (measured, S1 §1.5): `untrusted` = only trusted
 * commands run unattended and escalation is forbidden; `on-request` = the
 * model decides when to ask; `never` = never asks, failures go back to the
 * model. The object-shaped `granular` variant exists on the wire but is not
 * modelled this round.
 */
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const;

export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];

/** Codex `sandbox_mode` (measured). Network is a separate dimension, below. */
export const CODEX_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

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
      /**
       * Sub-dimension of the sandbox, not of the approval policy — and OPTIONAL
       * since the S3 terminal check.
       *
       * It is the one dimension this Host never asks for: `thread/start` takes
       * `sandbox` as a string, and `networkAccess` comes back only inside the
       * expanded sandbox object of the RESULT. So the only honest values are
       * "the runtime said on", "the runtime said off" and "the runtime has not
       * said" — the last of which is this key being absent. It was a required
       * `boolean` for exactly as long as the Host had a single hard-coded
       * sandbox tier to believe a default for; once S3 made the tier
       * user-selectable (`danger-full-access` has no sandbox at all, therefore
       * no network limit), a constant `false` would have reported the opposite
       * of the truth on the most dangerous tier. Absent renders as "not
       * reported", never as "off".
       */
      networkAccess?: boolean;
    };

/**
 * D48 S3 §5.4 — the REQUEST half of the pair. Preference is what the UI can
 * ASK for; `SessionPermissionPolicy` above is what the Host reports it actually
 * ran with. Two types, never one, for two reasons that both bite:
 *
 *  1. `networkAccess` is a FACT and not a request field — it appears only in
 *     codex's `thread/start` RESULT, as the server's default for the sandbox
 *     tier we asked for (`codexRuntime.ts` CODEX_PERMISSION_DEFAULT header,
 *     [实测]). The Codex arm below therefore has NO such key, so no UI built on
 *     this type can claim to control it (§5.7-C8 negative control), and
 *     `isSessionPermissionPreference` REFUSES a payload that carries one rather
 *     than dropping it quietly — pretending to have applied a posture nobody
 *     applied is the failure this pair exists to prevent.
 *  2. Merging them would let a renderer echo be read as a request (and vice
 *     versa) on a wire where both travel on the same command family.
 *
 * The dangerous tiers (`bypassPermissions`, `danger-full-access`) ARE part of
 * the vocabulary — the §8.0-Q3 decision gives them a control with a warning and
 * a second confirmation. What they must never be is a DEFAULT or a fallback: see
 * `isDangerousPermissionPreference` and the enumeration in
 * `chatAgentDefaults.ts` (§5.7-C13).
 */
export type SessionPermissionPreference =
  | { agent: 'claude-code'; permissionMode: SessionPermissionMode }
  | {
      agent: 'codex';
      approvalPolicy: CodexApprovalPolicy;
      sandboxMode: CodexSandboxMode;
    };

/** The Claude arm of the request union — the shape `query()` options need. */
export type ClaudePermissionPreference = Extract<
  SessionPermissionPreference,
  { agent: 'claude-code' }
>;

/** The Codex arm — approval + sandbox, and provably no `networkAccess`. */
export type CodexPermissionPreference = Extract<SessionPermissionPreference, { agent: 'codex' }>;

function permissionPreferenceRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Protocol-boundary guards: `permissionPreference` arrives as untrusted JSON
 * (renderer → Main → Host over NDJSON, and off app settings on disk), and the
 * value decides what a session may do without asking.
 *
 * ## Why the caller passes its own agent name
 *
 * This module cannot spell the chat-binding literal in value position
 * (`agentWireStatic.test.ts` Rule 2: it has exactly one home) and cannot VALUE
 * import the constant either — the Host loads this file under Node's
 * `--experimental-strip-types`, which only resolves specifiers carrying an
 * explicit `.ts`, while the root tsconfig rejects that suffix for `src/shared`
 * [实测: ERR_MODULE_NOT_FOUND on an extensionless value import]. Every caller
 * already holds the constant it means (`CLAUDE_CODE_AGENT` / `CODEX_AGENT`), so
 * the name travels IN rather than being re-homed here — and the discriminant is
 * still checked, which is what a shape-only guard could not do.
 *
 * ## What each guard refuses
 *
 * The arm's own keys must be present and valid AND the other arm's keys must be
 * absent: `{agent:'codex', permissionMode:'plan'}` is a real renderer bug shape
 * (JSON has no discriminant enforcement) and half-reading it would apply a tier
 * nobody asked for. Unknown EXTRA keys are otherwise tolerated — protocol
 * additivity, a newer renderer must not be refused by an older Host — with one
 * exception: a Codex preference carrying `networkAccess` is refused outright,
 * because that dimension is a runtime-reported FACT and accepting the claim
 * would let the caller believe something was configured that nothing configured
 * (§5.5 last bullet).
 *
 * The `as` casts are the honest spelling: `agent` is compared against a value
 * typed as the WIDE `AgentWireName`, which cannot narrow a discriminated union,
 * so the narrowing is stated rather than inferred.
 */
export function claudePermissionPreference(
  value: unknown,
  claudeAgent: AgentWireName
): ClaudePermissionPreference | undefined {
  const raw = permissionPreferenceRecord(value);
  if (!raw || raw.agent !== claudeAgent) return undefined;
  if ('approvalPolicy' in raw || 'sandboxMode' in raw) return undefined;
  return (SESSION_PERMISSION_MODES as readonly unknown[]).includes(raw.permissionMode)
    ? (value as ClaudePermissionPreference)
    : undefined;
}

export function codexPermissionPreference(
  value: unknown,
  codexAgent: AgentWireName
): CodexPermissionPreference | undefined {
  const raw = permissionPreferenceRecord(value);
  if (!raw || raw.agent !== codexAgent) return undefined;
  if ('permissionMode' in raw || 'networkAccess' in raw) return undefined;
  return (CODEX_APPROVAL_POLICIES as readonly unknown[]).includes(raw.approvalPolicy) &&
    (CODEX_SANDBOX_MODES as readonly unknown[]).includes(raw.sandboxMode)
    ? (value as CodexPermissionPreference)
    : undefined;
}

/** Both agent names, for the callers that validate a preference of either arm. */
export interface PermissionPreferenceAgents {
  claudeCode: AgentWireName;
  codex: AgentWireName;
}

/**
 * Untrusted value → a preference of EITHER arm, or `undefined`.
 *
 * For the boundary that does not yet know which agent it is looking at (the
 * Host's command dispatch, the settings sanitizer). Whether the preference is
 * addressed to the RIGHT agent is a separate question those callers ask after
 * this one — refusing a mismatch is their job, and both of them do it.
 */
export function readSessionPermissionPreference(
  value: unknown,
  agents: PermissionPreferenceAgents
): SessionPermissionPreference | undefined {
  return (
    claudePermissionPreference(value, agents.claudeCode) ??
    codexPermissionPreference(value, agents.codex)
  );
}

/**
 * The two tiers the §8.0-Q3 decision calls dangerous: Claude's SDK bypass and
 * codex's full-access sandbox. Both are selectable (with a warning and a second
 * confirmation); NEITHER may ever be produced by a default, a fallback, a
 * degradation arm or a not-yet-hydrated placeholder (§5.7-C13/C16).
 *
 * One predicate, so the settings layer, the confirmation gate and the
 * never-a-default assertions all read the same table.
 */
export const DANGEROUS_PERMISSION_MODE: SessionPermissionMode = 'bypassPermissions';
export const DANGEROUS_CODEX_SANDBOX_MODE: CodexSandboxMode = 'danger-full-access';

export function isDangerousPermissionPreference(
  value: SessionPermissionPreference | undefined
): boolean {
  if (!value) return false;
  // Narrowed by KEY, like the arm extractors above: the exported agent
  // constants are typed as the wide `AgentWireName` and do not narrow a
  // discriminated union.
  return 'permissionMode' in value
    ? value.permissionMode === DANGEROUS_PERMISSION_MODE
    : value.sandboxMode === DANGEROUS_CODEX_SANDBOX_MODE;
}

/**
 * D48 S4 / R18 — must this mid-session change be refused for want of a second
 * confirmation?
 *
 * ONE predicate for TWO walls. Main refuses first (so a dangerous posture is
 * unreachable from a renderer path that skipped the dialog) and the Host refuses
 * again (so the runtime is safe to drive from anywhere), and the thing that must
 * not happen is the two walls disagreeing about what counts as confirmation —
 * one of them accepting the string `"true"` off a JSON payload while the other
 * does not is a wall with a door in it.
 *
 * `!== true` rather than a falsiness test, deliberately: `confirmed` arrives as
 * untrusted JSON, and every value that is not the boolean `true` — `"true"`,
 * `1`, `{}` — means the caller did not state what this asks. Expanding privilege
 * is the one decision that gets no benefit of the doubt.
 */
export function permissionChangeNeedsConfirmation(
  preference: SessionPermissionPreference | undefined,
  confirmed: unknown
): boolean {
  return isDangerousPermissionPreference(preference) && confirmed !== true;
}

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
 * D48 S4 — when a posture the caller ASKED for starts to apply.
 *
 * The two axes are not the same axis and the copy must not pretend they are
 * (§6.3): codex's `thread/settings/update` is zero-turn and takes effect on the
 * thread that is already open, while Claude's `permissionMode` is a `query()`
 * option and every send opens a new `query()` — so the change lands on the NEXT
 * turn and nothing about the in-flight one moves [实测 06-probes P1/P2/P3].
 * The Host says which rather than letting the renderer infer it from the agent
 * name, because the renderer would then own a protocol fact it cannot verify.
 */
export type PermissionUpdateEffective = 'immediately' | 'next_turn';

/**
 * D48 S4 §6 — the ACK half of a mid-session posture change: this Host accepted
 * this preference for this session.
 *
 * Deliberately a REQUEST echo (`SessionPermissionPreference`) and not a fact
 * (`SessionPermissionPolicy`), which is the same split S3 drew and the same
 * reason: on the Codex axis "the update call returned" is not "the thread runs
 * under it" — the response body is empty [实测 06-probes P3: `null`/`{}`], and
 * the only echo of what the thread ACTUALLY runs is the
 * `thread/settings/updated` notification, which arrives on its own as a
 * `session.settingsEcho` below. Anything that renders a posture as a fact must
 * read that one; this event is what a control converges on and what a failed
 * update never produces (D7/D9/D10).
 *
 * Correlated by `requestId`, because Main waits for exactly this event (or a
 * correlated `host.error`) to decide whether the session snapshot may be
 * rewritten. A change that was refused must leave the snapshot byte-identical.
 */
export interface SessionPermissionUpdatedEvent extends RuntimeEventBase {
  type: 'session.permissionUpdated';
  sessionId: string;
  payload: {
    /** The accepted request, re-stated by the runtime that accepted it. */
    preference: SessionPermissionPreference;
    effective: PermissionUpdateEffective;
  };
}

/**
 * D48 S4 §6.2-6 — the posture a runtime says a session is running under, stated
 * outside the create/resume handshake.
 *
 * ## Both axes produce it, for the same reason and from different frames
 *
 * A mid-session tier change has to become visible without the session being
 * created or resumed again, and neither runtime restates its posture on its own:
 *
 *  - **Codex** broadcasts `thread/settings/updated`, a FULL snapshot of the
 *    thread [实测 06-probes P3], and this is one mapping of it. It is also the
 *    only echo there is — `turn/start`'s response, `turn/started`,
 *    `turn/completed` and `thread/read` all carry no settings at all
 *    [实测 06-probes §0.4].
 *  - **Claude** has no protocol frame to carry one, so the Host emits this at
 *    the moment it hands `permissionMode` to `query()` — the one instant on that
 *    axis at which the tier stops being a request and becomes what the SDK is
 *    running. Its `session.created` / `session.resumed` payloads carry the same
 *    value, but they fire ONCE per Host session (`sendPreamble` sends directly
 *    on an already-bound session), so within one app run they cannot report a
 *    change that happened after the session was opened.
 *
 * Neither arm is synthesized: each one restates something the runtime has
 * already been given or has already reported, never something a caller asked for.
 * The ACK for a request is `session.permissionUpdated` above; this is the fact.
 *
 * The field is optional and only present when there was something to say: this
 * event says what the runtime said, and a key it did not carry is silence rather
 * than a value.
 *
 * 遗留 §8.2-L12 (the thread's current MODEL, which after a sticky override is no
 * longer the one `thread/start` was given) is NOT carried here yet: it has no
 * reader in the renderer, and shipping a payload field ahead of its consumer is
 * the producer-side half of the empty-shell shape. It lands with the reader.
 */
export interface SessionSettingsEchoEvent extends RuntimeEventBase {
  type: 'session.settingsEcho';
  sessionId: string;
  payload: {
    /** The posture the session reports it is running under, right now. */
    permissionPolicy?: SessionPermissionPolicy;
  };
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

/**
 * T07 — Extension UI, the third and last way an agent turn can stop and ask the
 * user something (after `permission.requested` and `question.requested`).
 *
 * ## Why this exists at all
 *
 * pi extensions are written against a TUI: they call `ui.select(...)`,
 * `ui.confirm(...)`, `ui.setStatus(...)` on an `ExtensionUIContext` that pi
 * normally backs with an ANSI terminal. We are not a terminal, so the Host binds
 * a PORTABLE stand-in (`extensionUiBridge.ts`) that turns each of those calls
 * into one of these events and parks the extension's Promise until the answer
 * comes back as an `extensionUi.respond` command. `@gotgenes/pi-permission-system`
 * asks for tool approval through exactly this path (T08-b), which is why the
 * bridge is a prerequisite for permissions rather than a nice-to-have.
 *
 * ## Why it is NOT modelled on permission.requested
 *
 * A permission request is one shape with one vocabulary of answers, and the Host
 * knows what it means. An extension UI request is whatever the extension asked
 * for, and the Host is a passthrough — it cannot validate the semantics because
 * it does not know which extension is asking or why. So `method` + `args` stay
 * open and the renderer narrows them (`readExtensionUiDialogArgs` below); folding
 * this into the permission union would have made the Host claim an understanding
 * it does not have.
 */
export const EXTENSION_UI_METHODS = [
  'select',
  'confirm',
  'input',
  'editor',
  'notify',
  'setStatus',
  'setWorkingMessage',
  'setWorkingVisible',
  'setWorkingIndicator',
  'setHiddenThinkingLabel',
  'setWidget',
  'setTitle',
  'setEditorText',
  /** The bridge met a TUI-only method it cannot honour; `args` is `{ method }`. */
  'unsupported',
] as const;

export type ExtensionUiMethod = (typeof EXTENSION_UI_METHODS)[number];

/**
 * The four methods that BLOCK: the extension is awaiting a Promise and the turn
 * does not advance until this session answers. Everything else in the table is
 * fire-and-forget display state and must never be given a dialog.
 *
 * The split is load-bearing on both sides — the renderer decides whether to open
 * a modal off it, and the Host decides whether to keep a pending entry off it —
 * so it lives here once instead of being re-derived as two lists that drift.
 */
export const EXTENSION_UI_DIALOG_METHODS = ['select', 'confirm', 'input', 'editor'] as const;

export type ExtensionUiDialogMethod = (typeof EXTENSION_UI_DIALOG_METHODS)[number];

/**
 * T10 — one capability table for the pi ExtensionUIContext surface.
 *
 * `portable` has a real GUI/local implementation, `semantic-noop` can safely do
 * nothing (or return a stable local fallback) without lying to the extension,
 * and `tui-only` must be reported so the renderer can offer a TUI path. Future
 * methods deliberately fall into `tui-only` instead of throwing from the Proxy.
 */
export type ExtensionUiCapability = 'portable' | 'semantic-noop' | 'tui-only';

export const EXTENSION_UI_CAPABILITIES = {
  select: 'portable',
  confirm: 'portable',
  input: 'portable',
  editor: 'portable',
  notify: 'portable',
  setStatus: 'portable',
  setWidget: 'portable',
  setWorkingMessage: 'semantic-noop',
  setWorkingVisible: 'semantic-noop',
  setWorkingIndicator: 'semantic-noop',
  setHiddenThinkingLabel: 'semantic-noop',
  setTitle: 'semantic-noop',
  pasteToEditor: 'semantic-noop',
  setEditorText: 'semantic-noop',
  getEditorText: 'semantic-noop',
  getAllThemes: 'semantic-noop',
  getTheme: 'semantic-noop',
  setTheme: 'semantic-noop',
  getToolsExpanded: 'semantic-noop',
  onTerminalInput: 'tui-only',
  custom: 'tui-only',
  addAutocompleteProvider: 'tui-only',
  setFooter: 'tui-only',
  setHeader: 'tui-only',
  setEditorComponent: 'tui-only',
  getEditorComponent: 'semantic-noop',
  setToolsExpanded: 'tui-only',
} as const satisfies Record<string, ExtensionUiCapability>;

export type KnownExtensionUiContextMethod = keyof typeof EXTENSION_UI_CAPABILITIES;

export function extensionUiCapability(method: string): ExtensionUiCapability {
  return method in EXTENSION_UI_CAPABILITIES
    ? EXTENSION_UI_CAPABILITIES[method as KnownExtensionUiContextMethod]
    : 'tui-only';
}

export function isExtensionUiMethod(value: unknown): value is ExtensionUiMethod {
  return typeof value === 'string' && (EXTENSION_UI_METHODS as readonly string[]).includes(value);
}

export function isExtensionUiDialogMethod(value: unknown): value is ExtensionUiDialogMethod {
  return (
    typeof value === 'string' && (EXTENSION_UI_DIALOG_METHODS as readonly string[]).includes(value)
  );
}

/** `ui.select(title, options)` — pick one string, or dismiss. */
export interface ExtensionUiSelectArgs {
  title: string;
  options: string[];
}

/** `ui.confirm(title, message)` — yes/no. Dismissal is a NO, never a yes. */
export interface ExtensionUiConfirmArgs {
  title: string;
  message: string;
}

/** `ui.input(title, placeholder?)` — free text, or dismiss. */
export interface ExtensionUiInputArgs {
  title: string;
  placeholder?: string;
}

/** `ui.editor(title, prefill?)` — multi-line text, or dismiss. */
export interface ExtensionUiEditorArgs {
  title: string;
  prefill?: string;
}

export type ExtensionUiDialogArgs =
  | ({ method: 'select' } & ExtensionUiSelectArgs)
  | ({ method: 'confirm' } & ExtensionUiConfirmArgs)
  | ({ method: 'input' } & ExtensionUiInputArgs)
  | ({ method: 'editor' } & ExtensionUiEditorArgs);

/**
 * Untrusted `(method, args)` → a dialog this renderer can actually draw.
 *
 * `undefined` means "do not open a modal": either the method is not a dialog, or
 * the extension sent a shape we cannot render. The caller must then leave the
 * request pending for the BRIDGE's fallback to settle (the bridge already
 * carries the right no-answer value per method — `false` for confirm,
 * `undefined` for the rest), because a renderer that invents an answer here
 * would be answering on the user's behalf. Refusing to draw is safe; guessing
 * what an unrenderable dialog meant is not.
 *
 * `options` is filtered rather than refused: a select whose list is partly
 * malformed is still answerable from the entries that are strings, and dropping
 * the whole dialog would strand a turn that a human could have finished. An
 * EMPTY result is refused, because a picker with nothing to pick is not one.
 */
export function readExtensionUiDialogArgs(
  method: unknown,
  args: unknown
): ExtensionUiDialogArgs | undefined {
  if (!isExtensionUiDialogMethod(method)) return undefined;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const raw = args as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title : undefined;
  if (title === undefined) return undefined;

  switch (method) {
    case 'select': {
      if (!Array.isArray(raw.options)) return undefined;
      const options = raw.options.filter((o): o is string => typeof o === 'string');
      return options.length > 0 ? { method, title, options } : undefined;
    }
    case 'confirm':
      return typeof raw.message === 'string'
        ? { method, title, message: raw.message }
        : { method, title, message: '' };
    case 'input':
      return {
        method,
        title,
        ...(typeof raw.placeholder === 'string' ? { placeholder: raw.placeholder } : {}),
      };
    case 'editor':
      return {
        method,
        title,
        ...(typeof raw.prefill === 'string' ? { prefill: raw.prefill } : {}),
      };
  }
}

/**
 * One extension UI call, on its way out to the renderer.
 *
 * `uiRequestId` and NOT the base `requestId`, deliberately: the base field means
 * "this event answers that COMMAND" everywhere else in this protocol, and this
 * event answers no command — the extension spoke on its own, mid-turn. Reusing
 * it would make Main's command-correlation table match an event that was never a
 * reply.
 *
 * `runtimeId` identifies the BRIDGE INSTANCE. There is one bridge per HOST
 * SESSION (`piRuntime.ts` keys them by `sessionId`), and a new one is minted
 * whenever that session's runtime is rebuilt — closed and reopened, or moved to
 * a different workspace. It is therefore neither process-global nor per-turn.
 *
 * An in-place session swap (reload / fork / switch) keeps the bridge and DRAINS
 * it instead: every parked dialog is settled and announced through
 * `extensionUi.cancelled`, so a late answer to one of them matches no pending
 * entry and is refused. Staleness is caught by the pair — `runtimeId` says
 * "wrong bridge", the pending map says "no such open dialog" — and a consumer
 * must check both. Deleting a dialog on `uiRequestId` alone would let a
 * cancellation from another bridge close a live one.
 */
export interface ExtensionUiRequestedEvent extends RuntimeEventBase {
  type: 'extensionUi.request';
  payload: {
    runtimeId: string;
    uiRequestId: string;
    method: ExtensionUiMethod;
    /** Open by construction — see the type doc. Narrow with `readExtensionUiDialogArgs`. */
    args: unknown;
    /** Extension-supplied deadline; the BRIDGE owns the timer, not the renderer. */
    timeoutMs?: number;
  };
}

/**
 * Why the bridge settled a dialog nobody answered.
 *
 * `timed_out` is the EXTENSION's own deadline, handed to the bridge when the
 * dialog opens, so the bridge is the only layer that can act on it. `aborted`
 * covers both the extension's own abort signal and a user Stop — a Stop must
 * drain the parked dialogs, because aborting the pi session does not reach an
 * extension blocked inside `ui.select`. The last three are teardown:
 * `session_replaced` on an in-place reload / fork / switch, `session_closed`
 * when the session itself goes away, `host_shutdown` on exit.
 */
export type ExtensionUiCancelReason =
  | 'timed_out'
  | 'aborted'
  | 'session_replaced'
  | 'session_closed'
  | 'host_shutdown';

/**
 * These dialogs are dead — close them.
 *
 * ## Why the protocol needs this at all
 *
 * The BRIDGE owns the dialog timer (see `timeoutMs` above), so it can settle a
 * blocked extension without the renderer being involved. Every such settle
 * leaves a modal on screen that no longer maps to anything: answering it is
 * harmless (the Host matches no pending entry and drops it) but the user is
 * looking at a dialog that can never do anything, with no way to tell.
 *
 * The same applies to teardown. `reload()` drains on a session swap and
 * `dispose()` on shutdown, and neither has a renderer round trip.
 *
 * So: whenever the bridge settles a dialog WITHOUT a user answer, it says so
 * here. This is the only mechanism by which a modal closes for a reason other
 * than the user closing it, which is why `reason` is carried — "it timed out"
 * and "your session was replaced" are different things to tell someone.
 */
export interface ExtensionUiCancelledEvent extends RuntimeEventBase {
  type: 'extensionUi.cancelled';
  payload: {
    runtimeId: string;
    /** Never empty — the bridge does not announce a cancellation of nothing. */
    uiRequestIds: string[];
    reason: ExtensionUiCancelReason;
  };
}

/**
 * The bridge's in-place runtime was reloaded or disposed. Renderer display
 * state is keyed by runtimeId, so this explicit event clears statuses, widgets
 * and unsupported diagnostics even when there was no blocking dialog whose
 * cancellation could otherwise reveal the lifecycle boundary.
 */
export interface ExtensionUiResetEvent extends RuntimeEventBase {
  type: 'extensionUi.reset';
  sessionId: string;
  payload: {
    runtimeId: string;
    reason: 'session_replaced' | 'session_closed' | 'host_shutdown';
  };
}

/**
 * The answer to one `extensionUi.request`, travelling back as the payload of the
 * `extensionUi.respond` command.
 *
 * `ok: false` does NOT carry a value — it means "nobody answered" (dismissed,
 * closed, torn down), and the bridge substitutes the fallback it recorded when
 * the dialog opened. That is the only place a no-answer value is decided, so a
 * dismissal can never be mistaken for a confirmation.
 */
export interface ExtensionUiResponse {
  runtimeId: string;
  uiRequestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Protocol-boundary guard: untrusted JSON → a response the bridge may act on. */
export function readExtensionUiResponse(value: unknown): ExtensionUiResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.runtimeId !== 'string' || !raw.runtimeId) return undefined;
  if (typeof raw.uiRequestId !== 'string' || !raw.uiRequestId) return undefined;
  // `ok` is the discriminant between "the user answered" and "substitute the
  // fallback", so a missing or non-boolean one is refused rather than coerced —
  // a truthy string would turn a dismissal into an answer.
  if (typeof raw.ok !== 'boolean') return undefined;
  return {
    runtimeId: raw.runtimeId,
    uiRequestId: raw.uiRequestId,
    ok: raw.ok,
    ...('value' in raw ? { value: raw.value } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  };
}

/**
 * T08-b — what the permission plugin BROADCAST, as opposed to what it asked.
 *
 * ## Why this is not `permission.requested`
 *
 * `permission.requested` is a QUESTION: the Host is parked waiting for a
 * `permission.respond` command, and the renderer's card is the thing that
 * answers it. These events answer nothing. `@gotgenes/pi-permission-system`
 * asks its question through `extensionUi.request` (it calls `ui.select`), and
 * emits these on pi's extension event bus purely so observers can watch —
 * the plugin's own emit helpers swallow listener errors precisely because "a
 * consumer failure must not block the permission dialog itself".
 *
 * Routing them onto `permission.requested` would therefore put a card with live
 * Allow/Deny buttons on screen next to the real modal, and pressing them would
 * send a `permission.respond` that no runtime is waiting for.
 *
 * ## What it is for
 *
 * The record. After the user answers the modal, the decision should survive in
 * the timeline — which tool was asked about, what was decided, and whether the
 * policy decided it without asking at all. `policy_allow` never raises a dialog,
 * so this is the ONLY evidence that a tool call was gated rather than unchecked.
 */
export type PermissionActivityPhase = 'prompt' | 'decision';

/**
 * How a decision was reached, verbatim from the plugin's own vocabulary.
 *
 * Deliberately a plain `string` and not a union: this is a third-party
 * package's enum on a best-effort broadcast, and a closed union here would mean
 * a plugin upgrade that adds a resolution silently fails our own guard. The
 * renderer displays it and must not branch on values it has not seen.
 */
export interface PermissionActivityEvent extends RuntimeEventBase {
  type: 'permission.activity';
  payload: {
    phase: PermissionActivityPhase;
    /** The plugin's request id. One tool call runs several gates, hence several. */
    requestId: string;
    /** Actual gate surface, e.g. `path` or `external_directory`. */
    surface?: string;
    /** Prompt display/tool surface when it differs from the actual gate. */
    toolSurface?: string;
    /** The command / path / tool name that was evaluated. */
    value?: string;
    agentName?: string;
    /** `decision` phase only. */
    result?: 'allow' | 'deny';
    /** `decision` phase only — e.g. `user_approved`, `policy_allow`, `gate_error`. */
    resolution?: string;
    /** `decision` phase only — which config scope supplied the winning rule. */
    origin?: string;
    /** The rule pattern, when the plugin exposes it for this phase. */
    matchedPattern?: string;
    /**
     * The ask came from a SUBAGENT and was forwarded to this session to answer.
     * Worth surfacing on its own: approving a subagent's request is not the same
     * act as approving one's own, and the two are otherwise indistinguishable.
     */
    forwarded?: boolean;
    requesterAgentName?: string;
  };
}

/** Union of events Host may emit. */
export type RuntimeEvent =
  | HostReadyEvent
  | HostErrorEvent
  | SessionStatusEvent
  | SessionStderrEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionPermissionUpdatedEvent
  | SessionSettingsEchoEvent
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
  | ExtensionUiRequestedEvent
  | ExtensionUiCancelledEvent
  | ExtensionUiResetEvent
  | PermissionActivityEvent
  | SubagentActivityEvent
  | SessionTerminalEvent;

/**
 * A Runtime Event as a RUNTIME writes it — everything except the two fields the
 * Host entry stamps on the way out (`seq`, `timestamp`).
 *
 * The Host's `EmitFn` takes `Record<string, unknown>`, which is what let
 * `tool.completed` ship an `isError` field and `session.status.retry` an
 * `errorMessage` field: both compiled, both travelled, neither was read by any
 * consumer, and a failed tool rendered as a successful one for as long as that
 * lasted. A runtime that types its emit calls as this union gets that class of
 * drift as a compile error instead.
 *
 * Distributed over the union MEMBER by member so the discriminant survives:
 * a bare `Omit<RuntimeEvent, …>` would collapse `type` and `payload` into their
 * own unions and stop cross-checking each other. Distributing over `type`
 * literals instead would not work either — several members legitimately carry a
 * union there (`'session.completed' | 'session.failed' | 'session.stopped'`),
 * and `Extract` by one literal would miss them.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type RuntimeEventDraft = DistributiveOmit<RuntimeEvent, 'seq' | 'timestamp'>;
