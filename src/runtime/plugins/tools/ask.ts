/**
 * P5-1 / F5 — the tool that lets the model ask the user a question.
 *
 * ## Why this is new rather than restored
 *
 * The renderer has carried a question card, a pending-question slot and a
 * `question` block type for a long time, and `question.requested` has never had
 * a producer — on EITHER backend. The 2026-09-09 triage said so explicitly:
 * F5 is "a capability that never existed", not a native regression. So there is
 * no legacy behaviour to match here; what there is, is a renderer contract
 * (`shared/types/runtimeEvents.ts`) that was written for two other agents'
 * shapes and is finally being filled by ours.
 *
 * ## Why ids are assigned here
 *
 * `QuestionResolvedEvent.payload.answers` is keyed by `QuestionItem.id` when
 * the item carries one and by the question TEXT otherwise. The text is not a
 * key — two questions in one call may repeat verbatim, and by the time answers
 * reach this side they are already a record, so the duplicate is lost. This
 * runtime can supply ids, so it does, and the ambiguous path is simply never
 * taken.
 *
 * ## Why it is not gated
 *
 * Asking the user is the interaction, not an action taken on their behalf.
 * Putting an approval card in front of a question would ask the user for
 * permission to be asked something.
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { type Static, type TSchema, Type } from 'typebox';

export interface RuntimeQuestionOption {
  label: string;
  description?: string;
}

export interface RuntimeQuestionItem {
  /** Assigned by this module; the answers map is keyed by it. */
  id: string;
  question: string;
  header?: string;
  options: RuntimeQuestionOption[];
  multiSelect?: boolean;
}

export interface RuntimeQuestionRequest {
  /** One question set per tool call, so the tool call id addresses it. */
  questionId: string;
  questions: RuntimeQuestionItem[];
}

export interface RuntimeQuestionAnswer {
  outcome: 'answered' | 'cancelled';
  /** Keyed by {@link RuntimeQuestionItem.id}. Absent for a cancelled question. */
  answers?: Record<string, string>;
  /** Freeform text typed instead of picking options. Exclusive with `answers`. */
  response?: string;
}

/**
 * How the host asks. Resolving with `cancelled` is a normal outcome, not an
 * error: the user declining to answer must leave the turn able to continue.
 */
export type AskUser = (
  request: RuntimeQuestionRequest,
  signal: AbortSignal | undefined
) => Promise<RuntimeQuestionAnswer>;

const OPTION = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false }
);

const QUESTION = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 2000 }),
    header: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    options: Type.Array(OPTION, { minItems: 2, maxItems: 4 }),
    multiSelect: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export const ASK_PARAMETERS = Type.Object(
  { questions: Type.Array(QUESTION, { minItems: 1, maxItems: 4 }) },
  { additionalProperties: false }
);

/**
 * What the model reads back.
 *
 * The question is repeated next to its answer rather than just the answer:
 * these arrive as one tool result for up to four questions, and "Yes / Postgres
 * / no" is not something a model can reliably re-associate.
 */
function formatAnswer(
  questions: readonly RuntimeQuestionItem[],
  answer: RuntimeQuestionAnswer
): string {
  if (answer.outcome === 'cancelled') {
    return 'The user skipped these questions without answering. Proceed with a reasonable default and say which one you picked.';
  }
  if (answer.response?.trim()) return `The user answered: ${answer.response.trim()}`;
  const lines: string[] = [];
  for (const item of questions) {
    const given = answer.answers?.[item.id];
    lines.push(`${item.question}\n${given?.trim() ? given.trim() : '(not answered)'}`);
  }
  return lines.join('\n\n');
}

export function askTool(ask: AskUser): AgentTool<TSchema, unknown> {
  return {
    name: 'ask',
    label: 'Ask',
    description:
      'Ask the user to choose between options when the decision is genuinely theirs and you cannot settle it from the request, the code, or a sensible default. Each question needs 2-4 options. Blocks until the user answers or skips.',
    parameters: ASK_PARAMETERS,
    execute: async (id, params, signal): Promise<AgentToolResult<unknown>> => {
      const args = params as Static<typeof ASK_PARAMETERS>;
      const questions: RuntimeQuestionItem[] = args.questions.map((item, index) => ({
        // Unique within the call, and stable across the round trip, which is
        // what makes two identically worded questions distinguishable.
        id: `${id}-${index}`,
        question: item.question,
        ...(item.header ? { header: item.header } : {}),
        options: item.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        ...(item.multiSelect ? { multiSelect: true } : {}),
      }));
      const answer = await ask({ questionId: id, questions }, signal);
      return {
        content: [{ type: 'text', text: formatAnswer(questions, answer) }],
        details: { questionId: id, outcome: answer.outcome, answers: answer.answers ?? {} },
      };
    },
  };
}
