/**
 * The answerer of DSH's `user-questions/request` waterfall (dsh-rebase P1-4d3,
 * decisions 098 and 114).
 *
 * DSH's `ask_user_question` tool (`@deepseek-ai/dsh-tool-ask-user`, a row of
 * our product bundle) and `exit_plan_mode` ask through `ctx.userQuestions`,
 * which dispatches the waterfall scoped to the asking agent. The bridge claims
 * a request of its own session's root agent and shows it on 1.0.x's question
 * card: `question.requested`, answered by `worker.question.respond`, settled
 * with `question.resolved`. Field mapping (P1-4 shard 01 §1):
 *
 *   DSH question {id, question, detail?, header?, options?, multiSelect?, intent?}
 *     -> QuestionItem {id, question (+ "\n\n" + detail), header?, options ([] when
 *        absent), multiSelect?}; `intent` is presentation only and dropped: the
 *        card is the generic option list DSH names as the fallback
 *   answers[key] (multi-select joined with ", ", Other text last)
 *     -> {id, selected: the option labels it starts with, custom?: the rest};
 *        a single-select value is one label or the Other text (`custom`)
 *   response (free text instead of options) -> `custom` of every unanswered question
 *   cancel (the card's Skip)  -> {id, selected: []} for every question
 *   the asker's signal aborts -> the card is taken down (`cancelled`, marked
 *                                `stopped`), the waterfall rejects, DSH
 *                                answers ASK_ABORTED
 *
 * The card's answers are keyed by `QuestionItem.id`. DSH ids are the model's
 * own and may repeat within one call, so a repeated id is given a unique key
 * here (`<id>#<n>`) and mapped back to the model's id in the answer.
 *
 * Plan reviews (decision 169, revising 114 rules 3, 5 and 6): DSH's
 * `exit_plan_mode` question (`intent.kind === 'plan-review'`) is not the
 * generic card. It goes out with `review` (the plan as markdown, apart from
 * the question), its answer is the review's choice (`@shared/planReview`),
 * decoded fail-closed, and the runtime turns it into DSH's answer
 * (`DshPlanReviews.decide`): it switches the posture on an approval before
 * the answer settles. A cancel — the card closed, or a message sent while it
 * was up — is DSH's `ASK_CANCELLED`, never a skip (which DSH would read as
 * "keep planning" and present the plan again at once). The runtime raises
 * the same card for `create_goal` in plan mode (`review`).
 */

import {
  decodePlanReviewResponse,
  PLAN_REVIEW_QUESTION_ID,
  type PlanReviewChoice,
  type PlanReviewDecision,
  type PlanReviewGoalOutcome,
} from '../../shared/planReview.ts';
import { splitQuestionAnswer } from '../../shared/questionAnswer.ts';
import type {
  PlanReviewCard,
  QuestionItem,
  QuestionRequestedEvent,
  RuntimeEventDraft,
} from '../../shared/types/runtimeEvents.ts';
import { type DshPlanReviewRequest, planReviewOf } from './planReview.ts';

/** DSH's `AskUserQuestionItem` (dsh-user-questions), as read here. */
export interface DshQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: unknown;
}

/** DSH's `AskUserQuestionRequestEvent`, as read here. */
export interface DshQuestionRequest {
  questions: DshQuestionItem[];
  agent?: { readonly id: string };
  signal?: AbortSignal;
}

export interface DshQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** DSH's `AskUserQuestionAnswer`. */
export interface DshQuestionAnswer {
  answers: DshQuestionAnswerItem[];
}

/** `worker.question.respond`, as the RPC server hands it over. */
export interface DshQuestionResponse {
  questionId: string;
  answers?: Record<string, string>;
  response?: string;
  cancel?: boolean;
}

/** Prefix of the card ids the bridge mints: one per request, a UUID after it. */
export const DSH_QUESTION_ID_PREFIX = 'dsh-question-';

/** The card's key for each question: the model's id, made unique where it repeats. */
export function questionKeys(questions: readonly DshQuestionItem[]): string[] {
  const seen = new Map<string, number>();
  const taken = new Set(questions.map((question) => question.id));
  return questions.map((question) => {
    const count = (seen.get(question.id) ?? 0) + 1;
    seen.set(question.id, count);
    if (count === 1) return question.id;
    let suffix = count;
    while (taken.has(`${question.id}#${suffix}`)) suffix += 1;
    const key = `${question.id}#${suffix}`;
    taken.add(key);
    return key;
  });
}

/** One DSH question as 1.0.x's card draws it. */
export function questionItemFor(question: DshQuestionItem, key: string): QuestionItem {
  const detail = question.detail?.trim();
  return {
    id: key,
    question: detail ? `${question.question}\n\n${detail}` : question.question,
    ...(question.header ? { header: question.header } : {}),
    options: (question.options ?? []).map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    ...(question.multiSelect ? { multiSelect: true } : {}),
  };
}

/**
 * One card answer back in DSH's shape. Multi-select: the labels the value
 * starts with, longest label first at each position (a label may itself hold
 * ", "), and whatever follows the last one is the Other text — the split the
 * frozen card lists its answer by (`@shared/questionAnswer`). Single-select:
 * one label, or the Other text, which DSH reads as overriding the choice.
 */
export function answerItemFor(
  question: DshQuestionItem,
  value: string | undefined,
  response?: string
): DshQuestionAnswerItem {
  const { id } = question;
  if (value === undefined) {
    return response ? { id, selected: [], custom: response } : { id, selected: [] };
  }
  const labels = (question.options ?? []).map((option) => option.label);
  if (!question.multiSelect) {
    return labels.includes(value) ? { id, selected: [value] } : { id, selected: [], custom: value };
  }
  const { selected, rest } = splitQuestionAnswer(labels, value);
  return rest.length > 0 ? { id, selected, custom: rest } : { id, selected };
}

/** A card response as DSH's answer; `null` when it answers nothing (a skip). */
export function dshAnswerFor(
  questions: readonly DshQuestionItem[],
  keys: readonly string[],
  response: Omit<DshQuestionResponse, 'questionId'>
): DshQuestionAnswer | null {
  if (response.cancel) return null;
  const answers = response.answers ?? {};
  const text = response.response?.trim() ? response.response : undefined;
  if (Object.keys(answers).length === 0 && text === undefined) return null;
  return {
    answers: questions.map((question, index) =>
      answerItemFor(question, answers[keys[index] as string], text)
    ),
  };
}

/** The skip: every question answered with nothing selected (dsh-user-questions README). */
export function skippedAnswer(questions: readonly DshQuestionItem[]): DshQuestionAnswer {
  return { answers: questions.map((question) => ({ id: question.id, selected: [] })) };
}

/** Why a question parked here was taken down without an answer. */
export class DshQuestionWithdrawn extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshQuestionWithdrawn';
  }
}

/** How a plan review settles: what its asker gets, and the goal echoed on `question.resolved`. */
export interface PlanReviewSettlement<T> {
  /** The asker's answer, or the error it is rejected with. */
  result: T | Error;
  /** An approval's goal, when it asked for one. */
  goal?: PlanReviewGoalOutcome;
}

/** Decides a plan review's answer; called synchronously from `respond`. */
export type PlanReviewDecide<T> = (
  decision: PlanReviewDecision,
  questionId: string
) => PlanReviewSettlement<T>;

/** The runtime's side of `exit_plan_mode` reviews (decision 169). */
export interface DshPlanReviews {
  /** The card a review request is drawn as. */
  card(review: DshPlanReviewRequest): PlanReviewCard;
  /** Why a review is refused without a card (a plan already approved in this step), if it is. */
  refuse(): Error | undefined;
  /** DSH's answer to a review the user answered; an approval switches the posture first. */
  decide(review: DshPlanReviewRequest): PlanReviewDecide<DshQuestionAnswer>;
}

export interface DshQuestionPromptOptions {
  /** Through the runtime's `emit`, so a card raised inside a turn carries its requestId. */
  emit: (event: Omit<RuntimeEventDraft, 'sessionId'>) => void;
  /** The card's id; one per request. */
  newId: () => string;
  /** Without it a plan review is drawn on the generic card, as before decision 169. */
  planReviews?: DshPlanReviews;
}

export interface DshQuestionPrompt {
  /**
   * Raise the card for `request` and settle with the user's answer (a skip is
   * an answer: every question with nothing selected). Rejects when the
   * request's signal aborts or `drain` withdraws it.
   */
  ask(request: DshQuestionRequest): Promise<DshQuestionAnswer>;
  /**
   * Raise a plan review card the runtime asks for itself (`create_goal` in
   * plan mode) and settle with what `decide` makes of the answer. Rejects as
   * `ask` does when `signal` aborts or `drain` withdraws it.
   */
  review<T>(
    card: PlanReviewCard,
    signal: AbortSignal | undefined,
    decide: PlanReviewDecide<T>
  ): Promise<T>;
  /** `false` when nothing waits on `questionId` (answered already, withdrawn, or not ours). */
  respond(input: DshQuestionResponse): boolean;
  /** Withdraw every card still up (the session closes). */
  drain(reason: string): void;
  /** Cards up now. */
  readonly pending: number;
}

/** What the card sent, echoed on `question.resolved` as 1.0.x's prompt echoed it. */
interface CardAnswer {
  answers?: Record<string, string>;
  response?: string;
  /**
   * dsh-rebase P1-7e problem 8 (decision 144): nobody answered — the turn was
   * stopped (the asker's signal) or the session closed (`drain`). A Skip is
   * `cancelled` too, and without this the frozen card could not tell the two
   * apart.
   */
  stopped?: true;
  /** Decision 169: a plan review's choice, and an approval's goal. */
  review?: { choice: PlanReviewChoice; goal?: PlanReviewGoalOutcome };
}

interface Parked {
  settle(outcome: 'answered' | 'cancelled', result: unknown, card?: CardAnswer): void;
  /** How a card response settles this card. */
  answer(response: Omit<DshQuestionResponse, 'questionId'>): {
    outcome: 'answered' | 'cancelled';
    result: unknown;
    card?: CardAnswer;
  };
}

/** The choice the card sent, for the echo; a closed review has none. */
function choiceOf(decision: PlanReviewDecision): PlanReviewChoice | undefined {
  if (decision.kind === 'approve') return decision.choice;
  return decision.kind === 'keep-planning' ? 'keep-planning' : undefined;
}

/** A plan review response settled through `decide`. */
function reviewAnswer<T>(
  decide: PlanReviewDecide<T>,
  questionId: string,
  response: Omit<DshQuestionResponse, 'questionId'>
): ReturnType<Parked['answer']> {
  const decision = decodePlanReviewResponse(response);
  let settlement: PlanReviewSettlement<T>;
  try {
    settlement = decide(decision, questionId);
  } catch (error) {
    // The asker is refused rather than left waiting on a card nobody can answer again.
    return {
      outcome: 'cancelled',
      result: error instanceof Error ? error : new Error(String(error)),
    };
  }
  const choice = choiceOf(decision);
  if (!choice) return { outcome: 'cancelled', result: settlement.result };
  return {
    outcome: 'answered',
    result: settlement.result,
    card: {
      answers: { [PLAN_REVIEW_QUESTION_ID]: choice },
      ...(decision.kind === 'keep-planning' ? { response: decision.feedback } : {}),
      review: { choice, ...(settlement.goal ? { goal: settlement.goal } : {}) },
    },
  };
}

/**
 * 1.0.x's question prompt (`runtime/worker/questionPrompt.ts`) over DSH's
 * answer shape: no timeout (the question is on screen, and the turn's own
 * signal still settles it), a skip is a normal answer, and every card is
 * settled exactly once.
 */
export function createDshQuestionPrompt(options: DshQuestionPromptOptions): DshQuestionPrompt {
  const parked = new Map<string, Parked>();

  /**
   * One card up until it settles: answered, cancelled, withdrawn by `drain`,
   * or taken down by `signal` (a Stop). Settled exactly once.
   */
  function park<T>(
    signal: AbortSignal | undefined,
    payload: (questionId: string) => QuestionRequestedEvent['payload'],
    answer: (questionId: string) => Parked['answer']
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DshQuestionWithdrawn('the question was aborted before it was shown'));
        return;
      }
      const questionId = options.newId();
      let settled = false;
      const settle: Parked['settle'] = (outcome, result, card = {}) => {
        if (settled) return;
        settled = true;
        parked.delete(questionId);
        signal?.removeEventListener('abort', onAbort);
        options.emit({
          type: 'question.resolved',
          payload: {
            questionId,
            outcome,
            ...(card.answers ? { answers: card.answers } : {}),
            ...(card.response ? { response: card.response } : {}),
            ...(card.stopped ? { stopped: true as const } : {}),
            ...(card.review ? { review: card.review } : {}),
          },
        });
        if (result instanceof Error) reject(result);
        else resolve(result as T);
      };
      function onAbort() {
        settle('cancelled', new DshQuestionWithdrawn('the asker aborted the question'), {
          stopped: true,
        });
      }
      parked.set(questionId, { settle, answer: answer(questionId) });
      signal?.addEventListener('abort', onAbort, { once: true });
      options.emit({ type: 'question.requested', payload: payload(questionId) });
    });
  }

  function askGeneric(request: DshQuestionRequest): Promise<DshQuestionAnswer> {
    const questions = [...request.questions];
    const keys = questionKeys(questions);
    return park<DshQuestionAnswer>(
      request.signal,
      (questionId) => ({
        questionId,
        questions: questions.map((question, index) =>
          questionItemFor(question, keys[index] as string)
        ),
      }),
      () => (response) => {
        const answer = dshAnswerFor(questions, keys, response);
        if (answer === null) return { outcome: 'cancelled', result: skippedAnswer(questions) };
        return {
          outcome: 'answered',
          result: answer,
          card: {
            ...(response.answers ? { answers: response.answers } : {}),
            ...(response.response ? { response: response.response } : {}),
          },
        };
      }
    );
  }

  function reviewCard<T>(
    card: PlanReviewCard,
    signal: AbortSignal | undefined,
    decide: PlanReviewDecide<T>
  ): Promise<T> {
    return park<T>(
      signal,
      (questionId) => ({
        questionId,
        questions: [
          {
            id: PLAN_REVIEW_QUESTION_ID,
            header: 'Plan review',
            question: card.title ?? 'Plan review',
            options: [],
          },
        ],
        review: card,
      }),
      (questionId) => (response) => reviewAnswer(decide, questionId, response)
    );
  }

  return {
    get pending() {
      return parked.size;
    },

    ask(request) {
      const review = options.planReviews ? planReviewOf(request) : undefined;
      if (!review || !options.planReviews) return askGeneric(request);
      const refused = options.planReviews.refuse();
      if (refused) return Promise.reject(refused);
      return reviewCard(
        options.planReviews.card(review),
        request.signal,
        options.planReviews.decide(review)
      );
    },

    review(card, signal, decide) {
      return reviewCard(card, signal, decide);
    },

    respond({ questionId, ...response }) {
      const entry = parked.get(questionId);
      if (!entry) return false;
      const { outcome, result, card } = entry.answer(response);
      entry.settle(outcome, result, card);
      return true;
    },

    drain(reason) {
      // Copied first: settling deletes from the map being walked.
      for (const entry of [...parked.values()]) {
        entry.settle('cancelled', new DshQuestionWithdrawn(reason), { stopped: true });
      }
    },
  };
}
