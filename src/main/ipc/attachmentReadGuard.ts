/**
 * D4 (round-5): the decision half of `file:readAttachment`, kept pure so it is
 * unit-testable — the handler around it only supplies the fd.
 *
 * §12 verification first: `__tests__/attachmentReadGuard.test.ts`.
 *
 * Two rules matter here:
 *  - the size verdict is reached from `stat`, BEFORE any read. An 8 MB PNG
 *    must be refused without ever entering main's memory, which is also what
 *    makes the rejection instant in the UI instead of a multi-second stall
 *    followed by an error.
 *  - every fact is read off ONE open handle (round-5 S1). `stat(path)` then
 *    `readFile(path)` is two independent name lookups: the bytes measured and
 *    the bytes returned need not be the same file at all.
 */
import {
  type AttachmentReadFailureReason,
  type AttachmentReadResult,
  MAX_ATTACHMENT_READ_BYTES,
} from '@shared/types/attachmentIo';
import type {
  AttachmentGrantSnapshot,
  PickedAttachmentGrant,
} from '../services/files/PickedAttachmentAccess';

/**
 * The budget actually applied to one read: the caller's tier limit, floored by
 * the process-wide ceiling.
 *
 * A missing / non-finite / non-positive `maxBytes` falls back to the ceiling
 * rather than to "unlimited". The ceiling is the LOOSEST budget this channel
 * ever applies (5 MB, the image tier) — the point of the fallback is that a
 * caller which forgets the option lands on a process ceiling instead of on no
 * bound at all. Choosing the stricter, tier-appropriate number is
 * `admitAttachment`'s job in the renderer, not this function's.
 */
export function effectiveAttachmentReadLimit(maxBytes: number | undefined): number {
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return MAX_ATTACHMENT_READ_BYTES;
  }
  return Math.min(Math.floor(maxBytes), MAX_ATTACHMENT_READ_BYTES);
}

/**
 * Verdict for one candidate attachment, or `null` when it may be read.
 *
 * Order is fixed (kind -> size) for the same reason `admitAttachment`'s is: a
 * directory is not "too large", it is the wrong thing entirely, and the
 * message the renderer prints has to match the reason it was given.
 */
export function checkAttachmentRead(
  stats: { isFile: boolean; size: number },
  maxBytes: number
): AttachmentReadFailureReason | null {
  if (!stats.isFile) return 'not-a-file';
  if (stats.size > effectiveAttachmentReadLimit(maxBytes)) return 'too-large';
  return null;
}

/** The subset of `fs.Stats` a grant is verified against. */
export interface AttachmentStatFacts {
  isFile(): boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/** The subset of `fs.promises.FileHandle` this module needs (injected in tests). */
export interface AttachmentFileHandle {
  stat(): Promise<AttachmentStatFacts>;
  readFile(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface AttachmentReadIo {
  open(filePath: string): Promise<AttachmentFileHandle>;
}

/**
 * Is the thing behind this fd still the thing the user picked?
 *
 * All four fields, not just the identity pair: `dev`/`ino` catch a file
 * REPLACED at the same path (a copy over it, a re-pointed symlink, a rename
 * into place), while `size`/`mtimeMs` catch the same inode being rewritten in
 * place. Either way the answer is the same — nobody granted us these bytes.
 *
 * The redundancy is also why this is not a POSIX-only check: Windows fills
 * `ino` from the file index, which can be 0 on some filesystems and is lossy
 * once it exceeds 2^53, so identity alone would be weaker there. Size and
 * mtime carry the check when it is.
 */
export function matchesGrantSnapshot(
  stats: AttachmentStatFacts,
  snapshot: AttachmentGrantSnapshot
): boolean {
  return (
    stats.dev === snapshot.dev &&
    stats.ino === snapshot.ino &&
    stats.size === snapshot.size &&
    stats.mtimeMs === snapshot.mtimeMs
  );
}

async function closeQuietly(handle: AttachmentFileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // A failed close cannot change the verdict already reached, and there is
    // nothing the renderer could do with the news. Leaking the fd is the only
    // real cost, and it is not one the caller can pay for us.
    return;
  }
}

/**
 * Read one granted attachment through a single open handle.
 *
 * The whole point is that the file is identified ONCE — by the fd — and every
 * subsequent fact (kind, identity, size, bytes) is taken off that same fd. The
 * previous `stat(path)` + `readFile(path)` shape had two windows a renderer
 * could drive a different file through: it could swap the file between the two
 * calls (TOCTOU on the size ceiling), and, more bluntly, it could `file:copy`
 * arbitrary bytes onto an already-granted path and read them out verbatim,
 * because none of the copy/rename/move channels know anything about attachment
 * grants. Neither works against an fd: `open` follows the symlink or resolves
 * the name exactly once, and anything that arrived afterwards has a different
 * `{dev, ino, size, mtimeMs}` than the snapshot taken at pick time.
 *
 * Pure orchestration, with `io` injected, so `__tests__` can assert the ORDER
 * of the checks (refused before reading) rather than just their outcomes.
 */
export async function readAttachmentViaHandle(
  io: AttachmentReadIo,
  grant: PickedAttachmentGrant,
  maxBytes: number | undefined
): Promise<AttachmentReadResult> {
  const limit = effectiveAttachmentReadLimit(maxBytes);

  let handle: AttachmentFileHandle;
  try {
    handle = await io.open(grant.path);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }

  try {
    let stats: AttachmentStatFacts;
    try {
      stats = await handle.stat();
    } catch {
      return { ok: false, reason: 'unreadable' };
    }

    // One verdict, spent in three steps: kind -> identity -> size. A swapped
    // file has to read as `not-allowed` — reporting `too-large` instead would
    // both misname the failure and leak the size of a file nobody granted.
    const verdict = checkAttachmentRead({ isFile: stats.isFile(), size: stats.size }, limit);
    if (verdict === 'not-a-file') return { ok: false, reason: 'not-a-file' };
    if (!matchesGrantSnapshot(stats, grant.snapshot)) return { ok: false, reason: 'not-allowed' };
    if (verdict === 'too-large') return { ok: false, reason: 'too-large', byteLength: stats.size };

    let data: Uint8Array;
    try {
      data = await handle.readFile();
    } catch {
      return { ok: false, reason: 'unreadable' };
    }

    // Re-checked against what we actually hold, not against what `stat` said:
    // a file appended to between the two must not pass on the strength of its
    // old size, and the snapshot's size is the last word on how big the bytes
    // the user consented to were.
    if (data.byteLength > limit) {
      return { ok: false, reason: 'too-large', byteLength: data.byteLength };
    }
    if (data.byteLength !== grant.snapshot.size) {
      return { ok: false, reason: 'not-allowed' };
    }

    // Copy, never a view: a Node `Buffer` can be a window onto a shared
    // allocation pool, and handing its backing store across the bridge would
    // hand over whatever else lives in it.
    return { ok: true, bytes: new Uint8Array(data), byteLength: data.byteLength };
  } finally {
    await closeQuietly(handle);
  }
}
