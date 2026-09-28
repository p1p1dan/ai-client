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
 *   the asker's signal aborts -> the card is taken down (`cancelled`), the
 *                                waterfall rejects, DSH answers ASK_ABORTED
 *
 * The card's answers are keyed by `QuestionItem.id`. DSH ids are the model's
 * own and may repeat within one call, so a repeated id is given a unique key
 * here (`<id>#<n>`) and mapped back to the model's id in the answer.
 */

import type { QuestionItem, RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';

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

/** Joins a multi-select answer's parts on the card (`questionCardModel.buildRespondPayload`). */
const ANSWER_SEPARATOR = ', ';

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
 * ", "), and whatever follows the last one is the Other text. Single-select:
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
  const byLength = [...new Set(labels)].filter(Boolean).sort((a, b) => b.length - a.length);
  const selected: string[] = [];
  let at = 0;
  while (at < value.length) {
    const label = byLength.find(
      (candidate) =>
        value.startsWith(candidate, at) &&
        (at + candidate.length === value.length ||
          value.startsWith(ANSWER_SEPARATOR, at + candidate.length))
    );
    if (label === undefined) break;
    selected.push(label);
    at += label.length;
    if (at < value.length) at += ANSWER_SEPARATOR.length;
  }
  const rest = value.slice(at);
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

export interface DshQuestionPromptOptions {
  /** Through the runtime's `emit`, so a card raised inside a turn carries its requestId. */
  emit: (event: Omit<RuntimeEventDraft, 'sessionId'>) => void;
  /** The card's id; one per request. */
  newId: () => string;
}

export interface DshQuestionPrompt {
  /**
   * Raise the card for `request` and settle with the user's answer (a skip is
   * an answer: every question with nothing selected). Rejects when the
   * request's signal aborts or `drain` withdraws it.
   */
  ask(request: DshQuestionRequest): Promise<DshQuestionAnswer>;
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
}

interface Parked {
  settle(
    outcome: 'answered' | 'cancelled',
    result: DshQuestionAnswer | Error,
    card?: CardAnswer
  ): void;
  questions: DshQuestionItem[];
  keys: string[];
}

/**
 * 1.0.x's question prompt (`runtime/worker/questionPrompt.ts`) over DSH's
 * answer shape: no timeout (the question is on screen, and the turn's own
 * signal still settles it), a skip is a normal answer, and every card is
 * settled exactly once.
 */
export function createDshQuestionPrompt(options: DshQuestionPromptOptions): DshQuestionPrompt {
  const parked = new Map<string, Parked>();

  return {
    get pending() {
      return parked.size;
    },

    ask(request) {
      return new Promise<DshQuestionAnswer>((resolve, reject) => {
        const signal = request.signal;
        if (signal?.aborted) {
          reject(new DshQuestionWithdrawn('the question was aborted before it was shown'));
          return;
        }
        const questionId = options.newId();
        const questions = [...request.questions];
        const keys = questionKeys(questions);
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
            },
          });
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        function onAbort() {
          settle('cancelled', new DshQuestionWithdrawn('the asker aborted the question'));
        }
        parked.set(questionId, { settle, questions, keys });
        signal?.addEventListener('abort', onAbort, { once: true });
        options.emit({
          type: 'question.requested',
          payload: {
            questionId,
            questions: questions.map((question, index) =>
              questionItemFor(question, keys[index] as string)
            ),
          },
        });
      });
    },

    respond({ questionId, ...response }) {
      const entry = parked.get(questionId);
      if (!entry) return false;
      const answer = dshAnswerFor(entry.questions, entry.keys, response);
      if (answer === null) entry.settle('cancelled', skippedAnswer(entry.questions));
      else {
        entry.settle('answered', answer, {
          ...(response.answers ? { answers: response.answers } : {}),
          ...(response.response ? { response: response.response } : {}),
        });
      }
      return true;
    },

    drain(reason) {
      // Copied first: settling deletes from the map being walked.
      for (const entry of [...parked.values()]) {
        entry.settle('cancelled', new DshQuestionWithdrawn(reason));
      }
    },
  };
}
