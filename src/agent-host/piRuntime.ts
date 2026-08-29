/**
 * Pi Runtime Adapter — @earendil-works/pi-coding-agent SDK.
 * Emits AiClient Runtime Events; no Electron deps.
 */

import { parsePiModelRef } from '../shared/piModelConfig.ts';
import type { SessionAttachment } from '../shared/types/agentHost.ts';
import { PI_AGENT } from '../shared/types/agentWire.ts';
import type { ExtensionUiResponse } from '../shared/types/runtimeEvents.ts';
import type { EmitFn, LogFn } from './eventNormalizer.ts';
import {
  createPortableExtensionUiBridge,
  type PortableExtensionUiBridge,
} from './extensionUiBridge.ts';
import type { HostSession, SessionRegistry } from './sessionRegistry.ts';

// ─── pi SDK type projections (lazy-imported, ESM-only) ───

interface PiSdkModule {
  createAgentSessionServices: (opts: Record<string, unknown>) => Promise<PiServices>;
  createAgentSessionFromServices: (
    opts: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  createAgentSessionRuntime: (
    factory: PiRuntimeFactory,
    opts: Record<string, unknown>
  ) => Promise<PiRuntimeHandle>;
  getAgentDir: () => string;
  SessionManager: {
    create: (cwd: string, sessionDir: string) => PiSessionMgr;
    open: (sessionFile: string, sessionDir: string, cwd: string) => PiSessionMgr;
    continueRecent: (cwd: string, sessionDir: string) => PiSessionMgr;
    inMemory: (cwd: string) => PiSessionMgr;
  };
  SettingsManager: {
    create: (cwd: string, agentDir: string, opts: { projectTrusted: boolean }) => unknown;
  };
}

interface PiModel {
  provider: string;
  id: string;
  name?: string;
}

interface PiServices {
  modelRuntime: { getModel: (provider: string, id: string) => PiModel | undefined };
  diagnostics?: unknown[];
  cwd: string;
  agentDir: string;
  [key: string]: unknown;
}

interface PiSessionMgr {
  [key: string]: unknown;
}

type PiRuntimeFactory = (ctx: {
  cwd: string;
  sessionManager: PiSessionMgr;
  sessionStartEvent?: unknown;
}) => Promise<Record<string, unknown> & { services: PiServices; diagnostics: unknown[] }>;

/**
 * T11 — the SDK's Extension UI injection point (`ExtensionBindings`).
 *
 * `mode: 'rpc'` means "not a TUI", NOT "run the SDK in a subprocess". We hold
 * the session object in-process (`createAgentSessionRuntime` below); the word is
 * the SDK's for "the UI lives somewhere that answers over a wire", which for us
 * is the renderer at the far end of the MessagePort.
 *
 * Optional because it is projected off a lazily-imported ESM module: an SDK
 * build without it must degrade to "no extension UI", never crash the Host.
 */
interface PiExtensionBindings {
  uiContext?: unknown;
  mode?: 'rpc' | 'tui';
  onError?: (error: unknown) => void;
}

interface PiSession {
  prompt: (text: string, opts?: Record<string, unknown>) => Promise<void>;
  subscribe: (callback: (event: PiAgentEvent) => void) => () => void;
  bindExtensions?: (bindings: PiExtensionBindings) => Promise<void>;
  abort: () => Promise<void>;
  abortCompaction?: () => void;
  abortBranchSummary?: () => void;
  abortBash?: () => void;
  clearQueue?: () => void;
  sessionId: string;
  sessionFile?: string;
  model?: PiModel;
  setModel: (model: PiModel, options?: { persist?: boolean }) => Promise<void>;
  [key: string]: unknown;
}

interface PiRuntimeHandle {
  session: PiSession;
  services: PiServices;
  setBeforeSessionInvalidate?: (fn: () => void) => void;
  [key: string]: unknown;
}

export interface PiAgentEvent {
  type: string;
  [key: string]: unknown;
}

// ─── PiAgentRuntime class ───

export interface PiAgentRuntimeOptions {
  emit: EmitFn;
  log?: LogFn;
  registry: SessionRegistry;
  /** Test seam; production lazy-imports the ESM-only Pi SDK. */
  loadSdk?: () => Promise<unknown>;
}

interface TurnState {
  assistantMessageId: string | null;
  textBlockId: string | null;
  thinkingBlockId: string | null;
  textSnapshot: string;
  thinkingSnapshot: string;
  thinkingStarted: boolean;
}

function newTurnState(): TurnState {
  return {
    assistantMessageId: null,
    textBlockId: null,
    thinkingBlockId: null,
    textSnapshot: '',
    thinkingSnapshot: '',
    thinkingStarted: false,
  };
}

export class PiAgentRuntime {
  private sdk: PiSdkModule | null = null;
  private handle: PiRuntimeHandle | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly log: LogFn;
  private readonly opts: PiAgentRuntimeOptions;
  private abortController: AbortController | null = null;
  private turn: TurnState = newTurnState();
  private readonly extensionUi: PortableExtensionUiBridge;
  /**
   * Who an extension UI request is attributed to.
   *
   * The SDK does not tell the bridge which session an extension spoke for — the
   * `ExtensionUIContext` is bound once per runtime and called by ordinary
   * function calls with no session argument. Since this Host holds ONE handle
   * (and therefore one session object) at a time, "the session whose turn is
   * running" is the honest answer rather than a guess. It is `undefined` during
   * extension INIT, which is correct: nothing was running yet, so the request
   * belongs to no session and the renderer shows it as app-level.
   */
  private currentSessionId: string | undefined;

  constructor(opts: PiAgentRuntimeOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...args) => console.error('[pi-runtime]', ...args));
    // Built in the constructor, not in `ensureHandle`: `respondExtensionUi` must
    // be answerable the moment the Host is up, and extensions emit UI calls
    // during bind — i.e. before any handle exists to hang the bridge off.
    this.extensionUi = createPortableExtensionUiBridge({
      onRequest: (request) => {
        this.opts.emit({
          type: 'extensionUi.request',
          ...(this.currentSessionId ? { sessionId: this.currentSessionId } : {}),
          payload: {
            runtimeId: request.runtimeId,
            uiRequestId: request.uiRequestId,
            method: request.method,
            args: request.args,
            ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
          },
        });
      },
      onCancel: (cancel) => {
        this.opts.emit({
          type: 'extensionUi.cancelled',
          ...(this.currentSessionId ? { sessionId: this.currentSessionId } : {}),
          payload: {
            runtimeId: cancel.runtimeId,
            uiRequestIds: cancel.uiRequestIds,
            reason: cancel.reason,
          },
        });
      },
    });
  }

  /**
   * Route one renderer answer to its parked dialog. `false` = it settled
   * nothing: wrong bridge instance, already answered, or already timed out.
   * All three are ordinary races, so the caller reports rather than throws.
   */
  respondExtensionUi(response: ExtensionUiResponse): boolean {
    return this.extensionUi.respond(response);
  }

  private async ensureSdk(): Promise<PiSdkModule> {
    if (this.sdk) return this.sdk;
    const mod = this.opts.loadSdk
      ? await this.opts.loadSdk()
      : await import('@earendil-works/pi-coding-agent');
    this.sdk = mod as PiSdkModule;
    return this.sdk;
  }

  private async ensureHandle(workspacePath: string): Promise<PiRuntimeHandle> {
    if (this.handle) return this.handle;

    const sdk = await this.ensureSdk();
    const agentDir = sdk.getAgentDir();
    const sessionDir = `${agentDir}/sessions`;
    const sessionManager = sdk.SessionManager.create(workspacePath, sessionDir);

    const createRuntime: PiRuntimeFactory = async ({ cwd, sessionManager: sm }) => {
      const settingsManager = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      const services = await sdk.createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
      });
      return {
        ...(await sdk.createAgentSessionFromServices({ services, sessionManager: sm })),
        services,
        diagnostics: services.diagnostics ?? [],
      };
    };

    const handle = await sdk.createAgentSessionRuntime(createRuntime, {
      cwd: workspacePath,
      agentDir,
      sessionManager,
    });

    // The session object is replaced on reload / fork / switch, and the
    // extensions bound to the OLD one are gone with it. Draining here — before
    // the swap, which is what this SDK hook is for — is what stops an extension
    // from awaiting a dialog whose owner no longer exists.
    handle.setBeforeSessionInvalidate?.(() => {
      this.extensionUi.reload();
    });

    await this.bindExtensionUi(handle);

    this.handle = handle;
    return handle;
  }

  /**
   * Hand the portable UI context to the SDK.
   *
   * Non-fatal by design: a session with no extension UI still answers prompts,
   * whereas a Host that refuses to start because one extension failed to bind
   * leaves the user with nothing. The failure is surfaced as a `host.error` the
   * renderer can show, not swallowed.
   */
  private async bindExtensionUi(handle: PiRuntimeHandle): Promise<void> {
    if (typeof handle.session.bindExtensions !== 'function') {
      this.log('pi SDK has no bindExtensions(); extension UI is unavailable');
      return;
    }
    try {
      await handle.session.bindExtensions({
        uiContext: this.extensionUi.uiContext,
        mode: 'rpc',
        onError: (error) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.log(`extension error: ${detail}`);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`bindExtensions failed: ${message}`);
      this.opts.emit({
        type: 'host.error',
        payload: { code: 'extension_bind_failed', message, fatal: false },
      });
    }
  }

  private bindEvents(sessionId: string, session: PiSession, requestId?: string): void {
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event: PiAgentEvent) => {
      this.projectEvent(sessionId, event, requestId);
    });
  }

  private async applySelectedModel(
    handle: PiRuntimeHandle,
    session: HostSession,
    requestedModel: string | undefined
  ): Promise<void> {
    const selected = requestedModel?.trim() || session.model?.trim();
    if (!selected) return;
    const ref = parsePiModelRef(selected);
    if (!ref) {
      throw new Error(`Invalid Pi model reference: ${selected}. Expected provider/model`);
    }
    const model = handle.services.modelRuntime.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`Pi model not found: ${selected}`);
    if (
      handle.session.model?.provider !== ref.provider ||
      handle.session.model?.id !== ref.modelId
    ) {
      await handle.session.setModel(model, { persist: false });
    }
    session.model = selected;
  }

  private ensureAssistant(sessionId: string, requestId?: string): string {
    if (!this.turn.assistantMessageId) {
      this.turn.assistantMessageId = `asst-${sessionId}-${Date.now()}`;
      this.turn.textBlockId = `${this.turn.assistantMessageId}-text`;
      this.turn.thinkingBlockId = `${this.turn.assistantMessageId}-thinking`;
      this.turn.textSnapshot = '';
      this.turn.thinkingSnapshot = '';
      this.turn.thinkingStarted = false;

      const model = this.handle?.session?.model;
      this.opts.emit({
        type: 'message.started',
        sessionId,
        requestId,
        payload: {
          messageId: this.turn.assistantMessageId,
          role: 'assistant',
          ...(model ? { model: `${model.provider}/${model.id}` } : {}),
        },
      });
    }
    return this.turn.assistantMessageId;
  }

  private emitTextDelta(sessionId: string, text: string, requestId?: string): void {
    if (!text) return;
    const messageId = this.ensureAssistant(sessionId, requestId);
    this.opts.emit({
      type: 'message.delta',
      sessionId,
      requestId,
      payload: { messageId, blockId: this.turn.textBlockId, text },
    });
  }

  private emitThinkingDelta(sessionId: string, text: string, requestId?: string): void {
    if (!text) return;
    const messageId = this.ensureAssistant(sessionId, requestId);
    if (!this.turn.thinkingStarted) {
      this.turn.thinkingStarted = true;
      this.opts.emit({
        type: 'thinking.started',
        sessionId,
        requestId,
        payload: { messageId, blockId: this.turn.thinkingBlockId },
      });
    }
    this.opts.emit({
      type: 'thinking.delta',
      sessionId,
      requestId,
      payload: { messageId, blockId: this.turn.thinkingBlockId, text },
    });
  }

  private projectEvent(sessionId: string, event: PiAgentEvent, requestId?: string): void {
    const emit = this.opts.emit;

    switch (event.type) {
      case 'agent_start':
        this.turn = newTurnState();
        emit({
          type: 'session.status',
          sessionId,
          requestId,
          payload: { status: 'running' },
        });
        break;

      case 'agent_settled':
        emit({
          type: 'session.completed',
          sessionId,
          requestId,
          payload: {},
        });
        emit({
          type: 'session.status',
          sessionId,
          requestId,
          payload: { status: 'idle' },
        });
        break;

      case 'message_start': {
        const msg = event.message as { role?: string; content?: unknown } | undefined;
        if (msg?.role === 'user') {
          const userMsgId = `user-${sessionId}-${Date.now()}`;
          const userBlockId = `${userMsgId}-text`;
          emit({
            type: 'message.started',
            sessionId,
            requestId,
            payload: { messageId: userMsgId, role: 'user' },
          });
          const text = extractTextContent(msg.content) ?? '';
          if (text) {
            emit({
              type: 'message.delta',
              sessionId,
              requestId,
              payload: { messageId: userMsgId, blockId: userBlockId, text },
            });
          }
          emit({
            type: 'message.completed',
            sessionId,
            requestId,
            payload: { messageId: userMsgId },
          });
        } else if (msg?.role === 'assistant') {
          this.ensureAssistant(sessionId, requestId);
        }
        break;
      }

      case 'message_update': {
        const msg = event.message as
          | {
              role?: string;
              content?: Array<{ type: string; text?: string; thinking?: string }> | string;
            }
          | undefined;
        const ame = event.assistantMessageEvent as
          | { type?: string; delta?: string; content?: string }
          | undefined;

        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
          const fullText = msg.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text || '')
            .join('');
          if (fullText.length > this.turn.textSnapshot.length) {
            const chunk = fullText.slice(this.turn.textSnapshot.length);
            this.turn.textSnapshot = fullText;
            this.emitTextDelta(sessionId, chunk, requestId);
          }

          const fullThinking = msg.content
            .filter((c) => c.type === 'thinking')
            .map((c) => c.thinking || '')
            .join('');
          if (fullThinking.length > this.turn.thinkingSnapshot.length) {
            const chunk = fullThinking.slice(this.turn.thinkingSnapshot.length);
            this.turn.thinkingSnapshot = fullThinking;
            this.emitThinkingDelta(sessionId, chunk, requestId);
          }
        } else if (ame) {
          if (ame.type === 'text_delta' && typeof ame.delta === 'string' && ame.delta) {
            this.turn.textSnapshot += ame.delta;
            this.emitTextDelta(sessionId, ame.delta, requestId);
          } else if (ame.type === 'text_end' && typeof ame.content === 'string' && ame.content) {
            if (ame.content.length > this.turn.textSnapshot.length) {
              const chunk = ame.content.slice(this.turn.textSnapshot.length);
              this.turn.textSnapshot = ame.content;
              this.emitTextDelta(sessionId, chunk, requestId);
            }
          } else if (ame.type === 'thinking_delta' && typeof ame.delta === 'string' && ame.delta) {
            this.turn.thinkingSnapshot += ame.delta;
            this.emitThinkingDelta(sessionId, ame.delta, requestId);
          } else if (
            ame.type === 'thinking_end' &&
            typeof ame.content === 'string' &&
            ame.content
          ) {
            if (ame.content.length > this.turn.thinkingSnapshot.length) {
              const chunk = ame.content.slice(this.turn.thinkingSnapshot.length);
              this.turn.thinkingSnapshot = ame.content;
              this.emitThinkingDelta(sessionId, chunk, requestId);
            }
          }
        }
        break;
      }

      case 'message_end': {
        const msg = event.message as
          | { role?: string; stopReason?: string; errorMessage?: string }
          | undefined;
        if (msg?.role !== 'assistant') break;

        const messageId = this.turn.assistantMessageId;
        if (
          msg.stopReason === 'stop' ||
          msg.stopReason === 'length' ||
          msg.stopReason === 'toolUse'
        ) {
          emit({
            type: 'message.completed',
            sessionId,
            requestId,
            payload: { messageId, reason: msg.stopReason },
          });
        } else if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
          emit({
            type: 'session.failed',
            sessionId,
            requestId,
            payload: {
              error: msg.errorMessage ?? `Model response ${msg.stopReason}`,
            },
          });
        }
        this.turn.textSnapshot = '';
        this.turn.thinkingSnapshot = '';
        break;
      }

      case 'tool_execution_start': {
        const messageId = this.ensureAssistant(sessionId, requestId);
        emit({
          type: 'tool.started',
          sessionId,
          requestId,
          payload: {
            messageId,
            toolCallId: event.toolCallId as string,
            name: event.toolName as string,
            input: event.args ?? {},
          },
        });
        break;
      }

      case 'tool_execution_end': {
        const result = event.result as unknown;
        let output = '';
        if (typeof result === 'string') {
          output = result;
        } else if (result && typeof result === 'object' && 'content' in result) {
          const content = (result as { content: unknown }).content;
          output = typeof content === 'string' ? content : JSON.stringify(content);
        } else if (result !== undefined) {
          output = JSON.stringify(result);
        }
        emit({
          type: 'tool.completed',
          sessionId,
          requestId,
          payload: {
            messageId: this.turn.assistantMessageId,
            toolCallId: event.toolCallId as string,
            name: event.toolName as string,
            output,
            isError: (event.isError as boolean) ?? false,
          },
        });
        break;
      }

      case 'auto_retry_start':
        emit({
          type: 'session.status',
          sessionId,
          requestId,
          payload: {
            status: 'running',
            retry: {
              attempt: (event.attempt as number) ?? 0,
              maxRetries: (event.maxAttempts as number) ?? 0,
              delayMs: (event.delayMs as number) ?? 0,
              errorMessage: (event.errorMessage as string) ?? '',
            },
          },
        });
        break;

      default:
        break;
    }
  }

  createSession(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    requestId?: string;
  }): void {
    const session = this.opts.registry.create({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      agent: PI_AGENT,
      model: input.model,
    });
    this.opts.emit({
      type: 'session.created',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { agent: PI_AGENT },
    });
    this.opts.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'idle' },
    });
  }

  resumeSession(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    model?: string;
    requestId?: string;
  }): void {
    const current = this.opts.registry.get(input.sessionId);
    if (current?.running) {
      this.opts.emit({
        type: 'host.error',
        sessionId: input.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'session_busy',
          message: `Cannot resume while a turn is running: ${input.sessionId}`,
          fatal: false,
        },
      });
      return;
    }
    const session = this.opts.registry.resume({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      runtimeIdentity: input.runtimeIdentity,
      agent: PI_AGENT,
      model: input.model,
    });
    this.opts.emit({
      type: 'session.resumed',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: {
        agent: PI_AGENT,
        runtimeIdentity: session.runtimeIdentity,
      },
    });
    this.opts.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'idle' },
    });
  }

  async send(input: {
    sessionId: string;
    text: string;
    attachments?: SessionAttachment[];
    model?: string;
    requestId?: string;
  }): Promise<void> {
    const session = this.opts.registry.get(input.sessionId);
    if (!session) {
      this.opts.emit({
        type: 'host.error',
        requestId: input.requestId,
        payload: {
          code: 'session_not_found',
          message: `Unknown session: ${input.sessionId}`,
          fatal: false,
        },
      });
      return;
    }
    if (session.running) {
      this.opts.emit({
        type: 'host.error',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'session_busy',
          message: 'Session already has an active turn',
          fatal: false,
        },
      });
      return;
    }

    session.running = true;
    session.status = 'running';
    this.opts.registry.setStatus(session.sessionId, 'running');
    this.abortController = new AbortController();
    // Set BEFORE the handle is built: extensions emit UI calls during bind, and
    // this is the session that caused the bind to happen.
    this.currentSessionId = session.sessionId;

    this.opts.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'running' },
    });

    try {
      const handle = await this.ensureHandle(session.workspacePath);
      await this.applySelectedModel(handle, session, input.model);
      this.bindEvents(session.sessionId, handle.session, input.requestId);

      if (handle.session.sessionFile && !session.runtimeIdentity) {
        session.runtimeIdentity = handle.session.sessionFile;
      }

      await handle.session.prompt(input.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.abortController?.signal.aborted) {
        this.opts.emit({
          type: 'session.stopped',
          sessionId: session.sessionId,
          requestId: input.requestId,
          payload: {},
        });
      } else {
        this.log(`send failed for ${session.sessionId}: ${message}`);
        this.opts.emit({
          type: 'session.failed',
          sessionId: session.sessionId,
          requestId: input.requestId,
          payload: { error: message },
        });
      }
    } finally {
      session.running = false;
      session.status = 'idle';
      this.opts.registry.setStatus(session.sessionId, 'idle');
      this.abortController = null;
      this.opts.emit({
        type: 'session.status',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: { status: 'idle' },
      });
    }
  }

  stop(sessionId: string): void {
    const session = this.opts.registry.get(sessionId);
    if (!session?.running) return;

    this.abortController?.abort();

    if (this.handle?.session) {
      try {
        this.handle.session.abortCompaction?.();
        this.handle.session.abortBranchSummary?.();
        this.handle.session.abortBash?.();
      } catch {
        /* best-effort */
      }
      void this.handle.session.abort().catch(() => undefined);
    }
  }

  closeSession(sessionId: string, _requestId?: string): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    // The dialogs parked for this session can never be answered now — its UI is
    // gone. Draining them lets any extension still awaiting one finish with its
    // fallback instead of hanging until the Host exits.
    if (this.currentSessionId === sessionId) {
      this.extensionUi.reload();
      this.currentSessionId = undefined;
    }
    this.opts.registry.delete(sessionId);
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.extensionUi.dispose();
    this.currentSessionId = undefined;
    this.handle = null;
    this.sdk = null;
  }
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null && 'type' in part) {
        const typed = part as { type: string; text?: string };
        if (typed.type === 'text' && typed.text) return typed.text;
      }
    }
  }
  return undefined;
}
