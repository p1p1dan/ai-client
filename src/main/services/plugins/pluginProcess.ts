import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  HOST_API_METHODS,
  type HostApiMethod,
  type HostToPluginFrame,
  PLUGIN_ERRORS,
  PLUGIN_TIMEOUTS_MS,
  type PluginCallMethod,
  type PluginToHostFrame,
  type WireError,
} from '@shared/plugins/protocol';

/**
 * One plugin's process, seen from PiLab (plugin-system README §3).
 *
 * Started on the bundled Node — the carrier the encrypted machine accepts,
 * the same one the DSH host runs on — never on Electron's `utilityProcess`.
 * Talks `protocol.ts` frames over the IPC channel; stdout and stderr are the
 * plugin's console and go to the log.
 */

export const PLUGIN_HOST_MISSING = 'PLUGIN_HOST_MISSING';

export const PLUGIN_HOST_LAYOUT = {
  unpackaged: { nodeDir: 'out-node-runtime', entry: ['src', 'plugin-host', 'pluginHost.ts'] },
  packaged: { nodeDir: 'node-runtime', entry: ['plugin-host', 'pluginHost.mjs'] },
} as const;

/** Variables a plugin process inherits; nothing else (no provider keys, no shell env). */
const INHERITED_ENV = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'windir',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

export interface PluginLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function resolvePluginLaunch(input: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  pluginId: string;
  dataDir: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
}): PluginLaunch {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;
  const layout = input.isPackaged ? PLUGIN_HOST_LAYOUT.packaged : PLUGIN_HOST_LAYOUT.unpackaged;
  const root = input.isPackaged ? input.resourcesPath : input.appPath;
  const nodeName = (input.platform ?? process.platform) === 'win32' ? 'node.exe' : 'node';
  // Same override the DSH host honours in development; never a `node` on PATH.
  const override = input.isPackaged ? undefined : env.AICLIENT_DSH_NODE?.trim();
  const node = override || path.join(root, layout.nodeDir, nodeName);
  const entry = path.join(root, ...layout.entry);
  for (const [what, file] of [
    ['Node runtime', node],
    ['entry', entry],
  ] as const) {
    if (!exists(file)) {
      throw Object.assign(
        new Error(`${PLUGIN_HOST_MISSING}: the plugin host ${what} is missing: ${file}`),
        { code: PLUGIN_HOST_MISSING }
      );
    }
  }
  const childEnv: Record<string, string> = { PILAB_PLUGIN_ID: input.pluginId };
  for (const name of INHERITED_ENV) {
    const value = env[name];
    if (value !== undefined) childEnv[name] = value;
  }
  return { command: node, args: [entry], cwd: input.dataDir, env: childEnv };
}

export interface PluginProcessHandlers {
  /** Answer one host API call; the broker's checks live behind this. */
  onHostCall(method: HostApiMethod, args: unknown[]): Promise<unknown>;
  onLog(level: 'info' | 'warn' | 'error', message: string): void;
  /** The process is gone; `expected` when `stop()` asked for it. */
  onExit(info: { code: number | null; signal: string | null; expected: boolean }): void;
}

export class PluginCallFailed extends Error {
  constructor(readonly wire: WireError) {
    super(`${wire.code}: ${wire.message}`);
    this.name = 'PluginCallFailed';
  }
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

const HOST_METHODS: ReadonlySet<string> = new Set(HOST_API_METHODS);

export class PluginProcess {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private stopping = false;
  private exited = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly handlers: PluginProcessHandlers
  ) {}

  /** Spawn, send `init`, and resolve once the plugin's `activate` has returned. */
  static start(
    launch: PluginLaunch,
    init: Extract<HostToPluginFrame, { t: 'init' }>,
    handlers: PluginProcessHandlers,
    spawnFn: SpawnFn = spawn
  ): Promise<PluginProcess> {
    const child = spawnFn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    const plugin = new PluginProcess(child, handlers);
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          plugin.stopping = true;
          child.kill();
          reject(error);
        } else resolve(plugin);
      };
      // Activation itself is bounded in the child; this also covers a child that never starts.
      const timer = setTimeout(
        () => settle(new Error(`${PLUGIN_ERRORS.timeout}: plugin did not become ready`)),
        PLUGIN_TIMEOUTS_MS.activate + 5_000
      );
      plugin.attach((frame) => {
        if (frame.t === 'ready') settle();
        else if (frame.t === 'fail') settle(new PluginCallFailed(frame.error));
      });
      child.once('exit', (code, signal) => {
        settle(
          new Error(`${PLUGIN_ERRORS.crashed}: plugin exited during start (${code ?? signal})`)
        );
      });
      child.once('error', (error) => settle(error));
      child.send(init);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Call into the plugin (a service's start/stop, deactivate). */
  call(method: PluginCallMethod, args: unknown[], timeoutMs: number): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new Error(`${PLUGIN_ERRORS.crashed}: plugin is not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${PLUGIN_ERRORS.timeout}: ${method} took longer than ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ t: 'call', id, method, args } satisfies HostToPluginFrame);
    });
  }

  /** One-way push to the plugin; dropped if it is gone. */
  emit(name: string, payload: unknown): void {
    if (this.exited || !this.child.connected) return;
    try {
      this.child.send({ t: 'event', name, payload } satisfies HostToPluginFrame);
    } catch {
      // Exiting mid-send; the exit handler reports it.
    }
  }

  /** End the process now, for a quit that cannot wait. */
  killNow(): void {
    if (this.exited) return;
    this.stopping = true;
    this.child.kill('SIGKILL');
  }

  /** Let the plugin clean up, then end the process. */
  async stop(): Promise<void> {
    if (this.exited) return;
    this.stopping = true;
    await this.call('deactivate', [], PLUGIN_TIMEOUTS_MS.deactivate).catch(() => undefined);
    if (this.exited) return;
    const gone = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.kill();
    const forced = setTimeout(() => this.child.kill('SIGKILL'), 3_000);
    await gone;
    clearTimeout(forced);
  }

  private attach(onLifecycle: (frame: PluginToHostFrame) => void): void {
    this.child.stdout?.on('data', (chunk: Buffer) => this.forwardOutput('info', chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => this.forwardOutput('warn', chunk));
    this.child.on('message', (raw: unknown) => {
      const frame = raw as PluginToHostFrame;
      switch (frame?.t) {
        case 'ready':
        case 'fail':
          onLifecycle(frame);
          break;
        case 'log':
          this.handlers.onLog(frame.level, frame.message);
          break;
        case 'call':
          this.answer(frame);
          break;
        case 'res': {
          const waiting = this.pending.get(frame.id);
          if (!waiting) break;
          this.pending.delete(frame.id);
          clearTimeout(waiting.timer);
          if (frame.ok) waiting.resolve(frame.value);
          else waiting.reject(new PluginCallFailed(frame.error));
          break;
        }
        default:
          break;
      }
    });
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      for (const [id, waiting] of this.pending) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(`${PLUGIN_ERRORS.crashed}: plugin exited`));
        this.pending.delete(id);
      }
      this.handlers.onExit({ code, signal, expected: this.stopping });
    });
  }

  private answer(frame: Extract<PluginToHostFrame, { t: 'call' }>): void {
    const reply = (result: HostToPluginFrame) => {
      if (!this.exited && this.child.connected) this.child.send(result);
    };
    if (!HOST_METHODS.has(frame.method) || !Array.isArray(frame.args)) {
      reply({
        t: 'res',
        id: frame.id,
        ok: false,
        error: { code: PLUGIN_ERRORS.methodUnknown, message: `unknown method ${frame.method}` },
      });
      return;
    }
    this.handlers.onHostCall(frame.method, frame.args).then(
      (value) => reply({ t: 'res', id: frame.id, ok: true, value: value ?? null }),
      (error: unknown) => reply({ t: 'res', id: frame.id, ok: false, error: toWireError(error) })
    );
  }

  private forwardOutput(level: 'info' | 'warn', chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) this.handlers.onLog(level, line);
    }
  }
}

/** `code: message` errors keep their code across the wire. */
export function toWireError(error: unknown): WireError {
  if (error instanceof PluginCallFailed) return error.wire;
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Za-z_][A-Za-z0-9_]*): ([\s\S]*)$/.exec(message);
  return match?.[1] && match[2] !== undefined
    ? { code: match[1], message: match[2] }
    : { code: PLUGIN_ERRORS.failed, message };
}
