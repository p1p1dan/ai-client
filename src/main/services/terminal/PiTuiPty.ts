import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PI_PROJECT_TRUST_ENV } from '@shared/piModelConfig';
import type {
  PiTuiDataEvent,
  PiTuiExitEvent,
  PiTuiLaunchLayout,
  PiTuiLaunchPlan,
  PiTuiOpenRequest,
  PiTuiOpenResult,
  PiTuiStatus,
  PiTuiStatusEvent,
} from '@shared/types';
import type { IPty } from 'node-pty';
import * as nodePty from 'node-pty';
import { isCredentialEnvKey } from '../../../../scripts/credential-env-keys.mjs';
import { resolveManagedPiPtyEnv } from '../piModelConfig';

const MAX_SUSPENDED_REPLAY_CHARS = 65_536;
const DEFAULT_MAX_LIVE_TERMINALS = 2;

export type PtyHandle = Pick<IPty, 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>;

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtySpawnFn = (file: string, args: string[], options: PtySpawnOptions) => PtyHandle;

export async function createNodePtySpawn(): Promise<PtySpawnFn> {
  return (file, args, options) => nodePty.spawn(file, args, options);
}

export interface PiTuiCallbacks {
  onData: (event: PiTuiDataEvent) => void;
  onExit: (event: PiTuiExitEvent) => void;
  onState?: (event: PiTuiStatusEvent) => void;
}

interface LiveTerminal {
  terminalId: string;
  cwd: string;
  pty: PtyHandle;
  generation: number;
  suspended: boolean;
  replayBuffer: string;
  lastUsed: number;
}

function boundedDimension(value: number | undefined, minimum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value ?? fallback));
}

export function resolvePiTuiLaunchPlan(
  layout: PiTuiLaunchLayout,
  inheritedEnv: NodeJS.ProcessEnv = process.env
): PiTuiLaunchPlan {
  const cliPath = layout.isPackaged
    ? join(
        layout.resourcesPath,
        'agent-host',
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'bundle',
        'cli.js'
      )
    : join(
        layout.appPath,
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'bundle',
        'cli.js'
      );
  if (!existsSync(cliPath)) throw new Error(`Pi CLI artifact is missing: ${cliPath}`);

  const useElectronNode = !layout.isPackaged;
  const nodePath = useElectronNode
    ? layout.electronExecPath
    : join(layout.resourcesPath, 'node-runtime', layout.platform === 'win32' ? 'node.exe' : 'node');
  if (!existsSync(nodePath)) throw new Error(`Pi Node runtime is missing: ${nodePath}`);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (typeof value === 'string') env[key] = value;
  }

  const managedEnv = resolveManagedPiPtyEnv();
  if (managedEnv[PI_PROJECT_TRUST_ENV] === '0') {
    for (const key of Object.keys(env)) {
      if (isCredentialEnvKey(key)) delete env[key];
    }
  }
  Object.assign(env, managedEnv);

  env.TERM ||= 'xterm-256color';
  env.COLORTERM ||= 'truecolor';
  if (useElectronNode) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;

  const nodeDir = dirname(nodePath);
  const separator = layout.platform === 'win32' ? ';' : ':';
  const currentPath = env.PATH || env.Path || '';
  const pathEntries = currentPath.split(separator);
  const containsNodeDir = pathEntries.some((entry) =>
    layout.platform === 'win32' ? entry.toLowerCase() === nodeDir.toLowerCase() : entry === nodeDir
  );
  if (!containsNodeDir) {
    env.PATH = currentPath ? `${nodeDir}${separator}${currentPath}` : nodeDir;
    if (layout.platform === 'win32') env.Path = env.PATH;
  }

  // No --session/--continue argument: T36 intentionally creates a new TUI session.
  return { cliPath, nodePath, args: [cliPath], env, useElectronNode };
}

export class PiTuiPtyController {
  readonly windowId: number;
  readonly #spawn: PtySpawnFn;
  readonly #resolveLaunch: () => Promise<PiTuiLaunchPlan>;
  readonly #live = new Map<string, LiveTerminal>();
  readonly #chains = new Map<string, Promise<void>>();
  readonly #generations = new Map<string, number>();
  readonly #callbacks: PiTuiCallbacks;
  readonly #maxLiveTerminals: number;
  #openChain: Promise<void> = Promise.resolve();
  #disposed = false;
  #usageSequence = 0;

  constructor(
    windowId: number,
    callbacks: PiTuiCallbacks,
    spawn: PtySpawnFn,
    resolveLaunch: () => Promise<PiTuiLaunchPlan>,
    maxLiveTerminals = DEFAULT_MAX_LIVE_TERMINALS
  ) {
    this.windowId = windowId;
    this.#callbacks = callbacks;
    this.#spawn = spawn;
    this.#resolveLaunch = resolveLaunch;
    this.#maxLiveTerminals = Math.max(1, Math.floor(maxLiveTerminals));
  }

  open(request: PiTuiOpenRequest): Promise<PiTuiOpenResult> {
    const terminalId = request.terminalId.trim();
    const cwd = request.cwd.trim();
    if (!terminalId || !cwd) throw new Error('terminalId and cwd are required');
    const result = this.#openChain.then(() =>
      this.#enqueue(terminalId, () => this.#openExclusive({ ...request, terminalId, cwd }))
    );
    this.#openChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #openExclusive(request: PiTuiOpenRequest): Promise<PiTuiOpenResult> {
    if (this.#disposed) throw new Error('Pi TUI controller is disposed');
    const current = this.#live.get(request.terminalId);
    if (current) {
      current.suspended = false;
      current.lastUsed = ++this.#usageSequence;
      this.#resizeNow(current.pty, request.cols, request.rows);
      this.#emitState(request.terminalId, 'live');
      if (current.replayBuffer) {
        this.#callbacks.onData({ terminalId: request.terminalId, data: current.replayBuffer });
        current.replayBuffer = '';
      }
      return {
        terminalId: request.terminalId,
        generation: current.generation,
        resumed: true,
      };
    }

    this.#reserveCapacity();
    const launch = await this.#resolveLaunch();
    if (this.#disposed) throw new Error('Pi TUI controller is disposed');
    this.#reserveCapacity();
    const generation = (this.#generations.get(request.terminalId) ?? 0) + 1;
    this.#generations.set(request.terminalId, generation);
    const prompt = request.initialPrompt?.trim();
    const pty = this.#spawn(launch.nodePath, launch.args, {
      name: 'xterm-256color',
      cols: boundedDimension(request.cols, 20, 80),
      rows: boundedDimension(request.rows, 5, 24),
      cwd: request.cwd,
      env: launch.env,
    });
    const live: LiveTerminal = {
      terminalId: request.terminalId,
      cwd: request.cwd,
      pty,
      generation,
      suspended: false,
      replayBuffer: '',
      lastUsed: ++this.#usageSequence,
    };
    this.#live.set(request.terminalId, live);

    pty.onData((data) => {
      const active = this.#live.get(request.terminalId);
      if (!active || active.pty !== pty || active.generation !== generation) return;
      if (active.suspended) {
        active.replayBuffer = `${active.replayBuffer}${data}`.slice(-MAX_SUSPENDED_REPLAY_CHARS);
        return;
      }
      this.#callbacks.onData({ terminalId: request.terminalId, data });
    });
    pty.onExit((event) => {
      const active = this.#live.get(request.terminalId);
      if (!active || active.pty !== pty || active.generation !== generation) return;
      this.#live.delete(request.terminalId);
      this.#emitState(request.terminalId, 'dead');
      this.#callbacks.onExit({ terminalId: request.terminalId, ...event });
    });
    this.#emitState(request.terminalId, 'live');
    // Keep prompts out of argv/process listings. PTYs buffer early input until
    // the CLI has installed its stdin handler, so no timing sleep is required.
    if (prompt) pty.write(`\x1b[200~${prompt}\x1b[201~\r`);
    return { terminalId: request.terminalId, generation, resumed: false };
  }

  write(terminalId: string, data: string): Promise<void> {
    return this.#enqueue(terminalId, () => {
      const live = this.#live.get(terminalId);
      if (!live || live.suspended) throw new Error('Pi TUI is not open');
      live.pty.write(data);
    });
  }

  resize(terminalId: string, cols: number, rows: number): Promise<void> {
    return this.#enqueue(terminalId, () => {
      const live = this.#live.get(terminalId);
      if (live) this.#resizeNow(live.pty, cols, rows);
    });
  }

  suspend(terminalId: string): Promise<void> {
    return this.#enqueue(terminalId, () => {
      const live = this.#live.get(terminalId);
      if (!live) return;
      live.suspended = true;
      live.lastUsed = ++this.#usageSequence;
      this.#emitState(terminalId, 'suspended');
    });
  }

  dispose(terminalId: string): Promise<void> {
    return this.#enqueue(terminalId, () => this.#disposeNow(terminalId));
  }

  async disposeAll(): Promise<void> {
    this.#disposed = true;
    await Promise.allSettled([this.#openChain, ...this.#chains.values()]);
    this.disposeAllSync();
  }

  disposeAllSync(): void {
    this.#disposed = true;
    for (const terminalId of [...this.#live.keys()]) this.#disposeNow(terminalId);
    this.#chains.clear();
  }

  status(): PiTuiStatus {
    return { terminalIds: [...this.#live.keys()] };
  }

  #reserveCapacity(): void {
    if (this.#live.size < this.#maxLiveTerminals) return;
    const suspended = [...this.#live.values()]
      .filter((terminal) => terminal.suspended)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!suspended) {
      throw new Error(`Pi TUI capacity reached (${this.#maxLiveTerminals})`);
    }
    this.#disposeNow(suspended.terminalId);
  }

  #disposeNow(terminalId: string): void {
    const live = this.#live.get(terminalId);
    if (!live) return;
    this.#live.delete(terminalId);
    try {
      live.pty.kill();
    } catch {
      // Process may already have exited.
    }
    this.#emitState(terminalId, 'dead');
  }

  #resizeNow(pty: PtyHandle, cols: number | undefined, rows: number | undefined): void {
    try {
      pty.resize(boundedDimension(cols, 20, 80), boundedDimension(rows, 5, 24));
    } catch {
      // Resize races with process exit are harmless.
    }
  }

  #emitState(terminalId: string, state: PiTuiStatusEvent['state']): void {
    this.#callbacks.onState?.({ terminalId, state });
  }

  #enqueue<T>(terminalId: string, operation: () => T | Promise<T>): Promise<T> {
    if (!terminalId.trim()) return Promise.reject(new Error('terminalId is required'));
    const previous = this.#chains.get(terminalId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.#chains.set(terminalId, tail);
    void tail.finally(() => {
      if (this.#chains.get(terminalId) === tail) this.#chains.delete(terminalId);
    });
    return result;
  }
}
