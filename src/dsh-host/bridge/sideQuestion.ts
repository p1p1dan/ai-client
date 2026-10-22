/**
 * Layout 5f (ui-cohesion ruling L6): a side question on the DSH engine.
 *
 * One tool-free request through the host's LLM service (the same adapter,
 * routes and per-request keys as a chat turn, like the auto gear's review in
 * `autoReviewer.ts`), on the session's own model. The prompt carries the
 * conversation so far (`buildSideQuestionPrompt`) — the session's model surface
 * read through `sessionQuery.readSurface` where it can be, so the side question
 * sees what the model sees; nothing is written to the session and no event is
 * emitted. The answer is the stream's text.
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

import {
  buildSideQuestionPrompt,
  SIDE_QUESTION_SYSTEM_PROMPT,
  type SideQuestionSurfaceMessage,
} from '../../shared/sideQuestion.ts';
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
  /** The conversation as text (`buildSurfaceSideQuestionTranscript` or its history fallback). */
  transcript: string;
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
      transcript: input.transcript,
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

/** One event of `sessionQuery.readSurface(...).events`, as far as a transcript reads it. */
export interface DshSurfaceEventLike {
  type: string;
  data: unknown;
}

/**
 * The surface's messages: a `user/message` event's data IS the message; the
 * other message events carry it under `message`.
 */
export function surfaceMessagesOf(
  events: readonly DshSurfaceEventLike[]
): SideQuestionSurfaceMessage[] {
  return events.flatMap((event) => {
    const data = event.data as { message?: unknown } | null;
    const message = event.type === 'user/message' ? data : data?.message;
    if (!message || typeof message !== 'object') return [];
    const candidate = message as Partial<SideQuestionSurfaceMessage>;
    if (typeof candidate.role !== 'string' || !Array.isArray(candidate.content)) return [];
    return [candidate as SideQuestionSurfaceMessage];
  });
}

function cancelledError(): BridgeSessionError {
  return new BridgeSessionError(WORKER_SIDE_QUESTION_CANCELLED, 'The side question was cancelled');
}
