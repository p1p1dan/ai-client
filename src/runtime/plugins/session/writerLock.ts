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
 *
 * ## The two things "verified" has to mean (concurrency-01, concurrency-02)
 *
 * 1. **A takeover never frees the name.** The lock is replaced by a `rename`
 *    over it, under a short-lived `.takeover` sentinel that serializes
 *    claimants. The earlier shape — move the lock aside, look at it, put it
 *    back — left the name absent for the length of a read, and a third claimant
 *    arriving in that window created its own lock without ever seeing the one
 *    it displaced. Two writers on one JSONL is exactly the outcome this module
 *    exists to prevent, so the window is closed rather than narrowed.
 * 2. **"The pid exists" is not "our writer is running."** Pid numbers are
 *    recycled — quickly on Windows, and unconditionally across a reboot — so a
 *    stranded lock whose number has been handed to an unrelated process would
 *    otherwise lock that conversation out for good. What is checked is whether
 *    the record can still describe the live process under that number, using
 *    the boot time and the recorded process start time. Anything left after
 *    that (a recycled pid on a machine that has not rebooted) is the user's
 *    call, through {@link WriterLockOptions.force}, which is what the refusal
 *    message points at.
 */

import { randomUUID } from 'node:crypto';
import { hostname, uptime } from 'node:os';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode, RuntimeHostError } from '../../host/errors.ts';

/** What the sidecar records about the process holding the lock. */
export interface WriterLockOwner {
  pid: number;
  /** Machine the pid is meaningful on. Absent in locks written before this field existed. */
  host?: string;
  token: string;
  acquiredAt?: number;
  /**
   * When the owning PROCESS started, not when it took the lock.
   *
   * windows-06 — the cross-platform half of "is this still the same process?".
   * Reading another process's start time is not portable, but our own is
   * (`process.uptime()`), which settles the one case a pid check gets
   * dangerously wrong: a lock recorded under a pid that this very process now
   * carries. Absent in locks written before this field existed.
   */
  startedAt?: number;
}

export interface WriterLockOptions {
  /**
   * Take the lock even from an owner that still looks alive.
   *
   * The remedy for the case no automatic rule can settle: a pid was recycled
   * on a machine that has not rebooted since, so the record is indistinguishable
   * from a live writer. Refusing forever means a conversation that can only be
   * reopened by deleting a file from deep inside the user's data directory, so
   * the decision is offered rather than taken — this flag is what an explicit
   * "open it anyway" acts through, and nothing sets it on its own.
   */
  force?: boolean;
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

/** Suffix of the sentinel that lets one claimant at a time attempt a takeover. */
const TAKEOVER_SUFFIX = '.takeover';

/**
 * How long a takeover sentinel can plausibly be held.
 *
 * A takeover is a handful of IO calls, so anything older was stranded by a
 * crash. Generous by a wide margin, because being wrong here means two
 * claimants replacing one lock; being late means one extra failed open.
 */
const TAKEOVER_MAX_AGE_MS = 60_000;

/**
 * Slack allowed when comparing a recorded timestamp against boot time.
 *
 * `Date.now()` moves when the clock is corrected and `os.uptime()` does not, so
 * the two drift. Only a lock comfortably older than this boot is treated as
 * predating it.
 */
const BOOT_SKEW_MS = 60_000;

/**
 * Slack allowed when comparing a recorded process start against our own.
 *
 * Both sides are `Date.now() - uptime`, sampled at different moments, so they
 * differ by the scheduling jitter between the two samples — milliseconds, never
 * seconds.
 */
const PROCESS_START_SKEW_MS = 5_000;

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

/** Epoch ms this process started. */
function processStartedAt(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

/** Epoch ms this machine booted; pid numbers only mean anything after it. */
function bootedAt(): number {
  return Date.now() - Math.round(uptime() * 1000);
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
    ...(typeof record.startedAt === 'number' ? { startedAt: record.startedAt } : {}),
  };
}

/** The record this process writes when it claims a lock or a sentinel. */
function claimBytes(token: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token,
      acquiredAt: Date.now(),
      startedAt: processStartedAt(),
    } satisfies WriterLockOwner)
  );
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
 *
 * concurrency-02 / windows-06 — a live pid is necessary but not sufficient. Two
 * further checks say when the number cannot still mean what the record says,
 * and both only ever REJECT an identity, so neither can call a running writer
 * stale:
 *
 * - a lock taken before this boot: pids are handed out afresh each boot, so
 *   whatever runs under that number now is a different process;
 * - a lock under OUR pid that records a different process start: the number is
 *   ours, the process it described is gone.
 *
 * A lock left by an app instance that died without a reboot, whose pid has since
 * been reused by an unrelated program, stays outside all of this on purpose. It
 * is indistinguishable from a live writer, and the answer to it is the user's
 * (see {@link WriterLockOptions.force}), not a timeout that could displace a
 * writer that is genuinely running.
 */
function stale(held: LockFile): boolean {
  const owner = held.owner;
  if (owner === undefined) return true;
  if (owner.host !== undefined && owner.host !== hostname()) return false;
  if (!processAlive(owner.pid)) return true;
  if (owner.acquiredAt !== undefined && owner.acquiredAt < bootedAt() - BOOT_SKEW_MS) return true;
  return (
    owner.pid === process.pid &&
    owner.startedAt !== undefined &&
    Math.abs(owner.startedAt - processStartedAt()) > PROCESS_START_SKEW_MS
  );
}

/**
 * Whether a takeover sentinel can be dropped.
 *
 * Age comes first and applies to every sentinel, foreign host included: a
 * sentinel is held for milliseconds, so an old one is debris, and leaving
 * unattributable debris in place would make the session unopenable for good —
 * the failure mode this module was built to end.
 */
function sentinelStale(held: LockFile): boolean {
  const owner = held.owner;
  if (owner === undefined) return true;
  if (owner.acquiredAt === undefined) return true;
  if (Date.now() - owner.acquiredAt > TAKEOVER_MAX_AGE_MS) return true;
  if (owner.acquiredAt < bootedAt() - BOOT_SKEW_MS) return true;
  if (owner.host !== undefined && owner.host !== hostname()) return false;
  return !processAlive(owner.pid);
}

/** How long the lock says it has been held, in words a user can act on. */
function heldFor(owner: WriterLockOwner | undefined): string {
  if (owner?.acquiredAt === undefined) return '';
  const minutes = Math.floor(Math.max(0, Date.now() - owner.acquiredAt) / 60_000);
  if (minutes < 1) return ', held for less than a minute';
  if (minutes < 60) return `, held for ${minutes}m`;
  return `, held for ${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * The refusal, and what a user can do about it.
 *
 * The owner and the age are in the message rather than only in a field because
 * this error crosses a process boundary as text before anything renders it: who
 * holds the session and for how long is how a user judges whether the holder
 * can still be real, and the remedy has to travel with the judgement.
 */
function locked(file: string, owner: WriterLockOwner | undefined): SessionLockedError {
  const held =
    owner === undefined
      ? ''
      : ` (pid ${owner.pid}${owner.host !== undefined ? ` on ${owner.host}` : ''}${heldFor(owner)})`;
  return new SessionLockedError(
    `session already has a writer: ${file}${held}. If that writer is gone, reopen it with a forced takeover.`,
    owner
  );
}

/** `session_locked`, carrying who holds it for an in-process caller that can ask. */
export class SessionLockedError extends RuntimeHostError {
  readonly owner?: WriterLockOwner;
  constructor(message: string, owner?: WriterLockOwner) {
    super('session_locked', message);
    if (owner !== undefined) this.owner = owner;
  }
}

async function unlinkQuiet(io: RuntimeHostIoService, path: string): Promise<void> {
  await io.unlink(path).catch((error) => {
    if (errorCode(error) !== 'ENOENT') throw error;
  });
}

/**
 * Hold the right to attempt a takeover of `lock`, or report that someone else
 * has it.
 *
 * `createOnly` is the exclusion, exactly as it is for the lock itself. A
 * sentinel left behind by a crash is dropped by renaming it aside rather than
 * unlinking it: only one process can move a given name, so the sentinel can
 * never be deleted twice and created twice. The lock the sentinel guards is
 * untouched throughout, so a claimant that arrives during any of this still
 * sees a lock under the name and still has to reason about its owner.
 */
async function holdSentinel(
  io: RuntimeHostIoService,
  sentinel: string
): Promise<string | undefined> {
  const token = randomUUID();
  const record = claimBytes(token);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await io.writeFile(sentinel, record, { createOnly: true, mode: 0o600 });
      return token;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    if (attempt > 0) break;
    const held = await readLock(io, sentinel);
    // Released between the create and the read: try once more for it.
    if (held === undefined) continue;
    if (!sentinelStale(held)) return undefined;
    const aside = `${sentinel}.${randomUUID()}.stale`;
    try {
      await io.rename(sentinel, aside);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      continue;
    }
    await unlinkQuiet(io, aside);
  }
  return undefined;
}

/** Give up the sentinel, unless a later claimant already replaced it. */
async function releaseSentinel(
  io: RuntimeHostIoService,
  sentinel: string,
  token: string
): Promise<void> {
  const held = await readLock(io, sentinel);
  if (held?.owner?.token !== token) return;
  await unlinkQuiet(io, sentinel);
}

/**
 * Replace the lock we judged with our own claim, exclusively.
 *
 * session-04 — what is guarded is not the file but the DECISION: between
 * reading an owner and acting on it, another process can finish the same
 * takeover, and acting on a stale reading would put two writers on one JSONL.
 * So the sentinel is taken first and the lock is read again under it; anything
 * other than the record we judged means we lost the race and report it.
 *
 * concurrency-01 — the replacement is a `rename` of a fully written claim over
 * the existing name, which is atomic on POSIX and on Windows alike. The name
 * therefore holds a lock at every instant: the old one, then ours. A claimant
 * that arrives mid-takeover always finds an owner to reason about, and never an
 * opening in which its own `createOnly` simply succeeds.
 */
async function takeOver(
  io: RuntimeHostIoService,
  lock: string,
  expected: Buffer,
  token: string,
  force: boolean
): Promise<{ taken: true } | { taken: false; owner?: WriterLockOwner }> {
  const sentinel = `${lock}${TAKEOVER_SUFFIX}`;
  const sentinelToken = await holdSentinel(io, sentinel);
  if (sentinelToken === undefined) return { taken: false };
  try {
    const held = await readLock(io, lock);
    if (held === undefined) {
      // The owner released it while we queued: claiming it is the takeover.
      try {
        await io.writeFile(lock, claimBytes(token), { createOnly: true, mode: 0o600 });
        return { taken: true };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const winner = await readLock(io, lock);
        return winner?.owner === undefined
          ? { taken: false }
          : { taken: false, owner: winner.owner };
      }
    }
    // Not the record we judged — someone replaced it while we queued. A forced
    // takeover is a decision about the session, not about one owner record, so
    // it goes ahead; an automatic one starts over from a fresh reading.
    if (!force && !held.bytes.equals(expected))
      return held.owner === undefined ? { taken: false } : { taken: false, owner: held.owner };
    const staging = `${lock}.${randomUUID()}.claim`;
    try {
      await io.writeFile(staging, claimBytes(token), { createOnly: true, mode: 0o600 });
      await io.rename(staging, lock);
    } catch (error) {
      await unlinkQuiet(io, staging);
      throw error;
    }
    return { taken: true };
  } finally {
    await releaseSentinel(io, sentinel, sentinelToken);
  }
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
  file: string,
  options?: WriterLockOptions
): Promise<WriterLock> {
  const path = writerLockPath(file);
  const token = randomUUID();
  const force = options?.force === true;
  // Attempt 0 claims a free lock; attempt 1 claims one released while we read.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await io.writeFile(path, claimBytes(token), { createOnly: true, mode: 0o600 });
      return { path, token };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    if (attempt > 0) break;
    const held = await readLock(io, path);
    // Gone between the create and the read: nothing to take over, just retry.
    if (held === undefined) continue;
    if (!force && !stale(held)) throw locked(file, held.owner);
    const takeover = await takeOver(io, path, held.bytes, token, force);
    if (takeover.taken) return { path, token };
    throw locked(file, takeover.owner);
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
