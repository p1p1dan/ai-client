/**
 * Point-check issue 34 (dsh-rebase decision 138): names given to chats that
 * have no session-index row yet.
 *
 * A chat is indexed lazily — its first send records it (R5 round-2 A3: a chat
 * the user opens and abandons must not survive a restart). Renaming one before
 * that had nowhere to land: Main's rename answered `false` for the missing row
 * and the sidebar quietly put the old title back.
 *
 * Such a rename now takes effect on the live row, and the chat is remembered
 * here until its first send carries the name into the index
 * (`applyAutoSessionTitle`). Nothing is written to disk before that, so the A3
 * rule still holds: an unsent chat, named or not, is gone after a restart.
 *
 * A leaf module (imports only the store) so both the sidebar's rename path in
 * `useSessionIndex.ts` and the first-send title path in `chatSessionActions.ts`
 * can use it without importing each other.
 */

import { useChatSessionsStore } from './chatSessions';

const pendingDraftTitles = new Set<string>();

/**
 * Put `title` on the live row of `sessionId` and remember that the index has
 * not heard of it. A rename is activity, so the row's `updatedAt` moves too
 * (never backwards). Returns false when there is no such row.
 */
export function applyDraftSessionTitle(
  sessionId: string,
  title: string,
  now = Date.now()
): boolean {
  const state = useChatSessionsStore.getState();
  if (!state.sessions.some((session) => session.id === sessionId)) return false;
  useChatSessionsStore.setState({
    sessions: state.sessions.map((session) =>
      session.id === sessionId
        ? { ...session, title, updatedAt: Math.max(session.updatedAt, now) }
        : session
    ),
  });
  pendingDraftTitles.add(sessionId);
  return true;
}

/** The live title of this chat still has to be written to its index row. */
export function hasPendingDraftTitle(sessionId: string): boolean {
  return pendingDraftTitles.has(sessionId);
}

/** The index row has the name now (or another rename superseded it). */
export function settleDraftSessionTitle(sessionId: string): void {
  pendingDraftTitles.delete(sessionId);
}

/** Tests only. */
export function resetDraftSessionTitles(): void {
  pendingDraftTitles.clear();
}
