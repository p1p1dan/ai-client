/**
 * The plan review's DSH side (dsh-rebase decision 169), free of the runtime.
 *
 * Plan mode is DSH's own (`dsh-plan-mode`), kept in step with our gate: the
 * model presents its plan through `exit_plan_mode`, which asks
 * `ctx.userQuestions` one question with `intent {kind: 'plan-review'}`. The
 * bridge's answerer recognises it (`planReviewOf`) and raises the review card
 * instead of the generic question card; the card's choice
 * (`@shared/planReview`) is answered back in DSH's terms:
 *
 *   approve        `{selected: ['Approve']}`, nothing custom (DSH approves
 *                  only that), after the runtime switched the posture
 *   keep planning  `{selected: ['Keep planning'], custom: feedback}`: DSH
 *                  hands the feedback to the model, which revises the plan
 *   close          a `UserQuestionError` `ASK_CANCELLED` (duck-typed; DSH
 *                  restores the real error): the model stops and waits
 *
 * `create_goal` called in plan mode opens the same card from the bridge's
 * `tools/execute` wrapper; its call settles with the results built here.
 */

import {
  KEEP_PLANNING_FEEDBACK_PREFIX,
  PLAN_REVIEW_APPROVE_LABEL,
  PLAN_REVIEW_KEEP_PLANNING_LABEL,
  PLAN_REVIEW_QUESTION_ID,
  planTitleOf,
} from '../../shared/planReview.ts';
import type { PlanReviewCard } from '../../shared/types/runtimeEvents.ts';
import type { DshQuestionAnswer, DshQuestionItem, DshQuestionRequest } from './questions.ts';

/** The review question of an `exit_plan_mode` call, as the answerer reads it. */
export interface DshPlanReviewRequest {
  item: DshQuestionItem;
  plan: string;
  callId?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The request is DSH's plan review: exactly one question, whose intent is
 * `plan-review` and whose detail is the plan. Anything else is an ordinary
 * question, on the ordinary card.
 */
export function planReviewOf(request: DshQuestionRequest): DshPlanReviewRequest | undefined {
  if (request.questions.length !== 1) return undefined;
  const item = request.questions[0];
  const intent = recordOf(item?.intent);
  if (!item || intent?.kind !== 'plan-review' || typeof item.detail !== 'string') return undefined;
  const callId = typeof intent.callId === 'string' && intent.callId ? intent.callId : undefined;
  return { item, plan: item.detail, ...(callId ? { callId } : {}) };
}

/** The card for a plan presented through `exit_plan_mode`. */
export function exitPlanReviewCard(
  review: DshPlanReviewRequest,
  goalObjective: string
): PlanReviewCard {
  const title = planTitleOf(review.plan);
  return {
    kind: 'plan',
    source: 'exit_plan_mode',
    ...(title ? { title } : {}),
    plan: review.plan,
    ...(review.callId ? { callId: review.callId } : {}),
    goalObjective,
  };
}

/** The card for a goal the model proposed with `create_goal` while in plan mode. */
export function createGoalReviewCard(input: {
  objective: string;
  callId: string;
  /** The plan last presented in this session, when there is one. */
  plan?: string;
}): PlanReviewCard {
  const title = input.plan ? planTitleOf(input.plan) : undefined;
  return {
    kind: 'plan',
    source: 'create_goal',
    ...(title ? { title } : {}),
    ...(input.plan ? { plan: input.plan } : {}),
    objective: input.objective,
    callId: input.callId,
    goalObjective: input.objective,
  };
}

/** DSH's approval: exactly `Approve`, nothing custom (`dsh-plan-mode` reads nothing else as one). */
export function approveAnswer(id: string = PLAN_REVIEW_QUESTION_ID): DshQuestionAnswer {
  return { answers: [{ id, selected: [PLAN_REVIEW_APPROVE_LABEL] }] };
}

/** Keep planning with the user's feedback, which DSH hands the model. */
export function keepPlanningAnswer(
  feedback: string,
  id: string = PLAN_REVIEW_QUESTION_ID
): DshQuestionAnswer {
  return { answers: [{ id, selected: [PLAN_REVIEW_KEEP_PLANNING_LABEL], custom: feedback }] };
}

/**
 * `ASK_CANCELLED`, shaped as `dsh-user-questions` restores it into its own
 * `UserQuestionError`: the review was closed so the user can speak. DSH tells
 * the model to stay in plan mode, stop and wait.
 */
export function askCancelled(): Error {
  return Object.assign(new Error('the user closed the plan review to type a message'), {
    name: 'UserQuestionError',
    code: 'ASK_CANCELLED',
  });
}

/** A further review in the step that approved a plan: refused, no card. */
export function reviewAlreadyApproved(): Error {
  return new Error(
    'A plan was already approved in this step; implementation begins at your next step. Do not present another plan now.'
  );
}

/** A failed tool result in DSH's shape (`toolErrorResult` of dsh-tools). */
export interface DshToolErrorOutcome {
  readonly isError: true;
  readonly content: ReadonlyArray<{ type: 'text'; text: string }>;
  readonly error: { message: string; info?: { name: string; code: string } };
}

export function reviewErrorOutcome(message: string, code: string): DshToolErrorOutcome {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, info: { name: 'PlanReview', code } },
  };
}

/** dsh-tools' `toolAbortedResult`: the call was cancelled while its review was up (a Stop). */
export function abortedOutcome(): DshToolErrorOutcome {
  return {
    isError: true,
    content: [{ type: 'text', text: 'Error: tool call aborted' }],
    error: { message: 'tool call aborted', info: { name: 'AbortError', code: 'ABORTED' } },
  };
}

/** The keep-planning text a reviewed `create_goal` reads, worded as DSH words `exit_plan_mode`'s. */
export function keepPlanningMessage(feedback: string): string {
  return `${KEEP_PLANNING_FEEDBACK_PREFIX}${feedback}`;
}

/** `GoalView` of `@deepseek-ai/dsh-goal`, as `create_goal` reports it. */
export interface DshCreatedGoal {
  readonly id: string;
  readonly revision: number;
  readonly objective: string;
  readonly phase: string;
  readonly roundsStarted?: number;
  readonly maxGoalRounds: number;
  readonly blockedReason?: { readonly code: string; readonly message: string };
  readonly activation?: string;
}

/**
 * `create_goal`'s value for a goal (dsh-tool-goal `goalValue`): what the
 * call returns when the review set the goal, exactly as the tool itself
 * would have, so DSH renders and logs it through the tool's own output.
 */
export function goalToolValue(goal: DshCreatedGoal): unknown {
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted ?? 0,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason
        ? { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } }
        : {}),
    },
    activation: goal.activation === 'disarmed' ? 'disarmed' : 'armed',
  };
}

/** A positive integer round cap from `create_goal`'s arguments (0 is a strict-schema filler). */
export function goalRoundCapOf(args: unknown): number | undefined {
  const cap = recordOf(args)?.max_goal_rounds;
  return typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0 ? cap : undefined;
}

/** `create_goal`'s objective, when the call carries one. */
export function goalObjectiveOf(args: unknown): string | undefined {
  const objective = recordOf(args)?.objective;
  return typeof objective === 'string' && objective.trim() ? objective : undefined;
}
