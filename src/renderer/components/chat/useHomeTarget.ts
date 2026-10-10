import { useMemo } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { type HomeDraftBranch, type HomeTargetPick, useHomeDraftStore } from '@/stores/homeDraft';
import { type HomeTarget, resolveHomeDraftBranch, resolveHomeTarget } from './homeTarget';

export interface HomeTargetState {
  pick: HomeTargetPick;
  target: HomeTarget;
  /** The branch picked on the home page that still applies (`resolveHomeDraftBranch`). */
  draftBranch: HomeDraftBranch | null;
}

/**
 * Decision 174: the home page's draft target as the screen shows it. The
 * title, the work bar and the composer all subscribe through this one hook so
 * they cannot name different repositories.
 */
export function useHomeTarget(): HomeTargetState {
  const pick = useHomeDraftStore((state) => state.pick);
  const branch = useHomeDraftStore((state) => state.branch);
  const projects = useChatSessionsStore((state) => state.projects);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const target = useMemo(
    () => resolveHomeTarget({ pick, projects, workspaces, sessions }),
    [pick, projects, workspaces, sessions]
  );
  const draftBranch = useMemo(
    () => resolveHomeDraftBranch({ branch, workspace: target.workspace }),
    [branch, target.workspace]
  );
  return { pick, target, draftBranch };
}

/**
 * The same answer read fresh off the stores, for a send that runs after the
 * render it was started from (the home send awaits a checkout first).
 */
export function readHomeTarget(): HomeTargetState {
  const { pick, branch } = useHomeDraftStore.getState();
  const { projects, workspaces, sessions } = useChatSessionsStore.getState();
  const target = resolveHomeTarget({ pick, projects, workspaces, sessions });
  return {
    pick,
    target,
    draftBranch: resolveHomeDraftBranch({ branch, workspace: target.workspace }),
  };
}
