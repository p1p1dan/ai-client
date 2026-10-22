/**
 * Layout 5f (ui-cohesion ruling L6): a side question on the DSH engine.
 *
 * One tool-free request through the host's LLM service (the same adapter,
 * routes and per-request keys as a chat turn, like the auto gear's review in
 * `autoReviewer.ts`), on the session's own model. The prompt carries the
 * conversation so far (`buildSideQuestionPrompt`); nothing is written to the
 * session and no event is emitted. The answer is the stream's text.
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

import {
  buildSideQuestionPrompt,
  buildSideQuestionTranscript,
  SIDE_QUESTION_SYSTEM_PROMPT,
} from '../../shared/sideQuestion.ts';
import type { HistoryMessage } from '../../shared/types/sessionHistory.ts';
import {
  WORKER_SIDE_QUESTION_BUDGET_MS,
  WORKER_SIDE_QUESTION_CANCELLED,
  WORKER_SIDE_QUESTION_MAX_ANSWER_CHARS,
  type WorkerSideQuestionResult,
  type WorkerSideQuestionTurn,
} from '../../shared/types/workerRpc.ts';
import { BridgeSessionError } from './bridgeErrors.ts';
import type { CompletionLlm } from './completions.ts';
import type { DshRoutedModel } from './modelRoute.ts';

const TIMEOUT = 'side_question_timed_out';

export interface DshSideQuestionInput {
  llm: CompletionLlm;
  routed: DshRoutedModel;
  messages: readonly HistoryMessage[];
  question: string;
  history?: readonly WorkerSideQuestionTurn[];
  signal: AbortSignal;
  timeoutMs?: number;
  /** The stream's last `usage` chunk, once the request settles (the session total counts it). */
  onUsage?: (usage: unknown) => void;
}

export async function askDshSideQuestion(
  input: DshSideQuestionInput
): Promise<WorkerSideQuestionResult> {
  if (input.signal.aborted) throw cancelledError();
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(TIMEOUT),
    input.timeoutMs ?? WORKER_SIDE_QUESTION_BUDGET_MS
  );
  timer.unref?.();
  const settledByAbort = () => {
    if (controller.signal.reason === TIMEOUT) {
      return new BridgeSessionError(
        'WORKER_SIDE_QUESTION_TIMEOUT',
        'The side question got no answer in time'
      );
    }
    return cancelledError();
  };
  let usage: unknown;
  try {
    const prompt = buildSideQuestionPrompt({
      transcript: buildSideQuestionTranscript(input.messages),
      ...(input.history ? { history: input.history } : {}),
      question: input.question,
    });
    const stream = input.llm.stream({
      provider: input.routed.selection.provider,
      model: input.routed.selection.model,
      ...(input.routed.selection.reasoningEffort
        ? { reasoningEffort: input.routed.selection.reasoningEffort }
        : {}),
      system: SIDE_QUESTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
    });
    let text = '';
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        if (text.length < WORKER_SIDE_QUESTION_MAX_ANSWER_CHARS) text += chunk.text;
        continue;
      }
      if (chunk.type === 'usage') {
        usage = chunk.usage ?? usage;
        continue;
      }
      if (chunk.type !== 'finish') continue;
      const kind = chunk.reason?.kind;
      if (kind === 'aborted') throw settledByAbort();
      if (kind === 'error') {
        const message = chunk.reason?.failure?.message;
        const code = chunk.reason?.failure?.code;
        throw new BridgeSessionError(
          typeof code === 'string' && code ? code : 'WORKER_SIDE_QUESTION_FAILED',
          typeof message === 'string' && message ? message : 'The model call failed'
        );
      }
      break;
    }
    if (controller.signal.aborted) throw settledByAbort();
    const answer = text.slice(0, WORKER_SIDE_QUESTION_MAX_ANSWER_CHARS);
    return { text: answer.trim() ? answer : null };
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof BridgeSessionError)) {
      throw settledByAbort();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', onAbort);
    if (usage !== undefined) {
      try {
        input.onUsage?.(usage);
      } catch {
        // Bookkeeping only.
      }
    }
  }
}

function cancelledError(): BridgeSessionError {
  return new BridgeSessionError(WORKER_SIDE_QUESTION_CANCELLED, 'The side question was cancelled');
}
