/**
 * T-24: decide when the new shell must surface the "add repository" call to
 * action. Pure so vitest (node env, `.ts` only) can cover it — the previous
 * `.tsx`-inline `projects.length === 0` check was untested and provably dead.
 */

export interface WorkspacePathLike {
  path: string;
}

export interface IdentifiedWorkspace extends WorkspacePathLike {
  id: string;
}

export interface ProjectLike {
  id: string;
}

/**
 * A workspace is only usable once it points at a real directory. The chat
 * store boots with a DEMO project whose workspaces carry `path: ''`, so a
 * fresh machine has projects but nothing that can host an agent session.
 */
export function isUsableWorkspace(workspace: WorkspacePathLike): boolean {
  return workspace.path.trim().length > 0;
}

export function countUsableWorkspaces(workspaces: readonly WorkspacePathLike[]): number {
  return workspaces.filter(isUsableWorkspace).length;
}

/**
 * True when the sidebar tree cannot be trusted and the user needs the add
 * repository entry point instead.
 *
 * Checking `projects.length === 0` alone never fires on a fresh machine: the
 * sync bridge bails out early on an empty derived tree, leaving the DEMO seed
 * in place, so the user sees a plausible-looking tree with no way to register
 * a repository (plantree open-question #9).
 */
export function shouldShowAddRepositoryEmptyState(
  projects: readonly ProjectLike[],
  workspaces: readonly WorkspacePathLike[]
): boolean {
  return projects.length === 0 || countUsableWorkspaces(workspaces) === 0;
}

/**
 * True when "New chat" may run against `workspaceId`.
 *
 * The sidebar falls back to `workspaces[0]` when nothing is selected, which on
 * a fresh machine is a DEMO seed workspace with `path: ''`. Creating a session
 * there is worse than a no-op: while the empty state is shown the new session
 * is rendered nowhere, and its first send would reach the Host with an empty
 * cwd. Requiring a usable target keeps the add-repository entry point the only
 * live affordance until a real repository exists.
 */
export function canCreateSessionOnWorkspace(
  workspaceId: string | null | undefined,
  workspaces: readonly IdentifiedWorkspace[]
): boolean {
  if (!workspaceId) {
    return false;
  }
  const workspace = workspaces.find((item) => item.id === workspaceId);
  return workspace ? isUsableWorkspace(workspace) : false;
}
