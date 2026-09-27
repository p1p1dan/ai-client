// New in dsh-rebase P1-9a: the one error type the legacy pi session library throws.

/**
 * A pi session this library refused to read, keyed by a string `code`.
 *
 * The codes are the 1.0.x vocabulary (`session_invalid`,
 * `session_format_unsupported`, `session_operation_unfinished`,
 * `session_legacy_invalid`, `session_cwd_mismatch`, `WORKER_TREE_UNAVAILABLE`),
 * so a caller that branches on `code` behaves the same whichever host it runs
 * in. A host that needs its own error type (the 1.0.x runtime tests
 * `instanceof RuntimeHostError`) rethrows at its wrapper, keeping code, message
 * and cause.
 */
export class LegacyPiSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'LegacyPiSessionError';
  }
}
