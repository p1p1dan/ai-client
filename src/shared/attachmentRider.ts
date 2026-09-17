/**
 * T061 / D25 — the attachment's file name, carried on the stored image block.
 *
 * ## The hole this closes
 *
 * A picture reaches the model as `{ type, data, mimeType }` and that is exactly
 * what pi writes into the session JSONL. The name the user picked lives only in
 * `MessageAttachmentMeta`, which rides the live `message.started` event and is
 * never persisted — so a conversation reopened tomorrow replaced every chip
 * label with its media type (`big-5mib.png` became `image/png`).
 *
 * ## Why an extra key on the block
 *
 * The alternative was a per-message list beside the blocks (the shape
 * `internalMessage.ts` uses for its own mark). A list has to be kept in step
 * with the blocks by index, and the two are not 1:1 — a text attachment is
 * folded into the prompt text and produces no block at all — so the pairing
 * would have been a second thing to get wrong. On the block, the name simply
 * travels with the thing it names.
 *
 * ## Why this is harmless to existing readers
 *
 * - The wire never sees it, because the runtime takes it off: every registry
 *   `plugins/model-adapter` hands out strips the app's namespace from the
 *   context on the way to the provider (`stripAiclientKeys`). That guard is
 *   the guarantee — NOT the adapters. Most of them would drop the key anyway,
 *   since they REBUILD the image block from `mimeType` and `data` (`{ source:
 *   { type: 'base64', media_type, data } }` for Anthropic, a `data:` URL for
 *   OpenAI, `inlineData` for Google), but `pi-messages` sends the context
 *   verbatim and this app lists it as a user-selectable API, so one adapter
 *   would have put the file name on the wire.
 * - The file stays readable by everyone else: the session codec serializes
 *   messages verbatim and carries unknown fields through untouched, and any
 *   reader keying on `type === 'image'` — including `pi --session` — ignores a
 *   key it does not know.
 * - The name is namespaced rather than called `name`, so pi remains free to
 *   give `name` its own meaning on a content block without a silent collision.
 *
 * ## The trade-off taken
 *
 * The name is copied into the session file, which costs a few dozen bytes per
 * attachment against the session budget, and it is user-supplied text now
 * persisted where it was previously transient. Both are accepted: the byte cost
 * is noise beside the base64 payload it labels, and the same string was already
 * being shown in the timeline and logged with the send.
 *
 * Decision 015 (moving attachment bytes out of the JSONL) will have to decide
 * where the payload lives; the name is deliberately left here rather than
 * anticipating that move, because a label attached to the block is correct
 * whichever side the bytes end up on.
 */

const FIELD = 'aiclientName';

/** The rider, as fields to merge onto an image content block. */
export function attachmentNameRider(name: string | undefined): { aiclientName?: string } {
  return name ? ({ [FIELD]: name } as { aiclientName: string }) : {};
}

/**
 * The stored file name of an image block, or undefined.
 *
 * Takes `unknown` because its callers read blocks off a live stream and out of
 * a decoded session file — two static types, one question.
 */
export function attachmentNameOf(block: unknown): string | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const name = (block as Record<string, unknown>)[FIELD];
  return typeof name === 'string' && name ? name : undefined;
}
