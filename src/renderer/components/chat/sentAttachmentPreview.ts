/**
 * Issue #26 item 6: the bytes behind a sent image's thumbnail, through
 * `chat:readSentAttachment`, as a `data:` URL (the CSP's `img-src` takes
 * `data:`). One read per image per window: a bounded cache of the promises, so
 * a remount (a settled turn moving its rows) or the preview dialog opening does
 * not read the file again.
 */
import type { SentAttachmentReadRequest, SentAttachmentReadResult } from '@shared/types/ipc';
import type { ChatMessageAttachment } from '@/stores/chatSessions';

type Reader = (request: SentAttachmentReadRequest) => Promise<SentAttachmentReadResult>;

/** Images kept; each is at most a few MB of base64, and a chat shows a handful. */
export const SENT_ATTACHMENT_CACHE_SIZE = 24;

const cache = new Map<string, Promise<string | null>>();

/** Does this chip have bytes to show? Only a DSH image with its store reference does. */
export function hasSentImagePreview(attachment: ChatMessageAttachment): boolean {
  return attachment.kind === 'image' && typeof attachment.attachmentId === 'string';
}

export function sentAttachmentDataUrl(result: SentAttachmentReadResult): string | null {
  return result.ok ? `data:${result.mediaType};base64,${result.data}` : null;
}

/** The image as a `data:` URL, or `null` when it cannot be shown (the chip stays an icon). */
export function loadSentAttachment(
  request: SentAttachmentReadRequest,
  read: Reader = (payload) => window.electronAPI.chat.readSentAttachment(payload)
): Promise<string | null> {
  const cached = cache.get(request.attachmentId);
  if (cached) {
    // Most recently used goes last, so the oldest is the one evicted.
    cache.delete(request.attachmentId);
    cache.set(request.attachmentId, cached);
    return cached;
  }
  const loading = read(request)
    .then(sentAttachmentDataUrl)
    .catch(() => null)
    .then((url) => {
      // A failure is not remembered: the next mount may find the file.
      if (url === null) cache.delete(request.attachmentId);
      return url;
    });
  cache.set(request.attachmentId, loading);
  while (cache.size > SENT_ATTACHMENT_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return loading;
}

/** Tests only. */
export function clearSentAttachmentCache(): void {
  cache.clear();
}
