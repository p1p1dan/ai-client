/**
 * Derive Chat Store Project/Workspace tree from real App repositories + worktrees + temps.
 * T-01 bridge: pure function, does not mutate chatSessions store structure.
 */

import type { GitWorktree } from '@shared/types';
import type { TempWorkspaceItem } from '@shared/types/tempWorkspace';
import { canonicalPathKey, normalizePath } from '@shared/utils/path';
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

/**
 * Why a row ended up without a branch chip.
 *
 * M4 (2026-08-07 test machine: sidebar shows no branch) cost a whole test round
 * because this function could reach "no chip" down several paths and left no
 * trace of which one. `worktreesByRepoPath[path] ?? []` in particular collapses
 * four different situations — never queried, query failed, not a git repo, and
 * genuinely empty — into one indistinguishable empty array, so the round could
 * only report "still blank".
 *
 * These are returned rather than logged so the function stays pure and each
 * reason is unit-testable; the sync hook does the logging.
 */
export type WorkspaceTreeDiagnostic =
  | {
      kind: 'worktrees-absent';
      repoPath: string;
      /** `true` = key missing entirely (never queried / query failed); `false` = queried, empty. */
      neverQueried: boolean;
    }
  | {
      /**
       * The repo path is not itself a worktree entry, so no branch could be
       * read. Both canonical keys are carried because the usual cause is that
       * they differ for a reason the user can see (a mapped network drive or a
       * junction that git resolves, or a registered subdirectory of the repo).
       */
      kind: 'branch-unresolved';
      repoPath: string;
      repoKey: string;
      mainWorktreePath: string;
      mainWorktreeKey: string;
      listedKeys: string[];
    };

export interface DeriveChatWorkspaceTreeResult {
  projects: ChatProject[];
  workspaces: ChatWorkspace[];
  /** Empty on a healthy tree. See {@link WorkspaceTreeDiagnostic}. */
  diagnostics: WorkspaceTreeDiagnostic[];
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
  const diagnostics: WorkspaceTreeDiagnostic[] = [];
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
    const listedOrMissing = input.worktreesByRepoPath[repo.path];
    const listed = listedOrMissing ?? [];
    if (!isRemote && listed.length === 0) {
      diagnostics.push({
        kind: 'worktrees-absent',
        repoPath: repo.path,
        neverQueried: listedOrMissing === undefined,
      });
    }

    const mainWt = listed.find((wt) => wt.isMainWorktree);

    // T-31 (round-6 D2, generalized by review B4): a user can register a
    // folder that is NOT the repo root of the git repository it belongs to —
    // a linked worktree (openchamber's `aaa` added standalone), a
    // subdirectory of a registered repo, or a symlinked form of either.
    // `worktree.list` for such a folder returns the PARENT repo's worktree
    // list, whose main entry points at the parent's root. Treating that
    // entry as this project's main workspace collides with the parent
    // project's own `ws:main:<parent path>` id (first registrant wins;
    // pushWorkspace's seenWorkspaceIds silently drops the loser, so
    // whichever repo registers second gets zero workspaces) and re-attaches
    // the parent's sibling worktrees here, duplicating ids the parent
    // project already owns. The registered folder IS this project's main
    // workspace — so whenever the listed root differs from repo.path,
    // short-circuit with a single self workspace. The branch chip comes from
    // the matching linked-worktree entry when one exists (a subdirectory has
    // none). canonicalPathKey trims trailing separators too — `/aaa/` vs
    // `/aaa` must not silently disable this branch (review M5).
    if (!isRemote && mainWt && canonicalPathKey(mainWt.path) !== canonicalPathKey(repo.path)) {
      const selfWt = listed.find((wt) => canonicalPathKey(wt.path) === canonicalPathKey(repo.path));
      const selfBranch = workspaceBranch(selfWt);
      if (!selfBranch) {
        diagnostics.push({
          kind: 'branch-unresolved',
          repoPath: repo.path,
          repoKey: canonicalPathKey(repo.path),
          mainWorktreePath: mainWt.path,
          mainWorktreeKey: canonicalPathKey(mainWt.path),
          listedKeys: listed.map((wt) => canonicalPathKey(wt.path)),
        });
      }
      pushWorkspace({
        id: workspaceIdFor('main', repo.path),
        projectId,
        name: 'Main',
        kind: 'main',
        path: repo.path,
        ...(selfBranch ? { branch: selfBranch } : {}),
        gitEnabled: true,
      });
      continue;
    }

    const mainPath = mainWt?.path ?? repo.path;
    const mainKind: WorkspaceKind = isRemote ? 'remote' : 'main';
    const mainBranch = isRemote ? undefined : workspaceBranch(mainWt);
    // T-27: gates the Composer target bar's branch/worktree dropdown — true
    // once `worktree.list` resolved with at least the main entry for this
    // repo. Remote workspaces never show branch UI regardless of this value
    // (shouldShowBranchSelect also checks `kind`), so it is only attached to
    // the main/worktree entries below.
    const gitEnabled = listed.length > 0;

    pushWorkspace({
      id: workspaceIdFor(mainKind, mainPath),
      projectId,
      name: isRemote ? repo.name : 'Main',
      kind: mainKind,
      path: mainPath,
      // Conditional spread keeps `branch` truly absent (not an explicit
      // undefined key) when unknown — `'branch' in ws` stays false.
      ...(mainBranch ? { branch: mainBranch } : {}),
      ...(isRemote ? {} : { gitEnabled }),
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
        gitEnabled,
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

  return { projects, workspaces, diagnostics };
}

/**
 * Change signature for the sync bridge's early-return guard. Every field that
 * can alter what the sidebar renders must participate: `branch` was missing
 * once (T-26 review blocker) and a late-arriving branch on an otherwise
 * identical tree — the normal cold-start sequence for a repo with no linked
 * worktrees — produced a byte-identical signature, so the store never learned
 * the branch and the chip stayed empty for the whole app session. `gitEnabled`
 * (T-27) is the same failure mode: dropping it here would mean a late
 * `worktree.list` resolution never flips the Composer branch dropdown on.
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
      gitEnabled: ws.gitEnabled ?? null,
    })),
    preferredWorkspaceId,
  });
}

/**
 * Tie-break for path-only workspace lookups (round-6 review M3/Major-4): D2
 * deliberately lets one directory back two workspaces — the parent repo's
 * `worktree` entry and the registered folder's own `main`. Path-only
 * consumers must prefer the registered-folder identity deterministically;
 * a bare `.find()` inherits repository registration order, which flips the
 * resolved project when the order flips. Intentionally duplicated in
 * `composerTarget.ts` across the chat / workspace-shell boundary (same rule
 * as `resolveNewSessionWorkspaceId`).
 */
export function workspacePathMatchRank(kind: WorkspaceKind): number {
  switch (kind) {
    case 'main':
      return 0;
    case 'remote':
      return 1;
    case 'worktree':
      return 2;
    default:
      return 3;
  }
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
    const key = canonicalPathKey(path);
    const matches = workspaces.filter((ws) => canonicalPathKey(ws.path) === key);
    if (matches.length <= 1) {
      return matches[0];
    }
    // Stable sort keeps derivation order within one rank tier.
    return [...matches].sort(
      (a, b) => workspacePathMatchRank(a.kind) - workspacePathMatchRank(b.kind)
    )[0];
  };

  return (
    byPath(options.activeWorktreePath)?.id ??
    byPath(options.selectedRepoPath)?.id ??
    workspaces[0]?.id ??
    null
  );
}
