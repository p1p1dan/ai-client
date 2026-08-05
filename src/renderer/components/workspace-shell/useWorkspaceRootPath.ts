/**
 * T-32 (D27): the `activeSession → workspace → path` chain, shared.
 *
 * T-13 resolved this inline inside `EditorSurfaceView` because one component
 * owned both the tree and the editor. S3 split them across two columns, and a
 * second inline copy is exactly how the tree and the editor would end up
 * pointing at different workspaces for a frame. Same chain as
 * `useGitChangeCount.ts`, which spec §3 named as the pattern to follow.
 */
import { useChatSessionsStore } from '@/stores/chatSessions';

/** The active session's workspace path, or null when there is no usable one. */
export function useWorkspaceRootPath(): string | null {
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  return activeWorkspace?.path || null;
}

/**
 * Non-reactive twin of the hook, for race guards that must read the CURRENT
 * workspace rather than the one captured when an effect last ran.
 */
export function readWorkspaceRootPath(): string | null {
  const state = useChatSessionsStore.getState();
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
  const activeWorkspace = state.workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  return activeWorkspace?.path || null;
}
