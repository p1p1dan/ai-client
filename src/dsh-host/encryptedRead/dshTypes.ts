/**
 * Narrow structural views of the DSH shapes the `aiclient-encrypted-read`
 * row reads (DSH 0.1.7-rc.2: dsh-fs, dsh-fs-local, dsh-fs-sandbox).
 *
 * Declared here instead of imported so the row's unit tests build them by
 * hand and the row's bundle takes in no DSH types, like the loop guard's
 * `dshTypes.ts`.
 */

/** dsh-fs `FsTarget` as far as this row reads it. */
export interface FsTarget {
  /** The backend's canonical absolute path; what gets opened. */
  readonly targetKey: string;
  /** The caller-facing path used in error messages. */
  readonly displayPath: string;
}

/** dsh-fs `FsByteRange`: `offset` is 0-based, `length` the largest byte count. */
export interface FsByteRange {
  readonly offset: number;
  readonly length: number;
}

/** dsh-fs `FsStat`: what `stat` returns for an existing path. */
export interface FsStatView {
  readonly version: unknown;
  readonly type: string;
  readonly size: number;
}

/**
 * dsh-fs `FsWriteIntent`: the optimistic guard a write carries. Only
 * `replaceIfVersion` is built here — the encrypted-edit path writes back the
 * exact version it read (P1-13d; decision 135).
 */
export interface ReplaceIfVersionIntent {
  readonly kind: 'replaceIfVersion';
  readonly version: unknown;
}

/** What `writeText` returns; only the fields the edit path reports back. */
export interface FsWriteOutcome {
  readonly operation: string;
  readonly version: unknown;
  readonly before: string | null;
  readonly after: string;
}

/** dsh-fs `FsError`: a stable `code` plus a human-readable message. */
export interface FsErrorView extends Error {
  readonly code: string;
}

/** Builds the host's real `FsError`; injected so the pure logic stays DSH-free. */
export type FsErrorCtor = new (
  message: string,
  code: string,
  options?: { cause?: unknown }
) => FsErrorView;

/**
 * The slice of the `fs` service this row wraps (dsh-fs-local
 * `LocalFileSystem`, as extended by dsh-fs-sandbox `SandboxedFileSystem`):
 * the four read entrances plus `editText`, whose private `readForEdit` reads
 * through node:fs directly and therefore cannot be intercepted the same way.
 *
 * `stat` and `writeText` are on the same instance for the same reason: the
 * encrypted-edit path (P1-13d; decision 135) checks the read's version through
 * the service's own `stat` and writes back through its `writeText` with a
 * `replaceIfVersion` guard, so both the version compare and the sandbox fence
 * stay the backend's, never a copy; `checkedTarget` (optional) lets the edit
 * run that fence before its fallback read rather than only at write time.
 */
export interface FsReadService {
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>;
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>;
  readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes?: number
  ): Promise<Uint8Array>;
  readByteRange(target: FsTarget, range: FsByteRange, signal?: AbortSignal): Promise<Uint8Array>;
  editText(
    target: FsTarget,
    edit: unknown,
    expected: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown
  ): Promise<unknown>;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsStatView | undefined>;
  writeText(
    target: FsTarget,
    content: string,
    expected: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown
  ): Promise<FsWriteOutcome>;
  /**
   * dsh-fs-sandbox `SandboxedFileSystem.checkedTarget`: the per-call policy
   * fence its own `writeText` and `editText` run first, returning the exact
   * target the mutation must use or throwing `FS_SANDBOX_DENIED`. The
   * encrypted edit runs it before its fallback read, as the native edit
   * does. Absent on the unfenced dsh-fs-local backend.
   */
  checkedTarget?(target: FsTarget, sandboxPolicy?: unknown): Promise<FsTarget>;
}

/**
 * The slice of the row's Cordis context used here. `inject: ['fs']` orders
 * this row after the fs service; `ctx.get('fs')` then returns the registered
 * instance itself (Cordis `reflect.get` hands over the stored value), which
 * is the object whose own properties the wrapper shadows.
 */
export interface EncryptedReadRowContext {
  get(name: 'fs'): FsReadService | undefined;
}

/**
 * Reads every byte of one file as the decryption-authorized reader sees it.
 * Implementations own the process, its timeout, abort handling, output caps
 * and concurrency; they throw plain `Error`s the wrapper turns into
 * `FS_ENCRYPTED` refusals (an `AbortError` name maps to `FS_ABORTED`).
 */
export type FallbackReader = (path: string, signal?: AbortSignal) => Promise<Uint8Array>;

/** `process.platform` as the installer sees it; only `'win32'` wraps. */
export type Platform = NodeJS.Platform | string;
