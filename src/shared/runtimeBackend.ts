/**
 * ARD D8 — which engine a worker slot runs, as an environment variable.
 *
 * Lives in `shared` rather than in `src/runtime/flags.ts` because the root
 * tsconfig EXCLUDES `src/runtime/**`: Main cannot import the runtime package,
 * so a constant both sides need has nowhere else to be. `flags.ts` re-exports
 * it, which is what keeps the two readings of this variable the same string.
 */
export const RUNTIME_BACKEND_ENV = 'AICLIENT_RUNTIME_BACKEND';

export type RuntimeBackend = 'legacy' | 'native';

/**
 * An unrecognised value reads as `legacy`, not as an error: this variable is
 * set by hand during development, and a typo must not be the thing that decides
 * a user's session runs on unfinished code.
 */
export function readRuntimeBackend(env: NodeJS.ProcessEnv = process.env): RuntimeBackend {
  return env[RUNTIME_BACKEND_ENV]?.trim() === 'native' ? 'native' : 'legacy';
}
