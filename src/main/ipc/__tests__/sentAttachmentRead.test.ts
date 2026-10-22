import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  readSentImage,
  SENT_ATTACHMENT_MAX_BYTES,
  sentImageObjectsRoot,
  sentImagePath,
  sniffImageType,
} from '../sentAttachmentRead';

/**
 * Issue #26 item 6: `chat:readSentAttachment` reads a sent image back for the
 * bubble's thumbnail. The guard is the point: a reference reaches one file
 * under the DSH store, or nothing, before any IO.
 */
const HOME = path.join(path.sep, 'home', 'u', '.dsh');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const refOf = (data: Uint8Array) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

describe('sentImagePath (the path guard)', () => {
  it('maps a reference onto the store’s own object layout', () => {
    const hex = 'ab'.repeat(32);
    expect(sentImagePath(HOME, `sha256:${hex}`)).toBe(
      path.join(HOME, 'attachments', 'v1', 'objects', 'ab', hex)
    );
  });

  it.each([
    ['a path', '/etc/passwd'],
    ['a traversal', 'sha256:../../../../etc/passwd'],
    ['a short digest', 'sha256:abcd'],
    ['upper-case hex', `sha256:${'AB'.repeat(32)}`],
    ['a trailing segment', `sha256:${'ab'.repeat(32)}/x`],
    ['another algorithm', `md5:${'ab'.repeat(16)}`],
    ['not a string', 42],
    ['nothing', undefined],
  ])('refuses %s', (_name, ref) => {
    expect(sentImagePath(HOME, ref)).toBeNull();
  });

  it('whatever it returns stays inside the objects directory', () => {
    const file = sentImagePath(HOME, `sha256:${'0f'.repeat(32)}`) as string;
    expect(path.relative(sentImageObjectsRoot(HOME), file).startsWith('..')).toBe(false);
  });
});

describe('readSentImage', () => {
  const io = (data: Uint8Array | null, size = data?.byteLength ?? null) => ({
    size: vi.fn(async () => size),
    read: vi.fn(async () => {
      if (!data) throw new Error('ENOENT');
      return data;
    }),
  });

  it('answers the bytes as base64 with the sniffed type', async () => {
    const result = await readSentImage(HOME, refOf(PNG), io(PNG));
    expect(result).toEqual({
      ok: true,
      mediaType: 'image/png',
      data: Buffer.from(PNG).toString('base64'),
    });
  });

  it('an invalid reference does no IO at all', async () => {
    const files = io(PNG);
    expect(await readSentImage(HOME, '../x', files)).toEqual({ ok: false, reason: 'invalid-ref' });
    expect(files.size).not.toHaveBeenCalled();
    expect(files.read).not.toHaveBeenCalled();
  });

  it('an oversized object is refused from its size, unread', async () => {
    const files = io(PNG, SENT_ATTACHMENT_MAX_BYTES + 1);
    expect(await readSentImage(HOME, refOf(PNG), files)).toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(files.read).not.toHaveBeenCalled();
  });

  it('a missing object, or one that is not a file, is not found', async () => {
    expect(await readSentImage(HOME, refOf(PNG), io(null, null))).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('bytes that do not hash to the reference are not served', async () => {
    const planted = new Uint8Array([...PNG, 9]);
    expect(await readSentImage(HOME, refOf(PNG), io(planted))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });

  it('only image bytes are answered', async () => {
    const text = new TextEncoder().encode('<script>');
    expect(await readSentImage(HOME, refOf(text), io(text))).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg');
  });
});
