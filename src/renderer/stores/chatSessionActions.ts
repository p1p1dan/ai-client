/**
 * T-27: store write actions that live outside chatSessions.ts (a red-line
 * store touched only via external `setState`, per existing precedent).
 * Placed in `stores/` — a neutral spot both `components/chat` and
 * `components/workspace-shell` may import without crossing the
 * "chat must not import workspace-shell" boundary.
 */

import { type ChatSession, useChatSessionsStore } from './chatSessions';

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

  const sessionId = `session-${Date.now()}`;
  const session: ChatSession = {
    id: sessionId,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    title,
    status: 'idle',
    updatedAt: Date.now(),
  };

  useChatSessionsStore.setState({
    sessions: [session, ...state.sessions],
    activeSessionId: sessionId,
    recentSessionIds: [sessionId, ...state.recentSessionIds.filter((id) => id !== sessionId)].slice(
      0,
      20
    ),
    lastError: null,
  });

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
