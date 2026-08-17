/**
 * Agent Host protocol types (Main ↔ Node 24 Host over stdio NDJSON).
 * See docs/plans/2026-07-23-openchamber-chat-refactor-ard.md §5.3
 */

import type { AgentWireName } from './agentWire';
import type { PermissionDecisionId } from './runtimeEvents';

/**
 * Stays 1. Multi-agent support (S2) is additive only — optional fields, new
 * error-code VALUES, no new command or event types — so a version bump would
 * buy nothing and cost the `protocol_mismatch` signal its meaning. A new Host
 * talking to an old renderer just carries keys nobody reads; an old Host
 * talking to a new renderer is handled by `capabilities.agents`, not by
 * refusing the handshake.
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
  | 'session.listHistory'
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

/**
 * Reasoning effort level (T-20 selector base). Mirrors the Agent SDK
 * `EffortLevel` union — a TOP-LEVEL query() option, not `output_config.effort`.
 * Verified against SDK 0.3.218 sdk.d.ts and empirically by
 * spikes/c16-thinking-shape-probe.ts (scenario D, clean turn on the gateway).
 * `xhigh` needs Opus 4.7+/Sonnet 5/Fable 5 and silently degrades to `high`
 * elsewhere; `max` is select-models-only. Omit to inherit the model default.
 */
export const SESSION_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type SessionEffortLevel = (typeof SESSION_EFFORT_LEVELS)[number];

/**
 * Protocol-boundary guard for an untrusted `effort`.
 *
 * D48 §4.6 gave this a second caller: the Codex axis now puts effort on
 * `turn/start` too, and the gateway's vocabulary was measured to be these exact
 * five words with an EXPLICIT error outside them [实测 调查 04 探测 G]. One
 * table, two runtimes — a per-runtime copy is how the two axes end up
 * disagreeing about what `xhigh` means.
 */
export function isSessionEffortLevel(value: unknown): value is SessionEffortLevel {
  return typeof value === 'string' && (SESSION_EFFORT_LEVELS as readonly string[]).includes(value);
}

export interface SessionCreateCommand extends AgentHostCommandBase {
  type: 'session.create';
  payload: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    /** Session default effort; per-send effort overrides it for one turn. */
    effort?: SessionEffortLevel;
    /**
     * S2 (b/d): which runtime to start. Absent = Claude Code. The Host
     * dispatches runtime AND history reader off this one key, in one switch —
     * two independent lookups would be two places to disagree.
     */
    agent?: AgentWireName;
  };
}

export interface SessionResumeCommand extends AgentHostCommandBase {
  type: 'session.resume';
  payload: {
    sessionId: string;
    /**
     * The agent's own resume handle (not AiClient sessionId): a Claude Code
     * session id, a Codex threadId, whatever the runtime issued. Opaque —
     * only interpretable together with `agent`, never dispatched on by shape.
     */
    runtimeIdentity: string;
    workspacePath: string;
    /** S2 (b/d): which runtime resumes it. Absent = Claude Code. */
    agent?: AgentWireName;
    /**
     * Must be re-sent on resume: cli.js is re-spawned per turn, and a resumed
     * session without an explicit model silently falls back to the CLI default
     * (a different model than the user picked, and a full prompt-cache rewrite).
     */
    model?: string;
    /** Session default effort; per-send effort overrides it for one turn. */
    effort?: SessionEffortLevel;
  };
}

/**
 * Attachment carried on session.send (C-13, user feedback F2).
 * kind=image: data is base64-encoded bytes; kind=text: data is the raw text.
 * File paths never enter the protocol — Renderer reads and encodes locally.
 */
export interface SessionAttachment {
  kind: 'image' | 'text';
  /** MIME type, e.g. image/png, text/plain. */
  mediaType: string;
  data: string;
  /** Display / document title, e.g. the pasted file name. */
  name?: string;
}

export interface SessionSendCommand extends AgentHostCommandBase {
  type: 'session.send';
  payload: {
    sessionId: string;
    /** May be empty when attachments are present (attachment-only send). */
    text: string;
    attachments?: SessionAttachment[];
    /** Per-turn effort override; falls back to the session default. */
    effort?: SessionEffortLevel;
    /**
     * Per-turn model override; falls back to the session default from
     * create/resume. Round-2 P0 fix: purely additive optional field on an
     * existing command — AGENT_HOST_PROTOCOL_VERSION stays 1, an old Host
     * simply ignores this key from a new Renderer (backward compatible).
     */
    model?: string;
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

/**
 * List historical sessions for a workspace (includes CLI-created sessions
 * unknown to the app index — Claude Code's live in ~/.claude/projects/).
 * Host replies with a session.historyListed event correlated by requestId.
 */
export interface SessionListHistoryCommand extends AgentHostCommandBase {
  type: 'session.listHistory';
  payload: {
    workspacePath: string;
    /**
     * S2 (d, C7): which agents to fan out to. Same name and same meaning as
     * `capabilities.agents`. Absent = Claude Code only, i.e. today's behaviour
     * byte for byte.
     */
    agents?: AgentWireName[];
  };
}

export interface PermissionRespondCommand extends AgentHostCommandBase {
  type: 'permission.respond';
  payload: {
    sessionId: string;
    permissionId: string;
    /**
     * Stays REQUIRED. Every existing sender writes it, and the richer
     * `decision` below is the optional refinement — inverting that would make
     * four hand-written inline payloads illegal at once.
     */
    allow: boolean;
    /**
     * S2 (c): the button the user actually pressed, when it was richer than
     * allow/deny. Absent means `allow ? 'allow' : 'deny'`; the two must never
     * contradict each other.
     */
    decision?: PermissionDecisionId;
  };
}

export interface QuestionRespondCommand extends AgentHostCommandBase {
  type: 'question.respond';
  payload: {
    sessionId: string;
    questionId: string;
    /**
     * Opaque key -> chosen answer; multiSelect answers joined with ", "
     * (comma+space, matching the CLI separator). S2 (C8): the key is
     * `QuestionItem.id` when the item carried one, the question text verbatim
     * otherwise.
     *
     * The Claude CLI silently re-asks on a bare allow with no collected
     * answers, so at least one of answers/response/cancel must be present —
     * that guard is Claude's, not a general rule: Codex treats an empty
     * `answers` map as a clean cancellation and does not re-ask.
     */
    answers?: Record<string, string>;
    /**
     * Freeform text typed instead of selecting a structured option.
     * The CLI surfaces response to the model in preference to answers —
     * senders should treat the two as mutually exclusive.
     */
    response?: string;
    /** Dismiss the question: resolves with empty answers (no denial record). */
    cancel?: boolean;
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
  | SessionListHistoryCommand
  | PermissionRespondCommand
  | QuestionRespondCommand;

/** Host driver selected in Phase 0. */
export type AgentHostDriver = 'agent-sdk' | 'stream-json';

/** Default Host driver — Agent SDK; stream-json remains fallback. */
export const DEFAULT_AGENT_HOST_DRIVER: AgentHostDriver = 'agent-sdk';

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

export type NodeRuntimeSource = 'env' | 'nvm' | 'fnm' | 'volta' | 'path' | 'explicit' | 'bundled';

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
