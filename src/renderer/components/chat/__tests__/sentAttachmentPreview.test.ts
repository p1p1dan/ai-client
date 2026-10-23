import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSentAttachmentCache,
  hasSentImagePreview,
  loadSentAttachment,
  SENT_ATTACHMENT_CACHE_SIZE,
  sentAttachmentDataUrl,
} from '../sentAttachmentPreview';

/** Issue #26 item 6: a sent image's thumbnail bytes, read once per window. */
afterEach(() => clearSentAttachmentCache());

const ref = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;

describe('sentAttachmentPreview', () => {
  it('only a DSH image with its store reference has a preview', () => {
    expect(
      hasSentImagePreview({ kind: 'image', mediaType: 'image/png', attachmentId: ref(1) })
    ).toBe(true);
    expect(hasSentImagePreview({ kind: 'image', mediaType: 'image/png' })).toBe(false);
    expect(
      hasSentImagePreview({ kind: 'text', mediaType: 'text/plain', attachmentId: ref(1) })
    ).toBe(false);
  });

  it('turns an answer into a data URL, and a refusal into null', () => {
    expect(sentAttachmentDataUrl({ ok: true, mediaType: 'image/png', data: 'AAAA' })).toBe(
      'data:image/png;base64,AAAA'
    );
    expect(sentAttachmentDataUrl({ ok: false, reason: 'not-found' })).toBeNull();
  });

  it('reads an image once, however many times it is asked for', async () => {
    const read = vi.fn(async () => ({ ok: true as const, mediaType: 'image/png', data: 'AA' }));
    const request = { sessionId: 's', attachmentId: ref(1) };
    await loadSentAttachment(request, read);
    await loadSentAttachment(request, read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failure, so a later mount tries again', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'not-found' })
      .mockResolvedValueOnce({ ok: true, mediaType: 'image/png', data: 'AA' });
    const request = { sessionId: 's', attachmentId: ref(2) };
    expect(await loadSentAttachment(request, read)).toBeNull();
    expect(await loadSentAttachment(request, read)).toBe('data:image/png;base64,AA');
  });

  it('a rejected read is null, not a throw', async () => {
    const read = vi.fn(async () => {
      throw new Error('ipc');
    });
    expect(await loadSentAttachment({ sessionId: 's', attachmentId: ref(3) }, read)).toBeNull();
  });

  it('keeps a bounded number of images, evicting the least recently used', async () => {
    const read = vi.fn(async () => ({ ok: true as const, mediaType: 'image/png', data: 'AA' }));
    for (let n = 0; n <= SENT_ATTACHMENT_CACHE_SIZE; n += 1) {
      await loadSentAttachment({ sessionId: 's', attachmentId: ref(100 + n) }, read);
    }
    // The first one was evicted and is read again.
    await loadSentAttachment({ sessionId: 's', attachmentId: ref(100) }, read);
    expect(read).toHaveBeenCalledTimes(SENT_ATTACHMENT_CACHE_SIZE + 2);
  });
});
