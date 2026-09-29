/**
 * The identity stub of a DSH-backed chat session (dsh-rebase decisions 006 and
 * 007): the small file Main keeps as the session's durable `sessionFile`,
 * `$DSH_HOME/aiclient-sessions/<dshSessionId>.dsh.json`, naming the DSH
 * session and its fixed cwd.
 *
 * The stub is a mutable pointer (decision 006): a rewind moves `dshSessionId`
 * to a seeded child session and keeps the path. Version 2 (P1-4b, decision
 * 027) adds `lineage`, every DSH session this chat has been, oldest first,
 * the current one last; a version 1 stub reads as a lineage of one.
 *
 * Shared by the session runtime (create, resume, rewind, fork) and the host's
 * read-only `readPage` (decision 030), which must read and check a stub
 * exactly as a resume does.
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
import type { SeedOrigin } from '../../shared/legacyPiSession/convert/types.ts';

/** One DSH session a chat has been (decision 027). */
export interface SessionLineageEntry {
  dshSessionId: string;
  reason: 'create' | 'rewind' | 'fork';
  /** The session the seed was cut from; absent for `create`. */
  parentDshSessionId?: string;
  /** Last seq of the parent the child inherited; absent for an empty child. */
  cutSeq?: number;
  /** Epoch milliseconds. */
  at: number;
}

/** The file Main keeps as this session's durable identity (`sessionFile`, decision 006). */
export interface SessionStub {
  engine: 'dsh';
  /** 1 before P1-4b; every write since is 2. */
  version: 1 | 2;
  /** The DSH session the chat continues in: always the last of `lineage`. */
  dshSessionId: string;
  logicalSessionId: string;
  cwd: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Version 2: oldest first, only ever appended to. */
  lineage?: SessionLineageEntry[];
  /**
   * P1-9c (decision 054): the chat was migrated from a 1.0.x pi session, and
   * this is what was converted; P1-9f (decision 056): or imported from a
   * Claude Code / Codex conversation. Absent for a chat that began on DSH, and
   * for a fork (its own chat, even when cut from a seeded one); a rewind keeps it.
   */
  origin?: SessionStubOrigin;
}

/**
 * A seeded chat's source (`seedSession.ts`): for a migration, what was
 * converted, from which file, when; for an import (P1-9f, decision 056), the
 * conversation it was made of and when.
 */
export type SessionStubOrigin =
  | (Extract<SeedOrigin, { kind: 'pi-session' }> & {
      /** Epoch milliseconds. */
      migratedAt: number;
      /** The file Main named and what it held when read; for a legacy file, the file itself, not its copy. */
      file: { path: string; sha256: string; bytes: number; mtimeMs: number };
    })
  | (Extract<SeedOrigin, { kind: 'imported-conversation' }> & {
      /** Epoch milliseconds. */
      importedAt: number;
    });

/** The version this build writes. */
export const SESSION_STUB_VERSION = 2 as const;

/** Directory under `$DSH_HOME` holding the identity stubs, and their suffix. */
export const DSH_STUB_DIR = 'aiclient-sessions';
export const DSH_STUB_SUFFIX = '.dsh.json';
/** The session-grant sidecar beside a stub (decision 043): `<stub id>.dsh.grants.json`. */
export const DSH_GRANTS_SUFFIX = '.dsh.grants.json';

/** A stub that names nothing on disk, or a DSH session that is gone. */
export const DSH_SESSION_MISSING = 'dsh_session_missing';
/** A file that is not a stub, or a stub for another session. */
export const SESSION_INVALID = 'session_invalid';

/** The id becomes a file name, so nothing that could leave the stub directory. */
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function stubPathFor(home: string, dshSessionId: string): string {
  return join(home, DSH_STUB_DIR, `${dshSessionId}${DSH_STUB_SUFFIX}`);
}

function isLineageEntry(value: unknown): value is SessionLineageEntry {
  const entry = value as Partial<SessionLineageEntry> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.dshSessionId === 'string' &&
    SAFE_SESSION_ID.test(entry.dshSessionId) &&
    (entry.reason === 'create' || entry.reason === 'rewind' || entry.reason === 'fork') &&
    (entry.parentDshSessionId === undefined ||
      (typeof entry.parentDshSessionId === 'string' &&
        SAFE_SESSION_ID.test(entry.parentDshSessionId))) &&
    (entry.cutSeq === undefined || (Number.isSafeInteger(entry.cutSeq) && entry.cutSeq >= 0))
  );
}

export function isSessionStub(value: unknown): value is SessionStub {
  const stub = value as Partial<SessionStub> | null;
  if (
    typeof stub !== 'object' ||
    stub === null ||
    stub.engine !== 'dsh' ||
    (stub.version !== 1 && stub.version !== 2) ||
    typeof stub.dshSessionId !== 'string' ||
    !SAFE_SESSION_ID.test(stub.dshSessionId) ||
    typeof stub.logicalSessionId !== 'string' ||
    typeof stub.cwd !== 'string' ||
    stub.cwd.length === 0 ||
    // Read opaquely beyond its kind: a newer origin must not make the chat unopenable.
    (stub.origin !== undefined &&
      (typeof stub.origin !== 'object' ||
        stub.origin === null ||
        Array.isArray(stub.origin) ||
        typeof (stub.origin as { kind?: unknown }).kind !== 'string'))
  ) {
    return false;
  }
  if (stub.version === 1 || stub.lineage === undefined) return true;
  // A lineage that does not end at the session the stub names points nowhere safe.
  return (
    Array.isArray(stub.lineage) &&
    stub.lineage.length > 0 &&
    stub.lineage.every(isLineageEntry) &&
    stub.lineage.at(-1)?.dshSessionId === stub.dshSessionId
  );
}

/** Every DSH session of the stub's chat, oldest first; a version 1 stub was only ever created. */
export function stubLineage(stub: SessionStub): SessionLineageEntry[] {
  if (stub.lineage && stub.lineage.length > 0) return stub.lineage.map((entry) => ({ ...entry }));
  return [{ dshSessionId: stub.dshSessionId, reason: 'create', at: stub.createdAt }];
}

/**
 * The session-grant sidecar beside a stub (decision 043, P1-6 design §7):
 * `<dshSessionId>.dsh.grants.json`, named after the stub file, so a rewind
 * that repoints the stub keeps it.
 */
export function grantsSidecarFor(stubFile: string): string {
  return stubFile.endsWith(DSH_STUB_SUFFIX)
    ? `${stubFile.slice(0, -DSH_STUB_SUFFIX.length)}${DSH_GRANTS_SUFFIX}`
    : `${stubFile}.grants.json`;
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
