// New in dsh-rebase P1-6a: host-neutral error plumbing for the shared permission library.

/**
 * Builds every error this library throws, keyed by a string `code`.
 *
 * Injected rather than fixed so each host keeps its own error type: callers in
 * the 1.0.x runtime test `instanceof RuntimeHostError`, while a DSH host maps
 * the code onto its own denial shape. Hosts that bring nothing get
 * `PermissionError`.
 */
export type PermissionErrorFactory = (
  code: string,
  message: string,
  options?: ErrorOptions
) => Error;

/** The default error type, for hosts that do not inject their own. */
export class PermissionError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'PermissionError';
  }
}

export const createPermissionError: PermissionErrorFactory = (code, message, options) =>
  new PermissionError(code, message, options);

/**
 * The `code` an error carries, read the same duck-typed way the runtime reads
 * it, so a filesystem error from any host (`ENOENT`, `EACCES`) is recognised.
 */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
