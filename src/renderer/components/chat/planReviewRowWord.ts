/**
 * dsh-rebase decision 169: the word a plan review's tool row ends with —
 * `exit_plan_mode`, or `create_goal` reviewed in plan mode — read off the
 * row's own result, so a live row and a replayed one say the same. A leaf
 * (only `@shared/planReview`): `toolCard.ts` reads it.
 */

import { planReviewRowOutcome } from '@shared/planReview';

export interface PlanReviewWord {
  /** Dictionary key. */
  key: string;
  params?: Record<string, string>;
}

const FEEDBACK_CHARS = 120;

/** What the user wrote, on one line and bounded, for a row or the frozen card. */
export function clippedPlanFeedback(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > FEEDBACK_CHARS ? `${line.slice(0, FEEDBACK_CHARS)}…` : line;
}

const REVIEW_TOOLS = new Set(['exit_plan_mode', 'create_goal']);

/**
 * The row's word: approved, keep revising (with the feedback), closed;
 * undefined for every other row, a running one, and a `create_goal` that
 * simply set its goal.
 */
export function planReviewRowWord(
  toolName: string,
  status: 'running' | 'ok' | 'failed',
  output: string | undefined
): PlanReviewWord | undefined {
  if (!REVIEW_TOOLS.has(toolName) || status === 'running') return undefined;
  if (status === 'ok') return toolName === 'exit_plan_mode' ? { key: 'Plan approved' } : undefined;
  const outcome = planReviewRowOutcome(output);
  switch (outcome?.kind) {
    case 'keep-planning':
      return outcome.feedback
        ? {
            key: 'Keep revising: {{feedback}}',
            params: { feedback: clippedPlanFeedback(outcome.feedback) },
          }
        : { key: 'Keep revising' };
    case 'dismissed':
      return { key: 'Review closed' };
    case 'approved-without-goal':
      return { key: 'Approved, no goal set' };
    case 'goal-not-set':
      return { key: 'Approved; the goal could not be set' };
    default:
      return undefined;
  }
}
