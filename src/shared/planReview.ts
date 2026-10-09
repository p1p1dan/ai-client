// New in dsh-rebase (decision 169)

/**
 * The plan review (dsh-rebase decision 169): what the bridge, Main and the
 * renderer agree on when plan mode ends.
 *
 * In plan mode the model presents its plan through DSH's `exit_plan_mode`
 * (or proposes a goal through `create_goal`); the bridge raises the review
 * card instead of DSH's generic Approve / Keep planning question. The card
 * answers with one choice under the question key `plan-review`:
 *
 *   goal:auto      set it as the goal, execute on full auto (the default)
 *   goal:bypass    set it as the goal, execute with every prompt bypassed
 *                  (the renderer confirms it a second time, decision 023)
 *   run:auto       execute it this once on full auto, no goal
 *   keep-planning  stay in plan mode; the feedback (required) goes back to
 *                  the model
 *
 * and a cancel closes the review: the model stops and waits for the user's
 * message (DSH's `ASK_CANCELLED`). Anything else is read as a closed review
 * too — never as "keep planning", which makes DSH present the plan again at
 * once.
 *
 * No value imports: the bridge (Node type stripping), Main and the renderer
 * all load it.
 */

import type { RuntimePermissionSettings } from './types/runtimePermission.ts';

/** DSH's review question id (`dsh-plan-mode` REVIEW_ID): the key the card answers under. */
export const PLAN_REVIEW_QUESTION_ID = 'plan-review';
/** DSH's two option labels; only an exact `Approve` with no custom text approves. */
export const PLAN_REVIEW_APPROVE_LABEL = 'Approve';
export const PLAN_REVIEW_KEEP_PLANNING_LABEL = 'Keep planning';

export type PlanReviewChoice = 'goal:auto' | 'goal:bypass' | 'run:auto' | 'keep-planning';
export type PlanReviewApproval = Exclude<PlanReviewChoice, 'keep-planning'>;

/** Card order; the first is the default. */
export const PLAN_REVIEW_CHOICES: readonly PlanReviewChoice[] = [
  'goal:auto',
  'goal:bypass',
  'run:auto',
  'keep-planning',
];

export function isPlanReviewChoice(value: unknown): value is PlanReviewChoice {
  return PLAN_REVIEW_CHOICES.includes(value as PlanReviewChoice);
}

/** Whether an approval sets the plan as the session goal. */
export function planReviewSetsGoal(choice: PlanReviewApproval): boolean {
  return choice === 'goal:auto' || choice === 'goal:bypass';
}

/** The posture an approval switches the session to: execute mode, full auto or bypass. */
export function planReviewPermissions(choice: PlanReviewApproval): RuntimePermissionSettings {
  return { mode: 'agent', gear: choice === 'goal:bypass' ? 'bypass' : 'auto' };
}

export type PlanReviewDecision =
  | {
      kind: 'approve';
      choice: PlanReviewApproval;
      permissions: RuntimePermissionSettings;
      goal: boolean;
    }
  | { kind: 'keep-planning'; feedback: string }
  | { kind: 'dismiss' };

/** A card response as `worker.question.respond` carries it. */
export interface PlanReviewResponse {
  answers?: Record<string, string>;
  response?: string;
  cancel?: boolean;
}

/** What the card sends for a choice; `feedback` only goes with keep-planning. */
export function planReviewResponse(
  choice: PlanReviewChoice,
  feedback?: string
): { answers: Record<string, string>; response?: string } {
  const text = choice === 'keep-planning' ? feedback?.trim() : undefined;
  return {
    answers: { [PLAN_REVIEW_QUESTION_ID]: choice },
    ...(text ? { response: text } : {}),
  };
}

/**
 * A card response read back (the bridge acts on it, Main derives the posture
 * it may accept from it). Fails closed: a cancel, an unknown or missing
 * choice, extra keys, or keep-planning without feedback all close the review.
 * Free text alone is keep-planning with that feedback.
 */
export function decodePlanReviewResponse(response: PlanReviewResponse): PlanReviewDecision {
  if (response.cancel) return { kind: 'dismiss' };
  const feedback = typeof response.response === 'string' ? response.response.trim() : '';
  const answers = response.answers ?? {};
  const keys = Object.keys(answers);
  if (keys.length === 0) {
    return feedback ? { kind: 'keep-planning', feedback } : { kind: 'dismiss' };
  }
  const choice = answers[PLAN_REVIEW_QUESTION_ID];
  if (keys.length !== 1 || !isPlanReviewChoice(choice)) return { kind: 'dismiss' };
  if (choice === 'keep-planning') {
    return feedback ? { kind: 'keep-planning', feedback } : { kind: 'dismiss' };
  }
  return {
    kind: 'approve',
    choice,
    permissions: planReviewPermissions(choice),
    goal: planReviewSetsGoal(choice),
  };
}

/** What became of the goal an approval asked for. */
export type PlanReviewGoalOutcome = { set: true } | { set: false; reason: string };

// ---- the goal an approval sets ----------------------------------------------------

/** The cap on a goal objective taken from a plan; past it the goal points at the plan. */
export const PLAN_GOAL_OBJECTIVE_MAX = 4_000;
const TITLE_MAX = 200;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u;
const FENCE = /^\s*(```|~~~)/u;
/** Section headings that state the goal and how it is judged done. */
const GOAL_SECTION =
  /goal|objective|success|criteria|acceptance|definition of done|目标|成功标准|验收|完成标准/iu;
const NOT_GOAL_SECTION = /non-?goals?|out of scope|非目标|不做|不在范围/iu;

/** The plan's first markdown heading (any level), as DSH titles the review. */
export function planTitleOf(plan: string): string | undefined {
  let fenced = false;
  for (const line of plan.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = HEADING.exec(line);
    if (match?.[2]) return match[2];
  }
  return undefined;
}

/** The goal and success-criteria sections of a plan, headings included, in order. */
export function planGoalSections(plan: string): string[] {
  const lines = plan.split('\n');
  const sections: string[] = [];
  let fenced = false;
  let current: { level: number; lines: string[] } | null = null;
  let titleSeen = false;
  const close = () => {
    if (current) sections.push(current.lines.join('\n').trim());
    current = null;
  };
  for (const line of lines) {
    if (FENCE.test(line)) fenced = !fenced;
    const match = fenced ? null : HEADING.exec(line);
    if (match) {
      const level = match[1]?.length ?? 1;
      const text = match[2] ?? '';
      if (current && level <= (current as { level: number }).level) close();
      if (!titleSeen) {
        titleSeen = true;
        // The plan's own title is not a section of it.
        if (level === 1) continue;
      }
      if (!current && GOAL_SECTION.test(text) && !NOT_GOAL_SECTION.test(text)) {
        current = { level, lines: [] };
      }
    }
    if (current) (current as { lines: string[] }).lines.push(line);
  }
  close();
  return sections.filter((section) => section.length > 0);
}

function boundedTitle(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title;
}

/**
 * The objective of the goal an approved plan sets: its title and its goal /
 * success-criteria sections, which every goal round restates; a plan with
 * none, or with more than `PLAN_GOAL_OBJECTIVE_MAX` of them, gets an
 * objective that points at the plan instead (the model has it in context).
 */
export function planGoalObjective(plan: string): string {
  const title = boundedTitle(planTitleOf(plan) ?? 'the approved plan');
  const sections = planGoalSections(plan);
  if (sections.length > 0) {
    const objective = `# ${title}\n\n${sections.join('\n\n')}`;
    if (objective.length <= PLAN_GOAL_OBJECTIVE_MAX) return objective;
  }
  return `Carry out the approved plan "${title}" (presented for review in this session) until its success criteria are met.`;
}

// ---- what the model and the timeline read ------------------------------------------

/**
 * `MessageSource.kind` of the notice an approval leaves in the session log:
 * a `user/message` the model reads at its next step and the timeline shows
 * by its summary (`dshNotices.ts`), live and replayed.
 */
export const PLAN_REVIEW_SOURCE_KIND = 'aiclient-plan-review';

/**
 * The review's outcomes as the tool result tells the model. The first two
 * are DSH's own `exit_plan_mode` wording; the bridge words a `create_goal`
 * review the same way, so one reader serves both rows.
 */
export const KEEP_PLANNING_FEEDBACK_PREFIX = 'The user chose to keep planning; their feedback: ';
export const KEEP_PLANNING_TEXT =
  'The user chose to keep planning; revise the plan and present it again.';
export const REVIEW_DISMISSED_TEXT =
  'The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.';
/** DSH's `exit_plan_mode` result on approval. */
export const PLAN_APPROVED_TEXT =
  'Plan approved — plan mode exited; carry out the plan starting with your next step.';
/** A `create_goal` review approved without a goal (run once). */
export const RUN_WITHOUT_GOAL_TEXT =
  'The user approved the plan for this run only and set no goal; plan mode is exited — carry out the plan starting with your next step. Do not create a goal.';
/** A `create_goal` review approved, but the goal could not be created. */
export const GOAL_NOT_SET_PREFIX =
  'The user approved the plan, but the goal could not be set; plan mode is exited — carry out the plan starting with your next step. Reason: ';

/** How a plan review ended, read off its tool row (`exit_plan_mode` or a reviewed `create_goal`). */
export type PlanReviewRowOutcome =
  | { kind: 'approved' }
  | { kind: 'approved-without-goal' }
  | { kind: 'goal-not-set'; reason: string }
  | { kind: 'keep-planning'; feedback?: string }
  | { kind: 'dismissed' };

function errorBody(text: string): string {
  return text.startsWith('Error: ') ? text.slice('Error: '.length) : text;
}

/**
 * The review outcome a failed `exit_plan_mode` (or reviewed `create_goal`)
 * row carries, or undefined when the failure was something else (not in
 * plan mode, no heading, the turn stopped).
 */
export function planReviewRowOutcome(
  errorText: string | undefined
): PlanReviewRowOutcome | undefined {
  if (!errorText) return undefined;
  const text = errorBody(errorText.trim());
  if (text.startsWith(KEEP_PLANNING_FEEDBACK_PREFIX)) {
    const feedback = text.slice(KEEP_PLANNING_FEEDBACK_PREFIX.length).trim();
    return feedback ? { kind: 'keep-planning', feedback } : { kind: 'keep-planning' };
  }
  if (text.startsWith(KEEP_PLANNING_TEXT)) return { kind: 'keep-planning' };
  if (text.startsWith(REVIEW_DISMISSED_TEXT)) return { kind: 'dismissed' };
  if (text.startsWith(RUN_WITHOUT_GOAL_TEXT)) return { kind: 'approved-without-goal' };
  if (text.startsWith(GOAL_NOT_SET_PREFIX)) {
    return { kind: 'goal-not-set', reason: text.slice(GOAL_NOT_SET_PREFIX.length).trim() };
  }
  return undefined;
}

/** The one line the timeline shows for an approval (a dictionary key, no parameters). */
export function planReviewNoticeSummary(
  choice: PlanReviewApproval,
  goal?: PlanReviewGoalOutcome
): string {
  if (choice === 'run:auto')
    return 'Plan approved for this run only, on full auto; no goal was set.';
  const bypass = choice === 'goal:bypass';
  if (goal?.set === false) {
    return bypass
      ? 'Plan approved with all prompts bypassed; the goal could not be set.'
      : 'Plan approved on full auto; the goal could not be set.';
  }
  return bypass
    ? 'Plan approved: set as the goal, running with all prompts bypassed.'
    : 'Plan approved: set as the goal, running on full auto.';
}

/** Every summary `planReviewNoticeSummary` can return (the renderer's dictionary covers them). */
export const PLAN_REVIEW_NOTICE_SUMMARIES: readonly string[] = [
  'Plan approved: set as the goal, running on full auto.',
  'Plan approved: set as the goal, running with all prompts bypassed.',
  'Plan approved for this run only, on full auto; no goal was set.',
  'Plan approved on full auto; the goal could not be set.',
  'Plan approved with all prompts bypassed; the goal could not be set.',
];

/** What the model reads of an approval at its next step (model-facing). */
export function planReviewNoticeText(
  choice: PlanReviewApproval,
  goal?: PlanReviewGoalOutcome
): string {
  const posture =
    choice === 'goal:bypass'
      ? 'Tool calls now run with every approval prompt bypassed.'
      : 'Tool calls now run without ordinary approval prompts (full auto).';
  if (choice === 'run:auto') {
    return `The user approved the plan in the review for this run only; no goal was set. ${posture}`;
  }
  if (goal?.set === false) {
    return `The user approved the plan in the review and asked to set it as the session goal, but the goal could not be set (${goal.reason}); carry out the plan in this run. ${posture}`;
  }
  return `The user approved the plan in the review and set it as the session goal; after this turn, automatic goal rounds continue until the goal is complete. ${posture}`;
}

// ---- the calls plan review holds back ---------------------------------------------------

/**
 * Why a call of the session's own agent is refused between an approval and
 * the agent's next step: the calls the model wrote beside the review, before
 * it knew the answer. The plan policy says implementation begins at the next
 * step after approval; this holds the model to it.
 */
export const PLAN_APPROVAL_HOLD_REASON =
  'The plan was approved during this step; implementation begins at your next step. This call was not run — issue it again then if it is still needed.';

/**
 * `update_goal` with `resume` in plan mode: resuming would start automatic
 * rounds that the plan-mode gate refuses every change to.
 */
export const PLAN_MODE_RESUME_REASON =
  'Plan mode is on: a resumed goal would run automatic rounds that cannot change anything. Present your plan with exit_plan_mode; once the user approves it, the session leaves plan mode and the goal can be resumed.';

/** `update_goal` asking to resume a goal. */
export function isGoalResumeCall(name: string, args: unknown): boolean {
  return (
    name === 'update_goal' &&
    typeof args === 'object' &&
    args !== null &&
    (args as { action?: unknown }).action === 'resume'
  );
}
