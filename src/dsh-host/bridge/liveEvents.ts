/**
 * The live half of the bridge: one DSH session's durable `session/event`s and
 * `agent/assistant-stream` frames, turned into the RuntimeEvents the renderer
 * draws while a turn runs (P0-3 bridge, split out and completed for P1-4d1,
 * dsh-rebase decision 099). Everything here maps DSH's own data; nothing is
 * derived that DSH does not record:
 *
 *   stream text / reasoning deltas      message.delta / thinking.delta
 *   stream reasoning block start / end  thinking.started / thinking.completed
 *   stream tool-call deltas             tool.started / tool.updated with a size
 *                                       summary (bytes, lines), then the full
 *                                       arguments at the block's end (rule 14)
 *   stream `usage`                      usage.updated, pending (prompt side)
 *   `assistant/message.usage`           usage.updated, settled, with the context
 *                                       occupancy (`contextPressure`) and the
 *                                       session total (`tokenUsage`) of
 *                                       dsh-token-meter; no cost (rule 1)
 *   `tool/result`                       tool.completed with the row flags and the
 *                                       review of DSH's diff card (rules 5, 6)
 *   `llm/retry` / `llm/retry-started`   the retry banner, and its end (rule 3)
 *   `turn/end`                          session.completed / stopped / failed:
 *                                       DSH's failure sentence and our code, the
 *                                       step ceiling's cut as `turn_limit` (rule 4)
 *   `user/message` nobody typed         the head of a turn the engine started, or
 *                                       a notice (`custom.message`), by the table
 *                                       the history projection reads (rules 7, 8)
 *
 * Message ids are fixed by DSH's own coordinates — `dsh-user-<seq>`,
 * `dsh-notice-<seq>`, `dsh-<session>-t<turn>-s<step>` — and the history
 * projection names the same ids on its rows (`liveMessageId`), so a replay can
 * recognise the live copy of a message it carries.
 */

import { mapDshFailureCode } from '../../shared/dshFailureCodes.ts';
import { dshFileReview } from '../../shared/dshFileReview.ts';
import { dshToolOutcomeFlags } from '../../shared/dshHistory/projection.ts';
import { parseToolArguments, toolRowInput } from '../../shared/dshHistory/toolInput.ts';
import { AICLIENT_TURN_CEILING_REASON } from '../../shared/dshHistory/types.ts';
import {
  DSH_NOTICE_CUSTOM_TYPE_PREFIX,
  dshNoticeText,
  dshSourceKind,
  dshTurnHeadText,
  dshTurnOrigin,
} from '../../shared/dshNotices.ts';
import type { PiSessionUsage } from '../../shared/piTurnRollup.ts';
import {
  buildPiInterimUsagePayload,
  buildPiUsagePayload,
  type PiContextUsage,
} from '../../shared/piUsage.ts';
import {
  countStreamingLines,
  STREAMING_TOOL_ARGS_KEY,
  type StreamingToolArgs,
} from '../../shared/streamingToolArgs.ts';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import type { TurnOrigin } from '../../shared/types/sessionHistory.ts';

// ---- shapes -----------------------------------------------------------------

/** A RuntimeEventDraft without its session id, which the runtime fills in. */
export type BridgeDraft = RuntimeEventDraft extends infer E
  ? E extends unknown
    ? Omit<E, 'sessionId'>
    : never
  : never;

export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
}

export type StreamFrame =
  | { type: 'start'; attemptId: string; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; index: number; chunk: StreamChunk }
  | { type: 'end'; attemptId: string };

/** `StreamChunk` of `@deepseek-ai/dsh-llm`, read defensively. */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: Record<string, unknown> }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: string; index?: number };

/** A turn the runtime holds: its own send, or one DSH started (`synthetic`). */
export interface LiveTurn {
  requestId: string;
  attemptId?: string;
  /** Id of the user message this turn sent; its durable echo carries attemptId. */
  userMessageId?: string;
  /** Set when a DSH turn started without a worker.send (goal rounds, job notices). */
  synthetic: boolean;
}

/** dsh-token-meter's client views (`tokenUsage`, `contextPressure`), narrowed. */
export interface DshUsageView {
  tokenUsage?: {
    uncachedInputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  contextPressure?: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number };
}

/** What the translator needs from the runtime that owns the session. */
export interface DshLiveEventsHost {
  /** One event; the runtime adds the session id and the current turn's requestId. */
  emit(event: BridgeDraft): void;
  /** Our `provider/modelId` of the current selection, for `message.started`. */
  route(): string;
  /** The DSH session the events come from; live assistant ids name it. */
  dshSessionId(): string;
  turn(): LiveTurn | null;
  /** DSH started a turn nobody sent (a goal round, a wake-up): the runtime opens one for it. */
  openSyntheticTurn(turn: number): void;
  /** The turn ended; the runtime drops it. */
  closeTurn(): void;
  /** dsh-token-meter's usage views of the session, when the host composes them. */
  usageView(): DshUsageView | undefined;
  /** Model steps of the log with reported usage (the session total's turn count). */
  usageSteps(): number;
  /** The goal's round budget, as the log last recorded it. */
  goalMaxRounds(): number | undefined;
  now(): number;
}

// ---- helpers -----------------------------------------------------------------

/** Streaming argument updates are coalesced to at most one per call and window (1.0.x's T101). */
export const TOOL_ARG_COALESCE_MS = 100;

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** What a result carrying only images reads as (the history projection's wording). */
function outputOf(content: unknown): string {
  const text = textOf(content);
  if (text) return text;
  return Array.isArray(content) && content.some((block) => recordOf(block)?.type === 'image')
    ? '(image)'
    : '';
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The size of a call's arguments so far (decision 099 rule 14): the raw JSON
 * DSH streamed, with no early parse. Lines count the newlines the model wrote
 * inside strings (`\n` escapes), not the JSON's own, which has none.
 */
export function streamingArgsSummary(raw: string): StreamingToolArgs {
  // An escaped backslash first, so `\\n` (a backslash, then n) is not a newline.
  const text = raw.replace(/\\\\|\\n/g, (sequence) => (sequence === '\\n' ? '\n' : ''));
  return { bytes: utf8Length(raw), lines: countStreamingLines(text) };
}

/** dsh-llm's `TokenUsage` in the shape `buildPiUsagePayload` reads; DSH prices nothing. */
function turnUsageOf(usage: Row): Row {
  const input = numberOf(usage.inputTokens) ?? 0;
  const output = numberOf(usage.outputTokens) ?? 0;
  const cacheRead = numberOf(usage.cacheReadTokens) ?? 0;
  const cacheWrite = numberOf(usage.cacheWriteTokens) ?? 0;
  const reasoning = numberOf(usage.reasoningTokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: numberOf(usage.totalTokens) ?? input + output + cacheRead + cacheWrite,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

/**
 * The occupancy ring: `contextPressure`'s figure for the next request
 * (`projectedTokens`: the newest provider sample plus what the surface gained
 * since), falling back to that sample alone, then to this step's own prompt;
 * the window is the newest `request/context`'s. Nothing when no route
 * advertised a window.
 */
function contextOf(
  pressure: DshUsageView['contextPressure'],
  step: Row | undefined
): PiContextUsage | undefined {
  const contextWindow = numberOf(pressure?.contextWindow);
  if (contextWindow === undefined || contextWindow <= 0) return undefined;
  const prompt = step
    ? (numberOf(step.input) ?? 0) +
      (numberOf(step.cacheRead) ?? 0) +
      (numberOf(step.cacheWrite) ?? 0)
    : undefined;
  const tokens =
    numberOf(pressure?.projectedTokens) ?? numberOf(pressure?.pressureTokens) ?? prompt ?? null;
  return {
    tokens,
    contextWindow,
    percent: tokens === null ? null : (tokens / contextWindow) * 100,
  };
}

/** The session's running total: `tokenUsage` over the whole log, counted in reported steps. */
function sessionOf(totals: DshUsageView['tokenUsage'], steps: number): PiSessionUsage | null {
  if (!totals || steps <= 0) return null;
  const input = numberOf(totals.uncachedInputTokens) ?? 0;
  const output = numberOf(totals.outputTokens) ?? 0;
  const cacheRead = numberOf(totals.cacheReadTokens) ?? 0;
  const cacheWrite = numberOf(totals.cacheWriteTokens) ?? 0;
  return {
    turns: steps,
    toolResults: 0,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    costUsd: 0,
  };
}

/** `session.failed.error`: DSH's own sentence (`LlmFailure.message`), not the reason as JSON. */
function failureText(reason: Row): string {
  const failure = recordOf(reason.error);
  return (
    stringOf(failure?.message) ??
    stringOf(failure?.code) ??
    `DSH turn ended: ${JSON.stringify(reason).slice(0, 500)}`
  );
}

// ---- the translator ---------------------------------------------------------------

interface StepMessage {
  messageId: string;
  closed: boolean;
  /** Text already streamed per content-block index, to top up from the durable message. */
  streamed: Map<number, string>;
  /** Reasoning blocks opened (`thinking.started`) and not yet closed. */
  thinking: Set<number>;
  /** The pending usage of this step was sent. */
  pendingUsage: boolean;
}

interface ArgsStream {
  raw: string;
  lastEmitAt: number;
  lastBytes: number;
  /** The block ended: the full arguments went out, the summary stops. */
  settled: boolean;
}

export class DshLiveEvents {
  private readonly host: DshLiveEventsHost;
  private readonly steps = new Map<string, StepMessage>();
  /** Tool call id -> the live message of the step that asked for it. */
  private readonly toolStep = new Map<string, string>();
  private readonly toolNames = new Map<string, string>();
  /** Tool call id -> its parsed arguments, for the review of a `write` / `edit`. */
  private readonly callArgs = new Map<string, unknown>();
  private readonly startedTools = new Set<string>();
  private readonly argStreams = new Map<string, ArgsStream>();
  private currentStream: { attemptId: string; message: StepMessage } | null = null;
  /**
   * The turn is still taking in its first batch of input (until its first
   * model event), and whether a head came out of it (P1-4d1, decision 072).
   */
  private batch: { first: boolean; headed: boolean } = { first: false, headed: false };

  constructor(host: DshLiveEventsHost) {
    this.host = host;
  }

  /** Per-turn state; empty between turns, dropped when the session changes. */
  reset(): void {
    this.steps.clear();
    this.toolStep.clear();
    this.toolNames.clear();
    this.callArgs.clear();
    this.startedTools.clear();
    this.argStreams.clear();
    this.currentStream = null;
    this.batch = { first: false, headed: false };
  }

  private emit(event: BridgeDraft): void {
    this.host.emit(event);
  }

  private stepMessage(turn: number, step: number): StepMessage {
    const key = `${turn}:${step}`;
    let message = this.steps.get(key);
    if (!message) {
      message = {
        messageId: `dsh-${this.host.dshSessionId()}-t${turn}-s${step}`,
        closed: false,
        streamed: new Map(),
        thinking: new Set(),
        pendingUsage: false,
      };
      this.steps.set(key, message);
      this.emit({
        type: 'message.started',
        payload: { messageId: message.messageId, role: 'assistant', model: this.host.route() },
      });
    }
    return message;
  }

  /** A step's message ends, and with it any thought still open (a cut stream). */
  private closeMessage(message: StepMessage): void {
    if (message.closed) return;
    for (const index of message.thinking) {
      this.emit({
        type: 'thinking.completed',
        payload: { messageId: message.messageId, blockId: `${message.messageId}-r${index}` },
      });
    }
    message.thinking.clear();
    message.closed = true;
    this.emit({ type: 'message.completed', payload: { messageId: message.messageId } });
  }

  // ---- stream frames ---------------------------------------------------------

  onStreamFrame(frame: StreamFrame): void {
    if (frame.type === 'start') {
      this.batch.first = false;
      this.currentStream = {
        attemptId: frame.attemptId,
        message: this.stepMessage(frame.turn, frame.step),
      };
      return;
    }
    const current = this.currentStream;
    if (!current || current.attemptId !== frame.attemptId) return;
    if (frame.type === 'end') {
      this.currentStream = null;
      return;
    }
    this.onChunk(current.message, frame.chunk);
  }

  private onChunk(message: StepMessage, chunk: StreamChunk): void {
    const { messageId, streamed } = message;
    const index = 'index' in chunk && typeof chunk.index === 'number' ? chunk.index : 0;
    switch (chunk.type) {
      case 'block-start':
        if ('blockType' in chunk && chunk.blockType === 'reasoning')
          this.openThought(message, index);
        return;
      case 'text-delta':
        if (!('text' in chunk) || typeof chunk.text !== 'string') return;
        streamed.set(index, (streamed.get(index) ?? '') + chunk.text);
        this.emit({
          type: 'message.delta',
          payload: { messageId, blockId: `${messageId}-b${index}`, text: chunk.text },
        });
        return;
      case 'reasoning-delta':
        if (!('text' in chunk) || typeof chunk.text !== 'string') return;
        this.openThought(message, index);
        this.emit({
          type: 'thinking.delta',
          payload: { messageId, blockId: `${messageId}-r${index}`, text: chunk.text },
        });
        return;
      case 'tool-call-delta':
        if ('id' in chunk && typeof chunk.id === 'string' && chunk.id) {
          this.onArgumentsDelta(message, chunk as Extract<StreamChunk, { id: string }>);
        }
        return;
      case 'block-end': {
        const block = 'block' in chunk ? recordOf(chunk.block) : undefined;
        if (block?.type === 'reasoning') this.closeThought(message, index);
        else if (block?.type === 'tool-call') this.onToolCallBlock(message, block);
        return;
      }
      case 'usage': {
        // Once per step: the prompt side, while the reply is still coming.
        const usage = 'usage' in chunk ? recordOf(chunk.usage) : undefined;
        if (!usage || message.pendingUsage) return;
        const payload = buildPiInterimUsagePayload(turnUsageOf(usage));
        if (!payload) return;
        message.pendingUsage = true;
        this.emit({ type: 'usage.updated', payload });
        return;
      }
      default:
        return;
    }
  }

  private openThought(message: StepMessage, index: number): void {
    if (message.thinking.has(index)) return;
    message.thinking.add(index);
    this.emit({
      type: 'thinking.started',
      payload: { messageId: message.messageId, blockId: `${message.messageId}-r${index}` },
    });
  }

  private closeThought(message: StepMessage, index: number): void {
    if (!message.thinking.delete(index)) return;
    this.emit({
      type: 'thinking.completed',
      payload: { messageId: message.messageId, blockId: `${message.messageId}-r${index}` },
    });
  }

  /**
   * Decision 099 rule 14: a call's row opens on its first named delta and
   * grows by size alone — bytes and lines of the raw JSON so far, at most one
   * update per call and window. Its arguments are read at the block's end.
   */
  private onArgumentsDelta(
    message: StepMessage,
    chunk: { id: string; name?: string; argumentsDelta?: string }
  ): void {
    const id = chunk.id;
    let stream = this.argStreams.get(id);
    if (!stream) {
      stream = { raw: '', lastEmitAt: 0, lastBytes: -1, settled: false };
      this.argStreams.set(id, stream);
    }
    if (stream.settled) return;
    if (typeof chunk.argumentsDelta === 'string') stream.raw += chunk.argumentsDelta;
    if (typeof chunk.name === 'string' && chunk.name) this.toolNames.set(id, chunk.name);
    const summary = streamingArgsSummary(stream.raw);
    const now = this.host.now();
    if (!this.startedTools.has(id)) {
      const name = this.toolNames.get(id);
      // A call is addressed by its id and name; before both, there is no row to open.
      if (!name) return;
      this.startedTools.add(id);
      this.toolStep.set(id, message.messageId);
      stream.lastEmitAt = now;
      stream.lastBytes = summary.bytes;
      this.emit({
        type: 'tool.started',
        payload: {
          messageId: message.messageId,
          toolCallId: id,
          name,
          input: { [STREAMING_TOOL_ARGS_KEY]: summary },
        },
      });
      return;
    }
    if (summary.bytes === stream.lastBytes || now - stream.lastEmitAt < TOOL_ARG_COALESCE_MS) {
      return;
    }
    stream.lastEmitAt = now;
    stream.lastBytes = summary.bytes;
    this.emit({
      type: 'tool.updated',
      payload: {
        messageId: this.toolStep.get(id) ?? message.messageId,
        toolCallId: id,
        input: { [STREAMING_TOOL_ARGS_KEY]: summary },
      },
    });
  }

  /** The block's end carries the call as DSH assembled it: the row gets its full arguments. */
  private onToolCallBlock(message: StepMessage, block: Row): void {
    const id = stringOf(block.id);
    const name = stringOf(block.name) ?? this.toolNames.get(id ?? '');
    if (!id || !name) return;
    this.toolNames.set(id, name);
    const args = parseToolArguments(block.arguments);
    this.callArgs.set(id, args);
    const stream = this.argStreams.get(id) ?? {
      raw: '',
      lastEmitAt: 0,
      lastBytes: -1,
      settled: false,
    };
    stream.settled = true;
    this.argStreams.set(id, stream);
    if (!this.startedTools.has(id)) {
      this.startedTools.add(id);
      this.toolStep.set(id, message.messageId);
      this.emit({
        type: 'tool.started',
        payload: { messageId: message.messageId, toolCallId: id, name, input: toolRowInput(args) },
      });
      return;
    }
    this.emit({
      type: 'tool.updated',
      payload: {
        messageId: this.toolStep.get(id) ?? message.messageId,
        toolCallId: id,
        input: toolRowInput(args),
      },
    });
  }

  // ---- durable events ----------------------------------------------------------

  onSessionEvent(event: DshSessionEvent): void {
    const data = event.data ?? {};
    switch (event.type) {
      case 'turn/start':
        if (!this.host.turn()) this.host.openSyntheticTurn(Number(data.turn));
        this.batch = { first: true, headed: false };
        return;
      case 'user/message':
        this.onUserMessage(event);
        return;
      case 'assistant/message':
        this.batch.first = false;
        this.onAssistantMessage(data);
        return;
      case 'assistant/attempt':
        this.batch.first = false;
        return;
      case 'tool/call':
        this.onToolCall(data);
        return;
      case 'tool/result':
        this.onToolResult(data);
        return;
      case 'llm/retry':
        this.onRetry(event);
        return;
      case 'llm/retry-started':
        // The wait is over and the next attempt is on its way: the banner goes.
        this.emit({ type: 'session.status', payload: { status: 'running' } });
        return;
      case 'step/end': {
        this.batch.first = false;
        const message = this.steps.get(`${String(data.turn)}:${String(data.step)}`);
        if (message) this.closeMessage(message);
        return;
      }
      case 'turn/end':
        this.onTurnEnd(data);
        return;
      default:
        return;
    }
  }

  private onUserMessage(event: DshSessionEvent): void {
    const turn = this.host.turn();
    if (!turn) return;
    const data = event.data;
    const source = data.source;
    const kind = dshSourceKind(source);
    if (kind === 'user') {
      if (data.id === turn.userMessageId) this.echoPrompt(event.seq, turn, textOf(data.content));
      return;
    }
    // Decisions 072, 099: what the engine sent itself, by the history's own table.
    if (turn.synthetic && this.batch.first && !this.batch.headed) {
      const origin = dshTurnOrigin(source, this.host.goalMaxRounds());
      if (origin) {
        this.batch.headed = true;
        this.echoHead(event.seq, origin, dshTurnHeadText(source, data.content));
        return;
      }
    }
    const notice = dshNoticeText(source, data.content);
    if (notice === undefined || !kind) return;
    this.emit({
      type: 'custom.message',
      payload: {
        messageId: `dsh-notice-${event.seq}`,
        customType: `${DSH_NOTICE_CUSTOM_TYPE_PREFIX}${kind}`,
        content: notice,
      },
    });
  }

  private echoPrompt(seq: number, turn: LiveTurn, text: string): void {
    const messageId = `dsh-user-${seq}`;
    this.emit({
      type: 'message.started',
      payload: {
        messageId,
        role: 'user',
        ...(turn.attemptId ? { attemptId: turn.attemptId } : {}),
      },
    });
    this.emit({
      type: 'message.delta',
      payload: { messageId, blockId: `${messageId}-text`, text },
    });
    this.emit({ type: 'message.completed', payload: { messageId } });
  }

  /** The head of a turn nobody sent: a user message with its origin, never a prompt. */
  private echoHead(seq: number, origin: TurnOrigin, text: string): void {
    const messageId = `dsh-user-${seq}`;
    this.emit({ type: 'message.started', payload: { messageId, role: 'user', origin } });
    if (text) {
      this.emit({
        type: 'message.delta',
        payload: { messageId, blockId: `${messageId}-text`, text },
      });
    }
    this.emit({ type: 'message.completed', payload: { messageId } });
  }

  private onAssistantMessage(data: Row): void {
    const message = this.stepMessage(Number(data.turn), Number(data.step));
    const content = (recordOf(data.message)?.content as unknown[] | undefined) ?? [];
    content.forEach((block, index) => {
      const record = recordOf(block);
      if (record?.type === 'text' && typeof record.text === 'string') {
        // Top up whatever the live stream did not deliver (e.g. a replayed attempt).
        const already = message.streamed.get(index) ?? '';
        if (record.text.length > already.length && record.text.startsWith(already)) {
          const rest = record.text.slice(already.length);
          message.streamed.set(index, record.text);
          this.emit({
            type: 'message.delta',
            payload: {
              messageId: message.messageId,
              blockId: `${message.messageId}-b${index}`,
              text: rest,
            },
          });
        }
      }
    });
    this.settledUsage(data);
  }

  /**
   * Decision 099 rule 1: the step's own usage, settled, beside the context
   * occupancy and the session's running total — all dsh-token-meter's. A
   * step Stop cut mid-stream reports none; it says so (`unreported`, T125)
   * rather than a row of zeros that reads as "free".
   */
  private settledUsage(data: Row): void {
    const usage = recordOf(data.usage);
    if (!usage && data.interrupted !== true) return;
    const step = usage ? turnUsageOf(usage) : { input: 0, output: 0 };
    const view = this.host.usageView();
    const payload = buildPiUsagePayload(
      step,
      contextOf(view?.contextPressure, usage ? step : undefined),
      sessionOf(view?.tokenUsage, this.host.usageSteps()),
      null,
      { unreported: !usage }
    );
    if (payload) this.emit({ type: 'usage.updated', payload });
  }

  private onToolCall(data: Row): void {
    const callId = String(data.callId);
    const name = String(data.name);
    this.toolNames.set(callId, name);
    const args = parseToolArguments(data.arguments);
    if (!this.callArgs.has(callId)) this.callArgs.set(callId, args);
    const messageId = this.stepMessage(Number(data.turn), Number(data.step)).messageId;
    if (!this.toolStep.has(callId)) this.toolStep.set(callId, messageId);
    if (!this.startedTools.has(callId)) {
      this.startedTools.add(callId);
      this.emit({
        type: 'tool.started',
        payload: { messageId, toolCallId: callId, name, input: toolRowInput(args) },
      });
      return;
    }
    // The stream's block end already sent these very arguments.
    if (this.argStreams.get(callId)?.settled) return;
    this.emit({
      type: 'tool.updated',
      payload: {
        messageId: this.toolStep.get(callId) ?? messageId,
        toolCallId: callId,
        input: toolRowInput(args),
      },
    });
  }

  /**
   * Decision 099 rules 5 and 6: the row's flags off DSH's error identity —
   * never ran, stopped, outcome unknown, refused by our gate — and a
   * `write` / `edit`'s review off DSH's diff card; the same reading the
   * history projection gives the stored result.
   */
  private onToolResult(data: Row): void {
    const message = recordOf(data.message);
    const callId = String(message?.toolCallId ?? '');
    const messageId =
      this.toolStep.get(callId) ?? this.stepMessage(Number(data.turn), Number(data.step)).messageId;
    const text = outputOf(message?.content);
    const failed = message?.isError === true;
    const review = failed
      ? undefined
      : dshFileReview(this.toolNames.get(callId), this.callArgs.get(callId), data.meta);
    const details = {
      ...(review ? { review } : {}),
      ...dshToolOutcomeFlags(data.error, data.meta),
    };
    const structured = Object.keys(details).length > 0;
    this.emit({
      type: 'tool.completed',
      payload: {
        messageId,
        toolCallId: callId,
        ok: !failed,
        ...(structured
          ? { output: { content: [{ type: 'text', text }], details } }
          : failed
            ? {}
            : { output: text }),
        ...(failed ? { error: text || 'Tool call failed' } : {}),
      },
    });
  }

  /** Decision 099 rule 3: DSH waits before retrying the step's request — the banner says so. */
  private onRetry(event: DshSessionEvent): void {
    const data = event.data;
    const failure = recordOf(data.failure);
    const delayMs = numberOf(data.delayMs) ?? 0;
    const status = numberOf(failure?.status);
    this.emit({
      type: 'session.status',
      payload: {
        status: 'running',
        retry: {
          attempt: numberOf(data.retry) ?? 1,
          // `always` mode has no ceiling: the banner's "absent" sentinel.
          maxRetries: numberOf(data.maxRetries) ?? 0,
          delayMs,
          errorStatus: status !== undefined ? String(status) : null,
          error: stringOf(failure?.code) ?? 'unknown',
          ...(numberOf(event.time) !== undefined ? { retryAt: event.time + delayMs } : {}),
        },
      },
    });
  }

  private onTurnEnd(data: Row): void {
    const reason = recordOf(data.reason) ?? {};
    for (const message of this.steps.values()) this.closeMessage(message);
    const cause = recordOf(reason.reason);
    switch (reason.kind) {
      case 'completed':
      case 'blocked':
      case 'max-tokens':
        this.emit({ type: 'session.completed', payload: {} });
        break;
      case 'aborted':
        // Decision 081's handoff: the step ceiling's wrap-up ends the run, it does not stop it.
        if (cause?.kind === 'hook' && cause.reason === AICLIENT_TURN_CEILING_REASON) {
          this.emit({ type: 'session.completed', payload: { stopCause: 'turn_limit' } });
        } else {
          this.emit({ type: 'session.stopped', payload: {} });
        }
        break;
      default: {
        // Design shard 03 §5: DSH's failure code in our vocabulary, beside its sentence.
        const errorCode = mapDshFailureCode(recordOf(reason.error)?.code);
        this.emit({
          type: 'session.failed',
          payload: { error: failureText(reason), ...(errorCode ? { errorCode } : {}) },
        });
      }
    }
    this.emit({ type: 'session.status', payload: { status: 'idle' } });
    this.host.closeTurn();
    this.reset();
  }
}
