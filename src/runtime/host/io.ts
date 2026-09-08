import {
  appendFile,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Context, Service } from 'cordis';
import {
  EXEC_SERVICE,
  HOST_IO_SERVICE,
  type RuntimeFileInfo,
  type RuntimeHostConfig,
  type RuntimeHostIoService,
  type RuntimeReadOptions,
  type RuntimeReadResult,
  type RuntimeWriteOptions,
} from '../contracts.ts';
import { absolutePath, positiveInteger, RuntimeHostError } from './errors.ts';

const TSD_MAGIC = Buffer.from('%TSD-Header-###%');
const HELPER = fileURLToPath(new URL('./tsd-read.mjs', import.meta.url));
const CHUNK_BYTES = 64 * 1024;
export const TSD_READ_TIMEOUT_MS = 30_000;

export class HostIoPlugin extends Service implements RuntimeHostIoService {
  static inject = [EXEC_SERVICE];
  private readonly config: RuntimeHostConfig;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly appends = new Map<string, Promise<void>>();
  private disposed = false;
  private readonly controller = new AbortController();
  private readonly directories = new Set<import('node:fs').Dir>();

  constructor(ctx: Context, config: RuntimeHostConfig) {
    super(ctx, HOST_IO_SERVICE);
    this.config = config;
    ctx.effect(() => () => this.shutdown());
  }

  private track<T>(path: string, operation: () => Promise<T>): Promise<T> {
    if (this.disposed)
      return Promise.reject(new RuntimeHostError('runtime_disposed', 'host IO is disposed'));
    absolutePath(path);
    const work = operation();
    this.pending.add(work);
    return work.finally(() => this.pending.delete(work));
  }

  async shutdown(): Promise<void> {
    this.disposed = true;
    this.controller.abort();
    await Promise.allSettled(this.pending);
    const directories = [...this.directories];
    this.directories.clear();
    await Promise.all(directories.map((directory) => directory.close()));
  }

  readFile(path: string, options: RuntimeReadOptions): Promise<RuntimeReadResult> {
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal;
    return this.track(path, async () => {
      positiveInteger(options.maxBytes, 'maxBytes');
      const offset = options.offset ?? 0;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(options.maxBytes + 1)
      ) {
        throw new RuntimeHostError('invalid_host_request', 'invalid read window');
      }
      const checkAbort = () => {
        if (signal.aborted) throw new RuntimeHostError('io_aborted', 'read cancelled');
      };
      checkAbort();
      if (!(await stat(path)).isFile())
        throw new RuntimeHostError('invalid_host_request', 'read requires a regular file');
      const file = await open(path, 'r');
      let encrypted = false;
      try {
        const head = Buffer.alloc(TSD_MAGIC.length);
        const { bytesRead } = await file.read(head, 0, head.length, 0);
        encrypted = bytesRead === head.length && head.equals(TSD_MAGIC);
        if (!encrypted) {
          const chunks: Buffer[] = [];
          let count = 0;
          while (count <= options.maxBytes) {
            checkAbort();
            const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, options.maxBytes + 1 - count));
            const next = await file.read(buffer, 0, buffer.length, offset + count);
            if (!next.bytesRead) break;
            chunks.push(buffer.subarray(0, next.bytesRead));
            count += next.bytesRead;
          }
          checkAbort();
          return readResult(Buffer.concat(chunks), options, 'direct');
        }
      } finally {
        await file.close();
      }
      checkAbort();
      if (!this.config.node || this.config.tsdReadFallback !== 'configured-node') {
        throw new RuntimeHostError(
          'io_tsd_unavailable',
          `TSD read requires configured Node: ${path}`
        );
      }
      const output = await this.ctx.runtimeExec.run({
        command: this.config.node.path,
        args: [HELPER, path, String(offset), String(options.maxBytes + 1)],
        cwd: dirname(path),
        timeoutMs: TSD_READ_TIMEOUT_MS,
        maxOutputBytes: options.maxBytes + 1 + 4096,
        overflow: 'terminate',
        signal,
      });
      checkAbort();
      if (
        output.termination !== 'exit' ||
        output.exitCode !== 0 ||
        output.truncated ||
        output.stdout.length > options.maxBytes + 1
      ) {
        throw new RuntimeHostError(
          'io_tsd_unreadable',
          `TSD helper failed: ${output.termination}, exit ${output.exitCode}`,
          {
            cause: new Error(Buffer.from(output.stderr).toString('utf8')),
          }
        );
      }
      return readResult(Buffer.from(output.stdout), options, 'node-fallback');
    });
  }

  writeFile(path: string, bytes: Uint8Array, options?: RuntimeWriteOptions): Promise<void> {
    return this.track(path, () =>
      writeFile(path, bytes, { mode: options?.mode, flag: options?.createOnly ? 'wx' : 'w' })
    );
  }
  appendFile(path: string, bytes: Uint8Array, options?: { mode?: number }): Promise<void> {
    return this.track(path, async () => {
      const key = process.platform === 'win32' ? normalize(path).toLowerCase() : normalize(path);
      const previous = this.appends.get(key) ?? Promise.resolve();
      const write = previous.catch(() => {}).then(() => appendFile(path, bytes, options));
      this.appends.set(key, write);
      try {
        await write;
      } finally {
        if (this.appends.get(key) === write) this.appends.delete(key);
      }
    });
  }
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<RuntimeFileInfo> {
    return this.track(path, async () => {
      const info = await (options?.followSymlinks === false ? lstat(path) : stat(path));
      return { kind: kind(info), size: info.size, mtimeMs: info.mtimeMs };
    });
  }
  realpath(path: string): Promise<string> {
    return this.track(path, () => realpath(path));
  }
  async *readDirectory(
    path: string
  ): AsyncIterable<{ name: string; kind: RuntimeFileInfo['kind'] }> {
    absolutePath(path);
    if (this.disposed) throw new RuntimeHostError('runtime_disposed', 'host IO is disposed');
    const directory = await opendir(path);
    this.directories.add(directory);
    try {
      while (!this.disposed) {
        const entry = await directory.read();
        if (!entry) return;
        yield { name: entry.name, kind: kind(entry) };
      }
      throw new RuntimeHostError('runtime_disposed', 'host IO is disposed');
    } finally {
      if (this.directories.delete(directory)) await directory.close();
    }
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    return this.track(path, async () => {
      await mkdir(path, options);
    });
  }
  rename(from: string, to: string): Promise<void> {
    absolutePath(to);
    return this.track(from, () => rename(from, to));
  }
  unlink(path: string): Promise<void> {
    return this.track(path, () => unlink(path));
  }
}

function kind(info: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): RuntimeFileInfo['kind'] {
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  if (info.isSymbolicLink()) return 'symlink';
  return 'other';
}
function readResult(
  bytes: Buffer,
  options: RuntimeReadOptions,
  source: RuntimeReadResult['source']
): RuntimeReadResult {
  const truncated = bytes.length > options.maxBytes;
  if (truncated && options.overflow === 'error')
    throw new RuntimeHostError('io_limit', `read exceeds ${options.maxBytes} bytes`);
  return { bytes: bytes.subarray(0, options.maxBytes), truncated, source };
}
