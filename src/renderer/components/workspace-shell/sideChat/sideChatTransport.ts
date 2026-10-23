/**
 * Layout 5f (ruling L6): a side question on its way to the engine. A
 * conversation the engine is not running (a chat reopened from the list) is
 * started first, the way a send starts it, so the question reads the whole
 * conversation; then Main is asked (`chat:askSideQuestion`). Nothing is sent
 * into the conversation itself.
 */
import {
  runWithSessionStarted,
  SESSION_STOPPED_BEFORE_RUN,
  sessionStartFailureKey,
} from '@/components/chat/sessionStart';
import { sessionStartEffects } from '@/components/chat/sessionStartDeps';
import type { SideQuestionRequest } from '@/stores/sideChat';
import type { SideQuestionOutcome } from './sideChatModel';

export async function runSideQuestion(request: SideQuestionRequest): Promise<SideQuestionOutcome> {
  const result = await runWithSessionStarted({
    sessionId: request.sessionId,
    operation: () =>
      window.electronAPI.chat.askSideQuestion({
        sessionId: request.sessionId,
        questionId: request.questionId,
        question: request.question,
        ...(request.history.length > 0 ? { history: request.history } : {}),
      }),
    ...sessionStartEffects,
  });
  if (result.kind === 'not-started') {
    return { kind: 'failed', errorKey: sessionStartFailureKey(result.start) };
  }
  if (result.kind === 'cancelled') return { kind: 'failed', errorKey: SESSION_STOPPED_BEFORE_RUN };
  return { kind: 'answer', text: result.value.text };
}
