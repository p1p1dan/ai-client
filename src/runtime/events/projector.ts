import {
  type AgentEvent,
  type AgentMessage,
  estimateContextTokens,
} from '@earendil-works/pi-agent-core';
import { isInternalMessage } from '../../shared/internalMessage.ts';
import { applyTurnUsage, initTurnRollup, viewTurnRollup } from '../../shared/piTurnRollup.ts';
import {
  buildPiInterimUsagePayload,
  buildPiUsagePayload,
  type PiTurnUsage,
} from '../../shared/piUsage.ts';
import { reviewFromToolResult } from '../../shared/sessionFileChange.ts';
import type {
  MessageAttachmentMeta,
  RuntimeEventDraft,
  SessionRecoveryNote,
  SessionRetryInfo,
} from '../../shared/types/runtimeEvents.ts';
import type { RuntimeRunResult } from '../contracts.ts';
import { streamingToolArgsKey, summarizeStreamingToolArgs } from './streamingToolArgs.ts';

/**
 * T101 — the shortest gap between two `tool.updated` events for one call while
 * its arguments stream.
 *
 * A provider emits arguments in chunks of a few tokens, so an unthrottled pass
 * would put one event per chunk on the wire — thousands for a large `write`,
 * each one a store write and a re-render, to move a byte counter. 100 ms is
 * fast enough to read as live and slow enough that the file body costs ~10
 * events per second instead of ~200.
 */
export const TOOL_ARG_COALESCE_MS = 100;

/** What has already been said about one tool call opened during streaming. */
interface StreamingToolRow {
  /** The assistant message the row hangs on; its later events must agree. */
  messageId: string;
  /** `streamingToolArgsKey` of the last summary emitted, for change detection. */
  summary: string;
  /** Clock reading of the last event emitted for this row. */
  lastEmitMs: number;
  /** The complete arguments have been delivered; the streaming pass is done. */
  settled: boolean;
  /**
   * The argument object delivered as final, so the same one arriving again
   * says nothing. `message_end` and `tool_execution_start` both carry the tool
   * call's own `arguments` reference, and re-stating it would put a second,
   * byte-identical `tool.updated` on the wire for every call in every turn.
   */
  settledInput?: unknown;
}

/** Construction-time knobs, both injected so a test can drive them. */
export interface RuntimeEventProjectorOptions {
  /** {@link STREAM_TOOL_ROWS_ENV}. Defaults to `true`. */
  streamToolRows?: boolean;
  /** Monotonic-enough clock for {@link TOOL_ARG_COALESCE_MS}. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * What the composer said about this send, echoed back on the user message.
 *
 * Neither field can be recovered from the model stream: `attemptId` is the
 * renderer's own identity for the send it is optimistically showing, and the
 * attachment list is metadata the provider is never given. They ride the run
 * request and are stamped here.
 */
export interface UserTurnEcho {
  attemptId?: string;
  attachments?: readonly MessageAttachmentMeta[];
}

export interface RuntimeEventSink {
  sessionId: string;
  emit(event: RuntimeEventDraft): void;
}
function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: { type?: string; text?: string }) =>
      block?.type === 'text' ? (block.text ?? '') : ''
    )
    .join('');
}
/**
 * A tool result as the transcript should read it.
 *
 * The content of a pi tool result is usually a block array, and stringifying it
 * put `[{"type":"text","text":"Successfully wrote 3 bytes to E:/..."}]` on
 * screen — the 2026-09-10 screenshots caught exactly that line. `text()`
 * already knows how to read those blocks; JSON stays as the last resort for a
 * shape nothing here can read, because dropping it would hide a result
 * entirely, which is worse than showing it raw.
 */
export function output(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'content' in result) {
    const content = result.content;
    if (typeof content === 'string') return content;
    const rendered = text(content);
    return rendered || JSON.stringify(content);
  }
  return result === undefined ? '' : JSON.stringify(result);
}

/**
 * The new text in a cumulative snapshot, and where the cursor lands after it.
 *
 * Snapshots normally grow, and the growth IS the delta. Two shapes are not
 * growth. A snapshot that repeats — or truncates — what was already sent adds
 * nothing, and the longer cursor stands: that text is on screen and a transcript
 * cannot un-say it. A snapshot that DIVERGES is a rewrite; pi-ai's Responses
 * adapter replaces a whole text or thinking block when its output item
 * finalizes (`api/openai-responses-shared.js`), so this is reachable rather
 * than hypothetical. A rewrite cannot be replayed into an append-only
 * transcript either, but it must still move the cursor — leaving the cursor on
 * text the provider has abandoned made every later snapshot diverge too, which
 * silently muted the rest of the message, `message_end`'s final flush included.
 */
function advance(cursor: string, snapshot: string): { text?: string; cursor: string } {
  if (snapshot.startsWith(cursor))
    return snapshot.length > cursor.length
      ? { text: snapshot.slice(cursor.length), cursor: snapshot }
      : { cursor };
  if (cursor.startsWith(snapshot)) return { cursor };
  return { cursor: snapshot };
}

/** Sum two settled turn payloads. Addition only, same rule as the rollup. */
function addTurnUsage(left: PiTurnUsage | undefined, right: PiTurnUsage): PiTurnUsage {
  if (!left) return { ...right };
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd,
  };
}

/** Adapt the retired engine's projection to typed native AgentEvents; same wire DTOs. */
export class RuntimeEventProjector {
  private readonly sink: RuntimeEventSink;
  private readonly requestId: string;
  private assistant: string | undefined;
  /**
   * The model announced by `message_start`, held until a message is minted.
   *
   * An assistant message is opened by its first CONTENT, not by its
   * announcement, so the id and the model part company for as long as the
   * message stays empty. Kept because the model belongs on `message.started`:
   * the renderer's metadata row reads it off the last opened assistant message
   * and showed `null` for every turn whose message was minted by a tool row.
   */
  private model: string | undefined;
  private readonly toolMessages = new Map<string, string>();
  private index = 0;
  private prose = '';
  private thinking = '';
  private thinkingOpen = false;
  private rollup;
  /**
   * decision 005 — what this conversation's delegates have spent so far.
   *
   * Kept beside the rollup rather than inside it: the rollup's totals INCLUDE
   * this (a session total that excluded delegated work would contradict the
   * contract's "会话/轮级总成本含子调用"), and this is the slice of them that
   * says how much was delegated.
   */
  private delegatedUsage: PiTurnUsage | undefined;
  /** The last turn payload emitted, so a delegate settling can re-state it. */
  private lastTurnUsage: unknown;
  /**
   * The context-occupancy figure from the last `turn_end`, kept so a delegate
   * settling can re-state it instead of re-stating `undefined`.
   *
   * `delegated()` below used to hardcode this argument to `undefined`, which
   * made `foldSettledUsage` on the renderer side treat the whole `context`
   * field as gone — the occupancy ring read as zero for the length of a
   * delegation even though nothing about the parent turn's context changed.
   */
  private lastContextUsage: { tokens: number; contextWindow: number; percent: number } | undefined;
  /**
   * The usage block off the message currently streaming, kept so the interim
   * tick can be emitted from a later event than the one that carried it.
   *
   * pi reports usage on the PARTIAL message (`message_update`), but the
   * assistant message this projector mints is opened by its first content —
   * which for a tool-first turn is `tool_execution_start`, an event that
   * carries no usage at all. Cleared with the message it belongs to.
   */
  private streamingUsage: unknown;
  /** The message the interim tick was already emitted for; one per model call. */
  private interimUsageFor: string | undefined;
  private readonly contextWindow: number | undefined;
  private readonly userTurn: UserTurnEcho;
  /**
   * T101 — tool rows opened from a PARTIAL message, by tool call id.
   *
   * An entry lives from the first partial arguments until the call's execution
   * ends. While it exists it answers three questions: which message the row
   * hangs on, whether the row has already been announced (so
   * `tool_execution_start` does not open a second one), and whether the call
   * ever reached execution at all (so a stopped run can settle what is left).
   */
  private readonly streamingTools = new Map<string, StreamingToolRow>();
  private readonly streamToolRows: boolean;
  private readonly now: () => number;
  constructor(
    sink: RuntimeEventSink,
    requestId: string,
    history: readonly AgentMessage[] = [],
    contextWindow?: number,
    userTurn: UserTurnEcho = {},
    options: RuntimeEventProjectorOptions = {}
  ) {
    this.sink = sink;
    this.contextWindow = contextWindow;
    this.requestId = requestId;
    this.userTurn = userTurn;
    this.streamToolRows = options.streamToolRows ?? true;
    this.now = options.now ?? Date.now;
    this.rollup = initTurnRollup(sink.sessionId);
    for (const message of history) {
      if (message.role === 'assistant' || message.role === 'toolResult') {
        const usage = buildPiUsagePayload(message.usage);
        if (usage)
          this.rollup = applyTurnUsage(this.rollup, {
            sessionId: sink.sessionId,
            usage,
            source: message.role === 'assistant' ? 'turn' : 'tool',
          });
      }
    }
  }
  private emit(event: RuntimeEventDraft): void {
    this.sink.emit({ ...event, requestId: this.requestId });
  }
  start(): void {
    this.emit({
      type: 'session.status',
      sessionId: this.sink.sessionId,
      payload: { status: 'running' },
    });
  }
  /**
   * A new assistant message was announced: close the previous one, remember the
   * model, and reset the delta cursors. Nothing is emitted — see `model`.
   */
  private announceAssistant(model: string): void {
    this.closeAssistant();
    this.model = model;
    this.prose = '';
    this.thinking = '';
    this.thinkingOpen = false;
  }
  /** Mint the message on its first content, stamped with the announced model. */
  private ensureAssistant(): string {
    if (!this.assistant) {
      this.assistant = `asst-${this.requestId}-${++this.index}`;
      this.emit({
        type: 'message.started',
        sessionId: this.sink.sessionId,
        payload: {
          messageId: this.assistant,
          role: 'assistant',
          ...(this.model ? { model: this.model } : {}),
        },
      });
    }
    return this.assistant;
  }
  private deltas(message: AgentMessage, final = false): void {
    if (message.role !== 'assistant') return;
    const prose = text(message.content);
    const thinking = message.content
      .filter((block) => block.type === 'thinking')
      .map((block) => block.thinking)
      .join('');
    // Pi native events carry cumulative snapshots; `advance` says what part of
    // one is actually new. Read BEFORE the message is minted, so a snapshot
    // that adds nothing does not open a message that would stay empty.
    const nextThinking = advance(this.thinking, thinking);
    this.thinking = nextThinking.cursor;
    if (nextThinking.text !== undefined) {
      const messageId = this.ensureAssistant();
      if (!this.thinkingOpen) {
        this.emit({
          type: 'thinking.started',
          sessionId: this.sink.sessionId,
          payload: { messageId, blockId: `${messageId}-thinking` },
        });
        this.thinkingOpen = true;
      }
      this.emit({
        type: 'thinking.delta',
        sessionId: this.sink.sessionId,
        payload: { messageId, blockId: `${messageId}-thinking`, text: nextThinking.text },
      });
    }
    const nextProse = advance(this.prose, prose);
    this.prose = nextProse.cursor;
    if (nextProse.text !== undefined) {
      const messageId = this.ensureAssistant();
      if (this.thinkingOpen) {
        this.emit({
          type: 'thinking.completed',
          sessionId: this.sink.sessionId,
          payload: { messageId, blockId: `${messageId}-thinking` },
        });
        this.thinkingOpen = false;
      }
      this.emit({
        type: 'message.delta',
        sessionId: this.sink.sessionId,
        payload: { messageId, blockId: `${messageId}-text`, text: nextProse.text },
      });
    }
    this.toolDeltas(message, final);
  }
  /**
   * T101 — open a tool row as soon as the model starts dictating the call, and
   * keep its short arguments current while the rest of them arrive.
   *
   * Third pass of `deltas`, and the last one on purpose: a turn emits its prose
   * before the calls it decided on, so the row lands under the sentence that
   * explains it.
   *
   * Reads the `toolCall` blocks of the cumulative partial message rather than
   * the `toolcall_delta` payload beside it. The delta is a fragment of raw JSON
   * with no id and no tool name on it; the partial's block already carries both,
   * plus pi's own partial-JSON parse of the arguments so far — so `path` is
   * readable the moment the model has finished typing it, which for `write` is
   * before a single byte of the file.
   *
   * @param final the arguments on this message are complete (`message_end`, or
   *   a `toolcall_end` for one specific call): emit them in full and stop
   *   summarizing. Everything the summary withheld arrives exactly here.
   */
  private toolDeltas(message: AgentMessage, final: boolean, onlyId?: string): void {
    if (!this.streamToolRows || message.role !== 'assistant') return;
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      const { id, name } = block;
      // An id and a name are what a row IS addressed by; a provider that has
      // not sent them yet has not opened a call this projector can speak about.
      if (!id || !name) continue;
      if (onlyId !== undefined && onlyId !== id) continue;
      const seen = this.streamingTools.get(id);
      if (seen?.settled) continue;
      const summary = final ? undefined : summarizeStreamingToolArgs(block.arguments);
      const input = summary ?? block.arguments;
      if (!seen) {
        const messageId = this.ensureAssistant();
        this.streamingTools.set(id, {
          messageId,
          summary: summary ? streamingToolArgsKey(summary) : '',
          lastEmitMs: this.now(),
          settled: final,
          ...(final ? { settledInput: input } : {}),
        });
        this.toolMessages.set(id, messageId);
        this.emit({
          type: 'tool.started',
          sessionId: this.sink.sessionId,
          payload: { messageId, toolCallId: id, name, input },
        });
        continue;
      }
      if (!final) {
        // Two gates, both required. The summary must have actually moved —
        // a provider re-sending the same snapshot must not redraw the row —
        // and the previous event for THIS row must be at least one window old.
        const key = streamingToolArgsKey(summary ?? {});
        if (key === seen.summary) continue;
        const now = this.now();
        if (now - seen.lastEmitMs < TOOL_ARG_COALESCE_MS) continue;
        seen.summary = key;
        seen.lastEmitMs = now;
      } else {
        seen.settled = true;
        seen.settledInput = input;
        seen.lastEmitMs = this.now();
      }
      this.emit({
        type: 'tool.updated',
        sessionId: this.sink.sessionId,
        payload: { messageId: seen.messageId, toolCallId: id, input },
      });
    }
  }
  /**
   * Light the `↑` on the turn progress head as soon as the provider reports a
   * prompt size, instead of at `turn_end` (2026-09-19 user decision).
   *
   * Emitted at most once per assistant message, and only once that message has
   * been minted — the renderer attributes a `usage.updated` to whichever
   * assistant message is open (`messageMetadata.ts`'s `bySessionLastAssistant`),
   * so a tick sent before this call's message existed would be filed against
   * the PREVIOUS turn and make its settled total jump.
   *
   * `buildPiInterimUsagePayload` owns what the payload may claim; see its note
   * on the `output_tokens: 1` placeholder.
   */
  private interimUsage(): void {
    const messageId = this.assistant;
    if (!messageId || this.interimUsageFor === messageId) return;
    const payload = buildPiInterimUsagePayload(this.streamingUsage);
    if (!payload) return;
    this.interimUsageFor = messageId;
    this.emit({ type: 'usage.updated', sessionId: this.sink.sessionId, payload });
  }
  /**
   * T101 — give every tool row that never ran a terminal, so nothing is left
   * spinning.
   *
   * A row is now opened by the model DECIDING to call a tool, which is one
   * event earlier than the runtime agreeing to run it. Everything between the
   * two can go wrong: Stop, an output limit that truncates the arguments
   * mid-object, a provider error. `tool_execution_end` removes a row that did
   * run, so whatever is still here when its message closes is a call that
   * never started — and without this it would keep the `running` spinner for
   * the rest of the conversation, on a transcript that is otherwise finished.
   *
   * Reported as a FAILED completion rather than a silent removal: the model did
   * ask for the call, and a transcript that quietly drops a request the user
   * watched being typed is a worse lie than one that says it was dropped.
   */
  private settleUnfinishedToolRows(): void {
    for (const [toolCallId, row] of this.streamingTools) {
      this.emit({
        type: 'tool.completed',
        sessionId: this.sink.sessionId,
        payload: {
          messageId: row.messageId,
          toolCallId,
          ok: false,
          error: 'The run ended before this call started.',
        },
      });
      this.toolMessages.delete(toolCallId);
    }
    this.streamingTools.clear();
  }
  private closeAssistant(completed = true): void {
    this.model = undefined;
    this.streamingUsage = undefined;
    this.settleUnfinishedToolRows();
    if (!this.assistant) return;
    const messageId = this.assistant;
    if (this.thinkingOpen) {
      this.emit({
        type: 'thinking.completed',
        sessionId: this.sink.sessionId,
        payload: { messageId, blockId: `${messageId}-thinking` },
      });
      this.thinkingOpen = false;
    }
    if (completed)
      this.emit({
        type: 'message.completed',
        sessionId: this.sink.sessionId,
        payload: { messageId },
      });
    this.assistant = undefined;
  }
  observe(event: AgentEvent): void {
    const sessionId = this.sink.sessionId;
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'user') {
          // Not every `role: 'user'` message came from the user. The runtime
          // feeds a delegation report back through the same door, and pi wraps
          // it as a user message; projecting it would put a bubble the person
          // never wrote into their own conversation, stamped with the attemptId
          // and attachment chips of the send they DID write. It stays in the
          // model's context and in the session file, and off the screen: the
          // report already has a visible channel in the delegation panel.
          if (isInternalMessage(event.message)) break;
          const messageId = `user-${this.requestId}-${++this.index}`;
          this.emit({
            type: 'message.started',
            sessionId,
            payload: {
              messageId,
              role: 'user',
              ...(this.userTurn.attemptId ? { attemptId: this.userTurn.attemptId } : {}),
              ...(this.userTurn.attachments?.length
                ? { attachments: [...this.userTurn.attachments] }
                : {}),
            },
          });
          const value = text(event.message.content);
          if (value)
            this.emit({
              type: 'message.delta',
              sessionId,
              payload: { messageId, blockId: `${messageId}-text`, text: value },
            });
          this.emit({ type: 'message.completed', sessionId, payload: { messageId } });
        } else if (event.message.role === 'assistant')
          this.announceAssistant(`${event.message.provider}/${event.message.model}`);
        break;
      case 'message_update':
        // Before `deltas`, which is what mints the message the tick is filed
        // against: the partial carries the prompt counts Anthropic sent with
        // the very first frame of this call. Only an assistant message has a
        // `usage` block at all — `deltas` applies the same role test.
        if (event.message.role === 'assistant') this.streamingUsage = event.message.usage;
        this.deltas(event.message);
        // T101 — a call whose arguments just finished gets its complete set
        // NOW, not at `message_end`. For a turn with several calls that is the
        // difference between the first row settling immediately and it waiting
        // for the last one; and when the call needs approval, the permission
        // card and the row would otherwise disagree about what is being asked.
        if (event.assistantMessageEvent?.type === 'toolcall_end')
          this.toolDeltas(event.message, true, event.assistantMessageEvent.toolCall.id);
        this.interimUsage();
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          // `final`: this message's arguments are the ones that will be run, so
          // every row still carrying a redacted summary is filled in here.
          this.deltas(event.message, true);
          // A turn that ends in tool calls is not over. pi emits the tool rows
          // AFTER this event, so closing here minted a second, model-less
          // message to carry them and left this one — the message that asked
          // for the tools, and the one a pure tool-call turn leaves empty —
          // completed with nothing in it. `turn_end` closes what the rows hang
          // on, once the round they belong to is actually finished.
          if (event.message.stopReason !== 'toolUse')
            this.closeAssistant(['stop', 'length'].includes(event.message.stopReason));
        } else if (event.message.role === 'custom' && event.message.display !== false) {
          this.emit({
            type: 'custom.message',
            sessionId,
            payload: {
              messageId: `custom-${this.requestId}-${++this.index}`,
              customType: event.message.customType,
              content: (
                text(event.message.content) || JSON.stringify(event.message.details ?? '')
              ).slice(0, 16_000),
            },
          });
        }
        break;
      case 'tool_execution_start': {
        // T101 — idempotent. The streaming pass may already have opened this
        // row minutes ago (a `write` whose `content` is a whole file), in which
        // case a second `tool.started` would draw a SECOND row for one call.
        // What is left to say is the authoritative argument set the runtime is
        // about to execute, which is a `tool.updated` — a no-op downstream when
        // `message_end` already delivered the same object.
        const streamed = this.streamingTools.get(event.toolCallId);
        const messageId = streamed?.messageId ?? this.ensureAssistant();
        // A turn whose first output is a tool call mints its message HERE, so
        // this is the earliest point at which the tick has somewhere to go.
        // No-op once `message_update` already sent one for this message.
        this.interimUsage();
        this.toolMessages.set(event.toolCallId, messageId);
        if (streamed) {
          // Silent when `message_end` already delivered this very object,
          // which is the normal path — pi hands both events the tool call's
          // own `arguments`. Only a runtime that REVISED them before executing
          // has anything left to say here.
          const settled = streamed.settled && streamed.settledInput === event.args;
          streamed.settled = true;
          streamed.settledInput = event.args;
          if (!settled)
            this.emit({
              type: 'tool.updated',
              sessionId,
              payload: { messageId, toolCallId: event.toolCallId, input: event.args },
            });
          break;
        }
        this.emit({
          type: 'tool.started',
          sessionId,
          payload: {
            messageId,
            toolCallId: event.toolCallId,
            name: event.toolName,
            input: event.args,
          },
        });
        break;
      }
      case 'tool_execution_update': {
        const result = event.partialResult as { content?: unknown };
        const line = text(result?.content)
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);
        this.emit({
          type: 'tool.updated',
          sessionId,
          payload: {
            messageId: this.toolMessages.get(event.toolCallId) ?? this.ensureAssistant(),
            toolCallId: event.toolCallId,
            // The arguments as they stand now. A tool row is drawn from its
            // input, and the renderer's reducer bails on the first line when
            // this is absent — so every native `tool.updated` used to be a
            // no-op there, and a tool that revises its arguments mid-run (or
            // whose `tool.started` raced ahead of the final ones) left the
            // card showing the older set for the life of the turn.
            input: event.args,
            ...(line ? { status: line.slice(0, 120) } : {}),
          },
        });
        break;
      }
      case 'tool_execution_end': {
        const review = !event.isError ? reviewFromToolResult(event.result) : undefined;
        this.emit({
          type: 'tool.completed',
          sessionId,
          payload: {
            messageId: this.toolMessages.get(event.toolCallId) ?? this.ensureAssistant(),
            toolCallId: event.toolCallId,
            ok: !event.isError,
            output: review
              ? { content: [{ type: 'text', text: output(event.result) }], details: { review } }
              : output(event.result),
            ...(event.isError ? { error: output(event.result) || 'Tool call failed' } : {}),
          },
        });
        this.toolMessages.delete(event.toolCallId);
        // T101 — this row has a terminal of its own, so it is no longer one of
        // the unfinished ones `settleUnfinishedToolRows` has to answer for.
        this.streamingTools.delete(event.toolCallId);
        break;
      }
      case 'turn_end': {
        if (event.message.role !== 'assistant') break;
        this.closeAssistant();
        /**
         * MODEL-18 (2026-09-19): a turn that did not finish ends through a
         * PLACEHOLDER message, and that message must not be measured.
         *
         * `'aborted'` and `'error'` are one path, not two: pi's `runLoop` tests
         * for both in the same branch (`agent-loop.js:124`) and answers either
         * with a `turn_end` carrying empty content and no tool results.
         * `estimateContextTokens` then refuses that message's usage — its
         * `getAssistantUsage` excludes both stop reasons by name
         * (`compaction.js`) — and falls back to counting the characters of
         * nothing, which reported `{tokens: 0, percent: 0}` and dropped the
         * badge from 2% to 0. Neither pressing Stop nor a provider failing
         * empties the context, so the last measured occupancy stands and the
         * cached figures stay put for `delegated()` to re-state.
         */
        const placeholder = ['aborted', 'error'].includes(event.message.stopReason);
        if (!placeholder) this.lastTurnUsage = event.message.usage;
        const turn = buildPiUsagePayload(event.message.usage);
        if (turn)
          this.rollup = applyTurnUsage(this.rollup, { sessionId, usage: turn, source: 'turn' });
        for (const tool of event.toolResults) {
          const usage = buildPiUsagePayload(tool.usage);
          if (usage)
            this.rollup = applyTurnUsage(this.rollup, { sessionId, usage, source: 'tool' });
        }
        if (!placeholder) {
          const tokens = estimateContextTokens([event.message, ...event.toolResults]).tokens;
          this.lastContextUsage = this.contextWindow
            ? {
                tokens,
                contextWindow: this.contextWindow,
                percent: (tokens / this.contextWindow) * 100,
              }
            : undefined;
        }
        const payload = buildPiUsagePayload(
          event.message.usage,
          // Still absent before any turn has been measured, so a run that ends
          // on its first turn drops the key rather than claiming zero
          // occupancy — the rule `buildPiInterimUsagePayload` follows for a
          // figure it lacks.
          this.lastContextUsage,
          viewTurnRollup(this.rollup),
          this.delegatedUsage
        );
        if (payload) this.emit({ type: 'usage.updated', sessionId, payload });
        break;
      }
    }
  }
  /**
   * The turn is waiting out a provider retry, not stalled.
   *
   * The renderer has carried this banner since T-33 — `session.retry` in the
   * store, `deriveRetryBanner` above the turn head, a "network retry" note in
   * the composer — and the native backend never produced it: the retry ladder
   * wrote to the trace file and nothing else, so a 429 burst showed as up to
   * ~43s of `status: 'running'` with no explanation. Status stays `'running'`
   * on purpose (the turn IS alive); `retry` rides along as an optional field,
   * the compatibility shape `SessionRetryInfo` established.
   */
  retry(info: SessionRetryInfo): void {
    this.emit({
      type: 'session.status',
      sessionId: this.sink.sessionId,
      payload: { status: 'running', retry: info },
    });
  }
  /**
   * T034 (session-02): this session's file was repaired when it was opened.
   *
   * Same shape and same road as `retry` directly above — a rider on a
   * `session.status` the run emits anyway, because that event already reaches
   * the renderer and a new type would need a compatibility argument this note
   * does not need. Status stays `'running'`: nothing about the turn changed,
   * only what is known about the file it is being appended to.
   *
   * Emitted per RUN rather than once at open. A worker emits during bootstrap
   * while Main still has the session in `creating`, and `handleWorkerEvent`
   * drops everything that arrives before the slot is `ready` — so an open-time
   * event would be correct and invisible. The store keeps this note instead of
   * clearing it on the next status, so saying it again costs nothing.
   */
  recovery(note: SessionRecoveryNote): void {
    this.emit({
      type: 'session.status',
      sessionId: this.sink.sessionId,
      payload: { status: 'running', recovery: note },
    });
  }
  /**
   * The retried request started streaming: take the banner down.
   *
   * The store clears `retry` on the next `session.status` that carries none, so
   * this plain one is the end of the retry the event above announced. Without
   * it the banner would sit there promising a next attempt that already
   * happened, until the turn ended or output resumed.
   */
  recovered(): void {
    this.emit({
      type: 'session.status',
      sessionId: this.sink.sessionId,
      payload: { status: 'running' },
    });
  }
  compaction(summary: string): void {
    this.closeAssistant();
    const messageId = `compaction-${this.requestId}-${++this.index}`;
    this.emit({
      type: 'message.started',
      sessionId: this.sink.sessionId,
      payload: { messageId, role: 'system' },
    });
    this.emit({
      type: 'message.delta',
      sessionId: this.sink.sessionId,
      payload: { messageId, blockId: `${messageId}-text`, text: `Context summary\n\n${summary}` },
    });
    this.emit({
      type: 'message.completed',
      sessionId: this.sink.sessionId,
      payload: { messageId },
    });
  }
  /**
   * subagent-data-03 / decision 005 — fold what a delegate spent into the
   * conversation's totals, and say how much of them is delegated.
   *
   * The runtime computed this figure from the start; nothing consumed it. The
   * worker discards the whole `RuntimeRunResult` (`nativeWorkerRuntime` reports
   * a run through events only), and the projector's own `usage.updated` is
   * built from the PARENT's `turn_end`, so a session that fanned out three
   * explorers showed the user a token and cost total missing all three.
   *
   * Emitted as another `usage.updated` rather than a new event type, per
   * decision 005: the top-level fields still describe the last settled turn —
   * they are re-stated, not re-billed, because the renderer keeps the last
   * payload rather than accumulating them — while `session` and `delegated`
   * move. Before the first turn settles there is nothing to re-state, so the
   * fold happens and the next `turn_end` carries it.
   *
   * @param delegations how many settled delegates this one fold stands for.
   */
  delegated(usage: unknown, delegations = 1): void {
    const increment = buildPiUsagePayload(usage);
    if (!increment) return;
    this.rollup = applyTurnUsage(this.rollup, {
      sessionId: this.sink.sessionId,
      usage: increment,
      source: 'tool',
      count: delegations,
    });
    this.delegatedUsage = addTurnUsage(this.delegatedUsage, increment);
    if (this.lastTurnUsage === undefined) return;
    const payload = buildPiUsagePayload(
      this.lastTurnUsage,
      this.lastContextUsage,
      viewTurnRollup(this.rollup),
      this.delegatedUsage
    );
    if (payload) this.emit({ type: 'usage.updated', sessionId: this.sink.sessionId, payload });
  }

  finish(result: Pick<RuntimeRunResult, 'success' | 'error' | 'stopReason' | 'stopCause'>): void {
    this.closeAssistant();
    const type =
      result.stopReason === 'aborted'
        ? 'session.stopped'
        : result.success
          ? 'session.completed'
          : 'session.failed';
    this.emit({
      type,
      sessionId: this.sink.sessionId,
      // T066 回炉: the code travels beside the message, not inside it. A run
      // that ENDS in failure reports the provider's own sentence to the user,
      // so prefixing it would put `stop_error:` in front of a 503; the log and
      // any later branching reader read `errorCode` instead.
      payload: {
        ...(result.error ? { error: result.error.message, errorCode: result.error.code } : {}),
        // decision 040: only a completion can carry it — a wrap-up turn that
        // then failed or was stopped reports that ending, not the ceiling.
        ...(type === 'session.completed' && result.stopCause
          ? { stopCause: result.stopCause }
          : {}),
      },
    });
    this.emit({
      type: 'session.status',
      sessionId: this.sink.sessionId,
      payload: { status: 'idle' },
    });
  }
}
