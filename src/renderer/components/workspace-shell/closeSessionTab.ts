/**
 * Closing a center tab ends the conversation.
 *
 * D08 shipped the tab strip with `closeSession` meaning "hide the tab": the
 * worker stayed up, the session kept its slot in the bounded pool, and the only
 * way to actually stop it was the dock's own Close item. That reads as a leak —
 * the user closed the thing and it kept running — so the X now detaches the
 * runtime, behind a confirmation.
 *
 * What it deliberately does NOT do is remove the row from the dock. That is the
 * repo's other close (`closeSessionAndRemoveRow`), and the two are different
 * promises: this one ends the RUN and leaves the conversation where the user can
 * find it again; that one also takes it out of the list for the rest of the app
 * run. Permanent removal stays Archive.
 *
 * Kept out of `SessionTabs.tsx` so vitest can cover it: the repo's test
 * environment is `node` and collects `.ts` only.
 */
import { useChatSessionsStore } from '@/stores/chatSessions';

function withoutKey<T>(map: Record<string, T> | undefined, key: string): Record<string, T> {
  if (!map || !(key in map)) return map ?? {};
  const { [key]: _dropped, ...rest } = map;
  return rest;
}

/**
 * Detach the worker and reset this session's live state, keeping its row.
 *
 * The store surgery is not cosmetic — each field would otherwise leave the
 * reopened session broken in a different way:
 *
 *   - `hostBoundSessionIds` tells `sendMessage` the Host already knows this
 *     session, so it skips `createSession`. Left stale, the next send goes to a
 *     runtime that no longer exists.
 *   - `messages` is what `useActivateSession` reads to decide whether a click
 *     needs a resume (`!hasTimeline`). Left populated, reopening the tab would
 *     restore the transcript from memory and never spawn a worker for it.
 *   - `historyErrors` / pagination / branch revision all describe the read that
 *     produced that transcript, so they go with it.
 *
 * `runtimeIdentity` and the title stay: they are how the row finds its session
 * file again. Status becomes `disconnected` rather than `idle` because no worker
 * is attached — and unlike the busy states, it does not block a later resume.
 *
 * Returns whether the detach IPC was accepted. The local state is reset either
 * way: a Host that never had the session has nothing to detach, and leaving the
 * renderer pretending otherwise is the worse of the two failures.
 */
export async function endSessionForTab(sessionId: string): Promise<boolean> {
  let detached = true;
  try {
    await window.electronAPI.chat.closeSession({ sessionId });
  } catch {
    detached = false;
  }

  useChatSessionsStore.setState((current) => ({
    hostBoundSessionIds: current.hostBoundSessionIds.filter((id) => id !== sessionId),
    messages: withoutKey(current.messages, sessionId),
    historyErrors: withoutKey(current.historyErrors, sessionId),
    historyPagination: withoutKey(current.historyPagination, sessionId),
    historyBranchRevisions: withoutKey(current.historyBranchRevisions, sessionId),
    sessions: current.sessions.map((session) =>
      session.id === sessionId ? { ...session, status: 'disconnected' as const } : session
    ),
  }));

  return detached;
}
