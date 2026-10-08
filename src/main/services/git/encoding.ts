import { createRequire } from 'node:module';
import iconv from 'iconv-lite';

// isbinaryfile is CJS; use createRequire to bypass ESM linker in ASAR
const { isBinaryFile } = createRequire(import.meta.url)('isbinaryfile') as {
  isBinaryFile: typeof import('isbinaryfile')['isBinaryFile'];
};

import jschardet from 'jschardet';
import { isFileTsdEncrypted, readFileTsdSafe } from '../../utils/tsdSafeRead';
import {
  GIT_BLOB_MAX_BYTES,
  GIT_BLOB_READ_TIMEOUT_MS,
  isGitExitError,
  isGitOutputTooLarge,
  isGitReadTimeout,
  readGitBuffer,
} from './gitReadFallback';

export function decodeBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return '';
  const detected = jschardet.detect(buffer);
  const encoding = detected?.encoding || 'utf-8';
  return iconv.decode(buffer, encoding);
}

/**
 * Read a working-tree file the way Main must (ARD D13): the encrypted Windows
 * host hands unwhitelisted processes ciphertext, and Main is unwhitelisted.
 */
export function readWorkingTreeFile(filePath: string): Promise<Buffer> {
  return readFileTsdSafe(filePath);
}

/**
 * Detect if a file is binary by checking the file on disk or its git content.
 * Tries disk file first; on ENOENT falls back to git content inspection.
 * Returns false (text) on any detection failure.
 */
export async function detectBinaryFile(
  filePath: string,
  gitWorkdir: string,
  gitRef: string
): Promise<boolean> {
  try {
    // TSD ciphertext looks binary to every sniffer, so a whole text working
    // tree would render as "binary" (D13). Decrypt first, and only then, so
    // ordinary files keep the cheap 512-byte path-based probe.
    if (await isFileTsdEncrypted(filePath)) {
      const buffer = await readWorkingTreeFile(filePath);
      return buffer.length > 0 && (await isBinaryFile(buffer, buffer.length));
    }
    return await isBinaryFile(filePath);
  } catch (err: unknown) {
    // File not on disk (deleted/renamed), fall through to git content
    if (
      !(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT')
    ) {
      return false;
    }
  }
  try {
    const buffer = await gitShowBuffer(gitWorkdir, gitRef);
    if (buffer.length === 0) return false;
    return await isBinaryFile(buffer, buffer.length);
  } catch {
    return false;
  }
}

export const GIT_BLOB_TOO_LARGE = 'GIT_BLOB_TOO_LARGE';
export const GIT_BLOB_READ_TIMEOUT = 'GIT_BLOB_READ_TIMEOUT';

/** A blob the diff and conflict views cannot show: too large, or not read in time. */
export class GitBlobReadError extends Error {
  readonly code: typeof GIT_BLOB_TOO_LARGE | typeof GIT_BLOB_READ_TIMEOUT;

  constructor(code: GitBlobReadError['code'], message: string, cause: unknown) {
    // The code leads the message: it is what survives Electron's IPC wrapper.
    super(`${code}: ${message}`, { cause });
    this.code = code;
  }
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * `git show <ref>` as raw bytes.
 *
 * Empty only when git itself said no (a non-zero exit): the path is not in that
 * revision (the normal case for added and deleted files), the revision does not
 * exist (a root commit's parent, an unborn HEAD), or the conflict stage is
 * absent. Every other failure rejects, so a view never shows a file as empty or
 * newly added because its content could not be read:
 * - over `GIT_BLOB_MAX_BYTES` on either path -> `GIT_BLOB_TOO_LARGE`;
 * - past `GIT_BLOB_READ_TIMEOUT_MS` -> `GIT_BLOB_READ_TIMEOUT`;
 * - lost output, a runner or a directory that failed -> that error as is.
 *
 * F3: an empty blob is a real answer, so an empty stdout cannot show that the
 * output was lost; once a lost read has been recovered elsewhere in this
 * process, this goes through the node runner like every other read (see
 * `gitReadFallback`). Bytes, not text: `decodeBuffer` detects the encoding.
 */
export async function gitShowBuffer(workdir: string, ref: string): Promise<Buffer> {
  try {
    const { stdout } = await readGitBuffer({
      what: 'show',
      workdir,
      args: ['show', ref],
      lostWhen: 'never',
      timeoutMs: GIT_BLOB_READ_TIMEOUT_MS,
      maxBytes: GIT_BLOB_MAX_BYTES,
    });
    return stdout;
  } catch (error) {
    if (isGitExitError(error)) return Buffer.alloc(0);
    if (isGitOutputTooLarge(error)) {
      throw new GitBlobReadError(
        GIT_BLOB_TOO_LARGE,
        `${ref} is larger than ${megabytes(GIT_BLOB_MAX_BYTES)}`,
        error
      );
    }
    if (isGitReadTimeout(error)) {
      throw new GitBlobReadError(
        GIT_BLOB_READ_TIMEOUT,
        `reading ${ref} took longer than ${GIT_BLOB_READ_TIMEOUT_MS / 1000} s`,
        error
      );
    }
    throw error;
  }
}

export async function gitShow(workdir: string, ref: string): Promise<string> {
  const buffer = await gitShowBuffer(workdir, ref);
  return decodeBuffer(buffer);
}
