/**
 * The identity stub of a DSH-backed chat session (dsh-rebase decisions 006 and
 * 007): the small file Main keeps as the session's durable `sessionFile`,
 * `$DSH_HOME/aiclient-sessions/<dshSessionId>.dsh.json`, naming the DSH
 * session and its fixed cwd.
 *
 * Shared by the session runtime (create, resume) and the host's read-only
 * `readPage` (decision 030), which must read and check a stub exactly as a
 * resume does.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { PiWorkerSessionError } from '../../agent-host/piWorkerErrors.ts';

/** The file Main keeps as this session's durable identity (`sessionFile`, decision 006). */
export interface SessionStub {
  engine: 'dsh';
  version: 1;
  dshSessionId: string;
  logicalSessionId: string;
  cwd: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

/** Directory under `$DSH_HOME` holding the identity stubs, and their suffix. */
export const DSH_STUB_DIR = 'aiclient-sessions';
export const DSH_STUB_SUFFIX = '.dsh.json';

/** A stub that names nothing on disk, or a DSH session that is gone. */
export const DSH_SESSION_MISSING = 'dsh_session_missing';
/** A file that is not a stub, or a stub for another session. */
export const SESSION_INVALID = 'session_invalid';

/** The id becomes a file name, so nothing that could leave the stub directory. */
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function stubPathFor(home: string, dshSessionId: string): string {
  return join(home, DSH_STUB_DIR, `${dshSessionId}${DSH_STUB_SUFFIX}`);
}

export function isSessionStub(value: unknown): value is SessionStub {
  const stub = value as Partial<SessionStub> | null;
  return (
    typeof stub === 'object' &&
    stub !== null &&
    stub.engine === 'dsh' &&
    stub.version === 1 &&
    typeof stub.dshSessionId === 'string' &&
    SAFE_SESSION_ID.test(stub.dshSessionId) &&
    typeof stub.logicalSessionId === 'string' &&
    typeof stub.cwd === 'string' &&
    stub.cwd.length > 0
  );
}

/** The stub at `file`; `dsh_session_missing` when there is none, `session_invalid` when it is not one. */
export function readStub(file: string): SessionStub {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new PiWorkerSessionError(
        DSH_SESSION_MISSING,
        `DSH session identity is missing: ${file}`
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isSessionStub(parsed)) {
    throw new PiWorkerSessionError(SESSION_INVALID, `Not a DSH session identity: ${file}`);
  }
  return parsed;
}

/** Temp file + fsync + rename: a reader sees the old stub or the whole new one, never half. */
export function writeStubAtomically(file: string, stub: SessionStub): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(stub, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
