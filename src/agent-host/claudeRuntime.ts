/**
 * Claude Runtime Adapter — Agent SDK (default) over pinned Cometix cli.js.
 * Emits AiClient Runtime Events via EventNormalizer; no Electron deps.
 */

import type { AgentHostDriver } from '../shared/types/agentHost.ts';
import { type EmitFn, EventNormalizer, type LogFn } from './eventNormalizer.ts';
import { type HistoryReadResult, readSessionHistory } from './historyReader.ts';
import { PermissionBridge } from './permissionBridge.ts';
import type { SessionRegistry } from './sessionRegistry.ts';

export interface ClaudeRuntimeOptions {
  driver: AgentHostDriver;
  cliPath: string;
  /** Merged process + ~/.claude/settings.json env for SDK child. */
  env: NodeJS.ProcessEnv;
  emit: EmitFn;
  log?: LogFn;
  registry: SessionRegistry;
}

type SdkQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<unknown> & { close?: () => void };

export class ClaudeRuntime {
  private queryFn: SdkQueryFn | null = null;
  private readonly log: LogFn;
  private readonly opts: ClaudeRuntimeOptions;
  private readonly permissions: PermissionBridge;

  constructor(opts: ClaudeRuntimeOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((...args) => console.error('[claude-runtime]', ...args));
    this.permissions = new PermissionBridge(opts.emit, this.log);
  }

  get driver(): AgentHostDriver {
    return this.opts.driver;
  }

  /** Lazy-load Agent SDK query export. */
  private async ensureSdk(): Promise<SdkQueryFn> {
    if (this.opts.driver !== 'agent-sdk') {
      throw new Error(`Driver ${this.opts.driver} not implemented in Phase 2 slice 1`);
    }
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
    requestId?: string;
  }): void {
    const session = this.opts.registry.create({
      sessionId: input.sessionId,
      workspacePath: input.workspacePath,
      model: input.model,
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

  async send(input: { sessionId: string; text: string; requestId?: string }): Promise<void> {
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

    const canUseTool = this.permissions.createCanUseTool(session.sessionId);

    let stream: (AsyncIterable<unknown> & { close?: () => void }) | null = null;
    try {
      stream = queryFn({
        prompt: input.text,
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
          // CP3 (2026-07-24): thinking on by default. The historical CCH
          // "invalid thinking block" 400 no longer reproduces — C-05 spike ran
          // multi-turn resume with signed thinking history clean (8/8 turns).
          thinking: { type: 'enabled', budgetTokens: 4096 },
          // Interactive permission bridge (timeline cards) — not bypass.
          permissionMode: 'default',
          canUseTool,
          env: mergedEnv,
          abortController: abort,
          ...(session.model ? { model: session.model } : {}),
          ...(session.runtimeIdentity ? { resume: session.runtimeIdentity } : {}),
        },
      });

      for await (const event of stream) {
        if (abort.signal.aborted) break;
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
        this.permissions.rejectSession(session.sessionId, 'Session stopped');
        normalizer.emitStopped(input.requestId);
        session.status = 'idle';
        this.opts.registry.setStatus(session.sessionId, 'idle');
      } else if (session.status === 'running' || session.status === 'waiting_permission') {
        // The SDK stream can end without a result event (gateway hang /
        // dropped stream). finishTurn emits synthetic terminals so the UI
        // leaves `running`; it is a no-op when a result already emitted them.
        const outcome = normalizer.finishTurn(input.requestId);
        if (outcome !== 'already') {
          this.permissions.rejectSession(session.sessionId, 'Stream ended');
          this.log(`stream ended without result event — synthetic terminal: ${outcome}`);
        }
        const status = outcome === 'failed' ? 'failed' : 'idle';
        session.status = status;
        this.opts.registry.setStatus(session.sessionId, status);
      }
    } catch (err) {
      this.permissions.rejectSession(session.sessionId, 'Query failed');
      if (abort.signal.aborted) {
        normalizer.emitStopped(input.requestId);
        session.status = 'idle';
        this.opts.registry.setStatus(session.sessionId, 'idle');
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

  /** Host shutdown — fail-closed on any hanging permission. */
  dispose(): void {
    this.permissions.rejectAll('Host shutting down');
  }
}
