/**
 * T-32 (D27): the `activeSession → workspace → path` chain, shared.
 *
 * T-13 resolved this inline inside `EditorSurfaceView` because one component
 * owned both the tree and the editor. S3 split them across two columns, and a
 * second inline copy is exactly how the tree and the editor would end up
 * pointing at different workspaces for a frame. Same chain as
 * `useGitChangeCount.ts`, which spec §3 named as the pattern to follow.
 */

import { readHomeTarget, useHomeTarget } from '@/components/chat/useHomeTarget';
import { type ChatWorkspace, useChatSessionsStore } from '@/stores/chatSessions';
import { useScratchWorkspaceStore } from '@/stores/scratchWorkspace';

/**
 * Decision 174 (issue #6, second wave): while no conversation is open — the
 * home page — the workspace the shell is about is the home page's draft
 * repository, the one its title names and its work bar picked. The files, the
 * editor's tabs, search and the Git and terminal panels follow it, as they
 * followed the start-up chat's repository before the home page replaced that
 * chat; otherwise every launch opened them empty. `null` with a conversation
 * open, and on a home page with no repository picked.
 */
export function useHomeWorkspace(): ChatWorkspace | null {
  const onHome = useChatSessionsStore((state) => state.activeSessionId === null);
  const { target } = useHomeTarget();
  return onHome ? target.workspace : null;
}

/** Non-reactive twin of `useHomeWorkspace`. */
export function readHomeWorkspace(): ChatWorkspace | null {
  if (useChatSessionsStore.getState().activeSessionId !== null) return null;
  return readHomeTarget().target.workspace;
}

/**
 * The active session's workspace path, or null when there is no usable one.
 * On the home page, its draft repository's (decision 174).
 */
export function useWorkspaceRootPath(): string | null {
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const homeWorkspace = useHomeWorkspace();

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  const scratchPath = useScratchWorkspaceStore((state) => state.pathFor(activeSessionId));
  if (activeSessionId === null) return homeWorkspace?.path || null;
  return activeWorkspace?.path || activeSession?.unbound?.workspacePath || scratchPath;
}

/**
 * Non-reactive twin of the hook, for race guards that must read the CURRENT
 * workspace rather than the one captured when an effect last ran.
 */
export function readWorkspaceRootPath(): string | null {
  const state = useChatSessionsStore.getState();
  if (state.activeSessionId === null) return readHomeWorkspace()?.path || null;
  const activeSession = state.sessions.find((session) => session.id === state.activeSessionId);
  const activeWorkspace = state.workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  return (
    activeWorkspace?.path ||
    activeSession?.unbound?.workspacePath ||
    useScratchWorkspaceStore.getState().pathFor(state.activeSessionId)
  );
}
