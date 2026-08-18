/**
 * T-18 attachment budgets — one file so a re-measure only ever touches one
 * place, and one set of user-facing sentences.
 *
 * Numbers come from the 2026-07-27 re-measure on the shared test gateway plus
 * the published API limits; the older `0.36 s/KB` latency fit did NOT
 * reproduce (150 KB -> 11.2s, 500 KB -> 9.5s, 2 MB -> 10.6s the same day), so
 * nothing here is derived from a size/latency model.
 *
 * F2 (2026-08-18): the send-wait half moved to `sendBudgets.ts`. This file's
 * former second reason-to-exist ("the limit checks and the timeout formula
 * cannot drift apart") no longer holds — once the wait became a RESETTABLE
 * silence table, the user echo resets it at t~=0 and attachment bytes have
 * exactly zero effect on it, so there is nothing left for the two halves to
 * drift about.
 *
 * §12 verification first: __tests__/attachmentLimits.test.ts.
 */
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
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS
): AdmitResult {
  const label = next.name || 'Pasted item';
  if (next.byteLength <= 0) {
    return { ok: false, reason: 'empty', message: `"${label}" is empty — skipped.` };
  }
  if (existing.length >= limits.maxCount) {
    return {
      ok: false,
      reason: 'too-many',
      message: `Up to ${limits.maxCount} attachments per message — "${label}" skipped.`,
    };
  }
  const singleMax = next.kind === 'image' ? limits.maxImageBytes : limits.maxTextBytes;
  if (next.byteLength > singleMax) {
    const what = next.kind === 'image' ? 'image' : 'text file';
    return {
      ok: false,
      reason: 'too-large',
      message: `"${label}" is ${formatAttachmentSize(next.byteLength)} — max ${formatAttachmentSize(singleMax)} per ${what}.`,
    };
  }
  let total = next.byteLength;
  for (const item of existing) total += item.byteLength;
  if (total > limits.maxTotalBytes) {
    return {
      ok: false,
      reason: 'total-exceeded',
      message: `Attachments would total ${formatAttachmentSize(total)} — max ${formatAttachmentSize(limits.maxTotalBytes)} per message. Remove one first.`,
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
export function planImageAttachment(input: {
  name: string;
  mediaType: string;
  /** Omitted when the bitmap could not be decoded — the pixel check is skipped. */
  width?: number;
  height?: number;
  maxEdgePx?: number;
}): ImagePlan {
  const label = input.name || 'Pasted image';
  const supported = SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[];
  if (!supported.includes(input.mediaType)) {
    return {
      action: 'reject',
      reason: 'unsupported-type',
      message: `"${label}" is ${input.mediaType || 'an unknown image type'} — only JPEG, PNG, GIF and WebP are supported.`,
    };
  }
  const maxEdge = input.maxEdgePx ?? MAX_IMAGE_EDGE_PX;
  const edge = Math.max(input.width ?? 0, input.height ?? 0);
  if (edge > maxEdge) {
    return {
      action: 'reject',
      reason: 'oversized-pixels',
      message: `"${label}" is ${input.width}x${input.height}px — max ${maxEdge}px on the longer edge.`,
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
  } = { singleBytes: LARGE_SINGLE_HINT_BYTES, totalBytes: LARGE_TOTAL_HINT_BYTES }
): string | null {
  let total = 0;
  let largest = 0;
  for (const draft of drafts) {
    total += draft.byteLength;
    if (draft.byteLength > largest) largest = draft.byteLength;
  }
  if (largest > limits.singleBytes || total > limits.totalBytes) {
    return `Attachments total ${formatAttachmentSize(total)} — sending may take longer.`;
  }
  return null;
}

/**
 * DEPRECATED as a whole (F2 2026-08-18, §1.3) — the byte-scaled send budget is
 * retired, and with it the old "the renderer speaks first" INVARIANT block
 * that used to sit here. The authoritative (REVERSED) cross-program invariant,
 * the two Host mirrors and the live budgets are in `sendBudgets.ts`.
 *
 * Why the formula died rather than moved: `normalizer.beginTurn` emits the
 * user echo BEFORE the query starts, so a resettable silence table is reset at
 * t~=0 on every send — byte scaling has identically zero effect on it. The
 * size metadata the Composer still shows never went through here anyway
 * (`composerSendingLine` takes `attachmentCount` / `attachmentBytes` as its
 * own inputs, and `largeAttachmentHint` above is independent).
 *
 * ONE caller remains: `MessageTimeline.tsx`'s `DEFAULT_REPLY_BUDGET_MS`. F2 S2
 * removed both `ChatComposer.tsx` call sites; `MessageTimeline.tsx` is S3's
 * exclusive file, and S3 deletes this block together with that last consumer
 * (re-sourced to `SEND_SILENCE_CEILING_MS`). Do not add a new caller.
 */

/** @deprecated F2 S3 removes this with `sendTimeoutMs`. */
export const SEND_BASE_TIMEOUT_MS = 45_000;

/**
 * Not an upload-speed model: measured latency is size-independent
 * (2 MB -> 10.6s, 150 KB -> 11.2s on the same day). This was headroom for
 * gateway variance, which spanned ~8x on the same payload class across days —
 * the measurement `attachments.ts`'s "gateway latency varies" copy cites.
 *
 * @deprecated F2 S3 removes this with `sendTimeoutMs`.
 */
export const SEND_MS_PER_MB = 30_000;

/** @deprecated F2 S3 removes this with `sendTimeoutMs`. */
export const SEND_TIMEOUT_CEILING_MS = 180_000;

/**
 * Wait budget for one send. attachmentBytes = total RAW bytes (pre-base64).
 *
 * @deprecated F2 (2026-08-18): use `SEND_SILENCE_CEILING_MS` from
 * `sendBudgets.ts`. See the block above for the removal plan.
 */
export function sendTimeoutMs(attachmentBytes: number): number {
  if (attachmentBytes <= 0) return SEND_BASE_TIMEOUT_MS;
  const scaled = SEND_BASE_TIMEOUT_MS + Math.ceil(attachmentBytes / (1024 * 1024)) * SEND_MS_PER_MB;
  return Math.min(scaled, SEND_TIMEOUT_CEILING_MS);
}
