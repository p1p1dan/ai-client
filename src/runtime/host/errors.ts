import { isAbsolute } from 'node:path';

export class RuntimeHostError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'RuntimeHostError';
  }
}

export function absolutePath(path: string): void {
  if (!isAbsolute(path))
    throw new RuntimeHostError('invalid_host_request', `absolute path required: ${path}`);
}

export function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RuntimeHostError('invalid_host_request', `${name} must be a positive safe integer`);
  }
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function timerMilliseconds(value: number, name: string): void {
  positiveInteger(value, name);
  if (value > 2_147_483_647)
    throw new RuntimeHostError('invalid_host_request', `${name} exceeds the timer range`);
}
