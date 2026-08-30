/**
 * T-27: store write actions that live outside chatSessions.ts (a red-line
 * store touched only via external `setState`, per existing precedent).
 * Placed in `stores/` — a neutral spot both `components/chat` and
 * `components/workspace-shell` may import without crossing the
 * "chat must not import workspace-shell" boundary.
 */

import {
  deriveSessionTitleFromFirstMessage,
  isPlaceholderTitle,
} from '@/components/chat/sessionIndex/sessionTitle';
import { renameSessionIndexEntry } from '@/components/chat/sessionIndex/useSessionIndex';
import { uniqueId } from '@/lib/uniqueId';
import { type ChatSession, useChatSessionsStore } from './chatSessions';
import { markSessionsLive } from './sessionRetirement';

/**
 * Moved verbatim (function body unchanged) from
 * `components/workspace-shell/useSyncChatWorkspaceTree.ts:157`.
 */
export function createChatSessionOnWorkspace(
  workspaceId: string,
  title = 'New chat'
): string | null {
  const state = useChatSessionsStore.getState();
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    return null;
  }

  const sessionId = uniqueId('session');
  const session: ChatSession = {
    id: sessionId,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    title,
    status: 'idle',
    updatedAt: Date.now(),
  };

  markSessionsLive([sessionId]);
  useChatSessionsStore.setState({
    sessions: [session, ...state.sessions],
    activeSessionId: sessionId,
    recentSessionIds: [sessionId, ...state.recentSessionIds.filter((id) => id !== sessionId)].slice(
      0,
      20
    ),
    lastError: null,
  });

  // R5 round-2 (A3): creating a chat writes NOTHING to `session-index.json`.
  // D2 briefly registered the entry eagerly here so Archive would find one;
  // that was reverted because every "New" click then left a permanent,
  // empty-titled row in the persisted index — occupying a Recent slot after a
  // restart with no cleanup path, while "a never-sent chat does not survive a
  // restart" is the original design. Indexing stays lazy (the first send's
  // `chat.createSession` → `recordCreated`), and Archive's own
  // register-then-retry ladder covers a never-sent chat on demand.

  return sessionId;
}

/**
 * T-27 retarget: move the active session's projectId/workspaceId in place.
 * Returns whether a write happened. Does not check the three-tier rule —
 * callers must only invoke this when `planTargetChange(...).kind ===
 * 'retarget'` (the single source of truth for that rule lives in
 * `components/chat/composerTarget.ts`).
 */
export function retargetChatSession(sessionId: string, workspaceId: string): boolean {
  const state = useChatSessionsStore.getState();
  const workspace = state.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    return false;
  }

  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return false;
  }

  if (session.workspaceId === workspaceId) {
    return false;
  }

  useChatSessionsStore.setState({
    sessions: state.sessions.map((item) =>
      item.id === sessionId
        ? {
            ...item,
            projectId: workspace.projectId,
            workspaceId: workspace.id,
            updatedAt: Date.now(),
          }
        : item
    ),
    lastError: null,
  });

  return true;
}

// R2 fix: module-level dedup so two concurrent triggers for the SAME session
// (e.g. a queue release firing `applyAutoSessionTitle` again before a
// preceding direct-send call's IPC round-trip has resolved) never issue two
// overlapping `renameSessionIndexEntry` calls. Released in `finally` below —
// once a call genuinely completes (success OR failure), the session is free
// to be renamed again by a later call.
const autoTitleInFlight = new Set<string>();

/**
 * T-27 round-3 (point-check #10): once a session's first message is
 * successfully accepted by the Host, replace a still-placeholder title
 * ('New chat' / 'Live Agent Host' / 'Session xxxxxx' — see
 * `sessionTitle.ts`'s `isPlaceholderTitle`, the single definition of what
 * counts as a placeholder) with a title condensed from that message.
 *
 * A user-provided rename is never a placeholder, so it is never overwritten
 * here — the check runs fresh off the live store, not a stale snapshot.
 * Persists through the SAME action/IPC the manual LeftNav rename flow uses
 * (`renameSessionIndexEntry`, extracted from `useSessionIndex.ts` for this
 * reuse) rather than a full session-index refetch: this call site already
 * knows the exact new title, so it patches `sessions[].title` in place —
 * the same external-setState-bridge pattern `retargetChatSession` above
 * uses, keeping the red-line `chatSessions.ts` untouched.
 *
 * No-ops (leaving the placeholder in place) when: the session cannot be
 * found, its title is not a placeholder (already titled or user-renamed),
 * or the message has no derivable title (empty / symbols-only / etc.).
 */
export async function applyAutoSessionTitle(
  sessionId: string,
  firstMessageText: string
): Promise<void> {
  // R2 fix (i): a second concurrent call for the SAME session is a no-op —
  // whichever call is already mid-flight owns this rename.
  if (autoTitleInFlight.has(sessionId)) {
    return;
  }
  const session = useChatSessionsStore.getState().sessions.find((item) => item.id === sessionId);
  if (!session || !isPlaceholderTitle(session.title)) {
    return;
  }
  const title = deriveSessionTitleFromFirstMessage(firstMessageText);
  if (!title) {
    return;
  }
  autoTitleInFlight.add(sessionId);
  try {
    await renameSessionIndexEntry(sessionId, title, async () => {
      // R2 fix (ii): re-read the session FRESH off the live store here —
      // not the `session` snapshot captured above — and only patch if the
      // title is STILL a placeholder. The IPC round-trip above can take
      // long enough for the user to manually rename the session while it is
      // in flight; patching unconditionally would silently stomp that
      // rename back to the derived title the instant this callback runs.
      //
      // Residual risk (accepted, not closed here): this only closes the
      // RENDERER-side race. Main still receives this auto-title IPC call and
      // a concurrent manual-rename IPC call as two independent writes with
      // no compare-and-swap between them — whichever one persists to disk
      // last still wins there, on a millisecond-scale window. No Main-side
      // CAS is added for this: once a session's title is no longer a
      // placeholder, `applyAutoSessionTitle` is a permanent no-op for it
      // (the `isPlaceholderTitle` guards above and in `useSessionIndex`'s
      // merge never resurrect a placeholder over a real title), so the
      // worst realistic outcome is a single lost auto-title, never a manual
      // rename that keeps getting overwritten on every later message.
      const current = useChatSessionsStore
        .getState()
        .sessions.find((item) => item.id === sessionId);
      if (!current || !isPlaceholderTitle(current.title)) {
        return;
      }
      useChatSessionsStore.setState((state) => ({
        sessions: state.sessions.map((item) => (item.id === sessionId ? { ...item, title } : item)),
      }));
    });
  } finally {
    autoTitleInFlight.delete(sessionId);
  }
}
