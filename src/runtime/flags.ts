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

/**
 * P6-5 removed `AICLIENT_RUNTIME_BACKEND` along with the engine it could select.
 *
 * ARD D8 always said the switch would be deleted once the old path retired; the
 * user brought that forward on 2026-09-13. A rollback is now「装回上一个安装包」,
 * which is stated in `docs/pi-only-rollout-rollback.md`. Nothing reads the
 * variable any more — setting it has no effect at all.
 */

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

export interface RuntimeFlags {
  /**
   * The engine that produced a run, carried into every trace's version stamp.
   *
   * A constant since P6-5 — there is only one engine. Kept as a field rather
   * than inlined at the stamp so an archived trace and a current one can still
   * be compared field by field.
   */
  backend: 'native';
  /** Resolved catalog directory, or `null` when neither variable is set. */
  agentDir: string | null;
  traceDir: string | null;
}

export function readRuntimeFlags(env: NodeJS.ProcessEnv = process.env): RuntimeFlags {
  return {
    backend: 'native',
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
