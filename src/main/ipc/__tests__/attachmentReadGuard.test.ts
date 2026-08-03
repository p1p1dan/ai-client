import { MAX_ATTACHMENT_READ_BYTES } from '@shared/types/attachmentIo';
import { describe, expect, it } from 'vitest';
import type { PickedAttachmentGrant } from '../../services/files/PickedAttachmentAccess';
import {
  type AttachmentFileHandle,
  type AttachmentReadIo,
  type AttachmentStatFacts,
  checkAttachmentRead,
  effectiveAttachmentReadLimit,
  matchesGrantSnapshot,
  readAttachmentViaHandle,
} from '../attachmentReadGuard';

/**
 * D4 (round-5): the main-process gate in front of `file:readAttachment`.
 *
 * What these lock is not arithmetic but two safety properties: the size
 * verdict is reachable from `stat` alone, so an oversized file is refused
 * WITHOUT being read; and every fact is taken off ONE open handle, so no file
 * can be substituted between the measurement and the bytes. The IO is injected
 * for exactly that reason — the ORDER of the checks is the property under
 * test, and it is invisible if only outcomes are asserted (vitest also runs in
 * node with no electron, so a real handler could not be exercised here).
 */

const KB = 1024;
const MB = 1024 * KB;

describe('effectiveAttachmentReadLimit (D4)', () => {
  it('takes the caller tier when it is stricter than the process ceiling', () => {
    expect(effectiveAttachmentReadLimit(512 * KB)).toBe(512 * KB);
  });

  it('never lets a caller raise the ceiling', () => {
    expect(effectiveAttachmentReadLimit(100 * MB)).toBe(MAX_ATTACHMENT_READ_BYTES);
    expect(effectiveAttachmentReadLimit(MAX_ATTACHMENT_READ_BYTES + 1)).toBe(
      MAX_ATTACHMENT_READ_BYTES
    );
  });

  // The ceiling is the LOOSEST budget this channel applies (5 MB, the image
  // tier) — the fallback is not "strictest", it is "a process ceiling instead
  // of none". Picking the tier-appropriate number is `admitAttachment`'s job.
  // What must never happen is "absent" resolving to "unlimited": that is
  // precisely the bug this channel would be dangerous for — an arbitrary-size
  // read of arbitrary bytes.
  it('falls back to the ceiling for a missing or nonsense budget, never to unlimited', () => {
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveAttachmentReadLimit(bad)).toBe(MAX_ATTACHMENT_READ_BYTES);
    }
  });
});

describe('checkAttachmentRead (D4)', () => {
  it('admits a normal file inside the budget', () => {
    expect(checkAttachmentRead({ isFile: true, size: 120 * KB }, 5 * MB)).toBeNull();
  });

  // A directory is not "too large", it is the wrong kind of thing — the reason
  // and the sentence the renderer prints have to agree, so kind is judged
  // before size (same fixed order as `admitAttachment`).
  it('reports a directory as not-a-file regardless of size', () => {
    expect(checkAttachmentRead({ isFile: false, size: 0 }, 5 * MB)).toBe('not-a-file');
    expect(checkAttachmentRead({ isFile: false, size: 50 * MB }, 5 * MB)).toBe('not-a-file');
  });

  it('is inclusive at the boundary and rejects one byte past it', () => {
    expect(checkAttachmentRead({ isFile: true, size: 512 * KB }, 512 * KB)).toBeNull();
    expect(checkAttachmentRead({ isFile: true, size: 512 * KB + 1 }, 512 * KB)).toBe('too-large');
  });

  it('applies the ceiling even when the caller asked for more', () => {
    expect(checkAttachmentRead({ isFile: true, size: 8 * MB }, 100 * MB)).toBe('too-large');
  });

  // The text tier is stricter than the ceiling, and it has to be the one that
  // fires for a .md file — otherwise a 3 MB text file would be pulled into
  // memory only for the renderer to refuse it afterwards.
  it('lets the caller tier reject below the ceiling', () => {
    expect(checkAttachmentRead({ isFile: true, size: 600 * KB }, 512 * KB)).toBe('too-large');
    expect(600 * KB).toBeLessThan(MAX_ATTACHMENT_READ_BYTES);
  });

  // Emptiness is NOT decided here: `admitAttachment` owns that verdict (and
  // its sentence) for both the paste and the picked path. Duplicating it would
  // be a second place to change and a second phrasing to drift.
  it('leaves the empty-file verdict to the renderer budget layer', () => {
    expect(checkAttachmentRead({ isFile: true, size: 0 }, 5 * MB)).toBeNull();
  });
});

/**
 * Round-5 S1: the handle flow.
 *
 * The threat these lock is not a race the user could lose by accident. It is a
 * renderer that owns `file:copy` / `file:rename` / `file:move` — none of which
 * know anything about attachment grants — writing arbitrary bytes onto a path
 * the user did legitimately pick, and then reading them back verbatim. The
 * grant covers a FILE, identified by `{dev, ino, size, mtimeMs}` at pick time;
 * whatever else may later answer to that name is a different file.
 */

const SNAPSHOT = { dev: 66, ino: 4242, size: 4, mtimeMs: 1_700_000_000_000 };
const GRANT: PickedAttachmentGrant = { path: '/home/dan/shot.png', snapshot: SNAPSHOT };
const GRANTED_BYTES = new Uint8Array([1, 2, 3, 4]);

interface FakeIoSetup {
  /** Overrides on top of the granted file's own facts. */
  stat?: Partial<Omit<AttachmentStatFacts, 'isFile'>> & { isFile?: boolean };
  openError?: boolean;
  statError?: boolean;
  readError?: boolean;
  closeError?: boolean;
  bytes?: Uint8Array;
}

function fakeIo(setup: FakeIoSetup = {}) {
  const calls = { opened: [] as string[], stat: 0, read: 0, close: 0 };

  const handle: AttachmentFileHandle = {
    stat: async () => {
      calls.stat += 1;
      if (setup.statError) throw new Error('EIO');
      const { isFile = true, ...facts } = setup.stat ?? {};
      return { ...SNAPSHOT, ...facts, isFile: () => isFile };
    },
    readFile: async () => {
      calls.read += 1;
      if (setup.readError) throw new Error('EIO');
      return setup.bytes ?? GRANTED_BYTES;
    },
    close: async () => {
      calls.close += 1;
      if (setup.closeError) throw new Error('EBADF');
    },
  };

  const io: AttachmentReadIo = {
    open: async (filePath: string) => {
      calls.opened.push(filePath);
      if (setup.openError) throw new Error('ENOENT');
      return handle;
    },
  };

  return { io, calls };
}

describe('matchesGrantSnapshot (round-5 S1)', () => {
  const stats = (over: Partial<typeof SNAPSHOT> = {}): AttachmentStatFacts => ({
    ...SNAPSHOT,
    ...over,
    isFile: () => true,
  });

  it('accepts only the exact file that was picked', () => {
    expect(matchesGrantSnapshot(stats(), SNAPSHOT)).toBe(true);
  });

  // Each field on its own, because each one catches a different substitution:
  // dev/ino a replacement file (copy over the path, re-pointed symlink,
  // rename into place), size/mtimeMs the same inode rewritten underneath us.
  it('rejects any single field drifting', () => {
    expect(matchesGrantSnapshot(stats({ dev: 67 }), SNAPSHOT)).toBe(false);
    expect(matchesGrantSnapshot(stats({ ino: 4243 }), SNAPSHOT)).toBe(false);
    expect(matchesGrantSnapshot(stats({ size: 5 }), SNAPSHOT)).toBe(false);
    expect(matchesGrantSnapshot(stats({ mtimeMs: SNAPSHOT.mtimeMs + 1 }), SNAPSHOT)).toBe(false);
  });
});

describe('readAttachmentViaHandle (round-5 S1)', () => {
  it('serves the granted file and closes the handle', async () => {
    const { io, calls } = fakeIo();

    const result = await readAttachmentViaHandle(io, GRANT, 5 * MB);

    expect(result).toEqual({ ok: true, bytes: GRANTED_BYTES, byteLength: 4 });
    // The path opened is the one MAIN recorded in the grant, never a string
    // the renderer supplied.
    expect(calls.opened).toEqual([GRANT.path]);
    expect(calls.close).toBe(1);
  });

  // THE test of this batch: the renderer copies a secret over an already
  // picked path and reads it back. The fd says a different inode, so nothing
  // is read at all.
  it('refuses a file swapped in behind the granted path, without reading it', async () => {
    const { io, calls } = fakeIo({ stat: { ino: 9999, size: 4096, mtimeMs: 1_800_000_000_000 } });

    const result = await readAttachmentViaHandle(io, GRANT, 5 * MB);

    expect(result).toEqual({ ok: false, reason: 'not-allowed' });
    expect(calls.read).toBe(0);
    expect(calls.close).toBe(1);
  });

  // Same inode, rewritten in place — the identity pair alone would have let
  // this through.
  it('refuses the granted inode rewritten underneath the grant', async () => {
    const { io, calls } = fakeIo({ stat: { size: 64, mtimeMs: SNAPSHOT.mtimeMs + 1 } });

    const result = await readAttachmentViaHandle(io, GRANT, 5 * MB);

    expect(result).toEqual({ ok: false, reason: 'not-allowed' });
    expect(calls.read).toBe(0);
  });

  // Kind is judged before identity so the honest sentence survives: a
  // directory is the wrong thing entirely, not an unauthorised one.
  it('names a directory not-a-file even when the snapshot no longer matches', async () => {
    const { io, calls } = fakeIo({ stat: { isFile: false, ino: 5, size: 0, mtimeMs: 1 } });

    const result = await readAttachmentViaHandle(io, GRANT, 5 * MB);

    expect(result).toEqual({ ok: false, reason: 'not-a-file' });
    expect(calls.read).toBe(0);
  });

  // The size ceiling still fires from `stat`, before any read — an 8 MB file
  // never enters main's memory — and it reports the size so the renderer can
  // print the same sentence a pasted file of that size gets.
  it('refuses an oversized granted file before reading it', async () => {
    const big = { ...SNAPSHOT, size: 8 * MB };
    const { io, calls } = fakeIo({ stat: { size: 8 * MB } });

    const result = await readAttachmentViaHandle(io, { path: GRANT.path, snapshot: big }, 5 * MB);

    expect(result).toEqual({ ok: false, reason: 'too-large', byteLength: 8 * MB });
    expect(calls.read).toBe(0);
    expect(calls.close).toBe(1);
  });

  // Identity before size: a swapped-in 8 MB file must read as `not-allowed`,
  // never as `too-large` — the second answer would misname the failure and
  // leak the size of a file nobody granted.
  it('prefers not-allowed over too-large for a substituted file', async () => {
    const { io } = fakeIo({ stat: { ino: 9999, size: 8 * MB } });

    expect(await readAttachmentViaHandle(io, GRANT, 5 * MB)).toEqual({
      ok: false,
      reason: 'not-allowed',
    });
  });

  // `stat` described the file at open time; the bytes are what we actually
  // hold. A file that grew between the two must not pass on its old size.
  it('re-checks the ceiling against the bytes actually read', async () => {
    const grown = new Uint8Array(600 * KB);
    const { io, calls } = fakeIo({ bytes: grown });

    const result = await readAttachmentViaHandle(io, GRANT, 512 * KB);

    expect(result).toEqual({ ok: false, reason: 'too-large', byteLength: 600 * KB });
    expect(calls.close).toBe(1);
  });

  it('re-checks the bytes against the snapshot size', async () => {
    const { io } = fakeIo({ bytes: new Uint8Array([1, 2, 3]) });

    expect(await readAttachmentViaHandle(io, GRANT, 5 * MB)).toEqual({
      ok: false,
      reason: 'not-allowed',
    });
  });

  // A Node `Buffer` can be a window onto a shared allocation pool, so the
  // bytes crossing the bridge are copied — handing over the backing store
  // would hand over whatever else lives in it.
  it('copies the bytes instead of exposing the surrounding buffer', async () => {
    const pool = new Uint8Array([9, 9, 1, 2, 3, 4, 9]);
    const { io } = fakeIo({ bytes: pool.subarray(2, 6) });

    const result = await readAttachmentViaHandle(io, GRANT, 5 * MB);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.bytes]).toEqual([1, 2, 3, 4]);
    expect(result.bytes.buffer).not.toBe(pool.buffer);
    expect(result.bytes.byteLength).toBe(4);
  });

  it('reports an unopenable path as unreadable and has no handle to close', async () => {
    const { io, calls } = fakeIo({ openError: true });

    expect(await readAttachmentViaHandle(io, GRANT, 5 * MB)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(calls.close).toBe(0);
  });

  // The fd is ours the moment `open` resolves: every exit after that — verdict
  // or IO failure — has to give it back, or a session of refused picks leaks
  // one descriptor each.
  it('closes the handle on every failure path after open', async () => {
    const statFail = fakeIo({ statError: true });
    expect(await readAttachmentViaHandle(statFail.io, GRANT, 5 * MB)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(statFail.calls.close).toBe(1);

    const readFail = fakeIo({ readError: true });
    expect(await readAttachmentViaHandle(readFail.io, GRANT, 5 * MB)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    expect(readFail.calls.close).toBe(1);
  });

  // A close that itself fails must not become the caller's answer: the verdict
  // was already reached, and there is nothing the renderer could do about it.
  it('keeps its verdict when closing the handle fails', async () => {
    const ok = fakeIo({ closeError: true });
    expect(await readAttachmentViaHandle(ok.io, GRANT, 5 * MB)).toEqual({
      ok: true,
      bytes: GRANTED_BYTES,
      byteLength: 4,
    });

    const refused = fakeIo({ closeError: true, stat: { ino: 9999 } });
    expect(await readAttachmentViaHandle(refused.io, GRANT, 5 * MB)).toEqual({
      ok: false,
      reason: 'not-allowed',
    });
  });

  // Same clamp as `effectiveAttachmentReadLimit`, exercised through the flow:
  // a caller that forgets its budget still cannot ask for an unbounded read.
  it('applies the process ceiling when the caller passes no budget', async () => {
    const huge = { ...SNAPSHOT, size: MAX_ATTACHMENT_READ_BYTES + 1 };
    const { io, calls } = fakeIo({ stat: { size: MAX_ATTACHMENT_READ_BYTES + 1 } });

    const result = await readAttachmentViaHandle(
      io,
      { path: GRANT.path, snapshot: huge },
      undefined
    );

    expect(result).toEqual({
      ok: false,
      reason: 'too-large',
      byteLength: MAX_ATTACHMENT_READ_BYTES + 1,
    });
    expect(calls.read).toBe(0);
  });
});
