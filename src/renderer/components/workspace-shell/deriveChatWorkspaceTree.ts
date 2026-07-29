/**
 * Derive Chat Store Project/Workspace tree from real App repositories + worktrees + temps.
 * T-01 bridge: pure function, does not mutate chatSessions store structure.
 */

import type { GitWorktree } from '@shared/types';
import type { TempWorkspaceItem } from '@shared/types/tempWorkspace';
import { normalizePath } from '@shared/utils/path';
import type { Repository } from '@/App/constants';
import { TEMP_REPO_ID } from '@/App/constants';
import type { ChatProject, ChatWorkspace, WorkspaceKind } from '@/stores/chatSessions';

const TEMP_PROJECT_ID = 'project-temp';

export function workspaceIdFor(kind: WorkspaceKind, workspacePath: string): string {
  return `ws:${kind}:${normalizePath(workspacePath).toLowerCase()}`;
}

export function projectIdForRepo(repo: Repository): string {
  return repo.id || `project:${normalizePath(repo.path).toLowerCase()}`;
}

function workspaceName(kind: WorkspaceKind, repoName: string, wt: GitWorktree): string {
  if (kind === 'main') {
    return 'Main';
  }
  if (wt.branch) {
    return wt.branch.replace(/^refs\/heads\//, '');
  }
  const segments = normalizePath(wt.path).split('/').filter(Boolean);
  return segments[segments.length - 1] || repoName;
}

/**
 * Short branch name for the sidebar chip (T-26 / D21-A). Undefined when git
 * reports no branch (detached HEAD) — the chip is hidden rather than guessed.
 */
function workspaceBranch(wt: GitWorktree | undefined): string | undefined {
  if (!wt?.branch) {
    return undefined;
  }
  return wt.branch.replace(/^refs\/heads\//, '');
}

export interface DeriveChatWorkspaceTreeInput {
  repositories: Repository[];
  /** repo.path → git worktree list (may be empty while loading) */
  worktreesByRepoPath: Record<string, GitWorktree[]>;
  tempItems: TempWorkspaceItem[];
}

export interface DeriveChatWorkspaceTreeResult {
  projects: ChatProject[];
  workspaces: ChatWorkspace[];
}

/**
 * Build Project > Workspace list for LeftNav / chatSessions sync.
 * - Local/remote repos → Project
 * - Main worktree (or repo.path fallback) → kind main | remote
 * - Linked worktrees → kind worktree
 * - Temp sessions → synthetic Temp project, kind temp
 */
export function deriveChatWorkspaceTree(
  input: DeriveChatWorkspaceTreeInput
): DeriveChatWorkspaceTreeResult {
  const projects: ChatProject[] = [];
  const workspaces: ChatWorkspace[] = [];
  const seenWorkspaceIds = new Set<string>();

  const pushWorkspace = (workspace: ChatWorkspace) => {
    if (seenWorkspaceIds.has(workspace.id)) {
      return;
    }
    seenWorkspaceIds.add(workspace.id);
    workspaces.push(workspace);
  };

  for (const repo of input.repositories) {
    if (repo.path === TEMP_REPO_ID) {
      continue;
    }

    const projectId = projectIdForRepo(repo);
    projects.push({ id: projectId, name: repo.name });

    const isRemote = repo.kind === 'remote';
    const listed = input.worktreesByRepoPath[repo.path] ?? [];
    const mainWt = listed.find((wt) => wt.isMainWorktree);
    const mainPath = mainWt?.path ?? repo.path;
    const mainKind: WorkspaceKind = isRemote ? 'remote' : 'main';
    const mainBranch = isRemote ? undefined : workspaceBranch(mainWt);

    pushWorkspace({
      id: workspaceIdFor(mainKind, mainPath),
      projectId,
      name: isRemote ? repo.name : 'Main',
      kind: mainKind,
      path: mainPath,
      // Conditional spread keeps `branch` truly absent (not an explicit
      // undefined key) when unknown — `'branch' in ws` stays false.
      ...(mainBranch ? { branch: mainBranch } : {}),
    });

    if (isRemote) {
      continue;
    }

    for (const wt of listed) {
      if (wt.isMainWorktree) {
        continue;
      }
      if (normalizePath(wt.path).toLowerCase() === normalizePath(mainPath).toLowerCase()) {
        continue;
      }
      const wtBranch = workspaceBranch(wt);
      pushWorkspace({
        id: workspaceIdFor('worktree', wt.path),
        projectId,
        name: workspaceName('worktree', repo.name, wt),
        kind: 'worktree',
        path: wt.path,
        ...(wtBranch ? { branch: wtBranch } : {}),
      });
    }
  }

  if (input.tempItems.length > 0) {
    projects.push({ id: TEMP_PROJECT_ID, name: 'Temp' });
    for (const item of input.tempItems) {
      pushWorkspace({
        id: workspaceIdFor('temp', item.path),
        projectId: TEMP_PROJECT_ID,
        name: item.title || item.folderName,
        kind: 'temp',
        path: item.path,
      });
    }
  }

  return { projects, workspaces };
}

/**
 * Change signature for the sync bridge's early-return guard. Every field that
 * can alter what the sidebar renders must participate: `branch` was missing
 * once (T-26 review blocker) and a late-arriving branch on an otherwise
 * identical tree — the normal cold-start sequence for a repo with no linked
 * worktrees — produced a byte-identical signature, so the store never learned
 * the branch and the chip stayed empty for the whole app session.
 */
export function workspaceTreeSignature(
  projects: readonly ChatProject[],
  workspaces: readonly ChatWorkspace[],
  preferredWorkspaceId: string | null
): string {
  return JSON.stringify({
    projects,
    workspaces: workspaces.map((ws) => ({
      id: ws.id,
      path: ws.path,
      kind: ws.kind,
      branch: ws.branch ?? null,
    })),
    preferredWorkspaceId,
  });
}

/** Prefer active worktree path, else selected repo main, else first workspace. */
export function resolvePreferredWorkspaceId(
  workspaces: ChatWorkspace[],
  options: {
    selectedRepoPath: string | null;
    activeWorktreePath: string | null;
  }
): string | null {
  if (workspaces.length === 0) {
    return null;
  }

  const byPath = (path: string | null) => {
    if (!path || path === TEMP_REPO_ID) {
      return undefined;
    }
    const normalized = normalizePath(path).toLowerCase();
    return workspaces.find((ws) => normalizePath(ws.path).toLowerCase() === normalized);
  };

  return (
    byPath(options.activeWorktreePath)?.id ??
    byPath(options.selectedRepoPath)?.id ??
    workspaces[0]?.id ??
    null
  );
}
