/**
 * P6-2 — record every module specifier a process resolves.
 *
 * Runs on Node's module-hooks thread, so it cannot share memory with the worker
 * under test; the log is a file for that reason, not for convenience.
 */
import { appendFileSync } from 'node:fs';

let logPath;

export function initialize(data) {
  logPath = data?.path;
}

export async function resolve(specifier, context, nextResolve) {
  if (logPath && !specifier.startsWith('node:')) {
    appendFileSync(logPath, `${specifier}\n`);
  }
  return nextResolve(specifier, context);
}
