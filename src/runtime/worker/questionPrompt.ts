/**
 * F5 — the `ask` tool's other end: one structured question, asked as an event.
 *
 * Deliberately the same shape as `permissionPrompt.ts`, because they are the
 * same problem twice: a tool call parks, a card appears, one RPC answers it,
 * and everything that can end the turn has to settle the promise exactly once.
 * The differences are the interesting part:
 *
 * - **No timeout.** A permission gate needs one because a forgotten dialog
 *   blocks a tool call the user may not even know is waiting. A question is on
 *   screen, in the session the user is looking at, and an auto-answer would put
 *   a decision in their mouth. The turn's own abort still settles it.
 * - **Cancelling is a normal answer.** Deny is a real refusal; skipping a
 *   question is not. Both `drain` and the user's Skip resolve `cancelled`, and
 *   the tool tells the model to pick a default and say which one — a failed
 *   tool call would make "I would rather not say" look like a broken runtime.
 */

import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import type { AskUser, RuntimeQuestionAnswer } from '../plugins/tools/ask.ts';

export interface QuestionPromptOptions {
  sessionId: string;
  emit: (event: RuntimeEventDraft) => void;
}

/** One answer from the renderer. `cancel` and `answers` are exclusive. */
export interface QuestionResponse {
  questionId: string;
  answers?: Record<string, string>;
  response?: string;
  cancel?: boolean;
}

export interface QuestionPrompt {
  ask: AskUser;
  /** `false` when nothing was waiting on that id — see the RPC result's doc. */
  respond: (input: QuestionResponse) => boolean;
  /** Settle everything still parked, e.g. on dispose. Answers are skips. */
  drain: (reason: 'session_closed' | 'aborted') => void;
}

export function createQuestionPrompt(options: QuestionPromptOptions): QuestionPrompt {
  const pending = new Map<string, (answer: RuntimeQuestionAnswer) => void>();

  return {
    ask: (request, signal) =>
      new Promise<RuntimeQuestionAnswer>((resolve) => {
        options.emit({
          type: 'question.requested',
          sessionId: options.sessionId,
          payload: {
            questionId: request.questionId,
            // Sent as-is: `id` is already assigned per item by the tool, which
            // is what keeps the answers map unambiguous when two questions in
            // one call are worded identically.
            questions: request.questions.map((item) => ({
              id: item.id,
              question: item.question,
              ...(item.header ? { header: item.header } : {}),
              options: item.options.map((option) => ({
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
              })),
              ...(item.multiSelect ? { multiSelect: true } : {}),
            })),
          },
        });

        let settled = false;
        const settle = (answer: RuntimeQuestionAnswer) => {
          if (settled) return;
          settled = true;
          pending.delete(request.questionId);
          signal?.removeEventListener('abort', onAbort);
          options.emit({
            type: 'question.resolved',
            sessionId: options.sessionId,
            payload: {
              questionId: request.questionId,
              outcome: answer.outcome === 'answered' ? 'answered' : 'cancelled',
              ...(answer.answers ? { answers: answer.answers } : {}),
              ...(answer.response ? { response: answer.response } : {}),
            },
          });
          resolve(answer);
        };
        function onAbort() {
          settle({ outcome: 'cancelled' });
        }
        if (signal?.aborted) {
          settle({ outcome: 'cancelled' });
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(request.questionId, settle);
      }),

    respond: ({ questionId, answers, response, cancel }) => {
      const settle = pending.get(questionId);
      if (!settle) return false;
      if (cancel || (!answers && !response)) {
        settle({ outcome: 'cancelled' });
        return true;
      }
      settle({
        outcome: 'answered',
        ...(answers ? { answers } : {}),
        ...(response ? { response } : {}),
      });
      return true;
    },

    drain: () => {
      // Copied first: settling deletes from the map being walked.
      for (const [, settle] of [...pending]) settle({ outcome: 'cancelled' });
    },
  };
}
