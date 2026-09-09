import type { ImageContent } from '@earendil-works/pi-ai';
import type { SessionAttachment } from '../../../shared/types/agentHost.ts';
import type { MessageAttachmentMeta } from '../../../shared/types/runtimeEvents.ts';
import { RuntimeHostError } from '../../host/errors.ts';

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
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      images.push({
        type: 'image',
        data: attachment.data,
        mimeType: attachment.mediaType || 'image/png',
      });
    } else if (attachment.kind === 'text') {
      documents.push(`--- ${attachment.name ?? 'attachment'} ---\n${attachment.data}`);
    } else {
      throw new RuntimeHostError(
        'unsupported_attachment',
        `unsupported attachment kind: ${String((attachment as { kind: unknown }).kind)}`
      );
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
