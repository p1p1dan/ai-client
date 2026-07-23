/**
 * Claude Runtime Adapter — Agent SDK (default) over pinned Cometix cli.js.
 * Emits AiClient Runtime Events via EventNormalizer; no Electron deps.
 */

import type { AgentHostDriver } from '../shared/types/agentHost.ts';
import { EventNormalizer, type EmitFn, type LogFn } from './eventNormalizer.ts';
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
        if (runtimeId) {
          session.runtimeIdentity = runtimeId;
        }
      }

      if (abort.signal.aborted) {
        this.permissions.rejectSession(session.sessionId, 'Session stopped');
        normalizer.emitStopped(input.requestId);
        session.status = 'idle';
        this.opts.registry.setStatus(session.sessionId, 'idle');
      } else if (session.status === 'running' || session.status === 'waiting_permission') {
        // Normalizer may already have emitted completed/idle via result event.
        session.status = 'idle';
        this.opts.registry.setStatus(session.sessionId, 'idle');
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
