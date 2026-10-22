/**
 * Issue #26 item 6: the read half of `chat:readSentAttachment`, kept pure so
 * its path guard is unit-tested — the handler only supplies `DSH_HOME` and IO.
 *
 * Read-only and narrow on purpose:
 *  - the request names a store REFERENCE (`sha256:<64 hex>`), never a path, so
 *    the only file it can reach is `<DSH_HOME>/attachments/v1/objects/<ab>/<hex>`
 *    — dsh-attachment-local's own layout for a normalized image;
 *  - the joined path is re-checked to sit inside that directory;
 *  - the bytes must hash to the reference (the store's own integrity rule), so
 *    a planted file under the right name is not served either;
 *  - the media type is sniffed from the bytes, and only the image types DSH
 *    stores are answered.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SentAttachmentReadResult } from '@shared/types/ipc';

/** dsh-attachment-local's `ID_PATTERN`. */
const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/;

/** DSH's own upload ceiling (`DEFAULT_MAX_IMAGE_BYTES`); a normalized image is smaller. */
export const SENT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** The store's image objects directory under one `DSH_HOME`. */
export function sentImageObjectsRoot(dshHome: string): string {
  return path.join(dshHome, 'attachments', 'v1', 'objects');
}

/**
 * The file a reference names, or `null` when the reference is not one. The
 * result is always inside `sentImageObjectsRoot(dshHome)`.
 */
export function sentImagePath(dshHome: string, attachmentId: unknown): string | null {
  if (typeof attachmentId !== 'string') return null;
  const hex = ATTACHMENT_ID.exec(attachmentId)?.[1];
  if (!hex) return null;
  const root = sentImageObjectsRoot(dshHome);
  const file = path.join(root, hex.slice(0, 2), hex);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return file;
}

/** The image type the bytes are, among those DSH stores; `null` for anything else. */
export function sniffImageType(data: Uint8Array): string | null {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export interface SentAttachmentIo {
  /** Size first, so an oversized object is refused without being read. */
  size(file: string): Promise<number | null>;
  read(file: string): Promise<Uint8Array>;
}

export async function readSentImage(
  dshHome: string,
  attachmentId: unknown,
  io: SentAttachmentIo
): Promise<SentAttachmentReadResult> {
  const file = sentImagePath(dshHome, attachmentId);
  if (!file) return { ok: false, reason: 'invalid-ref' };
  const size = await io.size(file).catch(() => null);
  if (size === null) return { ok: false, reason: 'not-found' };
  if (size > SENT_ATTACHMENT_MAX_BYTES) return { ok: false, reason: 'too-large' };
  let data: Uint8Array;
  try {
    data = await io.read(file);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  const digest = createHash('sha256').update(data).digest('hex');
  if (`sha256:${digest}` !== attachmentId) return { ok: false, reason: 'corrupt' };
  const mediaType = sniffImageType(data);
  if (!mediaType) return { ok: false, reason: 'unsupported' };
  return { ok: true, mediaType, data: Buffer.from(data).toString('base64') };
}
