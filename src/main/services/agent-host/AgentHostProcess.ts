import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { AgentHostCommand } from '@shared/types/agentHost';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { killProcessTree } from '../../utils/processUtils';

export interface AgentHostProcessOptions {
  nodeExecPath: string;
  hostEntryPath: string;
  /** Extra node CLI args (e.g. --experimental-strip-types for TS entry). */
  nodeArgs?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Graceful shutdown wait before force-kill (ms). */
  shutdownTimeoutMs?: number;
}

/**
 * Thin stdio NDJSON transport around a Node 24 Agent Host child process.
 */
export class AgentHostProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private seqSeen = 0;
  private starting = false;

  constructor(private readonly options: AgentHostProcessOptions) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  async start(): Promise<void> {
    if (this.isRunning || this.starting) return;
    this.starting = true;
    try {
      const child = spawn(
        this.options.nodeExecPath,
        [...(this.options.nodeArgs ?? []), this.options.hostEntryPath],
        {
          cwd: this.options.cwd,
          env: {
            ...process.env,
            ...this.options.env,
            // Ensure Host does not inherit Electron-as-node quirks.
            ELECTRON_RUN_AS_NODE: undefined,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );
      this.child = child;

      let _stdoutBuf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        _stdoutBuf += chunk.toString('utf8');
        let idx: number;
        while ((idx = _stdoutBuf.indexOf('\n')) !== -1) {
          this.handleStdoutLine(_stdoutBuf.slice(0, idx).replace(/\r$/, ''));
          _stdoutBuf = _stdoutBuf.slice(idx + 1);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        this.emit('stderr', chunk.toString('utf8'));
      });

      child.on('error', (err) => {
        this.emit('error', err);
      });

      child.on('exit', (code, signal) => {
        this.child = null;
        this.emit('exit', { code, signal });
      });
    } finally {
      this.starting = false;
    }
  }

  send(command: AgentHostCommand): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Agent Host is not running');
    }
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /**
   * Ask Host to shut down, then force-kill the process tree if needed.
   */
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
      // stdin may already be closed
    }

    try {
      child.stdin.end();
    } catch {
      // ignore
    }

    const timer = setTimeout(() => {
      killProcessTree(child);
    }, timeoutMs);

    await exited;
    clearTimeout(timer);

    // Belt-and-suspenders: ensure tree is gone
    if (child.pid) {
      killProcessTree(child);
    }
    this.child = null;
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed) as RuntimeEvent;
      if (typeof event.seq === 'number') {
        this.seqSeen = Math.max(this.seqSeen, event.seq);
      }
      this.emit('event', event);
    } catch (err) {
      this.emit('parse-error', { line: trimmed, err });
    }
  }
}
