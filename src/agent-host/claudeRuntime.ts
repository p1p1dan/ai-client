/**
 * Claude Runtime Adapter — Agent SDK (default) over pinned Cometix cli.js.
 * Emits AiClient Runtime Events via EventNormalizer; no Electron deps.
 */

import type {
  AgentHostDriver,
  SessionAttachment,
  SessionEffortLevel,
} from '../shared/types/agentHost.ts';
import { type EmitFn, EventNormalizer, type LogFn } from './eventNormalizer.ts';
import { type HistoryReadResult, readSessionHistory } from './historyReader.ts';
import { PermissionBridge } from './permissionBridge.ts';
import { QuestionBridge, type QuestionRespondInput } from './questionBridge.ts';
import type { SessionRegistry } from './sessionRegistry.ts';

export interface ClaudeRuntimeOptions {
  driver: AgentHostDriver;
  cliPath: string;
  /** Merged process + ~/.claude/settings.json env for SDK child. */
  env: NodeJS.ProcessEnv;
  emit: EmitFn;
  log?: LogFn;
  registry: SessionRegistry;
  /** Test seam — replaces the lazily imported Agent SDK query(). */
  queryFn?: SdkQueryFn;
}

type SdkQueryFn = (params: {
  prompt: string | AsyncIterable<Record<string, unknown>>;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown> & { close?: () => void };

/**
 * C-13: attachments ride as content blocks inside a single-message stream
 * (query() accepts AsyncIterable<SDKUserMessage>; plain sends keep the
 * string prompt path untouched). Shapes verified by c13-attachment-probe.
 */
function buildPromptWithAttachments(
  text: string,
  attachments: SessionAttachment[]
): AsyncIterable<Record<string, unknown>> {
  const content: Record<string, unknown>[] = [];
  if (text) content.push({ type: 'text', text });
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mediaType,
          data: attachment.data,
        },
      });
    } else {
      content.push({
        type: 'document',
        source: {
          type: 'text',
          media_type: attachment.mediaType || 'text/plain',
          data: attachment.data,
        },
        ...(attachment.name ? { title: attachment.name } : {}),
      });
    }
  }
  return (async function* oneUserMessage() {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
  })();
}

/**
 * C-14 stall watchdog default: a turn whose SDK stream produces no events at
 * all for this long is aborted with an explicit session.failed (invalid model
 * and gateway hangs otherwise leave the UI in `running` forever). Waiting on
 * a permission/question prompt or an in-flight local tool never counts as a
 * stall. 0 (or negative) disables the watchdog.
 */
const DEFAULT_STALL_TIMEOUT_MS = 120_000;

function resolveStallTimeoutMs(): number {
  const raw = process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_STALL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_STALL_TIMEOUT_MS;
  return parsed;
}

/**
 * #8 (2026-07-27): thinking config sent to query().
 *
 * `display` is the load-bearing field. On Opus 4.8/4.7, Sonnet 5 and Fable 5 it
 * defaults to `omitted`, which streams thinking blocks whose text is an empty
 * string — that, not any broken code link, is why T-04's thinking card had
 * nothing to render. `summarized` puts real text on the wire.
 *
 * Evidence — spikes/c16-thinking-shape-probe.ts on the CCH gateway,
 * model claude-opus-4-8[1m], cometix 2.1.212 / SDK 0.3.218:
 *   {type:'adaptive'}                        → 1 thinking block, text length 0
 *   {type:'adaptive', display:'summarized'}  → 1 thinking block, text length 408
 * The summarized runs also emit system/thinking_tokens events (8–9 per turn)
 * that the bare-adaptive runs never produced.
 *
 * `adaptive` (not the previous `{type:'enabled', budgetTokens}`) is the shape
 * current models actually document: the fixed-budget form is deprecated on
 * Opus 4.6/Sonnet 4.6 and removed on Opus 4.8/4.7, Sonnet 5 and Fable 5, so it
 * is a latent 400 the moment the gateway stops tolerating it. NOTE: the same
 * probe found the old shape still returns 200 on this gateway today, so it was
 * NOT the cause of the C-14 "400 thinking 格式无效" transient — that stays open.
 */
const THINKING_CONFIG = { type: 'adaptive', display: 'summarized' } as const;

const EFFORT_LEVELS: readonly SessionEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/**
 * Guard the protocol boundary: `effort` arrives as untrusted JSON from Main, and
 * an unknown value would be forwarded verbatim into query() and rejected by the
 * API. Drop it instead so the turn still runs at the model default.
 */
export function normalizeEffort(value: unknown): SessionEffortLevel | undefined {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as SessionEffortLevel)
    : undefined;
}

export class ClaudeRuntime {
  private queryFn: SdkQueryFn | null = null;
  private readonly log: LogFn;
  private readonly opts: ClaudeRuntimeOptions;
  private readonly permissions: PermissionBridge;
  private readonly questions: QuestionBridge;

  constructor(opts: ClaudeRuntimeOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...args) => console.error('[claude-runtime]', ...args));
    this.permissions = new PermissionBridge(opts.emit, this.log);
    this.questions = new QuestionBridge(opts.emit, this.log);
  }

  get driver(): AgentHostDriver {
    return this.opts.driver;
  }

  /** Lazy-load Agent SDK query export. */
  private async ensureSdk(): Promise<SdkQueryFn> {
    if (this.opts.driver !== 'agent-sdk') {
      throw new Error(`Driver ${this.opts.driver} not implemented in Phase 2 slice 1`);
    }
    if (this.opts.queryFn) return this.opts.queryFn;
    if (this.queryFn) return this.queryFn;
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
      query?: SdkQueryFn;
      default?: { query?: SdkQueryFn };
    };
    const fn = sdk.query ?? sdk.default?.query;
    if (!fn) throw new Error('claude-agent-sdk has no query() export');
    this.queryFn = fn;
    return fn;
  }

  createSession(input: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    /** Untrusted at this boundary (raw NDJSON payload) — normalized below. */
    effort?: unknown;
    requestId?: string;
  }): void {
    const session = this.opts.registry.create({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      model: input.model,
      effort: normalizeEffort(input.effort),
    });
    this.opts.emit({
      type: 'session.created',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: {},
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
    /** Untrusted at this boundary (raw NDJSON payload) — normalized below. */
    effort?: unknown;
    requestId?: string;
  }): void {
    // CP4 F-1: resuming a session with an active turn would orphan its
    // abort/running state — reject instead of re-registering.
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
      model: input.model,
      effort: normalizeEffort(input.effort),
    });
    this.opts.emit({
      type: 'session.resumed',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { runtimeIdentity: session.runtimeIdentity },
    });
    // Per-session order contract: resumed → session.history → status idle.
    // The JSONL read runs detached so the command loop stays responsive.
    void this.replayHistory(input);
  }

  private async replayHistory(input: {
    sessionId: string;
    workspacePath: string;
    runtimeIdentity: string;
    requestId?: string;
  }): Promise<void> {
    let result: HistoryReadResult;
    try {
      result = await readSessionHistory({
        workspacePath: input.workspacePath,
        runtimeIdentity: input.runtimeIdentity,
      });
    } catch (err) {
      // readSessionHistory is contract-bound to not throw; belt and braces.
      result = {
        messages: [],
        truncated: false,
        omittedCount: 0,
        parseStats: { totalLines: 0, controlLines: 0, badLines: 0 },
        error: {
          code: 'read_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    // Session may have been closed while reading — drop silently.
    if (!this.opts.registry.get(input.sessionId)) return;
    if (result.error) {
      this.log(
        `history read for ${input.sessionId}: ${result.error.code} — ${result.error.message}`
      );
    }
    this.opts.emit({
      type: 'session.history',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: {
        runtimeIdentity: input.runtimeIdentity,
        workspacePath: input.workspacePath,
        messages: result.messages,
        truncated: result.truncated,
        omittedCount: result.omittedCount,
        ...(result.error ? { error: result.error } : {}),
        parseStats: result.parseStats,
      },
    });
    this.opts.emit({
      type: 'session.status',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: { status: 'idle' },
    });
  }

  async send(input: {
    sessionId: string;
    text: string;
    attachments?: SessionAttachment[];
    /**
     * Per-turn override; falls back to the session default.
     * Untrusted at this boundary (raw NDJSON payload) — normalized below.
     */
    effort?: unknown;
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

    if (this.opts.driver === 'stream-json') {
      this.opts.emit({
        type: 'host.error',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'not_implemented',
          message: 'stream-json driver adapter lands after agent-sdk vertical slice',
          fatal: false,
        },
      });
      return;
    }

    const queryFn = await this.ensureSdk();
    // Per-turn effort wins; otherwise the session default from create/resume.
    const effort = normalizeEffort(input.effort) ?? session.effort;
    const abort = new AbortController();
    session.abort = abort;
    session.running = true;
    session.status = 'starting';
    this.opts.registry.setStatus(session.sessionId, 'starting');

    const normalizer = new EventNormalizer(session.sessionId, this.opts.emit, this.log);
    normalizer.beginTurn(input.text, input.requestId);

    this.opts.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'running' },
    });
    session.status = 'running';

    // Match Phase 0 spike: pass absolute Node path (runtime accepts it; types list names only).
    const executablePath = process.execPath;
    const mergedEnv: NodeJS.ProcessEnv = {
      ...this.opts.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'aiclient-agent-host/0.0.1',
    };

    // AskUserQuestion parks on the question bridge (interactive answer card);
    // every other tool keeps the permission bridge flow.
    const permissionHandler = this.permissions.createCanUseTool(session.sessionId);
    const canUseTool: typeof permissionHandler = (toolName, input, options) => {
      if (toolName === 'AskUserQuestion') {
        return this.questions.request({
          sessionId: session.sessionId,
          input,
          signal: options.signal,
          toolUseId: options.toolUseID,
        });
      }
      return permissionHandler(toolName, input, options);
    };

    // C-14 stall watchdog: abort a turn whose stream goes fully silent.
    // Silence is legitimate while a user prompt is parked (permission /
    // question) or a local tool run is in flight — those re-arm instead.
    const stallTimeoutMs = resolveStallTimeoutMs();
    let stalled = false;
    let stallTimer: NodeJS.Timeout | null = null;
    const onStall = () => {
      if (
        this.permissions.hasPending(session.sessionId) ||
        this.questions.hasPending(session.sessionId) ||
        normalizer.hasOpenTools()
      ) {
        armStallTimer();
        return;
      }
      stalled = true;
      this.log(
        `stall watchdog: no stream events for ${stallTimeoutMs}ms on ${session.sessionId} — aborting turn`
      );
      abort.abort();
    };
    const armStallTimer = () => {
      if (stallTimeoutMs <= 0) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(onStall, stallTimeoutMs);
    };
    const stallErrorMessage = () =>
      `Host stall watchdog: no model progress for ${stallTimeoutMs}ms ` +
      '(model/gateway hang or endless retry — check model name and gateway ' +
      'health; tune via AICLIENT_HOST_STALL_TIMEOUT_MS, 0 disables)';
    // Only model-productive events reset the watchdog. `system` events are
    // control-plane: an invalid model puts the CLI into an endless api_retry
    // loop that streams system events forever — they must not count as
    // progress or the hang becomes undetectable (C-14 gateway repro).
    const PRODUCTIVE_EVENT_TYPES = new Set([
      'assistant',
      'user',
      'result',
      'tool_progress',
      'stream_event',
    ]);

    const prompt = input.attachments?.length
      ? buildPromptWithAttachments(input.text, input.attachments)
      : input.text;

    let stream: (AsyncIterable<unknown> & { close?: () => void }) | null = null;
    try {
      stream = queryFn({
        prompt,
        options: {
          cwd: session.workspacePath,
          pathToClaudeCodeExecutable: this.opts.cliPath,
          executable: executablePath,
          // Expose built-in Claude Code tools so Permission/Tool cards can fire.
          // Do NOT set bare allowedTools — that auto-approves and shadows canUseTool.
          tools: { type: 'preset', preset: 'claude_code' },
          // Isolate from filesystem permission.allow rules that would shadow canUseTool.
          // Credentials still come from options.env (loaded from settings.json).
          settingSources: [],
          // #8: adaptive thinking with visible summaries. `display:'summarized'`
          // is required — the default `omitted` streams empty thinking text.
          // See THINKING_CONFIG above for the probe evidence.
          thinking: THINKING_CONFIG,
          // Interactive permission bridge (timeline cards) — not bypass.
          permissionMode: 'default',
          canUseTool,
          env: mergedEnv,
          abortController: abort,
          ...(session.model ? { model: session.model } : {}),
          // Top-level option (NOT output_config.effort) — SDK 0.3.218 sdk.d.ts
          // Options.effort, confirmed clean by c16 probe scenario D.
          ...(effort ? { effort } : {}),
          ...(session.runtimeIdentity ? { resume: session.runtimeIdentity } : {}),
        },
      });

      armStallTimer();
      for await (const event of stream) {
        if (abort.signal.aborted) break;
        const eventType = String((event as { type?: string })?.type ?? '');
        if (PRODUCTIVE_EVENT_TYPES.has(eventType)) armStallTimer();
        const runtimeId = normalizer.ingest(event, input.requestId);
        if (runtimeId && runtimeId !== session.runtimeIdentity) {
          // First discovery (initial send) or a defensive fork cover — without
          // this event Main's session index never learns the resume identity.
          session.runtimeIdentity = runtimeId;
          this.opts.emit({
            type: 'session.updated',
            sessionId: session.sessionId,
            requestId: input.requestId,
            payload: { runtimeIdentity: runtimeId },
          });
        }
      }

      if (abort.signal.aborted) {
        const rejectReason = stalled ? 'Host stall watchdog fired' : 'Session stopped';
        this.permissions.rejectSession(session.sessionId, rejectReason);
        this.questions.rejectSession(session.sessionId, rejectReason);
        if (stalled) {
          normalizer.emitFailed(stallErrorMessage(), input.requestId);
          session.status = 'failed';
          this.opts.registry.setStatus(session.sessionId, 'failed');
        } else {
          normalizer.emitStopped(input.requestId);
          session.status = 'idle';
          this.opts.registry.setStatus(session.sessionId, 'idle');
        }
      } else if (
        session.status === 'running' ||
        session.status === 'waiting_permission' ||
        session.status === 'waiting_question'
      ) {
        // The SDK stream can end without a result event (gateway hang /
        // dropped stream). finishTurn emits synthetic terminals so the UI
        // leaves `running`; it is a no-op when a result already emitted them.
        const outcome = normalizer.finishTurn(input.requestId);
        if (outcome !== 'already') {
          this.permissions.rejectSession(session.sessionId, 'Stream ended');
          this.questions.rejectSession(session.sessionId, 'Stream ended');
          this.log(`stream ended without result event — synthetic terminal: ${outcome}`);
        }
        const status = outcome === 'failed' ? 'failed' : 'idle';
        session.status = status;
        this.opts.registry.setStatus(session.sessionId, status);
      }
    } catch (err) {
      this.permissions.rejectSession(session.sessionId, 'Query failed');
      this.questions.rejectSession(session.sessionId, 'Query failed');
      if (abort.signal.aborted) {
        if (stalled) {
          // The SDK often surfaces our watchdog abort as a thrown AbortError —
          // keep the explicit failed terminal instead of a silent "stopped".
          normalizer.emitFailed(stallErrorMessage(), input.requestId);
          session.status = 'failed';
          this.opts.registry.setStatus(session.sessionId, 'failed');
        } else {
          normalizer.emitStopped(input.requestId);
          session.status = 'idle';
          this.opts.registry.setStatus(session.sessionId, 'idle');
        }
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.log('query failed:', message);
        this.opts.emit({
          type: 'session.failed',
          sessionId: session.sessionId,
          requestId: input.requestId,
          payload: { error: message },
        });
        this.opts.emit({
          type: 'session.status',
          sessionId: session.sessionId,
          requestId: input.requestId,
          payload: { status: 'failed' },
        });
        session.status = 'failed';
        this.opts.registry.setStatus(session.sessionId, 'failed');
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      session.running = false;
      session.abort = undefined;
      try {
        stream?.close?.();
      } catch {
        // ignore
      }
    }
  }

  respondPermission(input: {
    sessionId: string;
    permissionId: string;
    allow: boolean;
    requestId?: string;
  }): void {
    const ok = this.permissions.respond({
      sessionId: input.sessionId,
      permissionId: input.permissionId,
      allow: input.allow,
    });
    if (!ok) {
      this.opts.emit({
        type: 'host.error',
        sessionId: input.sessionId,
        requestId: input.requestId,
        payload: {
          code: 'permission_not_pending',
          message: `No pending permission: ${input.permissionId}`,
          fatal: false,
        },
      });
    }
  }

  respondQuestion(input: QuestionRespondInput & { requestId?: string }): void {
    const { requestId, ...respondInput } = input;
    const ok = this.questions.respond(respondInput);
    if (!ok) {
      this.opts.emit({
        type: 'host.error',
        sessionId: input.sessionId,
        requestId,
        payload: {
          code: 'question_not_pending',
          message: `No pending question: ${input.questionId}`,
          fatal: false,
        },
      });
    }
  }

  stop(input: { sessionId: string; requestId?: string }): void {
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
    this.permissions.rejectSession(session.sessionId, 'Session stopped');
    this.questions.rejectSession(session.sessionId, 'Session stopped');
    if (!session.running || !session.abort) {
      this.opts.emit({
        type: 'session.status',
        sessionId: session.sessionId,
        requestId: input.requestId,
        payload: { status: session.status },
      });
      return;
    }
    session.status = 'stopping';
    this.opts.registry.setStatus(session.sessionId, 'stopping');
    this.opts.emit({
      type: 'session.status',
      sessionId: session.sessionId,
      requestId: input.requestId,
      payload: { status: 'stopping' },
    });
    session.abort.abort();
  }

  close(input: { sessionId: string; requestId?: string }): void {
    this.permissions.rejectSession(input.sessionId, 'Session closed');
    this.questions.rejectSession(input.sessionId, 'Session closed');
    const session = this.opts.registry.get(input.sessionId);
    if (session?.running && session.abort) {
      session.abort.abort();
    }
    this.opts.registry.delete(input.sessionId);
    this.opts.emit({
      type: 'session.status',
      sessionId: input.sessionId,
      requestId: input.requestId,
      payload: { status: 'disconnected' },
    });
  }

  /** Host shutdown — fail-closed on any hanging permission or question. */
  dispose(): void {
    this.permissions.rejectAll('Host shutting down');
    this.questions.rejectAll('Host shutting down');
  }
}
