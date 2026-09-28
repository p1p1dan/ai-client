/**
 * Read a WorkerManager error code out of a rejected `chat.send` IPC call.
 *
 * Two facts make this necessary. Main never emits a `host.error` runtime
 * event — grep confirms the type exists and nothing dispatches it — so
 * `ChatComposer`'s `fatalHostErrorCode` could only ever stay null on the Pi
 * path. And Electron's `invoke` rejection carries only `error.message`, so
 * `WorkerManagerError.code` did not survive the crossing either. Between the
 * two, the composer's `session_not_found` recovery and its bounded
 * `session_busy` retry were unreachable: a send into an idle-evicted slot
 * surfaced as a raw "Error invoking remote method 'chat:send'" toast and
 * bounced the user's text back, and only the NEXT send succeeded.
 *
 * `chat.ts`'s `withWorkerErrorCode` now re-throws as `<code>: <message>`, and
 * Electron prefixes its own wrapper text, so the code arrives embedded in a
 * longer string rather than at its head.
 *
 * Deliberately an ALLOW-LIST, not a general `^(\w+):` parse. Only these two
 * codes drive a recovery branch; matching anything else would hand unrelated
 * failures to a retry path built for these, and the surrounding word-boundary
 * guards keep `pi_session_not_found` (a different error, raised when the
 * session index itself has no row) from being read as `session_not_found`.
 */
const RECOVERABLE_SEND_ERROR_CODES = ['session_not_found', 'session_busy'] as const;

export type RecoverableSendErrorCode = (typeof RECOVERABLE_SEND_ERROR_CODES)[number];

const CODE_PATTERN = new RegExp(
  `(?:^|[^a-z0-9_])(${RECOVERABLE_SEND_ERROR_CODES.join('|')})(?![a-z0-9_])`
);

export function parseSendDispatchErrorCode(error: unknown): RecoverableSendErrorCode | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = CODE_PATTERN.exec(message);
  return match ? (match[1] as RecoverableSendErrorCode) : null;
}

/**
 * dsh-rebase P1-4c2 (decision 096; the path P1-1's GUI point-check D2 built) —
 * the engine refused an attachment of a send or a Ctrl+Enter interjection:
 * an image DSH will not admit, or a file it could not store.
 *
 * The bridge decides it before it starts or joins a turn, so nothing was
 * admitted. The code arrives as `WorkerSlotError: WORKER_ATTACHMENT_REJECTED:
 * <DSH code> "<file name>": <DSH sentence>` inside Electron's own wrapper —
 * `WorkerManager` passes it through unrenamed (`WORKER_ATTACHMENT_REJECTED`
 * in `@shared/types/workerRpc`) — and is matched with the same word guards as
 * the codes above. The file name is JSON-quoted and absent when the refusal
 * is about the images as a whole (too many, too many bytes).
 *
 * Deliberately NOT one of the recoverable codes: resending the same payload is
 * refused the same way every time, so the composer hands the payload back
 * instead of retrying it (`refusedByRule` in `queueRelease.ts`).
 */
const ATTACHMENT_REJECTED_PATTERN =
  /(?:^|[^A-Za-z0-9_])WORKER_ATTACHMENT_REJECTED: ([A-Z0-9_]+)(?: ("(?:[^"\\]|\\.)*"))?/;

export interface AttachmentRejection {
  /** DSH's code, e.g. `IMAGE_DIMENSION_TOO_LARGE`. */
  code: string;
  /** The attachment to blame, when one is. */
  name?: string;
}

export function parseAttachmentRejection(error: unknown): AttachmentRejection | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = ATTACHMENT_REJECTED_PATTERN.exec(message);
  if (!match) return null;
  let name: string | undefined;
  try {
    name = match[2] ? (JSON.parse(match[2]) as string) : undefined;
  } catch {
    name = undefined;
  }
  return { code: match[1] as string, ...(name ? { name } : {}) };
}
