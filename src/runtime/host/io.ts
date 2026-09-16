import {
  appendFile,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, normalize } from 'node:path';
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
import { resolveHelper } from './helpers.ts';

const TSD_MAGIC = Buffer.from('%TSD-Header-###%');
/**
 * Second criterion for "this really is a container" (tsd-07).
 *
 * The magic alone condemned every file that merely starts with those 16 bytes
 * — the note someone saved while chasing this very format, a fixture, a
 * support sample — to `io_tsd_unavailable` on every carrier, with a message
 * calling it encrypted. The encrypted box writes whole blocks: the two field
 * samples are 20480 and 45056 bytes, both multiples of 4096, and a container
 * holds at least one block. A file that is not block aligned is therefore read
 * as the plaintext it is.
 */
const TSD_CONTAINER_BLOCK_BYTES = 4096;
function containerShaped(size: number): boolean {
  return size >= TSD_CONTAINER_BLOCK_BYTES && size % TSD_CONTAINER_BLOCK_BYTES === 0;
}
/**
 * Frame around the helper's stdout (tsd-04).
 *
 * The helper inherits the machine's whole environment, so whatever its Node
 * prints before our first byte — an enterprise preload's banner, a telemetry
 * line — lands on the same pipe as the plaintext, and unframed those bytes ARE
 * the file as far as the caller can tell. An 8-byte magic plus the payload
 * length in front turns a silent content change into a read error. The
 * contract's "stdout stays raw bytes" is about not transforming the payload;
 * this is the only way to tell the payload from everything else.
 */
const TSD_FRAME_MAGIC = Buffer.from('%TSDOUT%');
const TSD_FRAME_HEADER_BYTES = TSD_FRAME_MAGIC.length + 4;
/**
 * Variables that let someone else run code inside the helper before it writes.
 * Dropped for this one command rather than for the worker as a whole: a user's
 * own `NODE_OPTIONS` still applies to the commands they ask for (tsd-04).
 */
const TSD_HELPER_ENV: Readonly<Record<string, string | undefined>> = {
  NODE_OPTIONS: undefined,
  NODE_REPL_EXTERNAL_MODULE: undefined,
  NODE_V8_COVERAGE: undefined,
};
// Resolved on first use, not at import: a packaging slip must fail the read
// that needs the helper, not the load of every worker.
let helperPath: string | undefined;
function tsdHelper(): string {
  helperPath ??= resolveHelper('tsd-read.mjs', import.meta.url);
  return helperPath;
}
const CHUNK_BYTES = 64 * 1024;
export const TSD_READ_TIMEOUT_MS = 30_000;
/**
 * core-host-05 — room for the helper's own error line plus whatever the
 * configured Node prints on startup, kept apart from the stdout quota so that
 * noise cannot be mistaken for an unreadable file.
 */
const TSD_STDERR_BYTES = 4096;

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
    try {
      absolutePath(path);
    } catch (error) {
      // Rejected rather than thrown, like every other exit from this service
      // and like the exec side: a caller that built a batch with `.catch()`
      // instead of `await` would otherwise see this one escape the batch.
      return Promise.reject(error);
    }
    return this.trackWork(operation());
  }

  /** Registered so `shutdown` waits for the operation instead of racing it. */
  private trackWork<T>(work: Promise<T>): Promise<T> {
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
      const info = await stat(path);
      if (!info.isFile())
        throw new RuntimeHostError('invalid_host_request', 'read requires a regular file');
      const file = await open(path, 'r');
      let encrypted = false;
      try {
        const head = Buffer.alloc(TSD_MAGIC.length);
        const { bytesRead } = await file.read(head, 0, head.length, 0);
        encrypted =
          bytesRead === head.length && head.equals(TSD_MAGIC) && containerShaped(info.size);
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
        // Names the carrier and the Node that would have run the helper: in
        // the field this is the difference between "the driver stopped
        // whitelisting our binary" and "this file was never readable", and the
        // last clause says what was actually observed so a block-aligned
        // plaintext file can be recognised as the other reading (tsd-01).
        throw new RuntimeHostError(
          'io_tsd_unavailable',
          `TSD read requires configured Node (carrier ${this.config.carrier}, node ${
            this.config.node?.path ?? 'none'
          }, fallback ${this.config.tsdReadFallback}): ${path} opens with the ` +
            `${TSD_MAGIC.length}-byte TSD container header and is ${info.size} bytes`
        );
      }
      const output = await this.ctx.runtimeExec.run({
        command: this.config.node.path,
        args: [tsdHelper(), path, String(offset), String(options.maxBytes + 1)],
        cwd: dirname(path),
        env: TSD_HELPER_ENV,
        timeoutMs: TSD_READ_TIMEOUT_MS,
        // The window the helper may print plus its frame, and no more: stderr
        // has its own budget, so a warning-happy Node no longer spends the
        // plaintext quota and gets a working read reported as
        // io_tsd_unreadable (core-host-05).
        maxOutputBytes: options.maxBytes + 1 + TSD_FRAME_HEADER_BYTES,
        maxStderrBytes: TSD_STDERR_BYTES,
        overflow: 'terminate',
        signal,
      });
      checkAbort();
      if (output.termination !== 'exit' || output.exitCode !== 0 || output.truncated) {
        throw new RuntimeHostError(
          'io_tsd_unreadable',
          `TSD helper failed: ${output.termination}, exit ${output.exitCode}`,
          {
            cause: new Error(Buffer.from(output.stderr).toString('utf8')),
          }
        );
      }
      return readResult(
        tsdPayload(Buffer.from(output.stdout), path, options.maxBytes + 1),
        options,
        'node-fallback'
      );
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
  /**
   * Validated here rather than in the generator body, which does not run until
   * something pulls it: a relative path or a disposed runtime must be reported
   * by the call that made the mistake, not by a later `for await` line.
   */
  readDirectory(path: string): AsyncIterable<{ name: string; kind: RuntimeFileInfo['kind'] }> {
    if (this.disposed) throw new RuntimeHostError('runtime_disposed', 'host IO is disposed');
    absolutePath(path);
    return this.iterateDirectory(path);
  }

  private async *iterateDirectory(
    path: string
  ): AsyncIterable<{ name: string; kind: RuntimeFileInfo['kind'] }> {
    const directory = await this.trackWork(opendir(path));
    this.directories.add(directory);
    try {
      while (!this.disposed) {
        // Each step is tracked, not the whole iteration: `shutdown` must wait
        // for the read in flight before closing the handle under it, but it
        // cannot wait for a consumer that stopped pulling.
        const entry = await this.trackWork(directory.read());
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
    return this.track(from, async () => {
      absolutePath(to);
      await rename(from, to);
    });
  }
  unlink(path: string): Promise<void> {
    return this.track(path, () => unlink(path));
  }
  rmdir(path: string): Promise<void> {
    return this.track(path, () => rmdir(path));
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
/**
 * The helper's stdout minus its frame, or an error naming what else was on the
 * pipe. Bytes before, after or instead of the frame mean a second writer
 * reached the same stdout, and nothing downstream could tell which of them are
 * the file (tsd-04).
 */
function tsdPayload(stdout: Buffer, path: string, window: number): Buffer {
  const framed =
    stdout.length >= TSD_FRAME_HEADER_BYTES &&
    stdout.subarray(0, TSD_FRAME_MAGIC.length).equals(TSD_FRAME_MAGIC);
  const declared = framed ? stdout.readUInt32BE(TSD_FRAME_MAGIC.length) : -1;
  const payload = stdout.subarray(TSD_FRAME_HEADER_BYTES);
  if (!framed || payload.length !== declared || payload.length > window) {
    throw new RuntimeHostError(
      'io_tsd_unreadable',
      `TSD helper stdout is not one framed read of ${path}: ${stdout.length} bytes on the pipe, ${
        framed ? `framed as ${declared}` : 'no frame header'
      }`
    );
  }
  return payload;
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
