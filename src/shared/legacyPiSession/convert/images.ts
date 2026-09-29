// New in dsh-rebase P1-9b

/**
 * Swap each pending image block for what admission made of it.
 *
 * The host admits `SeedConversion.images` through `ctx.attachments` (which
 * may re-encode them, plan P1-9 shard 03 §5) and hands the references back
 * by key. A key with no reference — refused, or never admitted — becomes the
 * text placeholder the migration plan names, so the seed still says an image
 * was there. Pure: returns new events, the input is left as it was.
 */

import { shadowedTokenCount } from './tokenEstimate.ts';
import type { DshSeedEvent } from './types.ts';

export interface BoundSeed {
  events: DshSeedEvent[];
  /** Image blocks now referencing an admitted attachment. */
  bound: number;
  /** Image blocks replaced by `[image not migrated: <media type>]`. */
  failed: number;
}

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

export function imageNotMigratedText(mediaType: string): string {
  return `[image not migrated: ${mediaType}]`;
}

/**
 * @param references - admitted `ImageAttachmentRef` by `SeedImage.key`;
 *   `null` or a missing key marks an image that could not be admitted.
 */
export function bindSeedImages(
  events: readonly DshSeedEvent[],
  references: ReadonlyMap<string, Row | null>
): BoundSeed {
  let bound = 0;
  let failed = 0;
  const bind = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content;
    return content.map((block) => {
      const row = recordOf(block);
      const attachment = recordOf(row?.attachment);
      if (row?.type !== 'image' || typeof attachment?.pendingImage !== 'string') return block;
      const reference = references.get(attachment.pendingImage);
      if (reference) {
        bound += 1;
        return { type: 'image', attachment: reference };
      }
      failed += 1;
      return { type: 'text', text: imageNotMigratedText(String(attachment.mediaType)) };
    });
  };
  const out = events.map((event) => {
    const data = recordOf(event.data);
    if (!data) return event;
    if (event.type === 'user/message')
      return { ...event, data: { ...data, content: bind(data.content) } };
    if (event.type === 'tool/result' || event.type === 'assistant/message') {
      const message = recordOf(data.message);
      if (!message) return event;
      return {
        ...event,
        data: { ...data, message: { ...message, content: bind(message.content) } },
      };
    }
    return event;
  });
  // A bound reference prices differently from the pending one: restate every
  // compaction's shadow price over the content DSH will actually store.
  const repriced = out.map((event) => {
    const data = recordOf(event.data);
    if (event.type !== 'compaction/summary' || !data || !Array.isArray(data.shadowedSeqs))
      return event;
    return {
      ...event,
      data: { ...data, shadowedTokenCount: shadowedTokenCount(out, data.shadowedSeqs) },
    };
  });
  return { events: repriced, bound, failed };
}
