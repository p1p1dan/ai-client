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

/**
 * T101 — open a tool row while its arguments are still streaming.
 *
 * Default ON. Before this, a row appeared only at `tool_execution_start`, which
 * is AFTER the model has finished dictating the call: a `write` whose `content`
 * is a whole file left the screen completely still for as long as the file took
 * to emit — minutes, with a spinning group head and nothing under it, and not
 * even a liveness event to say the turn was alive.
 *
 * Set to `0` to restore that behaviour exactly. The projector then ignores
 * `toolCall` blocks on partial messages and `tool_execution_start` is once again
 * the only producer of `tool.started`, so nothing downstream can tell the
 * difference — which is the point of the switch (engineering standard §6).
 */
export const STREAM_TOOL_ROWS_ENV = 'AICLIENT_STREAM_TOOL_ROWS';

/**
 * The subagent tool loop guard (engineering standard §6; see
 * `plugins/agent-loop/delegationLoopGuard.ts`'s module doc for the two
 * measured failure shapes this protects against).
 *
 * Default ON, opt-out like {@link STREAM_TOOL_ROWS_ENV}: set to `0` to kill it
 * in an emergency without a rebuild. Turning it off drops only the
 * INTERCEPTING behaviour — form B's mid-stream cut (`guardReplyRepetition` in
 * the agent loop), form A's refusal from the second idle `TaskWait` /
 * `TaskList` / `TaskStop` call on (`idleVerdict` in the subagent plugin) and
 * the turn-ceiling-style wrap-up that follows it, and the `aiclient.loopGuard`
 * session record either of those writes. It does NOT touch the tool answers
 * that were fixes rather than protection: report delivery, `TaskStop`'s
 * bounded wait, `TaskList`'s status labelling, or any of the tools'
 * descriptions — those stay exactly as they are with the switch off.
 */
export const LOOP_GUARD_ENV = 'AICLIENT_RUNTIME_LOOP_GUARD';

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
  /** See {@link STREAM_TOOL_ROWS_ENV}. Defaults to `true`. */
  streamToolRows: boolean;
  /** See {@link LOOP_GUARD_ENV}. Defaults to `true`. */
  loopGuardEnabled: boolean;
}

export function readRuntimeFlags(env: NodeJS.ProcessEnv = process.env): RuntimeFlags {
  return {
    backend: 'native',
    agentDir: firstNonEmpty(env[RUNTIME_AGENT_DIR_ENV], env[PI_AGENT_DIR_ENV]),
    traceDir: firstNonEmpty(env[RUNTIME_TRACE_DIR_ENV]),
    skipUserInstructions: env[SKIP_USER_INSTRUCTIONS_ENV] === '1',
    // Opt-OUT rather than opt-in, unlike every flag above: this one is the
    // behaviour we want shipped, and the variable exists to take it back.
    streamToolRows: env[STREAM_TOOL_ROWS_ENV] !== '0',
    // Same opt-OUT shape as `streamToolRows`: shipped ON, and the variable is
    // an emergency kill switch rather than an opt-in.
    loopGuardEnabled: env[LOOP_GUARD_ENV] !== '0',
  };
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
