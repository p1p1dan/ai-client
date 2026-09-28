/**
 * The `aiclient-loop-guard` row's names, limits and model-facing wording
 * (dsh-rebase P1-8; decisions 065, 066; runtime-hardening decisions 040, 042).
 *
 * Import-free on purpose: the bridge (P1-4d's `turn_limit` and failure-card
 * mappings) and the renderer can take these values without pulling in DSH.
 * The wording is 1.0.x's, verbatim (`src/runtime/plugins/agent-loop/`), so the
 * model reads the same instructions it did before the engine change.
 */

/** Stable Cordis plugin name and bundle row id. */
export const LOOP_GUARD_ROW = 'aiclient-loop-guard';

/** The Cordis service other rows query (`refusalFor`), e.g. P1-6b's permission gate. */
export const LOOP_GUARD_SERVICE = 'aiclientLoopGuard';

/**
 * Emergency kill switch, 1.0.x's name (`src/runtime/flags.ts`). Only the exact
 * value `0` turns the row off; it then neither cuts replies nor caps steps.
 * Main strips `AICLIENT_*` from the host's environment and forwards this one
 * explicitly (`dshHostEnvironment.ts`).
 */
export const LOOP_GUARD_ENV = 'AICLIENT_RUNTIME_LOOP_GUARD';

// ---- rule B: one reply repeating delegation calls --------------------------------

/** `turn/end.error.code` (and the renderer's failure-card key) of a cut reply. */
export const TOOL_CALL_REPETITION = 'tool_call_repetition';

/**
 * The delegation and background-work tool family, by DSH wire name: the
 * tools a degenerating model loops on (decision 042's scope, renamed for
 * DSH). `delegate` is decision 070's custom-subagent tool.
 */
export const DELEGATION_TOOL_NAMES: readonly string[] = [
  'subagent',
  'subagent_fork',
  'delegate',
  'send_message',
  'interrupt_agent',
  'list_agents',
  'job_output',
  'job_list',
  'job_kill',
];

/** 1.0.x `MAX_IDENTICAL_DELEGATION_CALLS_PER_REPLY`: the third identical call trips. */
export const MAX_IDENTICAL_DELEGATION_CALLS_PER_REPLY = 3;

/** 1.0.x `MAX_DELEGATION_CALLS_PER_REPLY`: the seventeenth family call trips. */
export const MAX_DELEGATION_CALLS_PER_REPLY = 16;

// ---- rule C: the step ceiling ------------------------------------------------------

/** Decision 040's ceiling, counted in DSH steps per agent (decision 066). */
export const DEFAULT_STEP_CEILING = 500;

/** `agent.cancel({kind:'hook', reason})` at the wrap-up step's `step/end`; the bridge maps it to `turn_limit`. */
export const TURN_CEILING_CANCEL_REASON = 'aiclient-turn-ceiling';

/** `source.kind` of the wrap-up instruction; the history projection hides it. */
export const LOOP_GUARD_SOURCE_KIND = 'aiclient-loop-guard';

/** `info.code` on a tool call refused inside the wrap-up step. */
export const TURN_CEILING_REFUSAL_CODE = 'turn_ceiling';

/**
 * Message sources that start a new count (decision 066 rule 1): the user
 * (send, interjection, and a delegating parent's prompt to its child), our
 * retry continuation (decision 028) and a goal round. Job notices, subagent
 * reports and our own instruction do not.
 */
export const EPOCH_SOURCE_KINDS: readonly string[] = ['user', 'aiclient-retry', 'goal'];

/** 1.0.x `TURN_CEILING_TOOL_REFUSAL`, what a call in the wrap-up step gets back. */
export const TURN_CEILING_TOOL_REFUSAL =
  'Refused: this run has reached its turn ceiling. Do not call tools; write your summary for the user instead.';

/**
 * 1.0.x `turnCeilingPrompt`. `withReports` when the step also carries
 * background reports (job notices, subagent results) that arrived after the
 * ceiling; they ride in front of this instruction, as in 1.0.x.
 */
export function turnCeilingPrompt(ceiling: number, withReports: boolean): string {
  return [
    `You have taken ${ceiling} assistant turns on this request, which is this app's ceiling for one run.`,
    'Stop working now and do not call any tool — a tool call in this reply will be refused.',
    ...(withReports
      ? [
          'The subagent reports above arrived after the ceiling; account for them in your summary, but do not continue the work they describe.',
        ]
      : []),
    'Write your final reply to the user, in the language they have been using: what you have done, where things stand, and what is left.',
    'The user can reply "continue" to carry on from exactly here.',
  ].join(' ');
}
