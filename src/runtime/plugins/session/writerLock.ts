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
 * Who holds `lock`, or `undefined` when the file names nobody we can identify —
 * it vanished between calls, or its contents are not a readable owner record
 * (a torn write from the crash that stranded it).
 */
async function readOwner(
  io: RuntimeHostIoService,
  lock: string
): Promise<WriterLockOwner | undefined> {
  let bytes: Uint8Array;
  try {
    const read = await io.readFile(lock, { maxBytes: MAX_LOCK_BYTES, overflow: 'truncate' });
    if (read.truncated) return undefined;
    bytes = read.bytes;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  return parseOwner(new TextDecoder().decode(bytes));
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
function stale(owner: WriterLockOwner | undefined): boolean {
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

/**
 * Remove a lock we judged stale, exclusively.
 *
 * Renaming aside rather than unlinking is what makes the takeover safe under a
 * race: two processes can both unlink, and the second one would delete the
 * fresh lock the first just created. Only one rename of a given name can
 * succeed, so the loser sees `ENOENT`, falls through to the create below, and
 * is rejected there if the winner already owns the session.
 */
async function clearStale(io: RuntimeHostIoService, lock: string): Promise<void> {
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    await io.rename(lock, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  await io.unlink(aside).catch((error) => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
}

/**
 * Take the writer lock for `file`, reclaiming it from a dead owner if needed.
 *
 * Throws `session_locked` when a live writer holds it, or when another process
 * won the same takeover race. Returns the lock path the caller must `unlink`
 * on close.
 */
export async function acquireWriterLock(io: RuntimeHostIoService, file: string): Promise<string> {
  const lock = writerLockPath(file);
  const claim = Buffer.from(
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: randomUUID(),
      acquiredAt: Date.now(),
    } satisfies WriterLockOwner)
  );
  // Attempt 0 claims a free lock; attempt 1 claims one we just cleared.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await io.writeFile(lock, claim, { createOnly: true, mode: 0o600 });
      return lock;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    if (attempt > 0) break;
    const owner = await readOwner(io, lock);
    if (!stale(owner)) throw locked(file, owner);
    await clearStale(io, lock);
  }
  throw locked(file, undefined);
}
