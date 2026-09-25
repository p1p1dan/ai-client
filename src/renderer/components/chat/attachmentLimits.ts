/**
 * T-18 attachment budgets — one file so a re-measure only ever touches one
 * place, and one set of user-facing sentences.
 *
 * Numbers come from the 2026-07-27 re-measure on the shared test gateway plus
 * the published API limits; the older `0.36 s/KB` latency fit did NOT
 * reproduce (150 KB -> 11.2s, 500 KB -> 9.5s, 2 MB -> 10.6s the same day), so
 * nothing here is derived from a size/latency model.
 *
 * F2 (2026-08-18, S3): the send-wait half — `sendTimeoutMs` and its
 * constants — has been removed entirely; this module is attachment limits
 * only. The wait budget now lives in `sendBudgets.ts`.
 *
 * §12 verification first: __tests__/attachmentLimits.test.ts.
 */
import { englishTranslate, type Translate } from '@shared/i18n';
import type { AgentModelOption } from '@shared/types/agentCatalog';
import type { AttachmentKind } from './attachments';
import { formatAttachmentSize } from './attachments';

/** API-supported image media types. Everything else is rejected up front. */
export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

/** API hard limit: a longer edge than this fails with invalid_request_error. */
export const MAX_IMAGE_EDGE_PX = 8000;

export interface AttachmentLimits {
  maxCount: number;
  /** RAW bytes; ~1.34x after base64, well below the 10 MB per-image API cap. */
  maxImageBytes: number;
  /** Text is bounded by token cost, not bytes: 512 KB is already ~130k tokens. */
  maxTextBytes: number;
  /** RAW bytes for one send; ~13.4 MB base64 against a 32 MB request cap. */
  maxTotalBytes: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxCount: 5,
  maxImageBytes: 5 * 1024 * 1024,
  maxTextBytes: 512 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
};

/** Above this the Composer says "this is big" — it never predicts seconds. */
export const LARGE_SINGLE_HINT_BYTES = 1024 * 1024;
export const LARGE_TOTAL_HINT_BYTES = 2 * 1024 * 1024;

export type AdmitReason = 'empty' | 'too-many' | 'too-large' | 'total-exceeded';

export type AdmitResult = { ok: true } | { ok: false; reason: AdmitReason; message: string };

export interface AdmitCandidate {
  name: string;
  byteLength: number;
  kind: AttachmentKind;
}

/**
 * Decide whether one more attachment may join the pending list.
 *
 * Order is fixed (empty -> count -> single size -> total) so the reason and
 * the message always agree. `empty` is not cosmetic: the Host rejects the
 * ENTIRE send when any attachment carries `data === ''`, so a zero-byte file
 * has to die here rather than take the user's message down with it.
 */
export function admitAttachment(
  existing: ReadonlyArray<{ byteLength: number }>,
  next: AdmitCandidate,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
  t: Translate = englishTranslate
): AdmitResult {
  const label = next.name || t('Pasted item');
  if (next.byteLength <= 0) {
    return {
      ok: false,
      reason: 'empty',
      message: t('"{{name}}" is empty — skipped.', { name: label }),
    };
  }
  if (existing.length >= limits.maxCount) {
    return {
      ok: false,
      reason: 'too-many',
      message: t('Up to {{max}} attachments per message — "{{name}}" skipped.', {
        max: limits.maxCount,
        name: label,
      }),
    };
  }
  const singleMax = next.kind === 'image' ? limits.maxImageBytes : limits.maxTextBytes;
  if (next.byteLength > singleMax) {
    // The noun is its own key: 「每张图片」 and 「每个文本文件」 are not one
    // sentence with a slot in Chinese any more than they are in English.
    const what = next.kind === 'image' ? t('image') : t('text file');
    return {
      ok: false,
      reason: 'too-large',
      message: t('"{{name}}" is {{size}} — max {{max}} per {{what}}.', {
        name: label,
        size: formatAttachmentSize(next.byteLength),
        max: formatAttachmentSize(singleMax),
        what,
      }),
    };
  }
  let total = next.byteLength;
  for (const item of existing) total += item.byteLength;
  if (total > limits.maxTotalBytes) {
    return {
      ok: false,
      reason: 'total-exceeded',
      message: t('Attachments would total {{size}} — max {{max}} per message. Remove one first.', {
        size: formatAttachmentSize(total),
        max: formatAttachmentSize(limits.maxTotalBytes),
      }),
    };
  }
  return { ok: true };
}

export type ImagePlan =
  | { action: 'as-is' }
  | { action: 'reject'; reason: 'unsupported-type' | 'oversized-pixels'; message: string };

/**
 * Gate an image on the two API constraints the byte budget cannot express:
 * the four-format whitelist and the 8000x8000 pixel cap.
 *
 * There is deliberately no `downscale` action. Re-encoding through a canvas
 * would be a lossy rewrite of user data, is untestable in the node test
 * environment, and buys nothing for correctness — the server already
 * downsamples anything past its own tier limit.
 */
export function planImageAttachment(
  input: {
    name: string;
    mediaType: string;
    /** Omitted when the bitmap could not be decoded — the pixel check is skipped. */
    width?: number;
    height?: number;
    maxEdgePx?: number;
  },
  t: Translate = englishTranslate
): ImagePlan {
  const label = input.name || t('Pasted image');
  const supported = SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[];
  if (!supported.includes(input.mediaType)) {
    return {
      action: 'reject',
      reason: 'unsupported-type',
      message: t('"{{name}}" is {{type}} — only JPEG, PNG, GIF and WebP are supported.', {
        name: label,
        type: input.mediaType || t('an unknown image type'),
      }),
    };
  }
  const maxEdge = input.maxEdgePx ?? MAX_IMAGE_EDGE_PX;
  const edge = Math.max(input.width ?? 0, input.height ?? 0);
  if (edge > maxEdge) {
    return {
      action: 'reject',
      reason: 'oversized-pixels',
      message: t('"{{name}}" is {{width}}x{{height}}px — max {{max}}px on the longer edge.', {
        name: label,
        width: String(input.width),
        height: String(input.height),
        max: maxEdge,
      }),
    };
  }
  return { action: 'as-is' };
}

/** Muted hint for payloads that are large but legal. Never predicts seconds. */
export function largeAttachmentHint(
  drafts: ReadonlyArray<{ byteLength: number }>,
  limits: {
    singleBytes: number;
    totalBytes: number;
  } = { singleBytes: LARGE_SINGLE_HINT_BYTES, totalBytes: LARGE_TOTAL_HINT_BYTES },
  t: Translate = englishTranslate
): string | null {
  let total = 0;
  let largest = 0;
  for (const draft of drafts) {
    total += draft.byteLength;
    if (draft.byteLength > largest) largest = draft.byteLength;
  }
  if (largest > limits.singleBytes || total > limits.totalBytes) {
    return t('Attachments total {{size}} — sending may take longer.', {
      size: formatAttachmentSize(total),
    });
  }
  return null;
}

/**
 * T3 — whether the composer should warn that the selected model will not see
 * the image(s) about to be sent.
 *
 * The runtime treats a model whose configuration does not declare `image`
 * input as text-only and swaps each picture for "(image omitted: model does
 * not support images)" — silently, after the send. The warning says so
 * beforehand. It never blocks the send.
 *
 * Only speaks when it KNOWS: `Automatic` (no wire model) lets the runtime pick
 * a model this side cannot name, and a model the catalog does not (yet) list
 * has no declaration to read. Both stay quiet rather than guess.
 */
export function modelLacksImageInput(input: {
  drafts: ReadonlyArray<{ kind: AttachmentKind }>;
  /** The model the next send carries (`toWireModel`); `undefined` = Automatic. */
  model: string | undefined;
  catalog: ReadonlyArray<Pick<AgentModelOption, 'id' | 'input'>>;
}): boolean {
  if (!input.drafts.some((draft) => draft.kind === 'image')) return false;
  if (!input.model) return false;
  const option = input.catalog.find((candidate) => candidate.id === input.model);
  if (!option) return false;
  return !(option.input ?? []).includes('image');
}

/**
 * The warning's sentence. It names the one place a user can declare image
 * input — the per-model metadata of an AI service they added themselves
 * (`ProviderSetupDialog`, commit cfd19433); administrator-managed models have
 * no such editor, hence "you added yourself".
 */
export function imageInputUnsupportedHint(t: Translate = englishTranslate): string {
  return t(
    'The selected model does not declare image input, so it will not see this image. Switch to a model that supports images, or, for an AI service you added yourself, set its input type to Image under Settings · Pi · AI services → Edit → Per-model metadata.'
  );
}
