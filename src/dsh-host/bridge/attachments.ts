/**
 * Composer attachments into the content of one DSH user message (dsh-rebase
 * P1-4c2, decisions 096 and 097). The one entry a send and a Ctrl+Enter
 * interjection share (decision 093):
 *
 *   image   handed to `ctx.attachments.admitPromptContent`, which validates,
 *           normalizes and stores it: an `image` block with its reference.
 *           The limits are DSH's (20 MiB, 20 per message, 8192 px a side);
 *           the 5 MiB the user sees is the renderer's and Main's, not re-checked here.
 *   text    stored verbatim with `ctx.attachments.saveFile`: a `file` block.
 *           The model gets one handle line naming its read-only path under
 *           `<DSH_HOME>/attachments/v1/` and reads it when it needs it; the
 *           permission row trusts that store (`isAttachmentPath`).
 *
 * The user's text comes first, then the attachments in the order they were
 * picked. A refusal is an `AttachmentError` of DSH, answered before any event
 * with `WORKER_ATTACHMENT_REJECTED`, its DSH code and the file to blame.
 */

import type { SessionAttachment } from '../../shared/types/agentHost.ts';
import { WORKER_ATTACHMENT_REJECTED } from '../../shared/types/workerRpc.ts';
import { BridgeSessionError } from './bridgeErrors.ts';

/** `FileAttachmentRef` of dsh-attachment: the verbatim stored file. */
export interface DshFileAttachmentRef {
  readonly attachmentId: string;
  readonly name: string;
  readonly bytes: number;
}

/** `ImageAttachmentRef` of dsh-attachment: the normalized stored image. */
export interface DshImageAttachmentRef {
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly name?: string;
}

/** `AttachmentAdmissionPart`: what `admitPromptContent` takes. */
export type DshAdmissionPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'file'; attachment: DshFileAttachmentRef };

/** `AdmittedPromptContentPart`: the content of the user message. */
export type DshUserContent =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: DshImageAttachmentRef }
  | { type: 'file'; attachment: DshFileAttachmentRef };

/** `ctx.attachments` (dsh-attachment's `AttachmentStore`), narrowed to what is used here. */
export interface DshAttachmentStore {
  readonly imageLimits: { readonly mediaTypes: readonly string[] };
  admitPromptContent(content: readonly DshAdmissionPart[]): Promise<readonly DshUserContent[]>;
  saveFile(input: { data: Uint8Array; name?: string }): Promise<DshFileAttachmentRef>;
  validateImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<void>;
  isAttachmentError(error: unknown): boolean;
}

/** DSH's codes about an image batch as a whole: no one file is to blame. */
const BATCH_CODES: ReadonlySet<string> = new Set(['TOO_MANY_IMAGES', 'IMAGES_TOO_LARGE']);

function nameOf(attachment: SessionAttachment): { name?: string } {
  return attachment.name ? { name: attachment.name } : {};
}

/** dsh-attachment's rule: an upload is its canonical base64 and nothing else. */
function isCanonicalBase64(data: string): boolean {
  return data.length > 0 && Buffer.from(data, 'base64').toString('base64') === data;
}

/**
 * The image a refused batch is refused for. Read off the batch where the
 * code says which (one image, a type DSH does not take, a bad encoding);
 * otherwise each image is validated alone, on the refusal path only.
 */
async function refusedImage(
  store: DshAttachmentStore,
  attachments: readonly SessionAttachment[],
  code: string
): Promise<SessionAttachment | undefined> {
  const images = attachments.filter((attachment) => attachment.kind === 'image');
  if (BATCH_CODES.has(code) || images.length === 0) return undefined;
  if (images.length === 1) return images[0];
  if (code === 'UNSUPPORTED_IMAGE_TYPE') {
    return images.find((image) => !store.imageLimits.mediaTypes.includes(image.mediaType));
  }
  if (code === 'INVALID_IMAGE_BASE64')
    return images.find((image) => !isCanonicalBase64(image.data));
  for (const image of images) {
    try {
      await store.validateImage({
        data: new Uint8Array(Buffer.from(image.data, 'base64')),
        mediaType: image.mediaType,
      });
    } catch {
      return image;
    }
  }
  return undefined;
}

/** `<DSH code> "<file name>": <DSH sentence>`, as `WORKER_ATTACHMENT_REJECTED` documents it. */
function rejection(error: unknown, culprit: SessionAttachment | undefined): BridgeSessionError {
  const { code, message } = error as { code?: unknown; message?: unknown };
  const blamed = culprit
    ? ` ${JSON.stringify(culprit.name ?? (culprit.kind === 'image' ? 'image' : 'attachment'))}`
    : '';
  return new BridgeSessionError(
    WORKER_ATTACHMENT_REJECTED,
    `${String(code)}${blamed}: ${String(message)}`
  );
}

/**
 * The content of the user message for `text` and `attachments`. Without
 * attachments it is the text alone, and nothing touches the store.
 */
export async function admitUserContent(
  store: DshAttachmentStore,
  text: string,
  attachments: readonly SessionAttachment[] | undefined
): Promise<DshUserContent[]> {
  if (!attachments || attachments.length === 0) return [{ type: 'text', text }];
  // An empty text block is refused by some providers; a message may be attachments alone.
  const parts: DshAdmissionPart[] = text.length > 0 ? [{ type: 'text', text }] : [];
  let saving: SessionAttachment | undefined;
  try {
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        parts.push({
          type: 'image',
          mediaType: attachment.mediaType,
          data: attachment.data,
          ...nameOf(attachment),
        });
        continue;
      }
      saving = attachment;
      parts.push({
        type: 'file',
        attachment: await store.saveFile({
          data: new Uint8Array(Buffer.from(attachment.data, 'utf8')),
          ...nameOf(attachment),
        }),
      });
      saving = undefined;
    }
    return [...(await store.admitPromptContent(parts))];
  } catch (error) {
    if (!store.isAttachmentError(error)) throw error;
    const culprit =
      saving ??
      (await refusedImage(store, attachments, String((error as { code?: unknown }).code)));
    throw rejection(error, culprit);
  }
}
