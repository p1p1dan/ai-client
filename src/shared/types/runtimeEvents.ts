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
  SubagentHistorySummary,
} from './sessionHistory';

export type RuntimeEventType =
  | 'host.ready'
  | 'host.error'
  | 'session.created'
  | 'session.resumed'
  | 'session.updated'
  | 'session.history'
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
  | 'custom.message'
  | 'custom.entry'
  | 'permission.requested'
  | 'permission.resolved'
  | 'question.requested'
  | 'question.resolved'
  | 'preview.requested'
  | 'usage.updated'
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
     * (process-level), never provider-specific behavior.
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
  /**
   * T093 / decision 029 clause 3 — absolute epoch ms of the next attempt.
   *
   * `delayMs` above is a DURATION, and a duration only means something at the
   * instant it was measured: the banner drew "retrying in 30s" once and left it
   * there for thirty seconds, so a user watching a stalled turn could not tell a
   * countdown from a frozen one. An absolute instant lets the renderer recompute
   * `retryAt - now` every second and switch wording when it passes.
   *
   * Optional for the compatibility reason the whole of this interface follows:
   * an old consumer ignores the extra key and keeps reading `delayMs`.
   */
  retryAt?: number;
  /**
   * Absolute epoch ms when the attempt that just failed was issued.
   *
   * With `retryAt` this is what makes "the request had been silent for 118
   * seconds" sayable — the fact the 2026-09-19 field report was missing. It is
   * also what the main-process log line derives its per-attempt duration from,
   * so the number in the log and the number on screen cannot disagree.
   */
  attemptStartedAt?: number;
  /**
   * The delegation whose provider call is being retried.
   *
   * Absent means the main conversation's own request. Present means a subagent
   * running under this session: delegate retries used to be completely silent
   * (the delegate's budget was built with no callbacks at all), so a fan-out
   * sitting in a gateway outage looked like a fan-out that had simply stopped.
   */
  delegationId?: string;
}

/**
 * F2 (2026-08-18 watchdog redesign): one Host watchdog window elapsed and the
 * watchdog DECLINED to abort. Status stays 'running' — the turn is alive.
 *
 * Optional-field addition, following the same compatibility precedent as
 * SessionRetryInfo above. GUARD FOR LATER READERS: if you are
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

/**
 * D12 (U24): why a session went `disconnected` without the user asking.
 *
 * Only ever set alongside `status: 'disconnected'`, and only for the ONE cause
 * the user cannot otherwise account for: the pool was full and this session's
 * idle worker was reclaimed to make room. Ending a conversation from the
 * sidebar, closing the app and a crash all reach `disconnected` too, and none
 * of them need explaining — the user did them, or already saw an error.
 *
 * A rider on `session.status` rather than a new event type, per the convention
 * `SessionRetryInfo` set: old consumers ignore the extra key and keep reading
 * the status they already understood.
 */
export type SessionDisconnectReason = 'capacity_reclaimed';

/**
 * T034 (session-02): this session's file was rewritten when it was opened,
 * because it held rows no reader could parse (decision 006).
 *
 * The user paid for the repair — a dropped row is a message, or a branch
 * pointer, that is gone — so the fact is not allowed to live only in a trace
 * file. Another rider on `session.status`, for the compatibility reason
 * `SessionRetryInfo` established: an old renderer ignores the extra key.
 *
 * Unlike `retry`, this is a fact about the FILE and not about the current turn,
 * so the store keeps it instead of clearing it on the next status.
 *
 * Line numbers only. The dropped text may be a half-written prompt, and a
 * diagnostic that ships the user's own content to every consumer of the event
 * stream is a worse trade than one that says which line to go and look at.
 */
export interface SessionRecoveryNote {
  /** 1-based line numbers dropped from the session file, in file order. */
  skippedLines: number[];
}

export interface SessionStatusEvent extends RuntimeEventBase {
  type: 'session.status';
  sessionId: string;
  payload: {
    status: SessionRuntimeStatus;
    retry?: SessionRetryInfo;
    liveness?: SessionLivenessNote;
    disconnectReason?: SessionDisconnectReason;
    recovery?: SessionRecoveryNote;
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
    /** Renderer-owned pending-send identity, present on authoritative Pi user echoes. */
    attemptId?: string;
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

/**
 * T101 — while a tool call's arguments are still streaming, its `input` is a
 * REDACTED summary: the short identifying fields that have arrived, plus a
 * `__streaming: { bytes, lines }` key standing for the long text withheld.
 * Defined in `shared/streamingToolArgs.ts` (a leaf module, so the renderer can
 * import the reader as a value without pulling this whole file into a chunk);
 * produced by `runtime/events/streamingToolArgs.ts`.
 *
 * The key's presence is the "not final yet" signal. One later `tool.updated`
 * carries the complete arguments without it.
 */
export type { StreamingToolArgs } from '../streamingToolArgs.ts';

export interface ToolStartedEvent extends RuntimeEventBase {
  type: 'tool.started';
  sessionId: string;
  payload: {
    messageId: string;
    toolCallId: string;
    name: string;
    /**
     * The call's arguments. Complete once the call is settled; while they are
     * still streaming this is the redacted summary described above, and a later
     * `tool.updated` replaces it.
     */
    input?: unknown;
  };
}

/**
 * N5 (devbox 2026-09-24): the flags a `tool.completed` output carries, in its
 * `details`, for a call that did NOT do its work (or, T130, did not finish
 * it). Such an output is the
 * `{ content, details }` shape (the same one a file-change `review` rides in),
 * so the renderer store passes it through untouched.
 *
 * Structured on purpose: the only other trace of either case is prose — a
 * refusal's text starts "Refused:", a never-run call's error is an English
 * sentence — and a row must not decide what happened by matching words.
 */
export interface ToolOutcomeDetails {
  /**
   * The runtime answered the call with a refusal instead of acting on it (the
   * subagent plugin's repeated idle `TaskWait`/`TaskStop`/`TaskList`). Copied
   * from the tool result's own `details.refused`.
   */
  refused?: true;
  /**
   * The call was never executed: the run ended (Stop, a loop-guard cut, a
   * provider error) after the model wrote the call and before it ran.
   */
  notStarted?: true;
  /**
   * T130: the call DID run and was cut short by Stop — a `bash` command whose
   * exec ended `aborted` / `disposed`. Settled `ok: false`, but not a failure
   * of the tool: the row reads "… · Stopped" in its ordinary tone and keeps
   * whatever output the command produced. Copied from the tool result's own
   * `details.stopped`.
   */
  stopped?: true;
}

export interface ToolCompletedEvent extends RuntimeEventBase {
  type: 'tool.completed';
  sessionId: string;
  payload: {
    messageId: string;
    toolCallId: string;
    ok: boolean;
    /**
     * A string, or `{ content, details }` when the result carries structured
     * facts the timeline reads: `details.review` (a file change) and the
     * {@link ToolOutcomeDetails} flags.
     */
    output?: unknown;
    error?: string;
  };
}

interface CustomTimelinePayload {
  messageId: string;
  customType: string;
  content: string;
}

/** Generic serializable fallback for a Pi extension custom message. */
export interface CustomMessageEvent extends RuntimeEventBase {
  type: 'custom.message';
  sessionId: string;
  payload: CustomTimelinePayload;
}

/** Generic serializable fallback for a Pi extension custom session entry. */
export interface CustomEntryEvent extends RuntimeEventBase {
  type: 'custom.entry';
  sessionId: string;
  payload: CustomTimelinePayload;
}

/**
 * S2 (c): what the card is asking about. Absent = `'tool'`, which is every
 * Claude request there has ever been, so old Hosts stay correct by omission.
 */
export type PermissionRequestKind = 'tool' | 'exec' | 'file_change';

/**
 * T023 — WHICH everyday action the gated tool is about to take, as an id.
 *
 * `kind` says what shape the card takes; this says what the sentence above it
 * reads. They are deliberately not the same axis: `write` and `edit` are both
 * `file_change` but "write a file" and "modify a file" are different promises,
 * and `read` is a plain `tool` that still deserves a sentence.
 *
 * An id rather than a sentence because the producer is the worker, which has
 * no locale: it ran before the user's language setting existed as far as it is
 * concerned. Shipping a finished sentence is how the four Chinese strings this
 * replaced ended up on English installs. The renderer owns the wording
 * (`PERMISSION_ACTION_LABELS` in `questionCardModel.ts`) and the dictionary
 * owns the translation, which is the same split `contentLabel` already uses.
 *
 * Absent means "no sentence available" — an unrecognised tool, or a Host older
 * than this field. The card then shows the tool name alone, exactly as it did
 * before any description existed.
 */
export type PermissionRequestAction = 'run_command' | 'write_file' | 'edit_file' | 'read_file';

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
 *
 * Every member DENIES. Widening the permission gear while a card is up settles
 * that card as a plain allow instead, carrying no reason at all: the user moved
 * the setting that decides this, so the outcome is theirs and the transcript
 * says the same thing it would have said had they pressed the button.
 */
export type PermissionAutoReason = 'unsupported' | 'session_closed' | 'aborted' | 'timed_out';

/**
 * What "Allow for session" on THIS card would remember.
 *
 * The button says "Allow for session" and nothing about its reach, and a button
 * whose reach a user cannot see is a button they cannot decide about. So the
 * runtime, which is the only side that knows what its own matcher will do, says
 * it here and the card words it. For bash the reach is genuinely wider than the
 * line on the card — every command starting with the same prefix — and for a
 * file tool it is that one file, which is worth naming precisely because a user
 * might otherwise assume the folder came with it.
 *
 * Absent when there is nothing a grant could be keyed on (MCP tools, skills) or
 * when the request cannot be remembered at all — in both cases there is nothing
 * extra to state, and the card keeps its generic scope line.
 */
export interface PermissionGrantScope {
  /** `command`: a bash prefix. `path`: one file, for one tool. */
  kind: 'command' | 'path';
  /**
   * Already shaped for display: a comma-joined prefix list, or a
   * workspace-relative path (absolute when the path is outside the workspace, so
   * an approval that reaches out of the project reads like one).
   */
  value: string;
}

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
 * the generated contract types it `["string","null"]` [contract], i.e. a command-less
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
       * remainder of the session [contract, marked UNSTABLE upstream]. Present only
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
    /**
     * Free prose from the ASKING AGENT, never from this app.
     *
     * T023 moved the native runtime's own one-line summary off this field and
     * onto `action`, because the two are not the same thing: whatever an agent
     * writes here is content and must be shown verbatim, while our own summary
     * is UI copy and must be translated. They shared a field until the copy
     * started reaching English installs in Chinese.
     */
    description?: string;
    /** T023: our own one-line summary, as an id the renderer words. */
    action?: PermissionRequestAction;
    input?: unknown;
    /**
     * T-34 (optional-field addition, protocol version unchanged): the
     * subagent that originated this request — canUseTool `options.agentID`,
     * same id family as `task_started.task_id` / `tool_use_result.agentId`.
     * The key is ABSENT (not undefined-valued) for main-agent requests.
     */
    agentId?: string;
    /**
     * P5-2-6: the delegate's NAME, alongside its id.
     *
     * The id is the join key and says nothing a person can read. The native
     * runtime knows the name at the gate, and a card that can say "the explorer
     * subagent wants to run this" beats one that can only say a delegation
     * started somewhere. Absent on the legacy backend, which never had it.
     */
    agentName?: string;
    /** S2: absent = `'tool'`. */
    kind?: PermissionRequestKind;
    /**
     * S2: the buttons this request actually offers, already narrowed to ids
     * this build models. Absent = the historical pair, Allow / Deny.
     */
    decisions?: PermissionDecisionId[];
    /** S2: card body for exec / file_change requests. */
    detail?: PermissionDetail;
    /**
     * What an `allow_session` answer to this card would remember. Absent on
     * backends that do not model it, and on requests with nothing to say — the
     * card then shows its generic scope line rather than inventing a reach.
     */
    sessionGrantScope?: PermissionGrantScope;
    /** S2: the agent's own justification, when it sent one. */
    reason?: string;
    /**
     * How long the asker will wait, in ms from this event's `timestamp`.
     *
     * The gate has always had a deadline — the permission engine aborts the
     * approval and denies — but nothing said so on screen, so a card could sit
     * there looking answerable after the answer had stopped mattering. With it
     * the card counts down and denies at zero, which is also PI-Desktop's
     * behaviour. Absent means "no stated deadline": the card shows no clock
     * rather than inventing one.
     */
    timeoutMs?: number;
    /**
     * S2: how many offered decisions this build did not model and therefore
     * dropped from `decisions`. Shown at the bottom of the card so a narrowed
     * choice never looks like the whole choice.
     */
    omittedDecisionCount?: number;
    /**
     * Which card of the current burst this is, 1-based.
     *
     * The native gate shows one card at a time: a model that asks for five
     * tools in one message used to raise five cards whose 120-second clocks all
     * started together, so the ones the user had not reached yet could expire
     * unseen. They are queued instead, and this says where in that line the card
     * on screen sits. Counting resets once the queue drains, so a request that
     * waited for nobody is always `1`.
     *
     * Absent on any backend that does not queue (the legacy one) and on older
     * Hosts. The card then shows no progress rather than inventing one.
     */
    queuePosition?: number;
    /**
     * How many requests the gate knows about right now: this card plus the ones
     * still queued behind it.
     *
     * NOT a promise about how many cards will follow. The queue is fed while
     * the user reads, so this number can be larger on the next card than it was
     * on this one — "2 of 5" after "1 of 3" is correct, not a glitch. It never
     * shrinks within a burst, and a renderer that treats it as a fixed total
     * will draw a progress bar that jumps backwards.
     */
    queueDepth?: number;
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
  payload?: {
    error?: string;
    /**
     * T066 rework — the machine-readable half, beside the sentence rather than
     * inside it.
     *
     * `error` is what the renderer shows, so it stays the provider's or the
     * runtime's own wording. The operator log needs the code (a refusal read
     * `turn failed: session exceeds the configured size budget`, with nothing
     * to grep for), and so would any later reader that has to branch on the
     * reason. Absent when the code is already spelled in `error` — the thrown
     * path prefixes it there for the renderer's recovery cards.
     */
    errorCode?: string;
    /**
     * decision 040 — why a run that COMPLETED stopped where it did, when that
     * was not the model's own choice. Only ever set on `session.completed`.
     *
     * `turn_limit`: the run reached the interactive turn ceiling, got one
     * tool-less wrap-up turn to summarise, and paused. Not a failure — the
     * work is intact and a plain "continue" carries on — which is why it rides
     * on the completed event instead of `session.failed` + `errorCode`.
     *
     * `interjected`: Ctrl+Enter ended the run at a turn boundary so the queued
     * message can go next. Delegates the run started may still be working in
     * the background, so a reader must not treat their lanes or their pending
     * approval cards as over.
     *
     * Optional-field addition, the same compatibility precedent as
     * `SessionLivenessNote`: a renderer that predates it reads a plain
     * completion.
     *
     * decision 046 adds two causes that only Main synthesizes, and only on
     * `session.stopped` (always followed by a settling `session.status`):
     *
     * `no_active_turn`: a Stop (or Ctrl+Enter) reached a worker with no turn
     * running. Nothing was interrupted; the event only settles a session some
     * reader still believed was running, and must not mark a turn as stopped.
     *
     * `forced`: the turn did not end on its own — Main tore its worker down
     * (the Stop watchdog expired, the worker died while stopping, or the
     * session was closed mid-turn).
     */
    stopCause?: 'turn_limit' | 'interjected' | 'no_active_turn' | 'forced';
  };
}

/**
 * P5-2-3 — the `browser_preview` tool asking the host to show a workspace file.
 *
 * Shaped like `permission.requested` and `question.requested` because it is the
 * same kind of thing: a tool call parks, something outside the runtime happens,
 * and one RPC (`worker.preview.respond`) settles it. Two differences:
 *
 * - **Main answers this one, not the renderer.** The preview surface is an
 *   Electron window, so `WorkerManager` handles the event where it arrives
 *   instead of forwarding a question to a card. It still travels as a runtime
 *   event so the path is the one already traced, logged and sequenced.
 * - **`path` is already gated.** The tool resolved and canonicalised it through
 *   the same permission path `read` uses before emitting, so the host opens a
 *   file the session was allowed to read rather than re-deciding that itself.
 */
export interface PreviewRequestedEvent extends RuntimeEventBase {
  type: 'preview.requested';
  sessionId: string;
  payload: {
    previewId: string;
    /** Absolute, canonical, already permission-gated workspace path. */
    path: string;
    /**
     * Bring the preview to the front.
     *
     * False is the delegate's case and the reason this field exists: a subagent
     * working in the background must be able to show a page without pulling the
     * user out of what they are doing.
     */
    focus: boolean;
  };
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

export interface SessionCreatedEvent extends RuntimeEventBase {
  type: 'session.created' | 'session.resumed';
  sessionId: string;
  payload?: {
    runtimeIdentity?: string;
    /**
     * Pi runtime binding echoed by the worker. Persisted consumers reject
     * absent or unknown bindings rather than guessing.
     */
    agent?: AgentWireName;
    /**
     * Which permission system this session's worker actually came up on, as
     * reported by `worker.bootstrap`.
     *
     * `user_configured` means the user's own agentDir declares
     * `@gotgenes/pi-permission-system`. Historically that meant this app did not
     * inject its bundled copy and the permission tiers stopped working, which is
     * why the tier control reads this field.
     *
     * T025: that reasoning no longer holds. Nothing injects a pi permission
     * extension since P6-5 — every decision is made by
     * `src/runtime/plugins/permissions/`, whatever the user has installed — so
     * the flag now only reports what the user's own pi config declares.
     *
     * T026: the native runtime therefore sends `bundled` unconditionally, and
     * `user_configured` has no producer left. What a user installs decides the
     * built-in Pi TERMINAL instead, which the plugins page now says in words.
     * The renderer half of this note is `stores/permissionGate.ts`.
     *
     * Optional: an older Host never sends it, and "not reported" is not the
     * same claim as "bundled".
     */
    permissionGate?: 'bundled' | 'user_configured';
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
     * Pi history-reader binding. Pairs with `runtimeIdentity`, which remains
     * opaque outside the worker runtime.
     */
    agent?: AgentWireName;
    /** Initial/refresh replaces the hydrated prefix; older prepends one page. */
    mode?: 'initial' | 'older' | 'refresh' | 'branch';
    /** Chronological. Message ids carry the `h:` contract prefix. */
    messages: HistoryMessage[];
    /** Number of newer projected messages skipped from the active branch leaf. */
    offset?: number;
    /** Normalized page size (1..500). */
    limit?: number;
    /** Total projected messages on the active Pi branch. */
    totalCount?: number;
    /** Whether an older page exists. */
    hasMore?: boolean;
    /** T33 active-branch generation; tree dialogs reject older snapshots. */
    branchRevision?: number;
    /** True when messages were dropped by pagination/input/output caps. */
    truncated: boolean;
    omittedCount: number;
    /**
     * P5-2-6 — delegations recorded on this branch, for rebuilding their panels.
     *
     * Rides the history event because it answers the same question at the same
     * moment: what did this conversation contain. Absent on the legacy backend
     * and on a session that delegated nothing — and absent is not "none
     * reported", it is "nothing to report", which is why the renderer only
     * rebuilds lanes when the key is present.
     */
    subagents?: SubagentHistorySummary[];
    error?: HistoryReadError;
    parseStats?: HistoryParseStats;
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
    /**
     * The arguments as they stand now, replacing whatever the row was showing.
     *
     * Three producers, in the order one call meets them: the streaming pass
     * (a redacted summary — see `StreamingToolArgs` above), the moment
     * the call is complete (the full arguments, summary key gone), and a tool
     * that revises its own arguments mid-execution.
     */
    input?: unknown;
    /**
     * T38-c: one clamped line of the tool's own progress report, off the SDK's
     * `partialResult`. Absent when the tool reported no text — that is "no
     * status", which is not the same as an empty one, so a consumer must not
     * render a blank strip for it. Never the growing output body: `output`
     * arrives once, settled, on `tool.completed`.
     */
    status?: string;
    /**
     * T146 — epoch ms the `bash` tool actually handed the command to
     * `runtimeExec.run`, published as an `onUpdate` right before that call
     * (see `plugins/tools/index.ts`). `tool.started` fires while arguments
     * are still streaming (T101), so its own elapsed already includes arg
     * streaming, the approval wait and the path re-check; this is the
     * runtime's own timeout origin, so a running row can show "elapsed /
     * limit" without the earlier, longer wait making it look past the limit.
     * Absent for every other tool and for a `tool.updated` that only carries
     * revised `input`.
     */
    execStartedAt?: number;
  };
}

/**
 * Token/cost totals for one turn, plus the session's context occupancy.
 *
 * `payload` stays `Record<string, unknown>` because this event predates its
 * current producer: the Claude host emitted interim estimates here under a
 * different key set. The Pi-only shape is defined and narrowed in
 * `shared/piUsage.ts` — build it with `buildPiUsagePayload`, read it with
 * `readPiUsagePayload`, and do not hand-write the keys at either end.
 */
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
/**
 * How a delegation ended.
 *
 * The first four are T-34's, from the legacy host's CLI vocabulary. P5-2-4 adds
 * the last two, which the native runtime can tell apart and the legacy host
 * never could:
 *
 * - `stopped` — the parent model called `TaskStop`, or the user pressed Stop.
 * - `truncated` — the delegate hit its own `maxTurns` cap with work left.
 *
 * They are separate values rather than `failed` on purpose. To a person reading
 * a transcript, "you stopped this", "it ran out of turns" and "it broke" are
 * three different things, and the P5-2 contract names collapsing them as a
 * regression. Consumers that only understand the original four must widen
 * together with this type — a reducer with a four-value allowlist does not
 * degrade gracefully, it drops the event.
 */
export type SubagentRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stopped'
  | 'truncated';

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
 * T08-b — what the permission plugin BROADCAST, as opposed to what it asked.
 *
 * ## Why this is not `permission.requested`
 *
 * `permission.requested` is a QUESTION: the Host is parked waiting for a
 * `permission.respond` command, and the renderer's card is the thing that
 * answers it. These events answer nothing. `@gotgenes/pi-permission-system`
 * asked its question on a channel of its own (the Extension UI bridge, retired
 * by decision 012) and emits these on pi's extension event bus purely so
 * observers can watch —
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
    /**
     * The delegation whose tool call raised this gate, when a subagent's did.
     *
     * Attribution, not authorization. A "for this session" grant stays session
     * scoped no matter which agent earned it (runtime-hardening decision 003),
     * so this answers "who was this checked for" and never narrows what the
     * check permits.
     *
     * This is the pair the native runtime's gate actually sends (see
     * `src/runtime/plugins/permissions/activity.ts`). The legacy backend sent
     * `forwarded` / `requesterAgentName` below instead; the renderer
     * (`permissionActivityRow.ts`) reads both pairs as the same fact
     * (MODEL-20, 2026-09-19).
     */
    delegationId?: string;
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
     *
     * Legacy backend only — the native runtime's gate never sets this pair,
     * it sets `delegationId` / `agentName` above instead.
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
  | SessionHistoryEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ThinkingStartedEvent
  | ThinkingDeltaEvent
  | ToolStartedEvent
  | ToolUpdatedEvent
  | ToolCompletedEvent
  | CustomMessageEvent
  | CustomEntryEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | QuestionRequestedEvent
  | QuestionResolvedEvent
  | PreviewRequestedEvent
  | UsageUpdatedEvent
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
