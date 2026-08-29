/**
 * Pi Agent Host process — spawns and communicates with the pi utilityProcess.
 *
 * Parallel to AgentHostProcess (NDJSON over child_process.spawn), this class
 * uses Electron's utilityProcess.fork() + MessagePort. The event interface is
 * identical so AgentHostManager can treat them interchangeably.
 *
 * D3 rev2: utilityProcess + MessagePort, not independent Node + NDJSON.
 */

import { EventEmitter } from 'node:events';
import type { AgentHostCommand } from '@shared/types/agentHost';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { type UtilityProcess, utilityProcess } from 'electron';

export interface PiHostProcessOptions {
  /** Path to the piHost entry file (piHost.ts in dev, piHost.js packaged). */
  hostEntryPath: string;
  /** Node CLI flags (e.g. --experimental-strip-types for TS entry in dev). */
  execArgv?: string[];
  env?: Record<string, string>;
  /** Graceful shutdown wait before force-kill (ms). */
  shutdownTimeoutMs?: number;
}

/**
 * MessagePort transport around an Electron utilityProcess running piHost.
 *
 * Emits the same events as AgentHostProcess:
 *   - 'event'  (RuntimeEvent)
 *   - 'stderr' (string)
 *   - 'error'  (Error)
 *   - 'exit'   ({ code, signal })
 */
export class PiHostProcess extends EventEmitter {
  private child: UtilityProcess | null = null;
  private starting = false;

  constructor(private readonly options: PiHostProcessOptions) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  async start(): Promise<void> {
    if (this.isRunning || this.starting) return;
    this.starting = true;
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined) env[k] = v;
      }
      Object.assign(env, this.options.env ?? {});

      const child = utilityProcess.fork(this.options.hostEntryPath, [], {
        execArgv: this.options.execArgv,
        env,
        stdio: 'pipe',
      });

      this.child = child;

      child.on('message', (data: unknown) => {
        if (!data || typeof data !== 'object') return;
        const event = data as RuntimeEvent;
        this.emit('event', event);
      });

      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          this.emit('stderr', chunk.toString('utf8'));
        });
      }

      child.on('exit', (code: number) => {
        this.child = null;
        this.emit('exit', { code, signal: null });
      });
    } catch (err) {
      this.child = null;
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.starting = false;
    }
  }

  send(command: AgentHostCommand): void {
    if (!this.child) {
      throw new Error('Pi Agent Host is not running');
    }
    this.child.postMessage(command);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;

    const timeoutMs = this.options.shutdownTimeoutMs ?? 3000;
    const exited = new Promise<void>((resolve) => {
      if (!this.child) {
        resolve();
        return;
      }
      this.once('exit', () => resolve());
    });

    try {
      this.send({
        protocolVersion: 1,
        requestId: `shutdown-${Date.now()}`,
        type: 'host.shutdown',
      });
    } catch {
      // port may already be closed
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // best-effort
      }
    }, timeoutMs);

    await exited;
    clearTimeout(timer);
    this.child = null;
  }
}
