/**
 * D4 (round-5): the "path -> bytes" hop behind the Composer's ⊕ menu.
 *
 * This is the ONLY thing the attachment pipeline was missing: the wire format
 * (`ChatSendAttachment`) has always been able to carry an image or a text
 * document, and `admitAttachment` has always owned the budgets — but the
 * renderer had no way to turn a picked file path into the bytes those two
 * already knew how to handle.
 *
 * Two deliberate non-goals:
 *
 *  - The renderer's four budgets (count / image / text / total) do NOT sink
 *    down here. Main enforces exactly one number — the hard ceiling below —
 *    plus whatever `maxBytes` the caller passes for this one read. Every
 *    tiered decision stays in `attachmentLimits.ts` so there is one place a
 *    re-measure can change it, and one set of user-facing sentences.
 *  - Failure is a value, not an exception: a rejected read is an ordinary
 *    "skipped" line in the same folded notice the paste path already
 *    produces, so it must survive the IPC hop as data.
 */

/**
 * Main-process hard ceiling for one attachment read, in RAW bytes.
 *
 * INVARIANT (locked by a unit test in `attachmentLimits.test.ts`): this equals
 * `DEFAULT_ATTACHMENT_LIMITS.maxImageBytes`. It cannot import that constant —
 * `@shared` is loaded by the main process, the renderer budgets are renderer
 * code — so the mirror is asserted instead, the same technique
 * `HOST_STALL_TIMEOUT_MS` uses for the agent-host boundary.
 *
 * It exists so that a renderer bug (or a compromised renderer) cannot ask the
 * main process to pull an arbitrarily large file into memory: `maxBytes` is
 * advice from the caller, this is the floor of the two.
 */
export const MAX_ATTACHMENT_READ_BYTES = 5 * 1024 * 1024;

/**
 * Why a read produced nothing.
 *
 * - `too-large`   — refused BEFORE reading, off `stat().size`; carries the
 *                   size so the renderer can print the same sentence
 *                   `admitAttachment` prints for an oversized paste.
 * - `not-a-file`  — a directory or a device node reached the handler.
 * - `not-allowed` — the path was not one the user just picked (see the
 *                   one-shot allowlist in `PickedAttachmentAccess`).
 * - `unreadable`  — permissions, a vanished file, an IO error.
 */
export type AttachmentReadFailureReason = 'too-large' | 'not-a-file' | 'unreadable' | 'not-allowed';

export type AttachmentReadResult =
  | { ok: true; bytes: Uint8Array; byteLength: number }
  | { ok: false; reason: AttachmentReadFailureReason; byteLength?: number };

/** Options for one `file:readAttachment` call. */
export interface AttachmentReadOptions {
  /** Caller's budget for THIS file (image vs text tier). Clamped by the ceiling. */
  maxBytes: number;
}
