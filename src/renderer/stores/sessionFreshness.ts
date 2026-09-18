/**
 * Idempotency predicate for the "start a new chat" entry points (LeftNav's
 * header button, a folder's own "+", SessionBar's "+"): whether the
 * currently ACTIVE session is a brand-new session nobody has touched yet, so
 * clicking New again should reuse it (see chatSessionActions.ts's
 * `createOrReuseChatSessionOnWorkspace` / `createOrReuseUnboundChatSession`)
 * instead of piling up another empty shell session next to it.
 *
 * A separate leaf module (mirrors composerTarget.ts / sessionTitle.ts) so the
 * predicate stays independently unit-testable without pulling in the
 * store-write actions around it.
 */

import { computeEverHostBound } from '@/components/chat/sessionBinding';
import { isPlaceholderTitle } from '@/components/chat/sessionIndex/sessionTitle';
import type { ChatSessionsState } from './chatSessions';

/**
 * True when `sessionId` names a session in `state.sessions` that:
 *  - has no messages yet (`state.messages[sessionId]` empty/absent — the
 *    same signal `useActivateSession.ts`'s `hasTimeline` reads),
 *  - was never registered with Agent Host (`computeEverHostBound`),
 *  - is `idle` (a busy session is never "fresh" regardless of message count
 *    — callers fall through to the unchanged, unconditional create-new path
 *    for any of `starting`/`running`/`stopping`/`waiting_permission`/
 *    `waiting_question`), and
 *  - still carries a placeholder title (`isPlaceholderTitle` — the single
 *    definition `applyAutoSessionTitle` / `resumeIntent.ts` already share).
 *
 * Host-binding uses `computeEverHostBound` rather than a bare
 * `hostBoundSessionIds.includes`, because `state.messages[id]` is EMPTY for a
 * restored session whose transcript has not been replayed into the bucket yet.
 * Such a session can be idle, message-less and still carry a placeholder title,
 * so the plainer check would call a real, persisted conversation "fresh" — and
 * the retarget branch would then rewrite its workspace binding in place. A
 * persisted `runtimeIdentity` is the one durable proof that a session already
 * exists on disk, which is exactly the case that must never be reused.
 */
export function isFreshEmptySession(
  state: Pick<ChatSessionsState, 'sessions' | 'messages' | 'hostBoundSessionIds'>,
  sessionId: string | null | undefined
): boolean {
  if (!sessionId) {
    return false;
  }
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return false;
  }
  if ((state.messages[sessionId]?.length ?? 0) !== 0) {
    return false;
  }
  if (computeEverHostBound(session, state.hostBoundSessionIds)) {
    return false;
  }
  if (session.status !== 'idle') {
    return false;
  }
  return isPlaceholderTitle(session.title);
}
