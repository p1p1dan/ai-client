/**
 * Uncommitted-change totals for a sidebar folder row.
 *
 * Restores the one fact the deleted `components/layout/WorktreePanel.tsx`
 * carried that the new shell dropped: how much a directory has changed while
 * you were looking at a different one. The old panel showed it per worktree
 * row; here it lands on the folder (project) row instead, because a diff is a
 * property of a working directory, not of a conversation — several sessions in
 * the same folder all share one set of changes, so a per-session copy would
 * just repeat itself. The session row also has no width left (`LeftNav.tsx`
 * documents its budget: the title floor plus the branch chip already spend it).
 *
 * The refresh strategy is the old panel's, unchanged, because it was already
 * matched to the case that matters: only directories with a session actually
 * running get polled, every 10s, and only while the window is focused. A
 * directory nobody is working in cannot be changing under you.
 */

import type { ChatWorkspace } from '@/stores/chatSessions';
import type { SidebarFolder } from './sidebarTree';

export interface DiffTotals {
  insertions: number;
  deletions: number;
}

/**
 * Workspace paths that currently have a busy session, deduplicated.
 *
 * `row.busy` is the sidebar's own running flag (`sidebarTree.ts` derives it
 * from the session status), so this stays in step with the 6px running dot on
 * the row — the dot and the number can never disagree about whether a folder
 * is working.
 *
 * Paths are returned exactly as `ChatWorkspace.path` spells them: the activity
 * store keys `diffStats` by the string handed to `fetchDiffStats`, so fetching
 * and reading must use the same spelling or every lookup misses.
 */
export function collectBusyWorkspacePaths(
  folders: readonly SidebarFolder[],
  workspaces: readonly ChatWorkspace[]
): string[] {
  const workspacePathById = new Map(workspaces.map((workspace) => [workspace.id, workspace.path]));
  const paths = new Set<string>();

  for (const folder of folders) {
    for (const row of folder.rows) {
      if (!row.busy) continue;
      const path = workspacePathById.get(row.workspaceId);
      // An empty path is the seeded placeholder a fresh install starts on, and
      // unbound (scratch) chats have no workspace at all — neither is a real
      // directory to run `git diff` in.
      if (path) paths.add(path);
    }
  }

  return [...paths];
}

/**
 * A folder's totals: the sum over every workspace under it that has stats.
 *
 * Summing rather than picking one worktree is deliberate — a project with two
 * checked-out worktrees really has changed in both, and the folder row is the
 * only place that says so at all. `null` means "nothing to show": either no
 * workspace under this folder has been measured yet, or every measurement came
 * back clean. Callers render nothing in that case rather than a `+0 -0` that
 * would put a permanent, meaningless column on every row.
 */
export function sumFolderDiffTotals(
  folder: SidebarFolder,
  workspaces: readonly ChatWorkspace[],
  diffStats: Readonly<Record<string, DiffTotals>>
): DiffTotals | null {
  let insertions = 0;
  let deletions = 0;

  for (const workspace of workspaces) {
    if (workspace.projectId !== folder.projectId) continue;
    const stats = diffStats[workspace.path];
    if (!stats) continue;
    insertions += stats.insertions;
    deletions += stats.deletions;
  }

  if (insertions === 0 && deletions === 0) return null;
  return { insertions, deletions };
}

/**
 * The set to fetch on a given tick: everything busy now, plus anything that
 * was busy a moment ago.
 *
 * The old panel skipped this and left the last number on screen forever after
 * an agent stopped — so a folder could keep claiming `+147 -38` long after the
 * work was committed. Including the paths that just went idle buys one final,
 * accurate reading for each of them, after which they drop out of the polling
 * set as before.
 */
export function withRecentlyBusy(
  current: readonly string[],
  previous: readonly string[]
): string[] {
  return [...new Set([...current, ...previous])];
}
