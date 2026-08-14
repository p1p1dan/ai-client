/**
 * Convert Claude Agent SDK messages into stable AiClient Runtime Events.
 * Unknown shapes are logged and skipped (Host must not crash).
 *
 * T-34 (subagent segregation): every SDK `assistant`/`user`/`stream_event`
 * message carries a top-level `parent_tool_use_id` — `null` for the main
 * agent, the delegating `Agent`/`Task` tool_use id for anything a subagent
 * did. Before T-34 this normalizer never looked at it, so a subagent's tool
 * calls were emitted as ordinary `tool.started`/`tool.completed` and rendered
 * as if the MAIN agent had made them. The parent-set branches below are that
 * fix: they never reach the main-stream emitters, and forward the same facts
 * on the segregated `subagent.activity` event instead.
 *
 * The `parent_tool_use_id === null` path is a REGRESSION RED LINE — it must
 * stay byte-for-byte the pre-T-34 behavior, and
 * `__tests__/eventNormalizerSubagent.test.ts` pins that directly.
 */

import { CoalescingEmitter } from './coalescingEmitter.ts';
import {
  clampSubagentText,
  DELEGATION_TOOL_NAMES,
  projectSubagentToolInput,
  SUBAGENT_EVENTS_MAX_PER_DELEGATION,
  SUBAGENT_TEXT_MAX_CHARS,
  subagentErrorText,
} from './subagentProjection.ts';

export type EmitFn = (event: Record<string, unknown>) => void;
export type LogFn = (...args: unknown[]) => void;

/**
 * 1d: minimum spacing between interim `usage.updated` events on the
 * `system/thinking_tokens` tick path — that path fires ~1:1 with every
 * `thinking_delta` (spike §1 Q5: 47~58 per turn), which is far more often
 * than a status line can usefully change. The `message_delta` step and the
 * thinking-block tail emit deliberately bypass this throttle.
 */
const INTERIM_USAGE_MIN_INTERVAL_MS = 250;

/** 1b: a partial content block being accumulated for whole-message reconciliation. */
interface PartialBlock {
  type: 'text' | 'thinking';
  acc: string;
  /** Consumed by a whole `assistant` message already — cannot match a second one. */
  matched: boolean;
}

interface NormalizerState {
  assistantMessageId: string | null;
  textBlockId: string | null;
  thinkingBlockId: string | null;
  /** tool_use id → started */
  seenTools: Set<string>;
  /** tool_use id started but no tool_result yet (local execution in flight). */
  openTools: Set<string>;
  textStarted: boolean;
  thinkingStarted: boolean;
  /** A result event emitted the turn's terminal events. */
  sawResult: boolean;
  turnIndex: number;
  /**
   * Round-2 P0: the actual model id read off the first raw SDK `assistant`
   * message this turn (`message.model`), captured before `ensureAssistant`
   * builds the envelope so it can ride along on the same `message.started`.
   */
  assistantModel: string | null;
  /**
   * T-34: CLI `task_id` → the delegation's `parent_tool_use_id`. Needed
   * because `system/task_updated` is the ONE control event that carries only
   * `task_id` (no `tool_use_id`), and it is also the only terminal signal a
   * FAILING subagent may produce. Filled by every task_* event that carries
   * both ids.
   */
  taskIdToParent: Map<string, string>;
  /** T-34: `subagent.activity` events already forwarded, per delegation. */
  subagentEventCount: Map<string, number>;
  /** T-34: delegations whose per-delegation cap fired — silence latch. */
  subagentCapped: Set<string>;
  /**
   * T-34 (review M2): main-stream `tool_use` id → tool name, so a
   * `tool_use_result` can be checked against the tool that actually ran.
   * `tool_use_result` is a generic SDK field — without this, any tool whose
   * result happened to carry `agentId`+`agentType` would be mistaken for a
   * delegation report and have its output body silently replaced.
   */
  toolNameById: Map<string, string>;

  // -------------------------------------------------------------------------
  // Partial-messages batch (片 1). Every field below stays at its initial
  // value unless a MAIN-agent `stream_event` carrying real content arrives, so
  // the control position (gateway not honouring `includePartialMessages`, or
  // the flag off) keeps the exact pre-batch behavior —
  // `__tests__/eventNormalizerGolden.test.ts` is the arbiter.
  // -------------------------------------------------------------------------
  /**
   * 1b THE GATE. Set ONLY when a main-agent `content_block_start(text|thinking)`
   * — or a text/thinking delta that has to establish its own accumulator —
   * arrives. Deliberately NOT set by `message_start`/`message_delta`/tool
   * blocks: a gateway that emits only envelope events has not actually
   * duplicated any content, and opening the gate there would route the whole
   * `assistant` message into a dedup path with nothing to dedup against.
   * The decision is made on OBSERVED FACT, never on the flag value (spike §3.4)
   * — that is what makes an unhonoured `includePartialMessages` degrade
   * silently into today's behavior.
   */
  partialContentSeen: boolean;
  /** 1b: content-block index → accumulator, for blocks not yet stopped. */
  openBlocks: Map<number, PartialBlock>;
  /**
   * 1b: blocks moved here by `content_block_stop`, kept (not discarded) so a
   * whole `assistant` message that arrives AFTER its block's stop can still be
   * reconciled instead of being emitted a second time.
   */
  closedBlocks: PartialBlock[];
  /**
   * 1c: tool_use id → the stub facts learned from `content_block_start`. The
   * stub's own `input` is `{}` (spike §4), so no `tool.started` is emitted from
   * it — `seenTools` is first-write-wins and would mask the real input forever.
   * The stub is kept so the information is not LOST: the whole message clears
   * it, and a `tool_result` with no whole message back-fills from it.
   */
  pendingToolStubs: Map<string, { name: string; inputJsonAcc: string }>;
  /**
   * 1c: content-block index → tool_use id, so `input_json_delta` fragments
   * (which carry only the index) reach the right stub. Cleared on
   * `message_start` alongside the content blocks — indices restart per API
   * message.
   */
  openToolBlocks: Map<number, string>;
  /** 1d: sum of every `message_delta.usage.output_tokens` this turn (per-message counters). */
  turnOutputTokensSettled: number;
  /** 1d: `system/thinking_tokens` estimate accumulated since the last settled step. */
  turnThinkingEstimate: number;
  /** 1d: monotonic peak of the displayed number — it must never count backwards. */
  turnTokensDisplayMax: number;
  /**
   * 1d: `null` means "nothing emitted yet, emit unconditionally". A `0` initial
   * value would make a mocked clock sitting at 0/10/20 look like a throttled
   * emit and turn the throttle test vacuously green.
   */
  lastInterimUsageEmitMs: number | null;
}

function newState(): NormalizerState {
  return {
    assistantMessageId: null,
    textBlockId: null,
    thinkingBlockId: null,
    seenTools: new Set(),
    openTools: new Set(),
    textStarted: false,
    thinkingStarted: false,
    sawResult: false,
    turnIndex: 0,
    assistantModel: null,
    // A delegation cannot span turns, so these reset with the turn — same
    // lifetime rule the tool sets above already follow.
    taskIdToParent: new Map(),
    subagentEventCount: new Map(),
    subagentCapped: new Set(),
    toolNameById: new Map(),
    partialContentSeen: false,
    openBlocks: new Map(),
    closedBlocks: [],
    pendingToolStubs: new Map(),
    openToolBlocks: new Map(),
    turnOutputTokensSettled: 0,
    turnThinkingEstimate: 0,
    turnTokensDisplayMax: 0,
    lastInterimUsageEmitMs: null,
  };
}

/** Lightweight attachment shape `beginTurn` needs — structurally compatible
 * with `SessionAttachment` (agent-host/../shared/types/agentHost.ts) minus
 * `data`; kept local so this module stays free of shared-type imports. */
export interface TurnAttachmentInput {
  kind: 'image' | 'text';
  mediaType: string;
  name?: string;
}

function extractTextParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: unknown };
    if ((p.type === 'text' || p.type === undefined) && typeof p.text === 'string') {
      chunks.push(p.text);
    }
  }
  return chunks.join('');
}

function extractThinkingParts(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; thinking?: unknown; text?: unknown };
    if (p.type === 'thinking') {
      if (typeof p.thinking === 'string') chunks.push(p.thinking);
      else if (typeof p.text === 'string') chunks.push(p.text);
    }
  }
  return chunks.join('');
}

interface ToolUseBlock {
  id: string;
  name: string;
  input?: unknown;
}

function extractToolUses(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ToolUseBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as {
      type?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
    if (p.type === 'tool_use' && typeof p.id === 'string' && typeof p.name === 'string') {
      out.push({ id: p.id, name: p.name, input: p.input });
    }
  }
  return out;
}

function extractToolResults(content: unknown): Array<{
  toolUseId: string;
  content: unknown;
  isError?: boolean;
}> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; content: unknown; isError?: boolean }> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as {
      type?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };
    if (p.type === 'tool_result' && typeof p.tool_use_id === 'string') {
      out.push({
        toolUseId: p.tool_use_id,
        content: p.content,
        isError: p.is_error,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// T-34 subagent shape helpers (pure)
// ---------------------------------------------------------------------------

function readString(source: unknown, field: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFiniteNumber(source: unknown, field: string): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `system/task_*.usage` → the protocol's `SubagentUsage`. Every field is
 * optional on both sides: an absent counter stays absent rather than becoming
 * a zero that the panel would render as a fact.
 */
function normalizeSubagentUsage(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage: Record<string, number> = {};
  const totalTokens = readFiniteNumber(raw, 'total_tokens');
  const toolUses = readFiniteNumber(raw, 'tool_uses');
  const durationMs = readFiniteNumber(raw, 'duration_ms');
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (toolUses !== undefined) usage.toolUses = toolUses;
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * CLI status string → `SubagentRunStatus`. An unrecognized value yields
 * `undefined` and the caller SKIPS the event: inventing a terminal state for
 * a status we cannot read would strand the carrier in a lie, whereas skipping
 * leaves the main Agent row's own `tool.completed` to settle it honestly.
 */
function normalizeSubagentRunStatus(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw) {
    case 'completed':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'aborted':
      return 'cancelled';
    case 'running':
    case 'in_progress':
    case 'started':
      return 'running';
    default:
      return undefined;
  }
}

/**
 * The structured terminal report on an Agent tool_result's `tool_use_result`
 * (SDK: "render from it instead of parsing the tool_result text").
 *
 * The gate is BOTH `agentId` and `agentType` being strings: `tool_use_result`
 * is a generic SDK field that other tools also populate, and a delegation
 * report is the only shape that carries an agent identity. `content`/`prompt`
 * are deliberately not projected — the protocol never re-carries bodies.
 */
function detectSubagentReport(raw: unknown):
  | {
      agentId: string;
      content: unknown;
      report: Record<string, unknown>;
    }
  | undefined {
  const agentId = readString(raw, 'agentId');
  const agentType = readString(raw, 'agentType');
  if (!agentId || !agentType) return undefined;

  const report: Record<string, unknown> = { agentType };
  // Review m6: normalized, not passed through. The protocol field is a
  // `SubagentRunStatus`, and an unreadable CLI string must leave it ABSENT
  // rather than smuggle an unmodelled value into the renderer's union.
  // `running` survives normalization on purpose — an `isAsync` background
  // delegation's report can legitimately be non-terminal.
  const status = normalizeSubagentRunStatus(readString(raw, 'status'));
  if (status) report.status = status;
  const resolvedModel = readString(raw, 'resolvedModel');
  if (resolvedModel) report.resolvedModel = resolvedModel;
  const totalDurationMs = readFiniteNumber(raw, 'totalDurationMs');
  if (totalDurationMs !== undefined) report.totalDurationMs = totalDurationMs;
  const totalTokens = readFiniteNumber(raw, 'totalTokens');
  if (totalTokens !== undefined) report.totalTokens = totalTokens;
  const totalToolUseCount = readFiniteNumber(raw, 'totalToolUseCount');
  if (totalToolUseCount !== undefined) report.totalToolUseCount = totalToolUseCount;

  const rawStats = (raw as Record<string, unknown>).toolStats;
  if (rawStats && typeof rawStats === 'object') {
    const stats: Record<string, number> = {};
    for (const field of [
      'readCount',
      'searchCount',
      'bashCount',
      'editFileCount',
      'linesAdded',
      'linesRemoved',
      'otherToolCount',
    ]) {
      const value = readFiniteNumber(rawStats, field);
      if (value !== undefined) stats[field] = value;
    }
    if (Object.keys(stats).length > 0) report.toolStats = stats;
  }

  return { agentId, content: (raw as Record<string, unknown>).content, report };
}

export class EventNormalizer {
  private state = newState();
  private readonly sessionId: string;
  /**
   * 1e: every emitted event goes through the coalescer. It is a straight
   * passthrough until the partial gate opens, so the control path is
   * unaffected; once open, consecutive same-block text deltas merge inside a
   * 45ms window. See `coalescingEmitter.ts`.
   */
  private readonly coalescer: CoalescingEmitter;
  private readonly log: LogFn;
  /**
   * T-34 flag (`AICLIENT_HOST_SUBAGENT_ACTIVITY`, resolved by
   * `claudeRuntime.ts`). `false` means QUIET, not legacy: subagent traffic is
   * still segregated out of the main stream — that half is a defect fix, not
   * a feature — it is simply dropped instead of forwarded. There is
   * deliberately no position that restores the pre-T-34 misattribution.
   */
  private readonly subagentActivityEnabled: boolean;

  constructor(
    sessionId: string,
    emit: EmitFn,
    log: LogFn = () => undefined,
    subagentActivityEnabled = true
  ) {
    this.sessionId = sessionId;
    this.coalescer = new CoalescingEmitter(emit);
    this.log = log;
    this.subagentActivityEnabled = subagentActivityEnabled;
  }

  /**
   * The single emit funnel. Identical call signature to the `emit` field it
   * replaced, so every existing call site is untouched; the only difference is
   * that the coalescer sits in the path (a no-op bypass while disabled).
   */
  private emit(event: Record<string, unknown>): void {
    this.coalescer.emit(event);
  }

  /**
   * Call at the start of each user send turn.
   *
   * `attachments` (round-2 P0): the turn's `SessionAttachment[]`, when any.
   * Only lightweight metadata (kind/mediaType/name) rides on the echoed
   * `message.started` — never the raw base64/text bytes, which the Host
   * already folded into the SDK prompt separately (`buildPromptWithAttachments`).
   */
  beginTurn(userText: string, attachments?: TurnAttachmentInput[], requestId?: string): void {
    // 1e: a new turn must not inherit the previous turn's buffered run — flush
    // it out (never drop: dropping would lose already-produced text) and close
    // the gate, which the new turn re-opens only on its own evidence.
    this.coalescer.setEnabled(false);
    this.state = newState();
    this.state.turnIndex += 1;
    const messageId = `user-${this.sessionId}-${Date.now()}`;
    const blockId = `${messageId}-text`;
    const attachmentMeta =
      attachments && attachments.length > 0
        ? attachments.map((a) => ({
            kind: a.kind,
            mediaType: a.mediaType,
            ...(a.name ? { name: a.name } : {}),
          }))
        : undefined;
    this.emit({
      type: 'message.started',
      sessionId: this.sessionId,
      requestId,
      payload: {
        messageId,
        role: 'user',
        ...(attachmentMeta ? { attachments: attachmentMeta } : {}),
      },
    });
    this.emit({
      type: 'message.delta',
      sessionId: this.sessionId,
      requestId,
      payload: { messageId, blockId, text: userText },
    });
    this.emit({
      type: 'message.completed',
      sessionId: this.sessionId,
      requestId,
      payload: { messageId },
    });
  }

  /** Ensure an assistant message envelope exists; returns messageId. */
  private ensureAssistant(requestId?: string): string {
    if (!this.state.assistantMessageId) {
      this.state.assistantMessageId = `asst-${this.sessionId}-${Date.now()}`;
      this.state.textBlockId = `${this.state.assistantMessageId}-text`;
      this.state.thinkingBlockId = `${this.state.assistantMessageId}-thinking`;
      this.emit({
        type: 'message.started',
        sessionId: this.sessionId,
        requestId,
        payload: {
          messageId: this.state.assistantMessageId,
          role: 'assistant',
          // Round-2 P0: real model id captured off the raw SDK `assistant`
          // message (BetaMessage.model), when the 'assistant' case saw one
          // before this envelope was created. Chosen over message.completed
          // because this is where the message's role/identity is minted —
          // the model is known by the same raw SDK message that supplies
          // role, so attaching it here keeps a single source of truth at
          // message creation instead of a second late-arriving event.
          ...(this.state.assistantModel ? { model: this.state.assistantModel } : {}),
        },
      });
    }
    return this.state.assistantMessageId;
  }

  private emitTextDelta(text: string, requestId?: string): void {
    if (!text) return;
    const messageId = this.ensureAssistant(requestId);
    if (!this.state.textStarted) {
      this.state.textStarted = true;
    }
    this.emit({
      type: 'message.delta',
      sessionId: this.sessionId,
      requestId,
      payload: {
        messageId,
        blockId: this.state.textBlockId,
        text,
      },
    });
  }

  private emitThinkingDelta(text: string, requestId?: string): void {
    if (!text) return;
    const messageId = this.ensureAssistant(requestId);
    if (!this.state.thinkingStarted) {
      this.state.thinkingStarted = true;
      this.emit({
        type: 'thinking.started',
        sessionId: this.sessionId,
        requestId,
        payload: { messageId, blockId: this.state.thinkingBlockId },
      });
    }
    this.emit({
      type: 'thinking.delta',
      sessionId: this.sessionId,
      requestId,
      payload: {
        messageId,
        blockId: this.state.thinkingBlockId,
        text,
      },
    });
  }

  private emitToolStarted(tool: ToolUseBlock, requestId?: string): void {
    if (this.state.seenTools.has(tool.id)) return;
    this.state.seenTools.add(tool.id);
    this.state.openTools.add(tool.id);
    // T-34 (review M2): remember what ran, so the `user` branch can verify a
    // `tool_use_result` really belongs to a delegation before treating it as
    // a subagent report.
    this.state.toolNameById.set(tool.id, tool.name);
    const messageId = this.ensureAssistant(requestId);
    this.emit({
      type: 'tool.started',
      sessionId: this.sessionId,
      requestId,
      payload: {
        messageId,
        toolCallId: tool.id,
        name: tool.name,
        input: tool.input,
      },
    });
  }

  private emitToolCompleted(
    toolUseId: string,
    ok: boolean,
    output: unknown,
    requestId?: string
  ): void {
    this.state.openTools.delete(toolUseId);
    const messageId = this.state.assistantMessageId ?? this.ensureAssistant(requestId);
    this.emit({
      type: 'tool.completed',
      sessionId: this.sessionId,
      requestId,
      payload: {
        messageId,
        toolCallId: toolUseId,
        ok,
        output,
        error: ok ? undefined : String(output ?? 'tool error'),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Partial-messages batch (片 1b/1c/1d) helpers
  // -------------------------------------------------------------------------

  /**
   * 1b: THE ONLY two call sites are `content_block_start(text|thinking)` and a
   * text/thinking delta that has to establish its own accumulator — both of
   * them downstream of the `parent_tool_use_id` drop, so a SUBAGENT's partial
   * traffic can never open the main stream's gate.
   */
  private openPartialGate(): void {
    if (this.state.partialContentSeen) return;
    this.state.partialContentSeen = true;
    this.coalescer.setEnabled(true);
  }

  /**
   * 1b: append a delta to its block's accumulator, creating the accumulator
   * when the `content_block_start` was never seen (truncated stream, or an
   * index reused after a missing stop).
   */
  private accumulatePartialText(index: number, type: 'text' | 'thinking', text: string): void {
    const open = this.state.openBlocks.get(index);
    if (open && open.type === type) {
      open.acc += text;
      return;
    }
    this.state.openBlocks.set(index, { type, acc: text, matched: false });
    this.openPartialGate();
  }

  /**
   * 1b: reconcile a whole `assistant` message's text/thinking against what the
   * deltas already emitted, and return ONLY the part that still needs to go
   * out (`''` = fully covered, drop the whole message).
   *
   * Candidate order — open same-typed block, then the first unmatched closed
   * one (the whole message can legitimately arrive after its
   * `content_block_stop`), then nothing:
   *  - `acc === whole`            → drop (the measured常态 path: five probe runs
   *                                 were byte-equal every time, spike §2);
   *  - `whole.startsWith(acc)`    → emit the missing suffix. NAMED "tail
   *                                 truncation fallback" on purpose: it covers
   *                                 ONLY text lost off the end. A delta lost in
   *                                 the MIDDLE lands in the mismatch branch
   *                                 below and cannot be repaired — the already
   *                                 emitted prefix cannot be rolled back on an
   *                                 append-only protocol. Accepted in writing;
   *                                 the log line carries both lengths so a real
   *                                 occurrence is diagnosable;
   *  - mismatch                   → drop the whole + log (宁弃不重);
   *  - ≥2 open same-typed blocks  → protocol invariant violated. Emit as-is and
   *                                 log — a silent drop here would be an
   *                                 invisible loss of the final answer;
   *  - no candidate at all        → emit as-is + log. A gateway that stops
   *                                 honouring partials mid-turn must never lose
   *                                 its final answer; a duplicate is strictly
   *                                 less bad than a disappearance.
   */
  private reconcileWholeBlock(type: 'text' | 'thinking', whole: string): string {
    if (!whole) return '';
    const open = [...this.state.openBlocks.values()].filter(
      (block) => block.type === type && !block.matched
    );
    if (open.length >= 2) {
      this.log(
        `normalizer partial dedup: ${open.length} open ${type} blocks when a whole message ` +
          `arrived (protocol invariant violated) — emitting it as-is, whole=${whole.length} chars`
      );
      return whole;
    }
    const candidate =
      open[0] ?? this.state.closedBlocks.find((block) => block.type === type && !block.matched);
    if (!candidate) {
      this.log(
        `normalizer partial dedup: no ${type} accumulator candidate (acc=none, ` +
          `whole=${whole.length} chars) — emitting the whole message as-is`
      );
      return whole;
    }
    candidate.matched = true;
    const acc = candidate.acc;
    if (acc === whole) return '';
    if (whole.startsWith(acc)) {
      this.log(
        `normalizer partial dedup: ${type} tail-truncation fallback — acc=${acc.length} chars, ` +
          `whole=${whole.length} chars, emitting the ${whole.length - acc.length}-char suffix`
      );
      return whole.slice(acc.length);
    }
    this.log(
      `normalizer partial dedup: ${type} accumulator mismatch — acc=${acc.length} chars, ` +
        `whole=${whole.length} chars; dropping the whole message (mid-stream delta loss is an ` +
        'append-only protocol limitation — emitted text cannot be rolled back)'
    );
    return '';
  }

  /**
   * 1d: emit one interim `usage.updated`.
   *
   * `sessionId`/`requestId` are mandatory, not decorative — the renderer's
   * `reduceSessionRuntimeFacts` drops any event without a sessionId, which
   * would make the whole channel silently dead.
   *
   * The displayed number is a MONOTONIC peak: a subagent's `thinking_tokens`
   * carries no parent marker, so it mixes into the estimate, and the main
   * stream's `message_delta` then zeroes that estimate — without the peak the
   * status line would visibly count backwards.
   *
   * `force` skips the throttle: used for the `message_delta` step and for the
   * thinking block's tail emit, neither of which can repeat often enough to
   * matter and both of which carry information a dropped tick would lose.
   */
  private emitInterimUsage(requestId: string | undefined, force: boolean): void {
    const now = Date.now();
    const last = this.state.lastInterimUsageEmitMs;
    if (!force && last !== null && now - last < INTERIM_USAGE_MIN_INTERVAL_MS) return;
    const display = Math.max(
      this.state.turnTokensDisplayMax,
      this.state.turnOutputTokensSettled + this.state.turnThinkingEstimate
    );
    this.state.turnTokensDisplayMax = display;
    this.state.lastInterimUsageEmitMs = now;
    this.emit({
      type: 'usage.updated',
      sessionId: this.sessionId,
      requestId,
      payload: { interim: true, turn_output_tokens_display: display },
    });
  }

  // -------------------------------------------------------------------------
  // T-34 subagent branches
  // -------------------------------------------------------------------------

  /**
   * Emit one `subagent.activity`, enforcing the per-delegation cap.
   *
   * Exactly `SUBAGENT_EVENTS_MAX_PER_DELEGATION` real events are forwarded for
   * a carrier, then ONE `kind:'capped'`, then silence. The `capped` event does
   * not itself count (it is the cap's announcement) and the latch guarantees
   * it fires at most once per delegation.
   *
   * When the flag is off this is a no-op — the caller has already suppressed
   * the main-stream emission, which is the half that must happen regardless.
   */
  private emitSubagentActivity(
    parentToolCallId: string,
    payload: Record<string, unknown>,
    requestId?: string
  ): void {
    if (!this.subagentActivityEnabled) return;
    if (this.state.subagentCapped.has(parentToolCallId)) return;

    const count = this.state.subagentEventCount.get(parentToolCallId) ?? 0;
    if (count >= SUBAGENT_EVENTS_MAX_PER_DELEGATION) {
      this.state.subagentCapped.add(parentToolCallId);
      this.log(
        `subagent activity capped at ${SUBAGENT_EVENTS_MAX_PER_DELEGATION} events for ${parentToolCallId}`
      );
      this.emit({
        type: 'subagent.activity',
        sessionId: this.sessionId,
        requestId,
        payload: {
          parentToolCallId,
          kind: 'capped',
          limit: SUBAGENT_EVENTS_MAX_PER_DELEGATION,
        },
      });
      return;
    }
    this.state.subagentEventCount.set(parentToolCallId, count + 1);
    this.emit({
      type: 'subagent.activity',
      sessionId: this.sessionId,
      requestId,
      payload: { parentToolCallId, ...payload },
    });
  }

  /**
   * A subagent's own `assistant` message. Reaches NONE of the main-stream
   * emitters — no `ensureAssistant`, so a delegation can never mint or
   * contaminate the main agent's message envelope, and in particular
   * `state.assistantModel` is left alone (a subagent's model must not be
   * reported as the turn's).
   *
   * Text/thinking only arrive when `forwardSubagentText` is on; tool_use
   * arrives in every mode. Empty bodies are dropped whole — the probe shows
   * summarized thinking legitimately arriving as `thinking: ''` with only a
   * signature, and a blank row would be noise pretending to be a fact.
   */
  private ingestSubagentAssistant(
    parentToolCallId: string,
    msg: { message?: { content?: unknown; id?: string }; uuid?: string },
    requestId?: string
  ): void {
    if (!this.subagentActivityEnabled) return;
    const content = msg.message?.content;
    const baseId =
      (typeof msg.uuid === 'string' && msg.uuid) ||
      (typeof msg.message?.id === 'string' && msg.message.id) ||
      `sub-${parentToolCallId}-${Date.now()}`;

    const thinking = extractThinkingParts(content);
    if (thinking) {
      this.emitSubagentActivity(
        parentToolCallId,
        {
          kind: 'thinking',
          id: `${baseId}-thinking`,
          text: clampSubagentText(thinking, SUBAGENT_TEXT_MAX_CHARS),
        },
        requestId
      );
    }

    const text = extractTextParts(content);
    if (text) {
      this.emitSubagentActivity(
        parentToolCallId,
        {
          kind: 'text',
          id: `${baseId}-text`,
          text: clampSubagentText(text, SUBAGENT_TEXT_MAX_CHARS),
        },
        requestId
      );
    }

    for (const tool of extractToolUses(content)) {
      const input = projectSubagentToolInput(tool.input);
      this.emitSubagentActivity(
        parentToolCallId,
        {
          kind: 'tool.started',
          toolCallId: tool.id,
          name: tool.name,
          ...(input ? { input } : {}),
        },
        requestId
      );
    }
  }

  /**
   * A subagent's own `user` message. Two shapes exist and both are handled by
   * the same rule "forward every tool_result, forward nothing else":
   *  - tool_result carriers become `kind:'tool.completed'`;
   *  - the delegation PROMPT ECHO (plain text, no tool_result) therefore
   *    produces zero events, which is the intended drop — the prompt is
   *    already the main Agent row's input body (T-34 L4).
   */
  private ingestSubagentUser(
    parentToolCallId: string,
    msg: { message?: { content?: unknown } },
    requestId?: string
  ): void {
    if (!this.subagentActivityEnabled) return;
    for (const result of extractToolResults(msg.message?.content)) {
      const ok = !result.isError;
      // Success carries no body at all (T-34 L2); only a failure gets text,
      // clamped, because "what went wrong" is the one thing the row cannot
      // reconstruct from its argument line.
      const errorText = ok ? undefined : subagentErrorText(result.content);
      this.emitSubagentActivity(
        parentToolCallId,
        {
          kind: 'tool.completed',
          toolCallId: result.toolUseId,
          ok,
          ...(errorText ? { errorText } : {}),
        },
        requestId
      );
    }
  }

  /**
   * The four `system/task_*` control events. They are keyed by `task_id` and
   * associate to a carrier through `tool_use_id` — except `task_updated`,
   * which carries only `task_id` and is resolved through the map every other
   * task_* event fills. An unresolvable `task_updated` is dropped with a log
   * rather than guessed at.
   *
   * Returns true when the subtype was one of the four (so the caller knows
   * not to fall through to the `init`/`api_retry` handling).
   */
  private ingestTaskControl(
    msg: {
      subtype?: string;
      task_id?: string;
      tool_use_id?: string;
      description?: string;
      subagent_type?: string;
      task_type?: string;
      status?: string;
      last_tool_name?: string;
      usage?: unknown;
      patch?: { status?: string; end_time?: number };
    },
    requestId?: string
  ): boolean {
    const subtype = msg.subtype;
    if (
      subtype !== 'task_started' &&
      subtype !== 'task_progress' &&
      subtype !== 'task_updated' &&
      subtype !== 'task_notification'
    ) {
      return false;
    }

    const taskId = typeof msg.task_id === 'string' && msg.task_id ? msg.task_id : undefined;
    const directParent =
      typeof msg.tool_use_id === 'string' && msg.tool_use_id ? msg.tool_use_id : undefined;
    if (taskId && directParent) {
      this.state.taskIdToParent.set(taskId, directParent);
    }
    const parentToolCallId =
      directParent ?? (taskId ? this.state.taskIdToParent.get(taskId) : undefined);
    if (!parentToolCallId) {
      // `task_updated` before any id-bearing task_* event for the same task —
      // nothing to attach it to. Dropping beats attaching it to the wrong row.
      this.log('normalizer skip unattachable task control:', subtype, taskId ?? '(no task_id)');
      return true;
    }
    const agentId = taskId ? { agentId: taskId } : {};

    switch (subtype) {
      case 'task_started': {
        this.emitSubagentActivity(
          parentToolCallId,
          {
            kind: 'started',
            ...agentId,
            ...(msg.subagent_type ? { agentType: msg.subagent_type } : {}),
            ...(msg.description ? { description: msg.description } : {}),
            ...(msg.task_type ? { taskType: msg.task_type } : {}),
            // `prompt` is deliberately NOT forwarded (T-34 L4).
          },
          requestId
        );
        return true;
      }
      case 'task_progress': {
        const usage = normalizeSubagentUsage(msg.usage);
        this.emitSubagentActivity(
          parentToolCallId,
          {
            kind: 'progress',
            ...agentId,
            ...(msg.description ? { description: msg.description } : {}),
            ...(msg.last_tool_name ? { lastToolName: msg.last_tool_name } : {}),
            ...(usage ? { usage } : {}),
          },
          requestId
        );
        return true;
      }
      case 'task_notification': {
        const status = normalizeSubagentRunStatus(msg.status);
        if (!status) {
          this.log('normalizer skip task_notification with unreadable status:', msg.status);
          return true;
        }
        const usage = normalizeSubagentUsage(msg.usage);
        this.emitSubagentActivity(
          parentToolCallId,
          {
            kind: 'status',
            ...agentId,
            status,
            ...(usage ? { usage } : {}),
            // `summary` / `output_file` deliberately dropped: the summary
            // duplicates the Agent row's own output body (T-34 §1 Q1).
          },
          requestId
        );
        return true;
      }
      default: {
        const status = normalizeSubagentRunStatus(msg.patch?.status);
        if (!status) {
          this.log('normalizer skip task_updated with unreadable status:', msg.patch?.status);
          return true;
        }
        const endedAt = readFiniteNumber(msg.patch, 'end_time');
        this.emitSubagentActivity(
          parentToolCallId,
          {
            kind: 'status',
            ...agentId,
            status,
            ...(endedAt !== undefined ? { endedAt } : {}),
          },
          requestId
        );
        return true;
      }
    }
  }

  /**
   * Ingest one SDK message. Returns Claude runtime session_id when discovered.
   */
  ingest(raw: unknown, requestId?: string): string | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const msg = raw as {
      type?: string;
      subtype?: string;
      session_id?: string;
      message?: { content?: unknown; role?: string; model?: string; id?: string };
      /**
       * T-34: `null` for the main agent, the delegating `Agent`/`Task`
       * tool_use id for anything a subagent produced. THE segregation key.
       */
      parent_tool_use_id?: string | null;
      uuid?: string;
      // T-34: `system/task_*` control-event fields.
      task_id?: string;
      task_type?: string;
      subagent_type?: string;
      description?: string;
      status?: string;
      last_tool_name?: string;
      patch?: { status?: string; end_time?: number };
      event?: {
        type?: string;
        // 1c: `input_json_delta` fragments — the ONLY place a tool's real
        // input exists before the whole message lands (spike §1 Q3).
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
        content_block?: { type?: string; id?: string; name?: string; input?: unknown };
        index?: number;
        // 1b: `message_start.message.model`. Without this the ON position
        // never sees a raw `assistant` message before `ensureAssistant` runs,
        // and `message.started` ships with no model at all (A06 regression).
        message?: { id?: string; model?: string };
        // 1d: `message_delta.usage.output_tokens` — per-API-message settled
        // total, one per message (spike §1 Q4).
        usage?: { output_tokens?: number };
      };
      // 1d: `system/thinking_tokens` increment; the only real-time token
      // source during the thinking phase (spike §5).
      estimated_tokens_delta?: number;
      tool_use_id?: string;
      tool_name?: string;
      result?: string;
      is_error?: boolean;
      error?: string;
      usage?: Record<string, unknown>;
      tool_use_result?: unknown;
      // a1: `system/api_retry` fields, passed through verbatim by the SDK
      // from cli.js. Raw shape confirmed by the investigation report:
      // {type:'system',subtype:'api_retry',attempt,max_retries,
      //  retry_delay_ms,error_status,error,session_id}.
      attempt?: number;
      max_retries?: number;
      retry_delay_ms?: number;
      error_status?: number | string | null;
    };

    const runtimeId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
    const type = String(msg.type ?? '');
    // T-34: presence of a non-empty parent id is what makes a message a
    // subagent's. `null`/absent takes every branch below unchanged.
    const parentToolCallId =
      typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id.length > 0
        ? msg.parent_tool_use_id
        : undefined;

    try {
      switch (type) {
        case 'system': {
          // T-34 first: the four task_* control events associate by their own
          // ids, not by parent_tool_use_id (which they never carry).
          if (this.ingestTaskControl(msg, requestId)) break;
          // init / api_retry / etc. — status only; no UI spam for unknown subtypes
          if (msg.subtype === 'init') {
            this.emit({
              type: 'session.status',
              sessionId: this.sessionId,
              requestId,
              payload: { status: 'running' },
            });
          } else if (msg.subtype === 'api_retry') {
            // a1: surface the CLI's own transport-retry loop instead of
            // dropping it — see the `attempt`/`max_retries`/etc. fields above.
            // Status stays 'running': the turn has not stalled, the SDK is
            // actively retrying underneath it. claudeRuntime.ts's
            // PRODUCTIVE_EVENT_TYPES deliberately does NOT include 'system',
            // so this does not reset the stall watchdog — an endless retry
            // loop must remain detectable as a stall.
            this.emit({
              type: 'session.status',
              sessionId: this.sessionId,
              requestId,
              payload: {
                status: 'running',
                retry: {
                  attempt: typeof msg.attempt === 'number' ? msg.attempt : 0,
                  maxRetries: typeof msg.max_retries === 'number' ? msg.max_retries : 0,
                  delayMs: typeof msg.retry_delay_ms === 'number' ? msg.retry_delay_ms : 0,
                  errorStatus:
                    typeof msg.error_status === 'string' || typeof msg.error_status === 'number'
                      ? String(msg.error_status)
                      : null,
                  error: typeof msg.error === 'string' ? msg.error : 'unknown',
                },
              },
            });
          } else if (msg.subtype === 'thinking_tokens') {
            // 1d: GATED. `thinking_tokens` is not a partial-messages event —
            // the control position emits 47~58 of them per turn today (spike
            // §1 Q5). Reacting to it unconditionally would emit brand-new
            // `usage.updated` events on the OFF path and blow the golden
            // zero-regression arbiter.
            if (this.state.partialContentSeen) {
              this.state.turnThinkingEstimate +=
                typeof msg.estimated_tokens_delta === 'number' ? msg.estimated_tokens_delta : 0;
              this.emitInterimUsage(requestId, false);
            }
          }
          break;
        }
        case 'assistant': {
          if (parentToolCallId) {
            // T-34: a subagent's assistant message NEVER reaches the main
            // emitters below — this is acceptance ② at its source.
            this.ingestSubagentAssistant(parentToolCallId, msg, requestId);
            break;
          }
          const content = msg.message?.content;
          // Round-2 P0: capture the real model id off the raw SDK message
          // (BetaMessage.model) before anything below lazily creates the
          // assistant envelope via ensureAssistant(). First one wins per
          // turn — a turn's model does not change mid-turn.
          if (!this.state.assistantModel && typeof msg.message?.model === 'string') {
            this.state.assistantModel = msg.message.model;
          }
          const text = extractTextParts(content);
          const thinking = extractThinkingParts(content);
          if (this.state.partialContentSeen) {
            // 1b: the deltas already carried this content — emit only what is
            // still missing (usually nothing). See reconcileWholeBlock.
            const thinkingResidue = this.reconcileWholeBlock('thinking', thinking);
            if (thinkingResidue) this.emitThinkingDelta(thinkingResidue, requestId);
            const textResidue = this.reconcileWholeBlock('text', text);
            if (textResidue) this.emitTextDelta(textResidue, requestId);
          } else {
            if (thinking) this.emitThinkingDelta(thinking, requestId);
            if (text) this.emitTextDelta(text, requestId);
          }
          for (const tool of extractToolUses(content)) {
            // 1c: the whole message is the FIRST and only `tool.started` — it
            // is the one carrying the real input. `seenTools` already makes
            // this idempotent; clearing the stub records that it was covered.
            this.emitToolStarted(tool, requestId);
            this.state.pendingToolStubs.delete(tool.id);
          }
          break;
        }
        case 'stream_event': {
          // T-34 RED LINE, unchanged by 片 1: a SUBAGENT's partial stream is
          // dropped whole — letting a character-level delta into the main
          // stream is the one shape that would break the render budget, and
          // the subagent's own whole-message `assistant` events carry the same
          // text. Everything below (including the partial gate) is deliberately
          // AFTER this line: a delegation must never open the main stream's
          // dedup gate.
          if (parentToolCallId) break;
          const ev = msg.event;
          if (!ev) break;
          if (ev.type === 'message_start') {
            // 1b, three jobs in one branch:
            // ① capture the model. On the ON path this is the ONLY model
            //    source that precedes envelope creation: the deltas mint the
            //    assistant envelope via ensureAssistant long before the first
            //    whole `assistant` message lands, so without this line
            //    `message.started` ships model-less (A06 regression). MUST
            //    stay ahead of every ensureAssistant path — it is, because
            //    this branch emits nothing.
            if (!this.state.assistantModel && typeof ev.message?.model === 'string') {
              this.state.assistantModel = ev.message.model;
            }
            // ② content-block indices restart at 0 for EVERY API message, so
            //    stale blocks from the previous message must go or a reused
            //    index would reconcile against the wrong accumulator.
            //    `pendingToolStubs` is keyed by tool id, not index, and
            //    deliberately survives: its `tool_result` arrives after this.
            this.state.openBlocks.clear();
            this.state.closedBlocks.length = 0;
            this.state.openToolBlocks.clear();
            // ③ does NOT open the gate — an envelope event duplicates nothing.
            break;
          }
          if (ev.type === 'content_block_start' && ev.content_block) {
            const block = ev.content_block;
            const index = typeof ev.index === 'number' ? ev.index : -1;
            if (block.type === 'tool_use' && block.id && block.name) {
              // 1c: NO `tool.started` here. This stub's `input` is `{}` (spike
              // §4) and `emitToolStarted` is first-write-wins, so emitting it
              // would permanently mask the real input arriving ~930ms later.
              // The facts are ledgered instead of thrown away.
              this.state.pendingToolStubs.set(block.id, { name: block.name, inputJsonAcc: '' });
              this.state.openToolBlocks.set(index, block.id);
            }
            if (block.type === 'thinking' || block.type === 'text') {
              this.state.openBlocks.set(index, { type: block.type, acc: '', matched: false });
              this.openPartialGate();
              this.ensureAssistant(requestId);
            }
          }
          if (ev.type === 'content_block_delta' && ev.delta) {
            const index = typeof ev.index === 'number' ? ev.index : -1;
            // The type dispatch below is exhaustive on purpose: `signature_delta`
            // (which closes a thinking block, spike §2 摘录 B seq 111) and
            // `input_json_delta` must NEVER reach the text/thinking emitters,
            // even if a future SDK starts attaching a `text` field to them.
            if (ev.delta.type === 'text_delta' && ev.delta.text) {
              this.accumulatePartialText(index, 'text', ev.delta.text);
              this.emitTextDelta(ev.delta.text, requestId);
            }
            if (
              (ev.delta.type === 'thinking_delta' || ev.delta.type === 'thinking') &&
              (ev.delta.thinking || ev.delta.text)
            ) {
              const thinkingText = ev.delta.thinking ?? ev.delta.text ?? '';
              this.accumulatePartialText(index, 'thinking', thinkingText);
              this.emitThinkingDelta(thinkingText, requestId);
            }
            if (ev.delta.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
              // 1c: the real tool input, one fragment at a time. Kept against
              // the stub so an orphaned `tool_result` can still be given a
              // `tool.started` with真入参 rather than an empty object.
              const toolId = this.state.openToolBlocks.get(index);
              const stub = toolId ? this.state.pendingToolStubs.get(toolId) : undefined;
              if (stub) stub.inputJsonAcc += ev.delta.partial_json;
            }
          }
          if (ev.type === 'content_block_stop') {
            const index = typeof ev.index === 'number' ? ev.index : -1;
            const open = this.state.openBlocks.get(index);
            if (open) {
              // 1b: retired, not discarded — a whole message that arrives
              // after its block's stop still needs something to match against.
              this.state.openBlocks.delete(index);
              this.state.closedBlocks.push(open);
              // 1d tail emit: the thinking→text transition is where the
              // `thinking_tokens` tick stops; without this the last few
              // estimated tokens never reach the status line.
              if (open.type === 'thinking') this.emitInterimUsage(requestId, true);
            }
            this.state.openToolBlocks.delete(index);
          }
          if (ev.type === 'message_delta') {
            // 1d: exactly one per API message, carrying that message's settled
            // output token total (spike §1 Q4) — so the turn total is a Host-
            // side sum (probe: 51+30 = the result event's 81). The estimate
            // resets because those tokens are now counted for real; the
            // monotonic peak in emitInterimUsage keeps the display from
            // stepping backwards when it does.
            this.state.turnOutputTokensSettled +=
              typeof ev.usage?.output_tokens === 'number' ? ev.usage.output_tokens : 0;
            this.state.turnThinkingEstimate = 0;
            this.emitInterimUsage(requestId, true);
          }
          break;
        }
        case 'user': {
          if (parentToolCallId) {
            // T-34: a subagent's tool_result NEVER becomes a main-stream
            // `tool.completed`; its prompt echo produces nothing at all.
            this.ingestSubagentUser(parentToolCallId, msg, requestId);
            break;
          }
          const content = msg.message?.content;
          const results = extractToolResults(content);
          // 1c ORPHAN FALLBACK. Normally the whole `assistant` message emits
          // `tool.started` before its result lands. When it never arrives (the
          // gateway stops honouring partials mid-turn, or the whole message is
          // lost), the stub ledger is the only surviving record — without this
          // the timeline would show a `tool.completed` with no card to settle.
          // Runs BEFORE `isDelegationResult` below so a back-filled tool name
          // is visible to the delegation check. On the control path
          // `pendingToolStubs` is always empty, making this a no-op.
          for (const result of results) {
            if (this.state.seenTools.has(result.toolUseId)) continue;
            const stub = this.state.pendingToolStubs.get(result.toolUseId);
            if (!stub) continue;
            let input: unknown = {};
            try {
              input = JSON.parse(stub.inputJsonAcc);
            } catch {
              // Truncated fragments cannot be parsed; an empty object beats
              // losing the card entirely.
              input = {};
            }
            this.log(
              `normalizer partial tool ledger: back-filling tool.started for ${result.toolUseId} ` +
                `(${stub.name}) from ${stub.inputJsonAcc.length} buffered partial_json chars — ` +
                'no whole assistant message ever arrived'
            );
            this.emitToolStarted({ id: result.toolUseId, name: stub.name, input }, requestId);
            this.state.pendingToolStubs.delete(result.toolUseId);
          }
          // T-34: the Agent tool's own result carries a structured
          // `tool_use_result` the SDK explicitly says to render FROM rather
          // than parse out of the result text. Attribution is only safe when
          // the message carries exactly ONE tool_result — a parallel-tool
          // message has one top-level `tool_use_result` and no way to say
          // which call it belongs to, so the report is skipped there rather
          // than guessed at (the row still settles on `tool.completed`).
          //
          // Review M2: the shape check alone is not enough. `tool_use_result`
          // is a generic SDK field that ordinary tools populate too, so the
          // id must ALSO resolve to a delegating tool this turn actually
          // started. An id we never saw is not a delegation either — an
          // unverifiable result must not silently have its body replaced.
          const isDelegationResult =
            results.length === 1 &&
            DELEGATION_TOOL_NAMES.has(this.state.toolNameById.get(results[0].toolUseId) ?? '');
          const report = isDelegationResult ? detectSubagentReport(msg.tool_use_result) : undefined;
          for (const result of results) {
            // With a report in hand, the row's body becomes the clean answer
            // content instead of the raw two-part text whose second part is
            // CLI plumbing (`agentId: … <usage>subagent_tokens…`).
            const output = report && report.content != null ? report.content : result.content;
            this.emitToolCompleted(result.toolUseId, !result.isError, output, requestId);
          }
          if (report) {
            this.emitSubagentActivity(
              results[0].toolUseId,
              { kind: 'report', agentId: report.agentId, report: report.report },
              requestId
            );
          }
          break;
        }
        case 'tool_progress': {
          // T-34: a subagent's inner tool progress is covered by the carrier's
          // own `progress` fold; emitting `tool.updated` for an id the main
          // timeline does not own would be a main-stream event about subagent
          // work — exactly what acceptance ② forbids.
          if (parentToolCallId) break;
          if (typeof msg.tool_use_id === 'string') {
            const messageId = this.state.assistantMessageId ?? this.ensureAssistant(requestId);
            this.emit({
              type: 'tool.updated',
              sessionId: this.sessionId,
              requestId,
              payload: {
                messageId,
                toolCallId: msg.tool_use_id,
              },
            });
          }
          break;
        }
        case 'result': {
          // T-34 (review M1): a parent-set `result` is a SUBAGENT's turn
          // ending, not the session's. Falling through would set `sawResult`
          // and emit message.completed / session.completed / status idle —
          // terminating the whole conversation the moment the first
          // delegation finished, while the main agent was still working.
          // Dropped whole, exactly like a parent-set `stream_event`: the
          // carrier's own terminal is carried by `task_*`/`report`, and the
          // main Agent row still settles on its own `tool.completed`.
          if (parentToolCallId) break;
          // 1e: the turn's terminals must not overtake buffered deltas — flush
          // before a single terminal event is emitted so the downstream order
          // (…delta → thinking.completed → message.completed → usage.updated →
          // session.completed → session.status) is exactly the control one.
          this.coalescer.flushAll();
          this.state.sawResult = true;
          if (this.state.thinkingStarted && this.state.assistantMessageId) {
            this.emit({
              type: 'thinking.completed',
              sessionId: this.sessionId,
              requestId,
              payload: {
                messageId: this.state.assistantMessageId,
                blockId: this.state.thinkingBlockId,
              },
            });
          }
          if (this.state.assistantMessageId) {
            this.emit({
              type: 'message.completed',
              sessionId: this.sessionId,
              requestId,
              payload: { messageId: this.state.assistantMessageId },
            });
          }
          if (msg.usage) {
            this.emit({
              type: 'usage.updated',
              sessionId: this.sessionId,
              requestId,
              payload: msg.usage,
            });
          }
          const failed = Boolean(msg.is_error) || msg.subtype === 'error';
          if (typeof msg.result === 'string' && msg.result && !this.state.textStarted) {
            // Fallback: some results only carry final text
            this.emitTextDelta(msg.result, requestId);
            if (this.state.assistantMessageId) {
              this.emit({
                type: 'message.completed',
                sessionId: this.sessionId,
                requestId,
                payload: { messageId: this.state.assistantMessageId },
              });
            }
          }
          this.emit({
            type: failed ? 'session.failed' : 'session.completed',
            sessionId: this.sessionId,
            requestId,
            payload: failed ? { error: msg.error ?? msg.result ?? 'session failed' } : undefined,
          });
          this.emit({
            type: 'session.status',
            sessionId: this.sessionId,
            requestId,
            payload: { status: failed ? 'failed' : 'idle' },
          });
          break;
        }
        default: {
          this.log('normalizer skip unknown type:', type || typeof raw);
        }
      }
    } catch (err) {
      this.log('normalizer error:', err);
      this.emit({
        type: 'host.error',
        sessionId: this.sessionId,
        requestId,
        payload: {
          code: 'normalize_error',
          message: err instanceof Error ? err.message : String(err),
          fatal: false,
        },
      });
    }

    return runtimeId;
  }

  /** A tool_use started this turn without a tool_result yet (running locally). */
  hasOpenTools(): boolean {
    return this.state.openTools.size > 0;
  }

  /** Emit a failed terminal (e.g. stall watchdog), closing any open blocks. */
  emitFailed(error: string, requestId?: string): void {
    // 1e: an aborted turn still owes the UI whatever text already streamed.
    this.coalescer.flushAll();
    if (this.state.thinkingStarted && this.state.assistantMessageId) {
      this.emit({
        type: 'thinking.completed',
        sessionId: this.sessionId,
        requestId,
        payload: {
          messageId: this.state.assistantMessageId,
          blockId: this.state.thinkingBlockId,
        },
      });
    }
    if (this.state.assistantMessageId) {
      this.emit({
        type: 'message.completed',
        sessionId: this.sessionId,
        requestId,
        payload: { messageId: this.state.assistantMessageId },
      });
    }
    this.emit({
      type: 'session.failed',
      sessionId: this.sessionId,
      requestId,
      payload: { error },
    });
    this.emit({
      type: 'session.status',
      sessionId: this.sessionId,
      requestId,
      payload: { status: 'failed' },
    });
  }

  /** Emit stopped terminal after abort. */
  emitStopped(requestId?: string): void {
    // 1e: same reason as emitFailed — flush before the terminals.
    this.coalescer.flushAll();
    if (this.state.thinkingStarted && this.state.assistantMessageId) {
      this.emit({
        type: 'thinking.completed',
        sessionId: this.sessionId,
        requestId,
        payload: {
          messageId: this.state.assistantMessageId,
          blockId: this.state.thinkingBlockId,
        },
      });
    }
    if (this.state.assistantMessageId) {
      this.emit({
        type: 'message.completed',
        sessionId: this.sessionId,
        requestId,
        payload: { messageId: this.state.assistantMessageId },
      });
    }
    this.emit({
      type: 'session.stopped',
      sessionId: this.sessionId,
      requestId,
    });
    this.emit({
      type: 'session.status',
      sessionId: this.sessionId,
      requestId,
      payload: { status: 'idle' },
    });
  }

  /**
   * Close out a turn when the SDK stream ends. The SDK normally ends a turn
   * with a result event; when the stream ends silently (gateway hang, dropped
   * connection), no terminal event reaches the UI and it stays `running`.
   * Returns:
   *   'already'   — a result event already emitted terminals (no-op)
   *   'completed' — assistant produced output but no result arrived; emitted
   *                 synthetic message/session.completed + status idle
   *   'failed'    — stream ended with no assistant output at all; emitted
   *                 session.failed + status failed
   */
  finishTurn(requestId?: string): 'already' | 'completed' | 'failed' {
    // 1e: a silently ended stream must not strand a buffered run. Ahead of the
    // `already` short-circuit because the `result` branch's own flush leaves
    // nothing behind — this is the no-result path's only chance.
    this.coalescer.flushAll();
    if (this.state.sawResult) return 'already';
    if (this.state.thinkingStarted && this.state.assistantMessageId) {
      this.emit({
        type: 'thinking.completed',
        sessionId: this.sessionId,
        requestId,
        payload: {
          messageId: this.state.assistantMessageId,
          blockId: this.state.thinkingBlockId,
        },
      });
    }
    if (this.state.assistantMessageId) {
      this.emit({
        type: 'message.completed',
        sessionId: this.sessionId,
        requestId,
        payload: { messageId: this.state.assistantMessageId },
      });
      this.emit({
        type: 'session.completed',
        sessionId: this.sessionId,
        requestId,
      });
      this.emit({
        type: 'session.status',
        sessionId: this.sessionId,
        requestId,
        payload: { status: 'idle' },
      });
      return 'completed';
    }
    this.emit({
      type: 'session.failed',
      sessionId: this.sessionId,
      requestId,
      payload: {
        error:
          'SDK stream ended without assistant output or result event (gateway hang or dropped stream)',
      },
    });
    this.emit({
      type: 'session.status',
      sessionId: this.sessionId,
      requestId,
      payload: { status: 'failed' },
    });
    return 'failed';
  }
}
