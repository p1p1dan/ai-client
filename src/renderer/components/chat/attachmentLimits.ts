/**
 * T-18 attachment budgets and the send-wait budget — one file so a re-measure
 * only ever touches one place, and so the limit checks and the timeout formula
 * cannot drift apart.
 *
 * Numbers come from the 2026-07-27 re-measure on the shared test gateway plus
 * the published API limits; the older `0.36 s/KB` latency fit did NOT
 * reproduce (150 KB -> 11.2s, 500 KB -> 9.5s, 2 MB -> 10.6s the same day), so
 * nothing here is derived from a size/latency model.
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

/** Unchanged text-path budget — the exact value runSend used before T-18. */
export const SEND_BASE_TIMEOUT_MS = 45_000;

/**
 * Not an upload-speed model: measured latency is size-independent
 * (2 MB -> 10.6s, 150 KB -> 11.2s on the same day). This is headroom for
 * gateway variance, which spanned ~8x on the same payload class across days.
 */
export const SEND_MS_PER_MB = 30_000;

/**
 * Documentation mirror of claudeRuntime.ts DEFAULT_STALL_TIMEOUT_MS. It cannot
 * be imported (src/agent-host is a separate program), so the invariant below
 * is locked by a unit test instead.
 */
export const HOST_STALL_TIMEOUT_MS = 120_000;

/**
 * Documentation mirror of claudeRuntime.ts's a4 (2026-07-30) one-shot TTFT
 * ("time to first productive event") watchdog default. Same cross-program
 * constraint as HOST_STALL_TIMEOUT_MS above — cannot import agent-host code —
 * so this is a second unit-test-locked mirror value.
 */
export const HOST_TTFT_TIMEOUT_MS = 32_000;

/**
 * INVARIANT (corrected 2026-07-30, a4 — the previous wording here claimed
 * the opposite of what these numbers produce): SEND_TIMEOUT_CEILING_MS
 * (115s) is LESS than HOST_STALL_TIMEOUT_MS (120s), so for a turn that HAS
 * already produced a first productive event, the renderer's ceiling elapses
 * FIRST, not the Host's — the Composer's generic "no assistant progress"
 * fallback can still win that race on a large-attachment send. That gap is a
 * known, accepted mid-term item (event-driven budget instead of a fixed wall
 * clock), not something this constant closes.
 *
 * What DOES protect the common case — a turn that never produces a first
 * productive event at all (api_retry loop, dead spawn) — is the Host's new
 * TTFT watchdog above: HOST_TTFT_TIMEOUT_MS (32s) is always below
 * SEND_BASE_TIMEOUT_MS (45s), so for that failure mode the Host speaks first
 * with its precise message, before the renderer's fallback ever fires.
 */
export const SEND_TIMEOUT_CEILING_MS = 115_000;

/** Wait budget for one send. attachmentBytes = total RAW bytes (pre-base64). */
export function sendTimeoutMs(attachmentBytes: number): number {
  if (attachmentBytes <= 0) return SEND_BASE_TIMEOUT_MS;
  const scaled = SEND_BASE_TIMEOUT_MS + Math.ceil(attachmentBytes / (1024 * 1024)) * SEND_MS_PER_MB;
  return Math.min(scaled, SEND_TIMEOUT_CEILING_MS);
}
