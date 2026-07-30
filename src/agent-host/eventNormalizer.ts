/**
 * Convert Claude Agent SDK messages into stable AiClient Runtime Events.
 * Unknown shapes are logged and skipped (Host must not crash).
 */

export type EmitFn = (event: Record<string, unknown>) => void;
export type LogFn = (...args: unknown[]) => void;

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

export class EventNormalizer {
  private state = newState();
  private readonly sessionId: string;
  private readonly emit: EmitFn;
  private readonly log: LogFn;

  constructor(sessionId: string, emit: EmitFn, log: LogFn = () => undefined) {
    this.sessionId = sessionId;
    this.emit = emit;
    this.log = log;
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

  /**
   * Ingest one SDK message. Returns Claude runtime session_id when discovered.
   */
  ingest(raw: unknown, requestId?: string): string | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const msg = raw as {
      type?: string;
      subtype?: string;
      session_id?: string;
      message?: { content?: unknown; role?: string; model?: string };
      event?: {
        type?: string;
        delta?: { type?: string; text?: string; thinking?: string };
        content_block?: { type?: string; id?: string; name?: string; input?: unknown };
        index?: number;
      };
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

    try {
      switch (type) {
        case 'system': {
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
          }
          break;
        }
        case 'assistant': {
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
          if (thinking) this.emitThinkingDelta(thinking, requestId);
          if (text) this.emitTextDelta(text, requestId);
          for (const tool of extractToolUses(content)) {
            this.emitToolStarted(tool, requestId);
          }
          break;
        }
        case 'stream_event': {
          const ev = msg.event;
          if (!ev) break;
          if (ev.type === 'content_block_start' && ev.content_block) {
            const block = ev.content_block;
            if (block.type === 'tool_use' && block.id && block.name) {
              this.emitToolStarted(
                { id: block.id, name: block.name, input: block.input },
                requestId
              );
            }
            if (block.type === 'thinking') {
              this.ensureAssistant(requestId);
            }
            if (block.type === 'text') {
              this.ensureAssistant(requestId);
            }
          }
          if (ev.type === 'content_block_delta' && ev.delta) {
            if (ev.delta.type === 'text_delta' && ev.delta.text) {
              this.emitTextDelta(ev.delta.text, requestId);
            }
            if (
              (ev.delta.type === 'thinking_delta' || ev.delta.type === 'thinking') &&
              (ev.delta.thinking || ev.delta.text)
            ) {
              this.emitThinkingDelta(ev.delta.thinking ?? ev.delta.text ?? '', requestId);
            }
          }
          break;
        }
        case 'user': {
          const content = msg.message?.content;
          for (const result of extractToolResults(content)) {
            this.emitToolCompleted(result.toolUseId, !result.isError, result.content, requestId);
          }
          // Some SDK builds put structured output on tool_use_result
          if (msg.tool_use_result != null && Array.isArray(content)) {
            for (const result of extractToolResults(content)) {
              // already emitted above
              void result;
            }
          }
          break;
        }
        case 'tool_progress': {
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
