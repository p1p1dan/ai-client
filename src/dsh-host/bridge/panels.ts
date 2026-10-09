/**
 * The goal bar's and the todo card's data, and the command channel their
 * buttons use (dsh-rebase P1-7a; decisions 072 rules 1-2, 113 rule 12, 118).
 *
 * Two RPCs and one bridge-made projection key:
 *
 *   `worker.command {line}`   one DSH command run out of band: no turn, no
 *                             event, not refused while a turn runs — the goal
 *                             bar's pause is meant for the round that is
 *                             running. DSH logs its `command/run` /
 *                             `command/done` as it does for any command; the
 *                             live translation only echoes the ones a send
 *                             carried (`liveEvents.ts`), so nothing shows.
 *   `worker.panels`           the current `todos`, `goal`, `subagentCatalog`
 *                             and `goalActivation`, for a renderer that missed
 *                             them (reload, a chat switched to, a session
 *                             reopened with no event since).
 *   `goalActivation`          DSH's `goal` projection leaves the process-local
 *                             armed state out on purpose; the bridge reads it
 *                             from `ctx.goals.get` and `goal/activation-changed`.
 *
 * No value imports from DSH: the runtime hands these helpers the services.
 */

import type { DshGoalActivation } from '../../shared/types/runtimeEvents.ts';
import type { WorkerCommandResult } from '../../shared/types/workerRpc.ts';
import {
  type DshCommandExecution,
  dshCommandName,
  HIDDEN_DSH_COMMANDS,
  WINDOW_OWNED_COMMANDS,
} from './commands.ts';
import type { DshCreatedGoal } from './planReview.ts';

/** `GoalView` of `@deepseek-ai/dsh-goal`, narrowed to what the bar needs from it. */
export interface DshGoalView {
  readonly id: string;
  readonly revision: number;
  readonly activation: 'armed' | 'disarmed';
}

/** `ctx.goals` (dsh-goal), narrowed: the live view of an agent's goal. */
export interface DshGoalsView {
  /** Throws when the agent is not the registry's live instance. */
  get(agent: unknown): DshGoalView | undefined;
  /**
   * Creates and arms a goal (decision 169: a plan review's approval); throws
   * `GOAL_ALREADY_EXISTS` while an unfinished goal is current.
   */
  create?(agent: unknown, request: { objective: string; maxGoalRounds?: number }): DshCreatedGoal;
}

/** `GoalActivationChanged` of `@deepseek-ai/dsh-goal`: one live activation edge. */
export interface DshGoalActivationChanged {
  readonly sessionId: string;
  /** Absent once no goal is current (a clear). */
  readonly goal?: { readonly id: string; readonly revision: number; readonly activation: string };
}

function activationOf(value: unknown): DshGoalActivation['activation'] | undefined {
  return value === 'armed' || value === 'disarmed' ? value : undefined;
}

/** The `goalActivation` view of a live goal: `null` when none is current. */
export function goalActivationOf(goal: DshGoalView | undefined): DshGoalActivation | null {
  const activation = activationOf(goal?.activation);
  if (!goal || !activation) return null;
  return { goalId: goal.id, revision: goal.revision, activation };
}

/** The `goalActivation` view an activation edge carries. */
export function goalActivationFromEdge(edge: DshGoalActivationChanged): DshGoalActivation | null {
  const activation = activationOf(edge.goal?.activation);
  if (!edge.goal || !activation) return null;
  return { goalId: edge.goal.id, revision: edge.goal.revision, activation };
}

/**
 * The command a `worker.command` line may run, or undefined: DSH's grammar
 * names it, and it is neither hidden (decision 113 rule 1) nor owned by the
 * window (`/compact`, which has its own RPC and budget).
 */
export function outOfBandCommandName(line: string): string | undefined {
  const name = dshCommandName(line);
  if (!name || HIDDEN_DSH_COMMANDS.has(name) || WINDOW_OWNED_COMMANDS.has(name)) return undefined;
  return name;
}

/** What a settled command answers the renderer: DSH's text either way. */
export function commandResultOf(execution: DshCommandExecution): WorkerCommandResult {
  const { result } = execution;
  if (result.kind === 'success') {
    return { ok: true, ...(result.text ? { output: result.text } : {}) };
  }
  return { ok: false, error: result.text };
}
