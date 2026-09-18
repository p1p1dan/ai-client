/**
 * Runtime environment knobs — engineering standard §6 (a new capability ships
 * behind a switch) and ARD D8 as it actually landed.
 *
 * D8 said the engine switch would be a dev environment variable and never a
 * settings-page control, and that it would be deleted once the old engine
 * retired. P6-5 did exactly that on 2026-09-13: `AICLIENT_RUNTIME_BACKEND` is
 * gone along with the engine it could select, setting it has no effect, and a
 * rollback is now "install the previous package" (`docs/pi-only-rollout-
 * rollback.md`). What is left here selects no engine — it only tells the single
 * runtime where to read the model catalog and where to write traces.
 *
 * All of these are read from a supplied `env` rather than `process.env`
 * directly, so a test can exercise both sides of a flag without mutating the
 * process. `bootstrap.ts` reads them exactly once, at construction: a flag that
 * could change mid-run would make a trace's version stamp a lie.
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

/**
 * A-round testing (temporary, see `perf-2026-09-18.md`): the user tier of
 * project instructions (decision 016's home-directory global — this repo's own
 * `~/.pilab/AGENTS.md`, or a tester's personal `~/.claude/CLAUDE.md` /
 * `~/.codex/AGENTS.md`) measured at 11,430 of a 16,918-byte system prompt on a
 * real machine. Set to `1` to drop just that tier for the duration of a run.
 *
 * TO REVERT AFTER A-ROUND TESTING: nothing to flip — the default (unset, or
 * any value other than `1`) is the pre-existing behaviour, so simply no
 * longer setting the variable is the full revert. The workspace's own
 * `CLAUDE.md` / `AGENTS.md` (decision 008's `project` / `local` sources) are
 * never affected by this switch either way.
 */
export const SKIP_USER_INSTRUCTIONS_ENV = 'AICLIENT_SKIP_USER_INSTRUCTIONS';

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
  /** See {@link SKIP_USER_INSTRUCTIONS_ENV}. Defaults to `false`. */
  skipUserInstructions: boolean;
}

export function readRuntimeFlags(env: NodeJS.ProcessEnv = process.env): RuntimeFlags {
  return {
    backend: 'native',
    agentDir: firstNonEmpty(env[RUNTIME_AGENT_DIR_ENV], env[PI_AGENT_DIR_ENV]),
    traceDir: firstNonEmpty(env[RUNTIME_TRACE_DIR_ENV]),
    skipUserInstructions: env[SKIP_USER_INSTRUCTIONS_ENV] === '1',
  };
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
