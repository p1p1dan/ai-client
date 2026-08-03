/**
 * D4 (round-5): the pure half of "user picked N files" — every decision the ⊕
 * menu's flow makes, plus the batch loop that spends them, with the read
 * itself injected. All of it therefore runs in the node test environment the
 * way the paste path's decisions already do; the hook next door is left with
 * state plumbing only.
 *
 * The governing rule of this module is that it owns NO budgets and NO
 * sentences of its own. A picked file and a pasted file are the same thing the
 * moment their bytes exist, so every limit and every skip message is delegated
 * to `attachmentLimits` / this file's shared formatters, which the paste path
 * uses too. The only reason a "picked" module exists at all is that the read
 * happens in the main process, which needs a per-file budget in advance and
 * can fail in ways a `File` object cannot.
 *
 * §12 verification first: `__tests__/pickedAttachments.test.ts`.
 */
import type { AttachmentReadFailureReason, AttachmentReadResult } from '@shared/types/attachmentIo';
import {
  type AttachmentLimits,
  admitAttachment,
  DEFAULT_ATTACHMENT_LIMITS,
} from './attachmentLimits';
import { type AttachmentKind, detectAttachmentKind } from './attachments';

/** What one picked path costs us to read, and how it will travel on the wire. */
export interface PickedReadPlan {
  kind: AttachmentKind;
  mediaType: string;
  /** Budget handed to the main process for THIS file (image or text tier). */
  maxBytes: number;
}

/**
 * Display name for a picked path.
 *
 * Both separators are checked rather than using the platform's: the value
 * comes back from the main process, and a renderer that assumed `/` would show
 * a full Windows path as the chip label.
 */
export function pickedFileName(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const name = cut >= 0 ? filePath.slice(cut + 1) : filePath;
  return name || filePath;
}

/**
 * Decide the read budget for a picked path, or `null` when the protocol cannot
 * carry that file at all (an archive, a video, an image codec the API rejects).
 *
 * The kind is resolved from the NAME with no MIME type, which is exactly the
 * case `detectAttachmentKind` was already built to survive: a picked path has
 * no `File.type`, and on Windows a real `File` usually has an empty one too.
 *
 * Returning the budget here — rather than letting main pick one — is what
 * keeps the tiers in a single place: main only floors whatever it is given by
 * its own ceiling.
 */
export function plannedReadLimit(
  fileName: string,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS
): PickedReadPlan | null {
  const detected = detectAttachmentKind(fileName, undefined);
  if (!detected) return null;

  return {
    kind: detected.kind,
    mediaType: detected.mediaType,
    maxBytes: detected.kind === 'image' ? limits.maxImageBytes : limits.maxTextBytes,
  };
}

/**
 * The count-budget verdict for a picked path, BEFORE it is read — or `null`
 * when there is still room for it.
 *
 * Round-5 C1: the paste path can afford to check budgets after the bytes exist
 * (a `File` is already in memory), but a picked path costs a real disk read
 * plus an IPC copy per file. Picking 20 screenshots when 5 are allowed must
 * therefore cost 5 reads, not 20 — the 6th one is refused on arithmetic alone.
 *
 * `projected` is "drafts already live + files already accepted in this batch",
 * so the check sees the same list `admitAttachment` will see later rather than
 * a stale render's idea of it.
 *
 * The sentence comes from `admitAttachment` and is never restated here: the
 * user must read the same line whether the 6th file was pasted or picked. Only
 * the LENGTH of `existing` matters to that call — `admitAttachment` decides
 * count before size — hence the placeholder entries, and hence `byteLength: 1`
 * on the candidate, which steps past the `empty` branch we are not asking
 * about (the real size is unknown until the read that this check prevents).
 */
export function pickedCountSkipMessage(
  projected: number,
  candidate: { name: string; kind: AttachmentKind },
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS
): string | null {
  if (projected < limits.maxCount) return null;

  const verdict = admitAttachment(
    Array.from({ length: projected }, () => ({ byteLength: 1 })),
    { name: candidate.name, kind: candidate.kind, byteLength: 1 },
    limits
  );
  return verdict.ok ? null : verdict.message;
}

/**
 * "This file is not something we can send" — shared with the paste path so the
 * two entry points cannot drift into two different sentences for one verdict.
 */
export function unsupportedKindMessage(label: string): string {
  return `"${label}" is not an image or text file — skipped.`;
}

/** "We could not get the bytes" — likewise shared with the paste path. */
export function unreadableMessage(label: string): string {
  return `Could not read "${label}" — skipped.`;
}

/**
 * Turn a main-process read failure into the line that joins the folded notice.
 *
 * `too-large` deliberately routes back through `admitAttachment` instead of
 * formatting its own sentence: the user must not be able to tell whether a
 * 6 MB image was refused by the renderer (pasted) or by the main process
 * (picked), and the only way to guarantee that is to have one function
 * produce both sentences.
 */
export function pickedSkipMessage(
  input: {
    reason: AttachmentReadFailureReason;
    name: string;
    kind: AttachmentKind;
    byteLength?: number;
  },
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS
): string {
  const label = input.name;

  switch (input.reason) {
    case 'too-large': {
      if (typeof input.byteLength === 'number' && input.byteLength > 0) {
        const verdict = admitAttachment(
          [],
          { name: label, kind: input.kind, byteLength: input.byteLength },
          limits
        );
        if (!verdict.ok) return verdict.message;
      }
      // Main refuses on size before reading and always reports the size it
      // saw, so this is unreachable. Falling back to the read-failure sentence
      // keeps an impossible state from inventing a number to print.
      return unreadableMessage(label);
    }
    case 'not-a-file':
      return `"${label}" is not a file — skipped.`;
    // `not-allowed` means the one-shot grant was missing (a replayed read, or
    // a path the user did not pick). It is an internal invariant breach, not
    // something the user did, and the only honest thing to tell them is the
    // same "could not read" the IO failures get.
    case 'not-allowed':
    case 'unreadable':
      return unreadableMessage(label);
  }
}

/** One picked path that made it back with bytes. */
export interface PickedReadSuccess {
  name: string;
  mediaType: string;
  byteLength: number;
  bytes: Uint8Array;
}

export interface PickedBatchOutcome {
  reads: PickedReadSuccess[];
  /** Every reason this batch dropped a file, in pick order, already phrased. */
  skipped: string[];
}

/**
 * Read one gesture's worth of picked paths, serially, through an injected
 * `read`.
 *
 * Serial rather than parallel on purpose: five 5 MB reads in flight is ~25 MB
 * of structured-clone traffic landing at once, and one at a time is no slower
 * for the case that matters (a couple of screenshots).
 *
 * Two properties this loop must keep, both of them round-5 fixes:
 *
 *  - **The count budget is spent before the disk is.** `liveCount()` is called
 *    per file (not sampled once) so a paste landing mid-batch counts, and the
 *    projection includes what this batch has already accepted. Picking 20
 *    images when 5 are allowed costs 5 reads — the rest are refused on
 *    arithmetic, with `admitAttachment`'s own sentence (C1).
 *  - **One bad path cannot mute the batch.** Every iteration is wrapped, so an
 *    unexpected throw becomes that file's skip line instead of discarding the
 *    lines already collected for its neighbours — the caller folds all of them
 *    into the single notice the gesture owes the user (C2).
 *
 * `read` is injected rather than reached for directly so the properties above
 * are testable as counts and order, not just as outcomes — the same reason the
 * main-side handle flow takes its `io` as an argument.
 */
export async function readPickedBatch(input: {
  paths: readonly string[];
  /** Drafts already in the composer, read live — a paste can land mid-batch. */
  liveCount: () => number;
  read: (filePath: string, maxBytes: number) => Promise<AttachmentReadResult>;
  limits?: AttachmentLimits;
}): Promise<PickedBatchOutcome> {
  const limits = input.limits ?? DEFAULT_ATTACHMENT_LIMITS;
  const reads: PickedReadSuccess[] = [];
  const skipped: string[] = [];

  for (const filePath of input.paths) {
    const label = pickedFileName(filePath);
    try {
      const plan = plannedReadLimit(label, limits);
      if (!plan) {
        skipped.push(unsupportedKindMessage(label));
        continue;
      }

      const countSkip = pickedCountSkipMessage(
        input.liveCount() + reads.length,
        { name: label, kind: plan.kind },
        limits
      );
      if (countSkip) {
        skipped.push(countSkip);
        continue;
      }

      const result = await input.read(filePath, plan.maxBytes);
      if (!result.ok) {
        skipped.push(
          pickedSkipMessage(
            { reason: result.reason, name: label, kind: plan.kind, byteLength: result.byteLength },
            limits
          )
        );
        continue;
      }

      reads.push({
        name: label,
        mediaType: plan.mediaType,
        byteLength: result.byteLength,
        bytes: result.bytes,
      });
    } catch {
      // A rejected read lands here, and so would a bug above it. Either way the
      // honest thing to tell the user is that this ONE file did not make it.
      skipped.push(unreadableMessage(label));
    }
  }

  return { reads, skipped };
}

/**
 * Detach the bytes that crossed the IPC bridge into a standalone ArrayBuffer.
 *
 * A `Uint8Array` is a VIEW: handing `bytes.buffer` to a consumer that reads
 * the whole buffer would hand over anything else sharing it, and would report
 * the wrong length whenever the view is a window rather than the whole thing.
 * The common case (a freshly deserialised array that owns its buffer) still
 * costs nothing — only a genuine sub-view is copied.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = bytes.buffer as ArrayBuffer;
  if (bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return buffer;
  }
  return buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
