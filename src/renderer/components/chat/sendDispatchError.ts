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
