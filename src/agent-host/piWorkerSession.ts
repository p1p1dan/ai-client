import { parsePiModelRef } from '../shared/piModelConfig.ts';
import type { SessionAttachment, SessionEffortLevel } from '../shared/types/agentHost.ts';
import type { ExtensionUiResponse, RuntimeEventDraft } from '../shared/types/runtimeEvents.ts';
import type {
  WorkerBootstrapPayload,
  WorkerBootstrapResult,
  WorkerSendPayload,
  WorkerSendResult,
  WorkerStopPayload,
  WorkerStopResult,
} from '../shared/types/workerRpc.ts';
import {
  createPortableExtensionUiBridge,
  type PortableExtensionUiBridge,
} from './extensionUiBridge.ts';
import type { PermissionPluginDecision } from './permissionPlugin.ts';
import {
  bootstrapPiAgentSession,
  type PiModel,
  type PiRuntimeHandle,
  type PiSdkModule,
  type PiSession,
} from './piAgentSessionBootstrap.ts';

interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

interface PiPromptOptions {
  images?: PiImageContent[];
}

export interface PiAgentEvent {
  type: string;
  [key: string]: unknown;
}

interface TurnProjection {
  assistantMessageId: string | null;
  textBlockId: string | null;
  thinkingBlockId: string | null;
  textSnapshot: string;
  thinkingSnapshot: string;
  thinkingStarted: boolean;
  thinkingCompleted: boolean;
  proseClosed: boolean;
}

interface ActiveTurn {
  token: number;
  requestId: string;
  attemptId: string;
  userText: string;
  attachmentMetadata: Array<{ kind: 'image' | 'text'; mediaType: string; name?: string }>;
  stopRequested: boolean;
  terminal: boolean;
  pendingError: string | null;
  projection: TurnProjection;
}

export interface PiWorkerSessionOptions extends WorkerBootstrapPayload {
  projectTrusted: boolean;
  emit: (event: RuntimeEventDraft) => void;
  loadSdk?: () => Promise<unknown>;
  decidePermissionGate?: (packages: unknown[]) => PermissionPluginDecision;
  log?: (...args: unknown[]) => void;
}

export class PiWorkerSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'PiWorkerSessionError';
  }
}

function selectedModel(handle: PiRuntimeHandle): string | undefined {
  const model = handle.session.model;
  return model ? `${model.provider}/${model.id}` : undefined;
}

function newProjection(): TurnProjection {
  return {
    assistantMessageId: null,
    textBlockId: null,
    thinkingBlockId: null,
    textSnapshot: '',
    thinkingSnapshot: '',
    thinkingStarted: false,
    thinkingCompleted: false,
    proseClosed: false,
  };
}

function readToolOutput(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'content' in result) {
    const content = (result as { content: unknown }).content;
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
  return result === undefined ? '' : JSON.stringify(result);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (typeof part === 'object' && part !== null && 'type' in part) {
      const typed = part as { type: string; text?: string };
      if (typed.type === 'text' && typed.text) return typed.text;
    }
  }
  return undefined;
}

function extractAllTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null || !('type' in part)) return '';
      const typed = part as { type: unknown; text?: unknown };
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

type StreamUpdateSource = 'delta' | 'snapshot';

function takeStreamUpdate(
  previous: string,
  update: string,
  source: StreamUpdateSource
): { chunk: string; cumulative: string } {
  if (!update) return { chunk: '', cumulative: previous };
  if (source === 'delta') return { chunk: update, cumulative: previous + update };
  if (!previous) return { chunk: update, cumulative: update };
  if (update === previous || previous.startsWith(update)) {
    return { chunk: '', cumulative: previous };
  }
  if (update.startsWith(previous)) {
    return { chunk: update.slice(previous.length), cumulative: update };
  }

  const maxOverlap = Math.min(previous.length, Math.max(0, update.length - 1), 64);
  for (let length = maxOverlap; length >= 2; length -= 1) {
    if (previous.endsWith(update.slice(0, length))) {
      return { chunk: update.slice(length), cumulative: previous + update.slice(length) };
    }
  }
  return { chunk: update, cumulative: previous + update };
}

const CUSTOM_TIMELINE_CONTENT_MAX = 16_000;

function sanitizeCustomValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (depth > 8) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeCustomValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = sanitizeCustomValue(item, depth + 1, seen);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

function serializeCustomValue(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(sanitizeCustomValue(value), null, 2) ?? '';
  } catch {
    return '[unserializable value]';
  }
}

function customTimelineContent(content: unknown, details: unknown): string {
  const text = extractAllTextContent(content);
  const serialized = serializeCustomValue(details);
  const combined = serialized
    ? `${text ? `${text}\n\n` : ''}\`\`\`json\n${serialized}\n\`\`\``
    : text;
  if (combined.length <= CUSTOM_TIMELINE_CONTENT_MAX) return combined;
  return `${combined.slice(0, CUSTOM_TIMELINE_CONTENT_MAX)}\n[truncated]`;
}

export function buildPiWorkerPrompt(
  text: string,
  attachments: SessionAttachment[] | undefined
): { text: string; options?: PiPromptOptions } {
  if (!attachments?.length) return { text };
  const images: PiImageContent[] = [];
  const documents: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      images.push({
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mediaType || 'image/png',
      });
    } else if (attachment.kind === 'text') {
      documents.push(`--- ${attachment.name ?? 'attachment'} ---\n${attachment.data}`);
    } else {
      throw new PiWorkerSessionError(
        'WORKER_UNSUPPORTED_ATTACHMENT',
        `Unsupported attachment kind for Pi: ${String((attachment as { kind: unknown }).kind)}`
      );
    }
  }
  return {
    text: documents.length ? [text, ...documents].filter(Boolean).join('\n\n') : text,
    ...(images.length ? { options: { images } } : {}),
  };
}

/** One utility worker owns one Pi AgentSession and at most one active turn. */
export class PiWorkerSession {
  readonly logicalSessionId: string;
  readonly cwd: string;

  private readonly options: PiWorkerSessionOptions;
  private readonly extensionUi: PortableExtensionUiBridge;
  private bootstrapPromise: Promise<WorkerBootstrapResult> | null = null;
  private handle: PiRuntimeHandle | null = null;
  private unsubscribe: (() => void) | null = null;
  private activeTurn: ActiveTurn | null = null;
  private turnSequence = 0;
  private assistantSequence = 0;
  private customSequence = 0;
  private disposed = false;

  constructor(options: PiWorkerSessionOptions) {
    this.options = options;
    this.logicalSessionId = options.logicalSessionId;
    this.cwd = options.cwd;
    this.extensionUi = createPortableExtensionUiBridge({
      onRequest: (request) =>
        this.emit({
          type: 'extensionUi.request',
          sessionId: this.logicalSessionId,
          payload: {
            runtimeId: request.runtimeId,
            uiRequestId: request.uiRequestId,
            method: request.method,
            args: request.args,
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          },
        }),
      onCancel: (cancel) =>
        this.emit({
          type: 'extensionUi.cancelled',
          sessionId: this.logicalSessionId,
          payload: {
            runtimeId: cancel.runtimeId,
            uiRequestIds: cancel.uiRequestIds,
            reason: cancel.reason,
          },
        }),
      onReset: (reset) =>
        this.emit({
          type: 'extensionUi.reset',
          sessionId: this.logicalSessionId,
          payload: { runtimeId: reset.runtimeId, reason: reset.reason },
        }),
    });
  }

  bootstrap(): Promise<WorkerBootstrapResult> {
    if (this.disposed) {
      return Promise.reject(
        new PiWorkerSessionError('WORKER_SESSION_DISPOSED', 'Pi worker session is disposed')
      );
    }
    if (!this.bootstrapPromise) this.bootstrapPromise = this.bootstrapInternal();
    return this.bootstrapPromise;
  }

  async startSend(input: WorkerSendPayload): Promise<WorkerSendResult> {
    this.assertLogicalSession(input.logicalSessionId);
    if (this.disposed) {
      throw new PiWorkerSessionError('WORKER_SESSION_DISPOSED', 'Pi worker session is disposed');
    }
    if (this.activeTurn && !this.activeTurn.terminal) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        'Session already has an active turn',
        true
      );
    }

    await this.bootstrap();
    const handle = this.requireHandle();
    const prompt = buildPiWorkerPrompt(input.text, input.attachments);
    await this.applySelectedModel(handle, input.model);
    this.applyEffort(handle.session, input.effort);

    const turn: ActiveTurn = {
      token: ++this.turnSequence,
      requestId: input.requestId,
      attemptId: input.attemptId,
      userText: input.text,
      attachmentMetadata: (input.attachments ?? []).map((attachment) => ({
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        ...(attachment.name ? { name: attachment.name } : {}),
      })),
      stopRequested: false,
      terminal: false,
      pendingError: null,
      projection: newProjection(),
    };
    this.activeTurn = turn;
    this.unsubscribe?.();
    this.unsubscribe =
      handle.session.subscribe?.((event: PiAgentEvent) => {
        if (this.activeTurn !== turn || turn.terminal || this.disposed) return;
        this.projectEvent(turn, event);
      }) ?? null;

    this.emitStatus(turn, 'running');
    void this.runPrompt(turn, prompt).catch((error) => {
      this.options.log?.('Pi worker prompt failed:', error);
    });
    return { accepted: true, requestId: input.requestId };
  }

  async stop(input: WorkerStopPayload): Promise<WorkerStopResult> {
    this.assertLogicalSession(input.logicalSessionId);
    const turn = this.activeTurn;
    if (!turn || turn.terminal) return { stopped: false };

    turn.stopRequested = true;
    this.emitStatus(turn, 'stopping');
    this.extensionUi.cancelAll('aborted');
    const session = this.handle?.session;
    try {
      session?.clearQueue?.();
      session?.abortCompaction?.();
      session?.abortBranchSummary?.();
      session?.abortBash?.();
    } catch {
      // Helper aborts are best effort; AgentSession.abort remains authoritative.
    }
    try {
      await session?.abort();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finishTurn(turn, 'failed', `Failed to stop Pi session: ${message}`);
      throw new PiWorkerSessionError('WORKER_STOP_FAILED', `Failed to stop Pi session: ${message}`);
    }
    this.finishTurn(turn, 'stopped');
    return { stopped: true };
  }

  respondExtensionUi(response: ExtensionUiResponse): boolean {
    return this.extensionUi.respond(response);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    const turn = this.activeTurn;
    if (turn && !turn.terminal) {
      try {
        await this.stop({ logicalSessionId: this.logicalSessionId, reason: 'dispose' });
      } catch {
        // Continue process teardown even when abort itself reports a failure.
      }
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.extensionUi.dispose('host_shutdown');

    let handle = this.handle;
    if (!handle && this.bootstrapPromise) {
      try {
        await this.bootstrapPromise;
        handle = this.handle;
      } catch {
        // Failed bootstrap already disposed any partial runtime.
      }
    }
    this.handle = null;
    if (handle?.dispose) await handle.dispose();
    else handle?.session.dispose?.();
  }

  private async runPrompt(
    turn: ActiveTurn,
    prompt: { text: string; options?: PiPromptOptions }
  ): Promise<void> {
    try {
      await this.requireHandle().session.prompt?.(prompt.text, prompt.options);
    } catch (error) {
      if (turn.terminal || this.activeTurn !== turn) return;
      if (turn.stopRequested) this.finishTurn(turn, 'stopped');
      else this.finishTurn(turn, 'failed', error instanceof Error ? error.message : String(error));
    }
  }

  private projectEvent(turn: ActiveTurn, event: PiAgentEvent): void {
    const sessionId = this.logicalSessionId;
    const requestId = turn.requestId;
    const projection = turn.projection;

    switch (event.type) {
      case 'agent_start':
        projection.textSnapshot = '';
        projection.thinkingSnapshot = '';
        break;
      case 'agent_end': {
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const last = [...messages].reverse().find((message) => {
          return (
            typeof message === 'object' &&
            message !== null &&
            'role' in message &&
            message.role === 'assistant'
          );
        }) as { stopReason?: string; errorMessage?: string } | undefined;
        if (
          !event.willRetry &&
          last &&
          (last.stopReason === 'error' || last.stopReason === 'aborted')
        ) {
          turn.pendingError = last.errorMessage ?? `Model response ${last.stopReason}`;
        }
        break;
      }
      case 'agent_settled':
        if (turn.stopRequested) this.finishTurn(turn, 'stopped');
        else if (turn.pendingError) this.finishTurn(turn, 'failed', turn.pendingError);
        else this.finishTurn(turn, 'completed');
        break;
      case 'message_start': {
        const message = event.message as { role?: string; content?: unknown } | undefined;
        if (message?.role === 'user') {
          const messageId = `user-${sessionId}-${turn.token}`;
          this.emit({
            type: 'message.started',
            sessionId,
            requestId,
            payload: {
              messageId,
              role: 'user',
              attemptId: turn.attemptId,
              ...(turn.attachmentMetadata.length > 0
                ? { attachments: turn.attachmentMetadata }
                : {}),
            },
          });
          const text = turn.userText || extractTextContent(message.content) || '';
          if (text) {
            this.emit({
              type: 'message.delta',
              sessionId,
              requestId,
              payload: { messageId, blockId: `${messageId}-text`, text },
            });
          }
          this.emit({ type: 'message.completed', sessionId, requestId, payload: { messageId } });
        } else if (message?.role === 'assistant') {
          this.ensureAssistant(turn);
        }
        break;
      }
      case 'message_update': {
        const message = event.message as
          | { role?: string; content?: Array<{ type: string; text?: string; thinking?: string }> }
          | undefined;
        const update = event.assistantMessageEvent as
          | { type?: string; delta?: string; content?: string }
          | undefined;
        const fullText =
          message?.role === 'assistant' && Array.isArray(message.content)
            ? message.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text ?? '')
                .join('')
            : '';
        const fullThinking =
          message?.role === 'assistant' && Array.isArray(message.content)
            ? message.content
                .filter((part) => part.type === 'thinking')
                .map((part) => part.thinking ?? '')
                .join('')
            : '';

        let textUpdate: { value: string; source: StreamUpdateSource } | null = null;
        if (fullText) textUpdate = { value: fullText, source: 'snapshot' };
        else if (update?.type === 'text_delta' && update.delta) {
          textUpdate = { value: update.delta, source: 'delta' };
        } else if (update?.type === 'text_end' && update.content) {
          textUpdate = { value: update.content, source: 'snapshot' };
        }
        if (textUpdate) {
          const next = takeStreamUpdate(
            projection.textSnapshot,
            textUpdate.value,
            textUpdate.source
          );
          projection.textSnapshot = next.cumulative;
          this.emitTextDelta(turn, next.chunk);
        }

        let thinkingUpdate: { value: string; source: StreamUpdateSource } | null = null;
        if (fullThinking) thinkingUpdate = { value: fullThinking, source: 'snapshot' };
        else if (update?.type === 'thinking_delta' && update.delta) {
          thinkingUpdate = { value: update.delta, source: 'delta' };
        } else if (update?.type === 'thinking_end' && update.content) {
          thinkingUpdate = { value: update.content, source: 'snapshot' };
        }
        if (thinkingUpdate) {
          const next = takeStreamUpdate(
            projection.thinkingSnapshot,
            thinkingUpdate.value,
            thinkingUpdate.source
          );
          projection.thinkingSnapshot = next.cumulative;
          this.emitThinkingDelta(turn, next.chunk);
        }
        break;
      }
      case 'message_end': {
        const message = event.message as
          | {
              role?: string;
              stopReason?: string;
              errorMessage?: string;
              customType?: string;
              content?: unknown;
              display?: boolean;
              details?: unknown;
            }
          | undefined;
        if (message?.role === 'custom') {
          if (message.display === false || !message.customType) break;
          this.closeProseStream(turn);
          this.emit({
            type: 'custom.message',
            sessionId,
            requestId,
            payload: {
              messageId: this.nextCustomMessageId(turn),
              customType: message.customType,
              content: customTimelineContent(message.content, message.details),
            },
          });
          break;
        }
        if (message?.role !== 'assistant') break;
        const messageId = projection.proseClosed ? null : projection.assistantMessageId;
        if (messageId && ['stop', 'length', 'toolUse'].includes(message.stopReason ?? '')) {
          this.emit({
            type: 'message.completed',
            sessionId,
            requestId,
            payload: { messageId },
          });
        }
        if (
          !turn.stopRequested &&
          (message.stopReason === 'error' || message.stopReason === 'aborted')
        ) {
          turn.pendingError = message.errorMessage ?? `Model response ${message.stopReason}`;
        }
        this.closeProseStream(turn);
        break;
      }
      case 'entry_appended': {
        const entry = event.entry as
          | { type?: string; customType?: string; data?: unknown }
          | undefined;
        if (entry?.type !== 'custom' || !entry.customType) break;
        this.closeProseStream(turn);
        this.emit({
          type: 'custom.entry',
          sessionId,
          requestId,
          payload: {
            messageId: this.nextCustomMessageId(turn),
            customType: entry.customType,
            content: customTimelineContent(undefined, entry.data),
          },
        });
        break;
      }
      case 'tool_execution_start': {
        this.closeProseStream(turn);
        const messageId = this.ensureAssistant(turn);
        this.emit({
          type: 'tool.started',
          sessionId,
          requestId,
          payload: {
            messageId,
            toolCallId: String(event.toolCallId ?? ''),
            name: String(event.toolName ?? ''),
            input: event.args ?? {},
          },
        });
        break;
      }
      case 'tool_execution_update': {
        const messageId = projection.assistantMessageId ?? this.ensureAssistant(turn);
        this.emit({
          type: 'tool.updated',
          sessionId,
          requestId,
          payload: {
            messageId,
            toolCallId: String(event.toolCallId ?? ''),
            ...(event.args !== undefined ? { input: event.args } : {}),
          },
        });
        break;
      }
      case 'tool_execution_end': {
        const failed = event.isError === true;
        const output = readToolOutput(event.result);
        const messageId = projection.assistantMessageId ?? this.ensureAssistant(turn);
        this.emit({
          type: 'tool.completed',
          sessionId,
          requestId,
          payload: {
            messageId,
            toolCallId: String(event.toolCallId ?? ''),
            ok: !failed,
            output,
            ...(failed ? { error: output || 'Tool call failed' } : {}),
          },
        });
        break;
      }
      case 'auto_retry_start':
        this.emit({
          type: 'session.status',
          sessionId,
          requestId,
          payload: {
            status: 'running',
            retry: {
              attempt: numberOr(event.attempt, 0),
              maxRetries: numberOr(event.maxAttempts, 0),
              delayMs: numberOr(event.delayMs, 0),
              error: stringOr(event.errorMessage, ''),
              errorStatus: stringOrNull(event.errorStatus),
            },
          },
        });
        break;
      default:
        break;
    }
  }

  private ensureAssistant(turn: ActiveTurn): string {
    const projection = turn.projection;
    if (!projection.assistantMessageId) {
      const messageId = `asst-${this.logicalSessionId}-${Date.now()}-${++this.assistantSequence}`;
      projection.assistantMessageId = messageId;
      projection.textBlockId = `${messageId}-text`;
      projection.thinkingBlockId = `${messageId}-thinking`;
      projection.thinkingStarted = false;
      projection.thinkingCompleted = false;
      const model = this.handle?.session.model;
      this.emit({
        type: 'message.started',
        sessionId: this.logicalSessionId,
        requestId: turn.requestId,
        payload: {
          messageId,
          role: 'assistant',
          ...(model ? { model: `${model.provider}/${model.id}` } : {}),
        },
      });
    }
    return projection.assistantMessageId;
  }

  private openProseMessage(turn: ActiveTurn): string {
    const projection = turn.projection;
    if (projection.proseClosed) {
      projection.proseClosed = false;
      projection.assistantMessageId = null;
      projection.textBlockId = null;
      projection.thinkingBlockId = null;
      projection.thinkingStarted = false;
      projection.thinkingCompleted = false;
    }
    return this.ensureAssistant(turn);
  }

  private completeThinking(turn: ActiveTurn): void {
    const projection = turn.projection;
    if (!projection.thinkingStarted || projection.thinkingCompleted) return;
    if (!projection.assistantMessageId || !projection.thinkingBlockId) return;
    projection.thinkingCompleted = true;
    this.emit({
      type: 'thinking.completed',
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: {
        messageId: projection.assistantMessageId,
        blockId: projection.thinkingBlockId,
      },
    });
  }

  private closeProseStream(turn: ActiveTurn): void {
    this.completeThinking(turn);
    turn.projection.proseClosed = true;
    turn.projection.textSnapshot = '';
    turn.projection.thinkingSnapshot = '';
  }

  private emitTextDelta(turn: ActiveTurn, text: string): void {
    if (!text) return;
    this.completeThinking(turn);
    const messageId = this.openProseMessage(turn);
    this.emit({
      type: 'message.delta',
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: {
        messageId,
        blockId: turn.projection.textBlockId ?? `${messageId}-text`,
        text,
      },
    });
  }

  private emitThinkingDelta(turn: ActiveTurn, text: string): void {
    if (!text) return;
    const messageId = this.openProseMessage(turn);
    const blockId = turn.projection.thinkingBlockId ?? `${messageId}-thinking`;
    if (!turn.projection.thinkingStarted) {
      turn.projection.thinkingStarted = true;
      this.emit({
        type: 'thinking.started',
        sessionId: this.logicalSessionId,
        requestId: turn.requestId,
        payload: { messageId, blockId },
      });
    }
    this.emit({
      type: 'thinking.delta',
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: { messageId, blockId, text },
    });
  }

  private nextCustomMessageId(turn: ActiveTurn): string {
    this.customSequence += 1;
    return `custom-${this.logicalSessionId}-${turn.token}-${this.customSequence}`;
  }

  private finishTurn(
    turn: ActiveTurn,
    outcome: 'completed' | 'failed' | 'stopped',
    error?: string
  ): void {
    if (turn.terminal || this.activeTurn !== turn) return;
    turn.terminal = true;
    this.completeThinking(turn);
    this.emit({
      type: `session.${outcome}`,
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: outcome === 'failed' ? { error: error ?? 'Agent request failed' } : {},
    });
    this.emitStatus(turn, 'idle');
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.activeTurn = null;
  }

  private emitStatus(turn: ActiveTurn, status: 'running' | 'stopping' | 'idle'): void {
    this.emit({
      type: 'session.status',
      sessionId: this.logicalSessionId,
      requestId: turn.requestId,
      payload: { status },
    });
  }

  private async applySelectedModel(
    handle: PiRuntimeHandle,
    requestedModel: string | undefined
  ): Promise<void> {
    const selected = requestedModel?.trim();
    if (!selected) return;
    const ref = parsePiModelRef(selected);
    if (!ref)
      throw new PiWorkerSessionError('WORKER_INVALID_MODEL', `Invalid Pi model: ${selected}`);
    const model: PiModel | undefined = handle.services.modelRuntime.getModel(
      ref.provider,
      ref.modelId
    );
    if (!model)
      throw new PiWorkerSessionError('WORKER_MODEL_NOT_FOUND', `Pi model not found: ${selected}`);
    if (
      handle.session.model?.provider !== ref.provider ||
      handle.session.model?.id !== ref.modelId
    ) {
      if (!handle.session.setModel) {
        throw new PiWorkerSessionError(
          'WORKER_MODEL_UNSUPPORTED',
          'Pi session cannot change model'
        );
      }
      await handle.session.setModel(model, { persist: false });
    }
  }

  private applyEffort(session: PiSession, effort: SessionEffortLevel | undefined): void {
    if (!effort) return;
    if (!session.setThinkingLevel) {
      throw new PiWorkerSessionError(
        'WORKER_EFFORT_UNSUPPORTED',
        `This Pi SDK cannot apply reasoning effort "${effort}"`
      );
    }
    session.setThinkingLevel(effort, { persist: false });
  }

  private assertLogicalSession(sessionId: string): void {
    if (sessionId !== this.logicalSessionId) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_MISMATCH',
        `Worker owns ${this.logicalSessionId}, not ${sessionId}`
      );
    }
  }

  private requireHandle(): PiRuntimeHandle {
    if (!this.handle)
      throw new PiWorkerSessionError('WORKER_NOT_BOOTSTRAPPED', 'Worker is not bootstrapped');
    return this.handle;
  }

  private async bootstrapInternal(): Promise<WorkerBootstrapResult> {
    const sdk = (
      this.options.loadSdk
        ? await this.options.loadSdk()
        : await import('@earendil-works/pi-coding-agent')
    ) as PiSdkModule;
    const bootstrapped = await bootstrapPiAgentSession({
      sdk,
      cwd: this.cwd,
      projectTrusted: this.options.projectTrusted,
      extensionUi: this.extensionUi,
      sessionFile: this.options.sessionFile,
      model: this.options.model,
      effort: this.options.effort,
      decidePermissionGate: this.options.decidePermissionGate,
      log: this.options.log,
      onPermissionActivity: (payload) =>
        this.emit({ type: 'permission.activity', sessionId: this.logicalSessionId, payload }),
    });
    if (this.disposed) {
      if (bootstrapped.handle.dispose) await bootstrapped.handle.dispose();
      else bootstrapped.handle.session.dispose?.();
      throw new PiWorkerSessionError(
        'WORKER_SESSION_DISPOSED',
        'Pi worker session was disposed during bootstrap'
      );
    }
    this.handle = bootstrapped.handle;
    const model = selectedModel(bootstrapped.handle) ?? this.options.model;
    return {
      bootstrapped: true,
      logicalSessionId: this.logicalSessionId,
      piSessionId: bootstrapped.handle.session.sessionId,
      cwd: this.cwd,
      agentDir: bootstrapped.agentDir,
      ...(bootstrapped.handle.session.sessionFile
        ? { sessionFile: bootstrapped.handle.session.sessionFile }
        : {}),
      ...(model ? { model } : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      projectTrusted: bootstrapped.projectTrusted,
      permissionGate: bootstrapped.permissionGate,
    };
  }

  private emit(event: RuntimeEventDraft): void {
    if (!this.disposed) this.options.emit(event);
  }
}
