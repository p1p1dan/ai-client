import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  CLAUDE_SDK_HOST_PROXY,
  CLAUDE_SDK_HOST_SECRET,
  type ClaudeSdkHostProxyUpdate,
  type ClaudeSdkHostSecret,
} from '@shared/claudeSdkEngine';
import type { HostProxySetting } from '@shared/hostProxy';
import type { WorkerRpcRequest } from '@shared/types/workerRpc';
import type { WorkerTransport, WorkerTransportExit } from './WorkerTransport';

/**
 * Route-B prototype: a worker transport that is one Node process per chat,
 * running `src/claude-sdk-host/host.ts` over an IPC channel. The host speaks
 * the same worker RPC as a DSH channel (it reuses the bridge's
 * `BridgeRpcServer`), so `WorkerSlot` cannot tell the two apart.
 *
 * One process per session rather than a channel of a shared host: the SDK
 * already runs one Claude Code child per session, so sharing the Node half
 * would save little, and a crash stays contained to its chat.
 */
export interface ClaudeSdkProcessLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /**
   * Route B S-3 (K-5): the gateway key, sent as the first IPC message and never
   * put in `env` (a process's initial environment stays readable on Linux).
   */
  apiKey: string;
  /**
   * Dsh-rebase decision 196: the product proxy, sent with the key and again on
   * every change while this host lives. `current()` undefined: the engines stay
   * off it (rule 10), and nothing is sent.
   */
  proxy?: {
    current(): HostProxySetting | null | undefined;
    subscribe(listener: (setting: HostProxySetting | null) => void): () => void;
  };
}

export class ClaudeSdkProcessTransport implements WorkerTransport {
  private readonly child: ChildProcess;
  private exitInfo: WorkerTransportExit | null = null;
  private unsubscribeProxy: (() => void) | undefined;

  constructor(launch: ClaudeSdkProcessLaunch) {
    this.child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.child.once('exit', (code, signal) => {
      this.exitInfo = { code, signal, cause: 'host-exit' };
      this.unsubscribeProxy?.();
    });
    // Before any worker request: the host answers none until it has the key.
    const proxy = launch.proxy?.current();
    const secret: ClaudeSdkHostSecret = {
      type: CLAUDE_SDK_HOST_SECRET,
      apiKey: launch.apiKey,
      ...(proxy !== undefined ? { proxy } : {}),
    };
    this.child.send(secret);
    if (proxy !== undefined) {
      this.unsubscribeProxy = launch.proxy?.subscribe((setting) => {
        if (this.exitInfo || !this.child.connected) return;
        const update: ClaudeSdkHostProxyUpdate = { type: CLAUDE_SDK_HOST_PROXY, proxy: setting };
        // A host exiting right now is not a transport error: the callback keeps
        // a failed send from being emitted as one.
        this.child.send(update, () => undefined);
      });
    }
    // Stdout carries nothing the protocol needs; drain it so the pipe never fills.
    this.child.stdout?.resume();
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  postMessage(message: WorkerRpcRequest): void {
    if (this.exitInfo || !this.child.connected) {
      throw new Error('CLAUDE_SDK_HOST_CLOSED: the Claude SDK host process is gone');
    }
    this.child.send(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.child.on('message', listener);
    return () => this.child.off('message', listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.child.on('error', listener);
    return () => this.child.off('error', listener);
  }

  onExit(listener: (exit: WorkerTransportExit) => void): () => void {
    if (this.exitInfo) {
      const exit = this.exitInfo;
      let active = true;
      queueMicrotask(() => {
        if (active) listener(exit);
      });
      return () => {
        active = false;
      };
    }
    const handler = (code: number | null, signal: NodeJS.Signals | null) =>
      listener({ code, signal, cause: 'host-exit' });
    this.child.on('exit', handler);
    return () => this.child.off('exit', handler);
  }

  onStderr(listener: (chunk: string) => void): () => void {
    const handler = (chunk: Buffer) => listener(chunk.toString('utf8'));
    this.child.stderr?.on('data', handler);
    return () => this.child.stderr?.off('data', handler);
  }

  /**
   * Kill the host and everything under it. On Windows `ChildProcess.kill` ends
   * only the Node process and would orphan the Claude Code child and whatever
   * its Bash tool started, so the whole tree goes through `taskkill /T`.
   */
  kill(): boolean {
    if (this.exitInfo || this.child.pid === undefined) return false;
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], {
        windowsHide: true,
      });
      return result.status === 0;
    }
    return this.child.kill('SIGKILL');
  }
}
