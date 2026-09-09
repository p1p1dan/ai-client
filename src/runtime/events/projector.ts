import {
  type AgentEvent,
  type AgentMessage,
  estimateContextTokens,
} from '@earendil-works/pi-agent-core';
import { applyTurnUsage, initTurnRollup, viewTurnRollup } from '../../shared/piTurnRollup.ts';
import { buildPiUsagePayload } from '../../shared/piUsage.ts';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import type { RuntimeRunResult } from '../contracts.ts';

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
function output(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'content' in result)
    return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  return result === undefined ? '' : JSON.stringify(result);
}

/** Adapt PiWorkerSession's projection to typed native AgentEvents; same wire DTOs. */
export class RuntimeEventProjector {
  private readonly sink: RuntimeEventSink;
  private readonly requestId: string;
  private assistant: string | undefined;
  private readonly toolMessages = new Map<string, string>();
  private index = 0;
  private prose = '';
  private thinking = '';
  private thinkingOpen = false;
  private rollup;
  private readonly contextWindow: number | undefined;
  constructor(
    sink: RuntimeEventSink,
    requestId: string,
    history: readonly AgentMessage[] = [],
    contextWindow?: number
  ) {
    this.sink = sink;
    this.contextWindow = contextWindow;
    this.requestId = requestId;
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
  private ensureAssistant(model?: string): string {
    if (!this.assistant) {
      this.assistant = `asst-${this.requestId}-${++this.index}`;
      this.prose = '';
      this.thinking = '';
      this.thinkingOpen = false;
      this.emit({
        type: 'message.started',
        sessionId: this.sink.sessionId,
        payload: { messageId: this.assistant, role: 'assistant', ...(model ? { model } : {}) },
      });
    }
    return this.assistant;
  }
  private deltas(message: AgentMessage): void {
    if (message.role !== 'assistant') return;
    const messageId = this.ensureAssistant(`${message.provider}/${message.model}`);
    const prose = text(message.content);
    const thinking = message.content
      .filter((block) => block.type === 'thinking')
      .map((block) => block.thinking)
      .join('');
    // Pi native events carry cumulative snapshots. Equal or stale snapshots
    // contribute nothing; final message_end flushes providers without deltas.
    if (thinking.startsWith(this.thinking) && thinking.length > this.thinking.length) {
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
        payload: {
          messageId,
          blockId: `${messageId}-thinking`,
          text: thinking.slice(this.thinking.length),
        },
      });
      this.thinking = thinking;
    }
    if (prose.startsWith(this.prose) && prose.length > this.prose.length) {
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
        payload: { messageId, blockId: `${messageId}-text`, text: prose.slice(this.prose.length) },
      });
      this.prose = prose;
    }
  }
  private closeAssistant(completed = true): void {
    if (!this.assistant) return;
    const messageId = this.assistant;
    if (this.thinkingOpen)
      this.emit({
        type: 'thinking.completed',
        sessionId: this.sink.sessionId,
        payload: { messageId, blockId: `${messageId}-thinking` },
      });
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
          const messageId = `user-${this.requestId}-${++this.index}`;
          this.emit({ type: 'message.started', sessionId, payload: { messageId, role: 'user' } });
          const value = text(event.message.content);
          if (value)
            this.emit({
              type: 'message.delta',
              sessionId,
              payload: { messageId, blockId: `${messageId}-text`, text: value },
            });
          this.emit({ type: 'message.completed', sessionId, payload: { messageId } });
        } else if (event.message.role === 'assistant')
          this.ensureAssistant(`${event.message.provider}/${event.message.model}`);
        break;
      case 'message_update':
        this.deltas(event.message);
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          this.deltas(event.message);
          this.closeAssistant(['stop', 'length', 'toolUse'].includes(event.message.stopReason));
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
            ...(line ? { status: line.slice(0, 120) } : {}),
          },
        });
        break;
      }
      case 'tool_execution_end':
        this.emit({
          type: 'tool.completed',
          sessionId,
          payload: {
            messageId: this.toolMessages.get(event.toolCallId) ?? this.ensureAssistant(),
            toolCallId: event.toolCallId,
            ok: !event.isError,
            output: output(event.result),
            ...(event.isError ? { error: output(event.result) || 'Tool call failed' } : {}),
          },
        });
        this.toolMessages.delete(event.toolCallId);
        break;
      case 'turn_end': {
        if (event.message.role !== 'assistant') break;
        this.closeAssistant();
        const turn = buildPiUsagePayload(event.message.usage);
        if (turn)
          this.rollup = applyTurnUsage(this.rollup, { sessionId, usage: turn, source: 'turn' });
        for (const tool of event.toolResults) {
          const usage = buildPiUsagePayload(tool.usage);
          if (usage)
            this.rollup = applyTurnUsage(this.rollup, { sessionId, usage, source: 'tool' });
        }
        const tokens = estimateContextTokens([event.message, ...event.toolResults]).tokens;
        const payload = buildPiUsagePayload(
          event.message.usage,
          this.contextWindow
            ? {
                tokens,
                contextWindow: this.contextWindow,
                percent: (tokens / this.contextWindow) * 100,
              }
            : undefined,
          viewTurnRollup(this.rollup)
        );
        if (payload) this.emit({ type: 'usage.updated', sessionId, payload });
        break;
      }
    }
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
      payload: { ...(result.error ? { error: result.error.message } : {}) },
    });
    this.emit({
      type: 'session.status',
      sessionId: this.sink.sessionId,
      payload: { status: 'idle' },
    });
  }
}
