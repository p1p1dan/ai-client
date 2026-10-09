/**
 * dsh-rebase decision 169: the plan review card's pure half.
 *
 * Plan mode ends with the model presenting its plan (`exit_plan_mode`) or
 * proposing a goal (`create_goal`); the bridge raises this card in the dock
 * (`question.requested` with `review`). The user picks how to go on:
 *
 *   设为目标，全自动执行   (default)        `goal:auto`
 *   设为目标，完全放行执行  confirmed once more `goal:bypass` (decision 023)
 *   只执行这一次，不设目标                  `run:auto`
 *   继续讨论修改          feedback required  `keep-planning`
 *
 * or closes the review (a cancel: the model stops and waits for a message).
 * The goal options are off while the chat has an unfinished goal (DSH would
 * refuse a second one), read live off the goal bar's own view.
 *
 * Also here: what a settled review says — the frozen card's line, and the
 * word a review's tool row ends with, live and replayed alike.
 */

import {
  type PlanReviewChoice,
  type PlanReviewGoalOutcome,
  planReviewResponse,
} from '@shared/planReview';
import type { PlanReviewCard } from '@shared/types/runtimeEvents';
import type { ChatBlock } from '@/stores/chatSessions';
import { hasUnfinishedGoal } from './goalStart';
import { clippedPlanFeedback, type PlanReviewWord } from './planReviewRowWord';
import type { GoalBarView } from './sessionPanelsModel';

/** Dictionary keys of the card's chrome. */
export const PLAN_REVIEW_TITLE = 'Plan ready for review';
export const PLAN_REVIEW_GOAL_TITLE = 'Goal proposed for review';
export const PLAN_REVIEW_CLOSE = 'Close the review and type a message';
export const PLAN_REVIEW_CONFIRM = 'Confirm';
export const PLAN_REVIEW_FEEDBACK_LABEL = 'What should change';
export const PLAN_REVIEW_FEEDBACK_REQUIRED =
  'Say what should change, or close the review to type a message.';
export const PLAN_REVIEW_GOAL_UNAVAILABLE =
  'This chat has an unfinished goal. Pause, finish or clear it in the goal bar first.';
export const PLAN_REVIEW_BYPASS_WARNING =
  'With all prompts bypassed, nothing is asked again (explicit deny rules still apply) until you pick another permission level at the bottom left of the message box.';
export const PLAN_REVIEW_BYPASS_CONFIRM = 'Confirm: run with all prompts bypassed';
export const PLAN_REVIEW_BACK = 'Back';

export interface PlanReviewOptionCopy {
  label: string;
  description: string;
}

/** Each choice's label and description, as dictionary keys, in card order. */
export const PLAN_REVIEW_OPTION_COPY: Readonly<Record<PlanReviewChoice, PlanReviewOptionCopy>> = {
  'goal:auto': {
    label: 'Set as goal, run on full auto',
    description:
      'Works toward this plan round after round until it is done; edits and commands are not asked about one by one.',
  },
  'goal:bypass': {
    label: 'Set as goal, bypass all prompts',
    description: 'Also runs what full auto would stop to ask about. You confirm this once more.',
  },
  'run:auto': {
    label: 'Run it once, without a goal',
    description: 'Carries out the plan in this run on full auto, then stops.',
  },
  'keep-planning': {
    label: 'Keep discussing and revising',
    description: 'Stays in plan mode; what you write goes back to the model.',
  },
};

const ORDER: readonly PlanReviewChoice[] = [
  'goal:auto',
  'goal:bypass',
  'run:auto',
  'keep-planning',
];

export interface PlanReviewOptionRow extends PlanReviewOptionCopy {
  id: PlanReviewChoice;
  disabled: boolean;
  /** Dictionary key: why a disabled row is off. */
  hint?: string;
}

/** The card's rows; the goal rows are off while an unfinished goal is current. */
export function planReviewOptionRows(goal: GoalBarView | null): PlanReviewOptionRow[] {
  const goalTaken = hasUnfinishedGoal(goal);
  return ORDER.map((id) => {
    const setsGoal = id === 'goal:auto' || id === 'goal:bypass';
    return {
      id,
      ...PLAN_REVIEW_OPTION_COPY[id],
      disabled: setsGoal && goalTaken,
      ...(setsGoal && goalTaken ? { hint: PLAN_REVIEW_GOAL_UNAVAILABLE } : {}),
    };
  });
}

/** What the card starts on: a goal on full auto, or running once when no goal can be set. */
export function defaultPlanReviewChoice(goal: GoalBarView | null): PlanReviewChoice {
  return hasUnfinishedGoal(goal) ? 'run:auto' : 'goal:auto';
}

/** A choice the rows still offer; a goal choice that went off falls back to the default. */
export function availablePlanReviewChoice(
  choice: PlanReviewChoice,
  goal: GoalBarView | null
): PlanReviewChoice {
  const row = planReviewOptionRows(goal).find((item) => item.id === choice);
  return row && !row.disabled ? choice : defaultPlanReviewChoice(goal);
}

export type PlanReviewSubmit =
  | { kind: 'send'; payload: { answers: Record<string, string>; response?: string } }
  | { kind: 'confirm-bypass' }
  | { kind: 'feedback-required' };

/**
 * What 「确定」 does: bypass asks once more first (decision 023), keep
 * planning needs feedback (an empty one would make DSH present the same plan
 * again at once), everything else answers.
 */
export function planReviewSubmit(
  choice: PlanReviewChoice,
  feedback: string,
  confirmedBypass: boolean
): PlanReviewSubmit {
  if (choice === 'goal:bypass' && !confirmedBypass) return { kind: 'confirm-bypass' };
  if (choice === 'keep-planning' && feedback.trim() === '') return { kind: 'feedback-required' };
  return { kind: 'send', payload: planReviewResponse(choice, feedback) };
}

/** The plan preview's height: a few lines in the dock, more once opened. */
export function planPreviewClass(expanded: boolean): string {
  return expanded ? 'max-h-96' : 'max-h-48';
}

/** What the card shows as the reviewed text: the plan, else the goal the model proposed. */
export function planReviewBody(card: PlanReviewCard): { kind: 'plan' | 'goal'; markdown: string } {
  if (card.plan?.trim()) return { kind: 'plan', markdown: card.plan };
  return { kind: 'goal', markdown: card.objective ?? card.goalObjective };
}

// ---- after the review -------------------------------------------------------------

const APPROVED_LINE: Readonly<Record<Exclude<PlanReviewChoice, 'keep-planning'>, string>> = {
  'goal:auto': 'Plan review · approved: set as goal, full auto',
  'goal:bypass': 'Plan review · approved: set as goal, all prompts bypassed',
  'run:auto': 'Plan review · approved: run once, no goal',
};

/** The frozen card's one line (`question.resolved`). */
export function frozenPlanReviewLine(block: ChatBlock): PlanReviewWord {
  if (block.questionStopped) return { key: 'Plan review · stopped' };
  const review = block.planReviewResult;
  if (block.questionOutcome !== 'answered' || !review) return { key: 'Plan review · closed' };
  if (review.choice === 'keep-planning') {
    const feedback = block.questionResponse ? clippedPlanFeedback(block.questionResponse) : '';
    return feedback
      ? { key: 'Plan review · keep revising: {{feedback}}', params: { feedback } }
      : { key: 'Plan review · keep revising' };
  }
  return { key: APPROVED_LINE[review.choice] };
}

/** The goal line under an approved frozen card, when its goal was not set. */
export function frozenPlanReviewGoalNote(block: ChatBlock): PlanReviewWord | null {
  const goal: PlanReviewGoalOutcome | undefined = block.planReviewResult?.goal;
  if (!goal || goal.set) return null;
  return { key: 'Goal not set: {{reason}}', params: { reason: clippedPlanFeedback(goal.reason) } };
}

/** The plan review card this chat has up, if any: what a message sent now closes first. */
export function pendingPlanReviewId(
  state: {
    pendingQuestions: readonly { sessionId: string; questionId: string; messageId: string }[];
    messages: Readonly<Record<string, readonly { id: string; blocks: readonly ChatBlock[] }[]>>;
  },
  sessionId: string | null
): string | null {
  if (!sessionId) return null;
  for (const pending of state.pendingQuestions) {
    if (pending.sessionId !== sessionId) continue;
    const message = state.messages[sessionId]?.find((item) => item.id === pending.messageId);
    const block = message?.blocks.find(
      (item) => item.type === 'question' && item.questionId === pending.questionId
    );
    if (block?.planReview && block.resolved !== true) return pending.questionId;
  }
  return null;
}
