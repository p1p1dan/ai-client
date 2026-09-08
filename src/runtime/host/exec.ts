import { spawn } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Context, Service } from 'cordis';
import {
  EXEC_SERVICE,
  type RuntimeExecRequest,
  type RuntimeExecResult,
  type RuntimeExecService,
  type RuntimeHostConfig,
} from '../contracts.ts';
import { absolutePath, positiveInteger, RuntimeHostError, timerMilliseconds } from './errors.ts';

export class ExecPlugin extends Service implements RuntimeExecService {
  readonly mode: 'pipe' | 'host-adapter';
  readonly adapterId: string;
  private disposed = false;
  private readonly active = new Map<AbortController, Promise<RuntimeExecResult>>();
  private disposal?: Promise<void>;

  private readonly config: RuntimeHostConfig;

  constructor(ctx: Context, config: RuntimeHostConfig) {
    super(ctx, EXEC_SERVICE);
    this.config = config;
    this.mode = config.exec.mode;
    this.adapterId =
      config.exec.mode === 'pipe'
        ? config.node
          ? 'node-runner-pipe-v1'
          : 'node-direct-pipe-v1'
        : config.exec.adapter.id;
    ctx.effect(() => () => this.shutdown());
  }

  async run(request: RuntimeExecRequest): Promise<RuntimeExecResult> {
    if (this.disposed)
      return Promise.reject(new RuntimeHostError('runtime_disposed', 'exec is disposed'));
    absolutePath(request.cwd);
    timerMilliseconds(request.timeoutMs, 'timeoutMs');
    positiveInteger(request.maxOutputBytes, 'maxOutputBytes');
    if (!request.command || (!isAbsolute(request.command) && /[/\\]/.test(request.command))) {
      throw new RuntimeHostError(
        'invalid_host_request',
        'command must be absolute or a bare executable name'
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort('aborted');
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener('abort', abort, { once: true });
    const normalized = {
      ...request,
      env: commandEnvironment(this.config, request.env),
      signal: controller.signal,
    };
    const work = Promise.resolve().then(() =>
      controller.signal.aborted
        ? {
            ...emptyResult(),
            termination:
              controller.signal.reason === 'disposed'
                ? ('disposed' as const)
                : ('aborted' as const),
          }
        : this.config.exec.mode === 'pipe'
          ? runPipe(normalized, this.config.cleanupTimeoutMs, this.config.node?.path)
          : this.config.exec.adapter.run(normalized, this.config.cleanupTimeoutMs)
    );
    this.active.set(controller, work);
    return work.finally(() => {
      request.signal?.removeEventListener('abort', abort);
      this.active.delete(controller);
    });
  }

  shutdown(): Promise<void> {
    this.disposal ??= this.stop();
    return this.disposal;
  }

  private async stop(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active.keys()) controller.abort('disposed');
    const results = await Promise.allSettled(this.active.values());
    if (this.config.exec.mode === 'host-adapter')
      await this.config.exec.adapter.dispose(this.config.cleanupTimeoutMs);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

export function commandEnvironment(
  config: RuntimeHostConfig,
  override: RuntimeExecRequest['env']
): Record<string, string> {
  const env: Record<string, string> = { ...config.childEnv };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (process.platform === 'win32') {
      for (const previous of Object.keys(env))
        if (previous.toLowerCase() === key.toLowerCase()) delete env[previous];
    }
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const pathKeys = Object.keys(env).filter((key) =>
    process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH'
  );
  const previous = pathKeys.map((key) => env[key]).join(delimiter);
  for (const key of pathKeys) delete env[key];
  env.PATH = config.node
    ? [dirname(config.node.path), previous].filter(Boolean).join(delimiter)
    : previous;
  return env;
}

function emptyResult(): RuntimeExecResult {
  return {
    exitCode: null,
    signal: null,
    termination: 'exit',
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
  };
}

function runPipe(
  request: RuntimeExecRequest,
  cleanupTimeoutMs: number,
  nodePath?: string
): Promise<RuntimeExecResult> {
  const result = emptyResult();
  if (request.signal?.aborted) {
    result.termination = request.signal.reason === 'disposed' ? 'disposed' : 'aborted';
    return Promise.resolve(result);
  }
  if (process.platform === 'win32' && !nodePath) {
    return Promise.reject(
      new RuntimeHostError('invalid_host_config', 'Windows exec requires a configured Node runner')
    );
  }
  return new Promise((resolve, reject) => {
    const runnerPath = fileURLToPath(new URL('./exec-runner.mjs', import.meta.url));
    const child = spawn(nodePath ?? request.command, nodePath ? [runnerPath] : [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: nodePath
        ? [request.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc']
        : [request.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let retained = 0;
    let settled = false;
    let stopping = false;
    let streamError: Error | undefined;
    let reportedExit = false;
    let childClosed = false;
    let cleanupError: Error | undefined;
    let windowsKillStarted = false;
    const cleaners = new Set<ReturnType<typeof spawn>>();
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => stop('timeout'), request.timeoutMs);
    const abort = () => stop(request.signal?.reason === 'disposed' ? 'disposed' : 'aborted');

    function snapshot(): RuntimeExecResult {
      result.stdout = Buffer.concat(chunks.stdout);
      result.stderr = Buffer.concat(chunks.stderr);
      return result;
    }
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(cleanupDeadline);
      for (const cleaner of cleaners) cleaner.kill();
      cleaners.clear();
      request.signal?.removeEventListener('abort', abort);
      if (error) reject(Object.assign(error, { partialResult: snapshot() }));
      else if (streamError) reject(Object.assign(streamError, { partialResult: snapshot() }));
      else resolve(snapshot());
    }
    function killTree(force: boolean): void {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        if (windowsKillStarted) return;
        windowsKillStarted = true;
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        cleaners.add(killer);
        killer.on('error', (error) => {
          cleanupError = new RuntimeHostError('exec_cleanup_failed', 'taskkill could not start', {
            cause: error,
          });
          child.kill();
        });
        killer.on('close', (code) => {
          cleaners.delete(killer);
          if (code !== 0)
            cleanupError ??= new RuntimeHostError('exec_cleanup_failed', `taskkill exited ${code}`);
          if (childClosed) finish(cleanupError);
        });
      } else {
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
            finish(
              new RuntimeHostError('exec_cleanup_failed', 'could not terminate command group', {
                cause: error,
              })
            );
          }
        }
      }
    }
    function stop(reason: RuntimeExecResult['termination']): void {
      if (settled || stopping) return;
      stopping = true;
      result.termination = reason;
      killTree(false);
      escalation = setTimeout(() => killTree(true), Math.max(1, Math.floor(cleanupTimeoutMs / 2)));
      cleanupDeadline = setTimeout(() => {
        killTree(true);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        finish(
          new RuntimeHostError(
            'exec_cleanup_failed',
            'command streams did not close before cleanup deadline'
          )
        );
      }, cleanupTimeoutMs);
    }
    function consume(stream: 'stdout' | 'stderr', data: Buffer): void {
      result[stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes'] += data.length;
      const count = Math.min(data.length, request.maxOutputBytes - retained);
      if (count > 0) chunks[stream].push(Buffer.from(data.subarray(0, count)));
      retained += count;
      if (count < data.length) {
        result.truncated = true;
        if (request.overflow === 'terminate') stop('output-limit');
      }
    }
    const streamFailed = (error: Error) => {
      streamError = new RuntimeHostError('exec_stdio_failed', 'command stream failed', {
        cause: error,
      });
      stop('aborted');
    };
    child.stdout?.on('error', streamFailed);
    child.stderr?.on('error', streamFailed);
    child.stdout?.on('data', (data: Buffer) => consume('stdout', data));
    child.stderr?.on('data', (data: Buffer) => consume('stderr', data));
    child.on('error', (error) =>
      finish(
        new RuntimeHostError('exec_spawn_failed', `could not start ${request.command}`, {
          cause: error,
        })
      )
    );
    child.on('close', (code, signal) => {
      childClosed = true;
      if (!reportedExit) {
        result.exitCode = code;
        result.signal = signal;
      }
      // Kill remaining members even when the leader exited normally.
      if (process.platform !== 'win32') killTree(true);
      if (!cleaners.size) finish(cleanupError);
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') streamFailed(error);
    });
    if (nodePath) {
      child.on(
        'message',
        (message: {
          type: 'exit' | 'spawn-error';
          code?: number | null;
          signal?: string | null;
          message?: string;
        }) => {
          if (message.type === 'spawn-error') {
            streamError = new RuntimeHostError(
              'exec_spawn_failed',
              message.message ?? 'command could not start'
            );
          } else {
            reportedExit = true;
            result.exitCode = message.code ?? null;
            result.signal = message.signal ?? null;
          }
          stop('exit');
        }
      );
      child.send?.(
        { command: request.command, args: request.args, cwd: request.cwd, env: request.env },
        (error: Error | null) => {
          if (error && !stopping && !settled) streamFailed(error);
        }
      );
    }
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    if (request.stdin) child.stdin?.end(request.stdin);
  });
}
