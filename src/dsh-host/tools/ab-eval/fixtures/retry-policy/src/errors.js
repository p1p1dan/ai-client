export class HttpError extends Error {
  constructor(status, message) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 429 and 5xx are worth another try; everything else fails fast. */
export function isRetryable(error) {
  if (!(error instanceof HttpError)) return false;
  return error.status === 429 || error.status >= 500;
}
