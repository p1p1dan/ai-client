export class PiWorkerSessionError extends Error {
  // Explicit fields rather than constructor parameter properties: dev runs the
  // worker under Node's strip-only type removal, which rejects them outright.
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'PiWorkerSessionError';
    this.code = code;
    this.retryable = retryable;
  }
}
