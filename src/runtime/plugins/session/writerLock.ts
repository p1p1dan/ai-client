/**
 * The advisory single-writer lock guarding one session JSONL file.
 *
 * The lock is a sidecar file created with `createOnly`, so creation is the
 * mutual exclusion: whoever creates it owns the session. The problem this
 * module exists to solve is what happens when the owner never gets to delete
 * it. A crash, a `SIGKILL`, or a force-quit leaves the sidecar on disk, and a
 * lock that is only ever tested for existence then rejects the session
 * forever — the user reopens a conversation and gets `session_locked` with no
 * writer anywhere on the machine.
 *
 * So the owner is recorded in the file and verified before we refuse. A lock
 * whose recorded process is gone is stale and can be taken over; a lock we
 * cannot attribute to a live local process — foreign host, unreadable content —
 * is left alone, because refusing a session is recoverable and two concurrent
 * writers on the same JSONL are not.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode, RuntimeHostError } from '../../host/errors.ts';

/** What the sidecar records about the process holding the lock. */
export interface WriterLockOwner {
  pid: number;
  /** Machine the pid is meaningful on. Absent in locks written before this field existed. */
  host?: string;
  token: string;
  acquiredAt?: number;
}

/**
 * A lock this process holds.
 *
 * The token is carried rather than recomputed: it is the only thing that tells
 * the lock we created apart from one that replaced it, and releasing is the
 * moment that distinction matters.
 */
export interface WriterLock {
  path: string;
  token: string;
}

/** The sidecar as it was on disk, kept verbatim so a takeover can prove identity. */
interface LockFile {
  bytes: Buffer;
  /** Absent when the content is torn, oversized, or otherwise not an owner record. */
  owner?: WriterLockOwner;
}

/** A lock file is a single small JSON object; anything larger is not one of ours. */
const MAX_LOCK_BYTES = 4096;

export function writerLockPath(file: string): string {
  return `${file}.writer.lock`;
}

/**
 * Whether `pid` still exists on this machine.
 *
 * `EPERM` counts as alive: the process is there, it just belongs to another
 * user. Only `ESRCH` — no such process — makes a lock stale.
 */
function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function parseOwner(text: string): WriterLockOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== 'number' || typeof record.token !== 'string') return undefined;
  return {
    pid: record.pid,
    token: record.token,
    ...(typeof record.host === 'string' ? { host: record.host } : {}),
    ...(typeof record.acquiredAt === 'number' ? { acquiredAt: record.acquiredAt } : {}),
  };
}

/**
 * Read `lock`, or `undefined` when there is no file there.
 *
 * The raw bytes come back alongside the parsed owner because the takeover below
 * compares them: a lock with no readable owner (a torn write from the crash
 * that stranded it) still has an identity we must not confuse with another
 * process's fresh claim.
 */
async function readLock(io: RuntimeHostIoService, lock: string): Promise<LockFile | undefined> {
  let read: { bytes: Uint8Array; truncated: boolean };
  try {
    read = await io.readFile(lock, { maxBytes: MAX_LOCK_BYTES, overflow: 'truncate' });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  const bytes = Buffer.from(read.bytes);
  // Oversized content is not a lock of ours, so it names no owner; the prefix
  // still serves as the identity the takeover compares.
  return read.truncated ? { bytes } : { bytes, owner: parseOwner(bytes.toString('utf8')) };
}

/**
 * Whether the lock can be taken over.
 *
 * Locks written on another machine are never stolen: `pid` means nothing here,
 * so a session directory on a network share would otherwise let two hosts write
 * the same file. Locks predating the `host` field are treated as local, which is
 * what they always were — they can only have been written by this app against
 * its own per-machine session directory.
 */
function stale(held: LockFile): boolean {
  const owner = held.owner;
  if (owner === undefined) return true;
  if (owner.host !== undefined && owner.host !== hostname()) return false;
  return !processAlive(owner.pid);
}

function locked(file: string, owner: WriterLockOwner | undefined): RuntimeHostError {
  const held =
    owner === undefined
      ? ''
      : ` (pid ${owner.pid}${owner.host !== undefined ? ` on ${owner.host}` : ''})`;
  return new RuntimeHostError('session_locked', `session already has a writer: ${file}${held}`);
}

async function unlinkQuiet(io: RuntimeHostIoService, path: string): Promise<void> {
  await io.unlink(path).catch((error) => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
}

/**
 * Remove the stale lock we read, exclusively.
 *
 * Renaming aside rather than unlinking keeps two processes from both deleting
 * and both creating: only one rename of a given name can succeed.
 *
 * session-04 — but a rename moves a NAME, not the file we judged. Between our
 * read and our rename another process can finish the same takeover and create
 * its own lock under that name, and renaming that one aside would leave two
 * writers convinced they hold the session. So what we moved is checked against
 * what we read: anything else means we lost the race, and we put it back
 * (exclusively, in case the winner has already replaced it again) and report
 * the loss instead of creating a second claim.
 */
async function clearStale(
  io: RuntimeHostIoService,
  lock: string,
  expected: Buffer
): Promise<{ cleared: true } | { cleared: false; owner?: WriterLockOwner }> {
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    await io.rename(lock, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { cleared: true };
    throw error;
  }
  const moved = await readLock(io, aside);
  if (moved !== undefined && !moved.bytes.equals(expected)) {
    await io.writeFile(lock, moved.bytes, { createOnly: true, mode: 0o600 }).catch((error) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    await unlinkQuiet(io, aside);
    return moved.owner === undefined ? { cleared: false } : { cleared: false, owner: moved.owner };
  }
  await unlinkQuiet(io, aside);
  return { cleared: true };
}

/**
 * Take the writer lock for `file`, reclaiming it from a dead owner if needed.
 *
 * Throws `session_locked` when a live writer holds it, or when another process
 * won the same takeover race. Returns the handle the caller must pass to
 * `releaseWriterLock` on close.
 */
export async function acquireWriterLock(
  io: RuntimeHostIoService,
  file: string
): Promise<WriterLock> {
  const path = writerLockPath(file);
  const token = randomUUID();
  const claim = Buffer.from(
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token,
      acquiredAt: Date.now(),
    } satisfies WriterLockOwner)
  );
  // Attempt 0 claims a free lock; attempt 1 claims one we just cleared.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await io.writeFile(path, claim, { createOnly: true, mode: 0o600 });
      return { path, token };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    if (attempt > 0) break;
    const held = await readLock(io, path);
    // Gone between the create and the read: nothing to take over, just retry.
    if (held === undefined) continue;
    if (!stale(held)) throw locked(file, held.owner);
    const takeover = await clearStale(io, path, held.bytes);
    if (!takeover.cleared) throw locked(file, takeover.owner);
  }
  throw locked(file, undefined);
}

/**
 * Give up a lock we hold.
 *
 * session-05 — the token is verified instead of assumed. The sidecar sitting
 * under our path is not necessarily the one we created: a takeover race or a
 * hand cleanup can have replaced it, and unlinking someone else's lock would
 * hand the session to a third process while its writer is still running. A
 * lock that is no longer ours is left exactly as found; `false` says so.
 */
export async function releaseWriterLock(
  io: RuntimeHostIoService,
  lock: WriterLock
): Promise<boolean> {
  const held = await readLock(io, lock.path);
  if (held?.owner?.token !== lock.token) return false;
  await unlinkQuiet(io, lock.path);
  return true;
}
