import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Locate a runtime helper script (P4-1).
 *
 * `exec-runner.mjs` and `tsd-read.mjs` are spawned by path, never imported, so
 * a bundler cannot see them. In dev the runtime runs from source and they sit
 * next to their caller; in the packaged worker everything is bundled into one
 * `worker.js` and `import.meta.url` points at that file instead, so the same
 * relative lookup finds nothing and the first shell tool of a packaged native
 * session fails on a missing file.
 *
 * Both layouts are therefore tried, and the miss is reported with both paths:
 * "helper not found" without saying where it looked is the kind of packaging
 * error that costs an afternoon.
 */
export const BUNDLED_HELPER_DIR = 'runtime-helpers';

export function resolveHelper(name: string, base: string): string {
  const candidates = [new URL(name, base), new URL(`${BUNDLED_HELPER_DIR}/${name}`, base)].map(
    (url) => fileURLToPath(url)
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Runtime helper ${name} is missing; looked in ${candidates.join(' and ')}`);
}
