import type { ImageContent } from '@earendil-works/pi-ai';
import { attachmentNameRider } from '../../../shared/attachmentRider.ts';
import type { SessionAttachment } from '../../../shared/types/agentHost.ts';
import { MAX_ATTACHMENT_READ_BYTES } from '../../../shared/types/attachmentIo.ts';
import type { MessageAttachmentMeta } from '../../../shared/types/runtimeEvents.ts';
import { RuntimeHostError } from '../../host/errors.ts';
import { SESSION_MAX_BYTES } from '../session/codec.ts';

/**
 * P4-5 — composer attachments, split the two ways a turn needs them.
 *
 * Images become content blocks the provider is given; text documents are
 * appended to the prompt, because a text attachment is a pasted file and the
 * model reads it as part of the question. The shape mirrors the legacy backend's
 * `buildPiWorkerPrompt` deliberately: the same drag-and-drop must produce the
 * same conversation on either engine, and an attachment that reads differently
 * is a regression the user notices in the answer, not in a log.
 *
 * An unknown `kind` FAILS rather than being skipped. Dropping it silently is the
 * outcome to avoid — the user watches the attachment upload and the model
 * answers as though it never arrived.
 */
/**
 * capacity-01 — the server-side ceiling on ONE attachment, in raw bytes.
 *
 * The renderer already refuses anything larger before it composes a send, and
 * the main process refuses to read a bigger file off disk
 * (`MAX_ATTACHMENT_READ_BYTES`). Neither of those is a guarantee down here: the
 * IPC hop carries `attachments` through preload, the chat handler and the
 * worker bridge without a single byte check, so a renderer bug — or a renderer
 * that has been tampered with — reaches this function with whatever it likes,
 * and everything it hands over is written verbatim into the session file.
 *
 * The number is imported rather than re-picked so the two ceilings cannot drift
 * apart: a file the main process would not even read must not arrive here by
 * another door and be accepted.
 */
export const ATTACHMENT_MAX_BYTES = MAX_ATTACHMENT_READ_BYTES;

/**
 * capacity-01 — what ONE send's attachments may add to the session FILE.
 *
 * Measured in stored bytes, not raw bytes, because the session budget is a file
 * budget: an image travels as base64 and lands as base64, so 5 MiB of photo is
 * ~6.7 MiB of session file. A quarter of `SESSION_MAX_BYTES` per send is the
 * share that keeps one message from being a meaningful fraction of the whole
 * conversation — before this cap the renderer's own maximum send (10 MiB raw,
 * ~13.4 MiB stored) could claim 42% of the budget, and three of them left the
 * session permanently read-only with `session_size_limit` on every later write.
 *
 * Refusing here rather than at `appendMessage` is the point: the send fails
 * with a sentence naming the attachment, instead of the conversation quietly
 * becoming unwritable several messages later.
 */
export const ATTACHMENT_TURN_STORED_BYTES = Math.floor(SESSION_MAX_BYTES / 4);

/**
 * Raw bytes behind a base64 payload, without decoding it.
 *
 * Decoding a 5 MiB image to measure it would allocate the very thing the cap
 * exists to refuse.
 */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** What this attachment costs the model side: the bytes the user picked. */
function rawBytes(attachment: SessionAttachment): number {
  return attachment.kind === 'image'
    ? base64Bytes(attachment.data)
    : Buffer.byteLength(attachment.data, 'utf8');
}

function describe(attachment: SessionAttachment): string {
  return attachment.name ?? (attachment.kind === 'image' ? 'image' : 'attachment');
}

export interface PreparedPrompt {
  text: string;
  images: ImageContent[];
  metadata: MessageAttachmentMeta[];
}

export function preparePrompt(
  text: string,
  attachments: readonly SessionAttachment[] | undefined
): PreparedPrompt {
  if (!attachments?.length) return { text, images: [], metadata: [] };
  const images: ImageContent[] = [];
  const documents: string[] = [];
  const metadata: MessageAttachmentMeta[] = [];
  let storedBytes = 0;
  for (const attachment of attachments) {
    if (attachment.kind !== 'image' && attachment.kind !== 'text') {
      throw new RuntimeHostError(
        'unsupported_attachment',
        `unsupported attachment kind: ${String((attachment as { kind: unknown }).kind)}`
      );
    }
    // capacity-01. Both budgets are checked BEFORE the payload is copied into
    // the prompt, so an oversized send costs one comparison rather than a copy.
    const raw = rawBytes(attachment);
    if (raw > ATTACHMENT_MAX_BYTES) {
      throw new RuntimeHostError(
        'attachment_size_limit',
        `attachment "${describe(attachment)}" is ${raw} bytes; the limit is ${ATTACHMENT_MAX_BYTES} bytes per attachment`
      );
    }
    storedBytes += Buffer.byteLength(attachment.data, 'utf8');
    if (storedBytes > ATTACHMENT_TURN_STORED_BYTES) {
      throw new RuntimeHostError(
        'attachment_size_limit',
        `attachments would add ${storedBytes} bytes to the session file; the limit is ${ATTACHMENT_TURN_STORED_BYTES} bytes per message`
      );
    }
    if (attachment.kind === 'image') {
      // D25 — the file name rides along so a reopened conversation still says
      // `photo.png` instead of `image/png`. `plugins/model-adapter` strips the
      // app's namespace before a request leaves, so it lands in the session
      // file and never on the wire; see `attachmentRider.ts`.
      images.push({
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mediaType || 'image/png',
        ...attachmentNameRider(attachment.name),
      });
    } else {
      documents.push(`--- ${attachment.name ?? 'attachment'} ---\n${attachment.data}`);
    }
    metadata.push({
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      ...(attachment.name ? { name: attachment.name } : {}),
    });
  }
  return {
    text: documents.length ? [text, ...documents].filter(Boolean).join('\n\n') : text,
    images,
    metadata,
  };
}
