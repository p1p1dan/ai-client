import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { PiWorkerSessionError } from './piWorkerErrors.ts';

const HEADER_SCAN_LIMIT = 64 * 1024;
const HEADER_CHUNK_SIZE = 4 * 1024;

export interface PiSessionHeaderMetadata {
  sessionId: string;
  cwd: string;
  fileIdentity: { dev: bigint; ino: bigint };
}

function comparablePath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePiSessionPath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

export async function assertPiSessionFileIdentity(
  sessionFile: string,
  expected: PiSessionHeaderMetadata['fileIdentity']
): Promise<void> {
  let current: Awaited<ReturnType<typeof stat>>;
  try {
    current = await stat(sessionFile, { bigint: true });
  } catch (error) {
    throw new PiWorkerSessionError(
      'WORKER_SESSION_IDENTITY_MISMATCH',
      `Pi session file changed after preflight: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new PiWorkerSessionError(
      'WORKER_SESSION_IDENTITY_MISMATCH',
      `Pi session path was replaced between preflight and SDK open: ${sessionFile}`
    );
  }
}

/**
 * Validate the exact Pi JSONL identity without modifying it.
 *
 * This runs only inside the utility worker. It deliberately reads a bounded
 * prefix and requires a complete first non-empty JSONL record before the Pi
 * SDK is allowed to open the file; missing, empty, or foreign files therefore
 * cannot be turned into a new session by SessionManager.open().
 */
export async function preflightPiSessionFile(
  sessionFile: string,
  expectedCwd: string
): Promise<PiSessionHeaderMetadata> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(sessionFile, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_FILE_NOT_FOUND',
        `Pi session file does not exist: ${sessionFile}`
      );
    }
    throw new PiWorkerSessionError(
      'WORKER_SESSION_READ_FAILED',
      `Failed to inspect Pi session file ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  }
  if (!fileStat.isFile() || fileStat.size === 0n) {
    throw new PiWorkerSessionError(
      'WORKER_SESSION_FILE_CORRUPT',
      `Pi session file is empty or is not a regular file: ${sessionFile}`
    );
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(sessionFile, 'r');
    const chunks: Buffer[] = [];
    let total = 0;
    let buffered = '';
    let reachedEof = false;
    while (total < HEADER_SCAN_LIMIT) {
      const buffer = Buffer.allocUnsafe(Math.min(HEADER_CHUNK_SIZE, HEADER_SCAN_LIMIT - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
      buffered = Buffer.concat(chunks, total).toString('utf8');
      if (/\S[^\n]*\n/.test(buffered)) break;
      if (BigInt(total) >= fileStat.size) {
        reachedEof = true;
        break;
      }
    }

    const firstLine = buffered
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim();
    if (!firstLine || (!buffered.includes('\n') && !reachedEof)) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_FILE_CORRUPT',
        `Pi session header is missing or exceeds ${HEADER_SCAN_LIMIT} bytes: ${sessionFile}`
      );
    }

    let header: { type?: unknown; id?: unknown; cwd?: unknown };
    try {
      header = JSON.parse(firstLine) as { type?: unknown; id?: unknown; cwd?: unknown };
    } catch {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_FILE_CORRUPT',
        `Pi session header is not valid JSON: ${sessionFile}`
      );
    }
    if (
      header.type !== 'session' ||
      typeof header.id !== 'string' ||
      !header.id.trim() ||
      typeof header.cwd !== 'string' ||
      !header.cwd.trim()
    ) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_FILE_CORRUPT',
        `Pi session header is missing type, id, or cwd: ${sessionFile}`
      );
    }
    if (!samePiSessionPath(header.cwd, expectedCwd)) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_CWD_MISMATCH',
        `Pi session workspace mismatch: expected ${expectedCwd}, file declares ${header.cwd}`
      );
    }
    return {
      sessionId: header.id,
      cwd: header.cwd,
      fileIdentity: { dev: fileStat.dev, ino: fileStat.ino },
    };
  } catch (error) {
    if (error instanceof PiWorkerSessionError) throw error;
    throw new PiWorkerSessionError(
      'WORKER_SESSION_READ_FAILED',
      `Failed to read Pi session header ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`,
      true
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
