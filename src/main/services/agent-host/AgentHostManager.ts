import path from 'node:path';
import { COMETIX_PIN } from '@shared/agentHost/cometixPin';
import { AGENT_HOST_PROTOCOL_VERSION, type AgentHostDriver } from '@shared/types/agentHost';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { app } from 'electron';
import { AgentHostProcess } from './AgentHostProcess';
import { resolveNode24Runtime } from './NodeRuntimeResolver';

export type AgentHostState = 'stopped' | 'starting' | 'ready' | 'error';

/**
 * Owns the single Agent Host child process lifecycle for the Electron Main process.
 */
export class AgentHostManager {
  private process: AgentHostProcess | null = null;
  private state: AgentHostState = 'stopped';
  private driver: AgentHostDriver = 'stream-json';
  private readyPromise: Promise<void> | null = null;
  private eventHandlers = new Set<(event: RuntimeEvent) => void>();

  getStatus(): {
    state: AgentHostState;
    pid?: number;
    driver: AgentHostDriver;
    cometixVersion: string;
  } {
    return {
      state: this.state,
      pid: this.process?.pid,
      driver: this.driver,
      cometixVersion: COMETIX_PIN.version,
    };
  }

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async ensureStarted(driver?: AgentHostDriver): Promise<void> {
    if (driver) this.driver = driver;
    if (this.state === 'ready' && this.process?.isRunning) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = this.startInternal();
    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  async shutdown(): Promise<void> {
    const proc = this.process;
    this.process = null;
    this.state = 'stopped';
    if (proc) {
      await proc.stop();
    }
  }

  private async startInternal(): Promise<void> {
    this.state = 'starting';
    const resolved = await resolveNode24Runtime();
    if (!resolved.ok || !resolved.runtime) {
      this.state = 'error';
      throw new Error(resolved.error ?? 'Node 24 not found');
    }

    const hostEntryPath = resolveHostEntryPath();
    const useStripTypes = hostEntryPath.endsWith('.ts');
    const proc = new AgentHostProcess({
      nodeExecPath: resolved.runtime.execPath,
      hostEntryPath,
      nodeArgs: useStripTypes ? ['--experimental-strip-types'] : [],
      env: {
        AICLIENT_AGENT_HOST_DRIVER: this.driver,
        AICLIENT_COMETIX_VERSION: COMETIX_PIN.version,
      },
    });

    proc.on('event', (event: RuntimeEvent) => {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
      if (event.type === 'host.ready') {
        this.state = 'ready';
      }
      if (
        event.type === 'host.error' &&
        (event as { payload?: { fatal?: boolean } }).payload?.fatal
      ) {
        this.state = 'error';
      }
    });

    proc.on('exit', () => {
      if (this.process === proc) {
        this.process = null;
        this.state = 'stopped';
      }
    });

    this.process = proc;
    await proc.start();

    proc.send({
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      requestId: `init-${Date.now()}`,
      type: 'host.initialize',
      payload: { driver: this.driver },
    });

    // Wait briefly for host.ready; Phase 2 will harden with proper handshake timeout.
    await waitForReady(proc, 5000);
    this.state = 'ready';
  }
}

function resolveHostEntryPath(): string {
  // Packaged: prebuilt JS under resources/agent-host.
  // Dev: TypeScript entry via Node 24 --experimental-strip-types.
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-host', 'index.js');
  }
  return path.join(app.getAppPath(), 'src', 'agent-host', 'index.ts');
}

function waitForReady(proc: AgentHostProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      // Soft-ready for Phase 0: process is alive even if handshake is stubby.
      if (proc.isRunning) resolve();
      else reject(new Error('Agent Host failed to become ready'));
    }, timeoutMs);

    const onEvent = (event: RuntimeEvent) => {
      if (event.type === 'host.ready') {
        cleanup();
        resolve();
      }
      if (event.type === 'host.error') {
        cleanup();
        reject(new Error(String((event as { payload?: { message?: string } }).payload?.message)));
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error('Agent Host exited before ready'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.off('event', onEvent);
      proc.off('exit', onExit);
    };
    proc.on('event', onEvent);
    proc.on('exit', onExit);
  });
}

/** Singleton used by IPC + app cleanup. */
export const agentHostManager = new AgentHostManager();
