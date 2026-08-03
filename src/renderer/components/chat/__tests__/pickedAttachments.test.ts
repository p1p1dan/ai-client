import type { AttachmentReadResult } from '@shared/types/attachmentIo';
import { describe, expect, it } from 'vitest';
import { admitAttachment, DEFAULT_ATTACHMENT_LIMITS } from '../attachmentLimits';
import {
  pickedCountSkipMessage,
  pickedFileName,
  pickedSkipMessage,
  plannedReadLimit,
  readPickedBatch,
  toArrayBuffer,
  unreadableMessage,
  unsupportedKindMessage,
} from '../pickedAttachments';

/**
 * D4 (round-5): the ⊕ menu's pure decisions.
 *
 * The whole point of this module is that picking a file must be
 * indistinguishable from pasting one once the bytes exist, so most of what is
 * asserted below is SAMENESS with the paste path — same budgets, same
 * sentences — rather than any new behaviour of its own.
 */

const KB = 1024;
const MB = 1024 * KB;

describe('pickedFileName (D4)', () => {
  it('takes the basename off both separators', () => {
    expect(pickedFileName('/home/dan/shot.png')).toBe('shot.png');
    // The path comes from the main process, so a renderer that assumed `/`
    // would show a full Windows path as the chip label.
    expect(pickedFileName('C:\\Users\\dan\\shot.png')).toBe('shot.png');
  });

  it('passes a bare name through and never returns an empty label', () => {
    expect(pickedFileName('shot.png')).toBe('shot.png');
    expect(pickedFileName('/trailing/')).toBe('/trailing/');
  });
});

describe('plannedReadLimit (D4)', () => {
  // A picked path has no MIME type at all — the same state a real `File` is in
  // on Windows — so the extension fallback is the load-bearing half here.
  it('reads an image tier off the extension alone', () => {
    expect(plannedReadLimit('shot.png')).toEqual({
      kind: 'image',
      mediaType: 'image/png',
      maxBytes: DEFAULT_ATTACHMENT_LIMITS.maxImageBytes,
    });
    expect(plannedReadLimit('PHOTO.JPEG')?.kind).toBe('image');
  });

  it('reads a text tier for everything the protocol carries as text', () => {
    expect(plannedReadLimit('notes.md')).toEqual({
      kind: 'text',
      mediaType: 'text/plain',
      maxBytes: DEFAULT_ATTACHMENT_LIMITS.maxTextBytes,
    });
    // SVG is markup, not one of the four supported image media types.
    expect(plannedReadLimit('icon.svg')?.kind).toBe('text');
  });

  it('refuses to plan a read the wire protocol could not carry', () => {
    expect(plannedReadLimit('bundle.zip')).toBeNull();
    expect(plannedReadLimit('clip.mp4')).toBeNull();
    expect(plannedReadLimit('scan.pdf')).toBeNull();
  });

  // The budgets are READ from the shared limits, never restated. If a
  // re-measure moves a tier, this path moves with it or this test fails.
  it('never invents a budget of its own', () => {
    expect(plannedReadLimit('shot.png')?.maxBytes).toBe(DEFAULT_ATTACHMENT_LIMITS.maxImageBytes);
    expect(plannedReadLimit('notes.md')?.maxBytes).toBe(DEFAULT_ATTACHMENT_LIMITS.maxTextBytes);
  });

  // Round-5 C3: the mirror assertions above are honest about DRIFT but blind
  // to a shared-constant edit — if someone set both tiers to 1 byte, they
  // would still pass. These three name the numbers, so the tiers cannot be
  // moved silently: a deliberate re-measure has to come and edit this test.
  it('asks main for 512 KB on a text file and 5 MB on an image, stated outright', () => {
    expect(plannedReadLimit('notes.md')?.maxBytes).toBe(512 * 1024);
    expect(plannedReadLimit('shot.png')?.maxBytes).toBe(5 * 1024 * 1024);
  });

  // An extension nobody has heard of is text, not "unsupported": the file may
  // well be a config or a log, and the read is bounded by the text tier
  // either way — `isProbablyBinary` is what refuses it after the bytes exist.
  it('plans an unknown extension as text at the text budget', () => {
    expect(plannedReadLimit('notes.xyzzy')).toEqual({
      kind: 'text',
      mediaType: 'text/plain',
      maxBytes: 512 * 1024,
    });
    expect(plannedReadLimit('Makefile')?.kind).toBe('text');
  });
});

describe('pickedSkipMessage (D4)', () => {
  // THE assertion of this file: a user must not be able to tell whether a 6 MB
  // image was refused by the renderer (pasted) or by the main process
  // (picked). The only way to guarantee that is for one function to produce
  // both sentences — so this compares against `admitAttachment` verbatim.
  it('speaks the exact sentence admitAttachment speaks for an oversized image', () => {
    const byteLength = 6 * MB;
    const pasted = admitAttachment([], { name: 'shot.png', kind: 'image', byteLength });
    expect(pasted.ok).toBe(false);

    expect(
      pickedSkipMessage({ reason: 'too-large', name: 'shot.png', kind: 'image', byteLength })
    ).toBe(pasted.ok ? '' : pasted.message);
  });

  it('speaks the text tier sentence for an oversized text file', () => {
    const byteLength = 600 * KB;
    const pasted = admitAttachment([], { name: 'notes.md', kind: 'text', byteLength });
    expect(pasted.ok).toBe(false);

    expect(
      pickedSkipMessage({ reason: 'too-large', name: 'notes.md', kind: 'text', byteLength })
    ).toBe(pasted.ok ? '' : pasted.message);
    // And it must quote the TEXT budget, not the image one.
    expect(
      pickedSkipMessage({ reason: 'too-large', name: 'notes.md', kind: 'text', byteLength })
    ).toContain('512.0 KB');
  });

  it('names a directory for what it is', () => {
    expect(pickedSkipMessage({ reason: 'not-a-file', name: 'docs', kind: 'text' })).toBe(
      '"docs" is not a file — skipped.'
    );
  });

  // `not-allowed` is an internal invariant breach (a replayed read, a path the
  // user never picked), not something the user did. Telling them anything
  // other than "could not read it" would be noise about our own bookkeeping.
  it('reports an IO failure and a missing grant identically', () => {
    expect(pickedSkipMessage({ reason: 'unreadable', name: 'a.md', kind: 'text' })).toBe(
      unreadableMessage('a.md')
    );
    expect(pickedSkipMessage({ reason: 'not-allowed', name: 'a.md', kind: 'text' })).toBe(
      unreadableMessage('a.md')
    );
  });

  // Unreachable in practice (main always reports the size it refused on), but
  // it must not print an invented number if it ever happens.
  it('does not invent a size when main refused without reporting one', () => {
    const message = pickedSkipMessage({ reason: 'too-large', name: 'x.png', kind: 'image' });
    expect(message).toBe(unreadableMessage('x.png'));
    expect(message).not.toMatch(/\d+(\.\d+)?\s?(KB|MB)/);
  });

  it('folds into the same shape the paste path produces', () => {
    // Both sentences end the same way, which is what makes a mixed batch read
    // as one list rather than two voices.
    expect(unsupportedKindMessage('bundle.zip')).toBe(
      '"bundle.zip" is not an image or text file — skipped.'
    );
    expect(unreadableMessage('a.md')).toBe('Could not read "a.md" — skipped.');
  });
});

describe('pickedCountSkipMessage (round-5 C1)', () => {
  it('stays out of the way while there is room', () => {
    expect(pickedCountSkipMessage(0, { name: 'a.png', kind: 'image' })).toBeNull();
    expect(
      pickedCountSkipMessage(DEFAULT_ATTACHMENT_LIMITS.maxCount - 1, {
        name: 'a.png',
        kind: 'image',
      })
    ).toBeNull();
  });

  // Same sentence a pasted 6th file gets — the check exists to save a read,
  // not to invent a second way of saying "that is one too many".
  it('speaks admitAttachment’s own count sentence at the limit', () => {
    const full = Array.from({ length: DEFAULT_ATTACHMENT_LIMITS.maxCount }, () => ({
      byteLength: 1,
    }));
    const pasted = admitAttachment(full, { name: 'a.png', kind: 'image', byteLength: 4096 });
    expect(pasted.ok).toBe(false);

    expect(
      pickedCountSkipMessage(DEFAULT_ATTACHMENT_LIMITS.maxCount, { name: 'a.png', kind: 'image' })
    ).toBe(pasted.ok ? '' : pasted.message);
  });

  // The candidate's real size is unknown at this point — that is the whole
  // reason the check runs before the read — so the stand-in byte length must
  // not be able to trip the `empty` branch and mislabel the refusal.
  it('never reports the unread candidate as empty', () => {
    const message = pickedCountSkipMessage(9, { name: 'a.png', kind: 'image' });
    expect(message).not.toContain('is empty');
    expect(message).toContain('Up to 5 attachments');
  });
});

describe('readPickedBatch (round-5 C1/C2)', () => {
  function okResult(byteLength: number): AttachmentReadResult {
    return { ok: true, bytes: new Uint8Array(byteLength), byteLength };
  }

  /** Counts what actually hit the disk, which is the property under test. */
  function countingReader(result: (path: string) => AttachmentReadResult = () => okResult(4096)) {
    const seen: string[] = [];
    return {
      seen,
      read: async (filePath: string) => {
        seen.push(filePath);
        return result(filePath);
      },
    };
  }

  const manyImages = Array.from({ length: 20 }, (_, index) => `/home/dan/shot-${index}.png`);

  // THE C1 assertion: 20 picked images with 5 allowed must cost 5 reads, not
  // 20. Before this check the composer pulled ~100 MB across the bridge to
  // then refuse 15 of them.
  it('stops reading once the count budget is spent', async () => {
    const reader = countingReader();

    const outcome = await readPickedBatch({
      paths: manyImages,
      liveCount: () => 0,
      read: reader.read,
    });

    expect(reader.seen).toHaveLength(DEFAULT_ATTACHMENT_LIMITS.maxCount);
    expect(outcome.reads).toHaveLength(DEFAULT_ATTACHMENT_LIMITS.maxCount);
    expect(outcome.skipped).toHaveLength(20 - DEFAULT_ATTACHMENT_LIMITS.maxCount);
    expect(outcome.skipped[0]).toContain('Up to 5 attachments');
  });

  it('counts drafts the composer already holds against that budget', async () => {
    const reader = countingReader();

    const outcome = await readPickedBatch({
      paths: manyImages,
      liveCount: () => DEFAULT_ATTACHMENT_LIMITS.maxCount - 2,
      read: reader.read,
    });

    expect(reader.seen).toHaveLength(2);
    expect(outcome.reads).toHaveLength(2);
  });

  // The count is a getter, not a snapshot: a paste (or a removal) landing
  // while the batch is still reading has to count, or the two entry points can
  // together push the composer past its own limit.
  it('re-reads the live count between files', async () => {
    let live = 0;
    const reader = countingReader();

    const outcome = await readPickedBatch({
      paths: manyImages,
      liveCount: () => live,
      read: async (filePath: string) => {
        // A paste lands mid-batch and fills the composer.
        live = DEFAULT_ATTACHMENT_LIMITS.maxCount;
        return reader.read(filePath);
      },
    });

    expect(reader.seen).toHaveLength(1);
    expect(outcome.reads).toHaveLength(1);
  });

  // Nothing the protocol cannot carry is ever fetched — the verdict is
  // reachable from the name alone.
  it('never reads a path it could not send anyway', async () => {
    const reader = countingReader();

    const outcome = await readPickedBatch({
      paths: ['/a/bundle.zip', '/a/clip.mp4', '/a/notes.md'],
      liveCount: () => 0,
      read: reader.read,
    });

    expect(reader.seen).toEqual(['/a/notes.md']);
    expect(outcome.skipped).toEqual([
      unsupportedKindMessage('bundle.zip'),
      unsupportedKindMessage('clip.mp4'),
    ]);
  });

  it('turns a refused read into the shared sentence for that reason', async () => {
    const outcome = await readPickedBatch({
      paths: ['/a/shot.png'],
      liveCount: () => 0,
      read: async () => ({ ok: false, reason: 'not-allowed' }),
    });

    expect(outcome.reads).toHaveLength(0);
    expect(outcome.skipped).toEqual([unreadableMessage('shot.png')]);
  });

  // C2: one exploding read must not take the batch's other verdicts with it.
  // The notice this feeds is the only report the gesture ever makes.
  it('isolates a throwing read and keeps the rest of the batch', async () => {
    const outcome = await readPickedBatch({
      paths: ['/a/one.png', '/a/boom.png', '/a/two.png'],
      liveCount: () => 0,
      read: async (filePath: string) => {
        if (filePath.includes('boom')) throw new Error('bridge gone');
        return okResult(2048);
      },
    });

    expect(outcome.reads.map((read) => read.name)).toEqual(['one.png', 'two.png']);
    expect(outcome.skipped).toEqual([unreadableMessage('boom.png')]);
  });

  it('carries the wire facts each read produced', async () => {
    const outcome = await readPickedBatch({
      paths: ['/home/dan/shot.png', '/home/dan/notes.md'],
      liveCount: () => 0,
      read: async (filePath: string) => okResult(filePath.endsWith('.png') ? 64 : 32),
    });

    expect(outcome.reads).toEqual([
      { name: 'shot.png', mediaType: 'image/png', byteLength: 64, bytes: new Uint8Array(64) },
      { name: 'notes.md', mediaType: 'text/plain', byteLength: 32, bytes: new Uint8Array(32) },
    ]);
  });

  it('asks main for the tier budget of each file, not one budget for the batch', async () => {
    const asked: Array<[string, number]> = [];

    await readPickedBatch({
      paths: ['/a/shot.png', '/a/notes.md'],
      liveCount: () => 0,
      read: async (filePath: string, maxBytes: number) => {
        asked.push([filePath, maxBytes]);
        return okResult(16);
      },
    });

    expect(asked).toEqual([
      ['/a/shot.png', DEFAULT_ATTACHMENT_LIMITS.maxImageBytes],
      ['/a/notes.md', DEFAULT_ATTACHMENT_LIMITS.maxTextBytes],
    ]);
  });
});

describe('toArrayBuffer (D4)', () => {
  it('hands back the same buffer when the view owns all of it', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(toArrayBuffer(bytes)).toBe(bytes.buffer);
    expect(toArrayBuffer(bytes).byteLength).toBe(4);
  });

  // A `Uint8Array` is a VIEW: passing `bytes.buffer` for a sub-view would hand
  // over neighbouring bytes and report the wrong length — for a Node `Buffer`
  // that neighbour is the 8 KB allocation pool, i.e. other files' contents.
  it('copies a sub-view instead of leaking the bytes around it', () => {
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = pool.subarray(2, 5);

    const out = toArrayBuffer(view);
    expect(out.byteLength).toBe(3);
    expect([...new Uint8Array(out)]).toEqual([1, 2, 3]);
    expect(out).not.toBe(pool.buffer);
  });
});
