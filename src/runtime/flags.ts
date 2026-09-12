/**
 * Runtime feature flags — engineering standard §6 (every new capability ships
 * behind a switch) and ARD D8 (the backend switch is a dev environment
 * variable, never a settings-page control).
 *
 * All of these are read from a supplied `env` rather than `process.env`
 * directly, so a test can exercise both sides of a flag without mutating the
 * process. `bootstrap.ts` reads them exactly once, at construction: a flag that
 * could change mid-run would make a trace's version stamp a lie.
 */

import { type RuntimeBackend, readRuntimeBackend } from '../shared/runtimeBackend.ts';

/**
 * ARD D8. Same naming family as `AICLIENT_PI_WORKER_CAPACITY`.
 *
 * Re-exported from `shared` rather than declared here: Main has to read the
 * same variable (P5-5 only assembles a catalog for the native backend) and
 * cannot import this package — the root tsconfig excludes `src/runtime/**`.
 */
export { RUNTIME_BACKEND_ENV } from '../shared/runtimeBackend.ts';

/**
 * Where the pi catalog (`models.json` + `auth.json`) lives.
 *
 * Defaults to `PI_CODING_AGENT_DIR`, which Main already exports for the managed
 * credential mode (`src/main/services/piModelConfig/index.ts:230`). Reusing it
 * is ARD D7 in practice — the new runtime reads the credential layout the app
 * already writes, and Main needs no change to feed it. The dedicated override
 * exists so a smoke run can point at a fixture directory without disturbing the
 * variable a real worker inherits.
 */
export const RUNTIME_AGENT_DIR_ENV = 'AICLIENT_RUNTIME_AGENT_DIR';
export const PI_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';

/** Directory run traces are appended to. Absent = keep traces in memory only. */
export const RUNTIME_TRACE_DIR_ENV = 'AICLIENT_RUNTIME_TRACE_DIR';

export type { RuntimeBackend } from '../shared/runtimeBackend.ts';

export interface RuntimeFlags {
  /**
   * Which engine a WorkerSlot should start (P4-2 reads this; P0 only reports
   * it, so the value shows up in traces from the first run onward).
   *
   * Defaults to `legacy` because the native runtime is incomplete until P4.
   * P6-1 flips the default and P6-4 keeps the switch for one release cycle.
   */
  backend: RuntimeBackend;
  /** Resolved catalog directory, or `null` when neither variable is set. */
  agentDir: string | null;
  traceDir: string | null;
}

export function readRuntimeFlags(env: NodeJS.ProcessEnv = process.env): RuntimeFlags {
  return {
    backend: readRuntimeBackend(env),
    agentDir: firstNonEmpty(env[RUNTIME_AGENT_DIR_ENV], env[PI_AGENT_DIR_ENV]),
    traceDir: firstNonEmpty(env[RUNTIME_TRACE_DIR_ENV]),
  };
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
