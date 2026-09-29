/**
 * The `aiclient-encrypted-read` row's wiring, free of Cordis and of DSH
 * imports (dsh-rebase P1-13c; decision 091). `plugin.ts` hands it the fs
 * service instance and the error constructor; the PowerShell reader is
 * injected, so the unit tests run on every platform.
 *
 * What this wraps on the service instance, and why:
 *
 *   readText / streamText    TSD ciphertext in, plaintext from the fallback
 *                            reader out, with dsh-fs-local's own text
 *                            semantics restated on it (NUL-sample binary
 *                            rejection, strict UTF-8 decoding)
 *   readBytes                same, with the caller's `maxBytes` enforced
 *                            against the plaintext length
 *   readByteRange            the byte window taken from the plaintext
 *   editText                 a clear `FS_ENCRYPTED` refusal — its private
 *                            `readForEdit` reads through node:fs directly,
 *                            so without this the model would meet the
 *                            misleading "binary file" error instead
 *
 * A file whose node-visible prefix does NOT start with the marker is left to
 * the original method untouched; the only extra cost of a normal read is the
 * 16-byte prefix read. Every fallback outcome that is not trusted plaintext
 * raises `FS_ENCRYPTED` — ciphertext never reaches the model.
 */

import { BINARY_SAMPLE_BYTES, FALLBACK_MAX_PLAINTEXT_BYTES, FS_ENCRYPTED } from './constants.ts';
import type { FallbackReader, FsErrorCtor, FsReadService, Platform } from './dshTypes.ts';
import { isTsdHeader, readFilePrefix } from './tsdHeader.ts';

/** Marks a service this installer already wrapped; a second install is a no-op. */
const INSTALL_MARK = Symbol('aiclient-encrypted-read');

/** The refusal message every encrypted-file outcome shares. */
function encryptedRefusal(displayPath: string, verb: 'read' | 'edit', reason?: string): string {
  const head = `cannot ${verb} "${displayPath}": the file is protected by a disk-encryption policy`;
  return reason === undefined ? `${head} and cannot be read here` : `${head} — ${reason}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** One line of cause for a fallback failure, without leaking paths or stack. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * Read the file through the fallback reader and validate what came back:
 * still-ciphertext, an aborted read, a failed reader or an oversized result
 * all raise; only plaintext the marker check accepts gets through.
 */
async function fallbackPlaintext(
  reader: FallbackReader,
  targetKey: string,
  displayPath: string,
  signal: AbortSignal | undefined,
  createError: FsErrorCtor
): Promise<Uint8Array> {
  let plain: Uint8Array;
  try {
    plain = await reader(targetKey, signal);
  } catch (error) {
    if (isAbortError(error)) throw new createError('read aborted', 'FS_ABORTED');
    throw new createError(
      encryptedRefusal(displayPath, 'read', `the decryption fallback failed: ${reasonOf(error)}`),
      FS_ENCRYPTED,
      { cause: error }
    );
  }
  if (isTsdHeader(plain)) {
    throw new createError(
      encryptedRefusal(displayPath, 'read', 'the decryption fallback returned ciphertext too'),
      FS_ENCRYPTED
    );
  }
  if (plain.length > FALLBACK_MAX_PLAINTEXT_BYTES) {
    throw new createError(
      encryptedRefusal(
        displayPath,
        'read',
        `the decrypted file is larger than the ${FALLBACK_MAX_PLAINTEXT_BYTES}-byte fallback limit`
      ),
      FS_ENCRYPTED
    );
  }
  return plain;
}

/**
 * dsh-fs-local's whole-file text semantics, restated on fallback plaintext:
 * reject a NUL byte in the first {@link BINARY_SAMPLE_BYTES} bytes, then
 * decode strictly as UTF-8 — the same messages and codes the original raises.
 */
function decodeFallbackText(
  bytes: Uint8Array,
  displayPath: string,
  createError: FsErrorCtor
): string {
  if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new createError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new createError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT');
  }
}

export interface InstallEncryptedReadOptions {
  /** The fs service instance whose read methods get wrapped. */
  readonly service: FsReadService;
  /** Reads a whole file as the decryption-authorized reader sees it. */
  readonly reader: FallbackReader;
  /** Only `'win32'` wraps; any other value leaves the service untouched. */
  readonly platform: Platform;
  /** Builds the host's real `FsError`. */
  readonly createError: FsErrorCtor;
  readonly log?: (line: string) => void;
}

export interface InstallEncryptedReadResult {
  /** Whether this call wrapped the service (false: wrong platform, or already wrapped). */
  readonly wrapped: boolean;
  /** The method names this call wrapped, in call order. */
  readonly entries: readonly string[];
}

/**
 * Wrap the four read entrances and `editText` on the fs service instance with
 * the encrypted-file fallback. Idempotent: a service already wrapped is left
 * alone. On non-Windows platforms nothing happens at all.
 */
export function installEncryptedRead(
  options: InstallEncryptedReadOptions
): InstallEncryptedReadResult {
  const { service, reader, platform, createError } = options;
  const log = options.log ?? (() => {});
  if (platform !== 'win32') return { wrapped: false, entries: [] };
  if (INSTALL_MARK in service) {
    log('fs service already wrapped; leaving it alone');
    return { wrapped: false, entries: [] };
  }

  const originalReadText = service.readText.bind(service);
  const originalStreamText = service.streamText.bind(service);
  const originalReadBytes = service.readBytes.bind(service);
  const originalReadByteRange = service.readByteRange.bind(service);
  const originalEditText = service.editText.bind(service);

  /**
   * The marker decision for one target: `undefined` delegates to the original
   * method (not encrypted, or the prefix read failed — the original raises
   * the canonical error), `true` runs the fallback.
   */
  const needsFallback = async (
    targetKey: string,
    signal: AbortSignal | undefined
  ): Promise<boolean> => {
    const prefix = await readFilePrefix(targetKey, signal);
    return prefix !== null && isTsdHeader(prefix);
  };

  service.readText = async (target, signal) => {
    if (signal?.aborted || !(await needsFallback(target.targetKey, signal))) {
      return originalReadText(target, signal);
    }
    const plain = await fallbackPlaintext(
      reader,
      target.targetKey,
      target.displayPath,
      signal,
      createError
    );
    return decodeFallbackText(plain, target.displayPath, createError);
  };

  service.streamText = async (target, signal) => {
    if (signal?.aborted || !(await needsFallback(target.targetKey, signal))) {
      return originalStreamText(target, signal);
    }
    const plain = await fallbackPlaintext(
      reader,
      target.targetKey,
      target.displayPath,
      signal,
      createError
    );
    const text = decodeFallbackText(plain, target.displayPath, createError);
    // Chunk boundaries carry no meaning downstream; one chunk is a valid stream.
    return (async function* singleChunk() {
      yield text;
    })();
  };

  service.readBytes = async (target, signal, maxBytes) => {
    if (signal?.aborted || !(await needsFallback(target.targetKey, signal))) {
      return originalReadBytes(target, signal, maxBytes);
    }
    const plain = await fallbackPlaintext(
      reader,
      target.targetKey,
      target.displayPath,
      signal,
      createError
    );
    if (maxBytes !== undefined && plain.length > maxBytes) {
      throw new createError(
        `cannot read "${target.displayPath}": ${plain.length} bytes exceeds the ${maxBytes}-byte limit`,
        'FS_TOO_LARGE'
      );
    }
    return Buffer.from(plain);
  };

  service.readByteRange = async (target, range, signal) => {
    if (signal?.aborted || !(await needsFallback(target.targetKey, signal))) {
      return originalReadByteRange(target, range, signal);
    }
    if (
      !Number.isInteger(range?.offset) ||
      !Number.isInteger(range?.length) ||
      range.offset < 0 ||
      range.length < 0
    ) {
      throw new createError(
        `cannot read "${target.displayPath}": offset and length must be non-negative integers`,
        'FS_IO_ERROR'
      );
    }
    const plain = await fallbackPlaintext(
      reader,
      target.targetKey,
      target.displayPath,
      signal,
      createError
    );
    if (range.length === 0) return new Uint8Array(0);
    // A window at or past the end is empty, as in the original.
    return Buffer.from(plain.subarray(range.offset, range.offset + range.length));
  };

  service.editText = async (target, edit, expected, signal, sandboxPolicy) => {
    if (!signal?.aborted && (await needsFallback(target.targetKey, signal))) {
      throw new createError(encryptedRefusal(target.displayPath, 'edit'), FS_ENCRYPTED);
    }
    return originalEditText(target, edit, expected, signal, sandboxPolicy);
  };

  Object.defineProperty(service, INSTALL_MARK, { value: true, enumerable: false });
  const entries = ['readText', 'streamText', 'readBytes', 'readByteRange', 'editText'];
  log(`wrapped the fs service's ${entries.join(', ')} with the encrypted-read fallback`);
  return { wrapped: true, entries };
}
