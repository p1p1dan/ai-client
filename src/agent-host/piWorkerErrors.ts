export class PiWorkerSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'PiWorkerSessionError';
  }
}
