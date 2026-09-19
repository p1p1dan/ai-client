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
  constructor(
    sink: RuntimeEventSink,
    requestId: string,
    history: readonly AgentMessage[] = [],
    contextWindow?: number,
    userTurn: UserTurnEcho = {}
  ) {
    this.sink = sink;
    this.contextWindow = contextWindow;
    this.requestId = requestId;
    this.userTurn = userTurn;
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
  private deltas(message: AgentMessage): void {
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
  private closeAssistant(completed = true): void {
    this.model = undefined;
    this.streamingUsage = undefined;
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
        this.interimUsage();
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          this.deltas(event.message);
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
        const messageId = this.ensureAssistant();
        // A turn whose first output is a tool call mints its message HERE, so
        // this is the earliest point at which the tick has somewhere to go.
        // No-op once `message_update` already sent one for this message.
        this.interimUsage();
        this.toolMessages.set(event.toolCallId, messageId);
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
        break;
      }
      case 'turn_end': {
        if (event.message.role !== 'assistant') break;
        this.closeAssistant();
        this.lastTurnUsage = event.message.usage;
        const turn = buildPiUsagePayload(event.message.usage);
        if (turn)
          this.rollup = applyTurnUsage(this.rollup, { sessionId, usage: turn, source: 'turn' });
        for (const tool of event.toolResults) {
          const usage = buildPiUsagePayload(tool.usage);
          if (usage)
            this.rollup = applyTurnUsage(this.rollup, { sessionId, usage, source: 'tool' });
        }
        const tokens = estimateContextTokens([event.message, ...event.toolResults]).tokens;
        const contextUsage = this.contextWindow
          ? {
              tokens,
              contextWindow: this.contextWindow,
              percent: (tokens / this.contextWindow) * 100,
            }
          : undefined;
        this.lastContextUsage = contextUsage;
        const payload = buildPiUsagePayload(
          event.message.usage,
          contextUsage,
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

  finish(result: Pick<RuntimeRunResult, 'success' | 'error' | 'stopReason'>): void {
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
      },
    });
    this.emit({
      type: 'session.status',
      sessionId: this.sink.sessionId,
      payload: { status: 'idle' },
    });
  }
}
