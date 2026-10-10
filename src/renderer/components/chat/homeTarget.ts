/**
 * dsh-rebase decision 174 (GitHub issue #6, second wave): the home page's draft
 * target, resolved — where the next conversation will be made, and on which
 * branch.
 *
 * Pure (type imports plus pure helpers), like `composerTarget.ts`: the home
 * title, the composer's work bar and the home send all read the same answer
 * from here, so the repository the title names is the one the send uses.
 */

import { canonicalPathKey } from '@shared/utils/path';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import type { HomeDraftBranch, HomeTargetPick } from '@/stores/homeDraft';
import type { BranchLockReason } from './composerColumns';
import {
  isTargetableWorkspace,
  matchWorkspaceByPath,
  resolveProjectDefaultWorkspaceId,
} from './composerTarget';

export interface HomeTarget {
  /** Where the next conversation is made; null makes a temporary chat. */
  workspace: ChatWorkspace | null;
  /** The repository's name as the work bar and the title show it. */
  repositoryName: string | null;
  /** At least one repository could be picked (the title's two "no repository" sentences). */
  hasRepositories: boolean;
}

interface HomeTargetInput {
  pick: HomeTargetPick;
  projects: readonly ChatProject[];
  workspaces: readonly ChatWorkspace[];
  sessions: readonly ChatSession[];
}

/**
 * The repositories the home page can default to: every project whose default
 * checkout is a usable, non-temporary workspace. The synthetic Temp Session
 * project is pickable from the menu like any folder, but never the default —
 * the sidebar keeps 「临时工作区」 last, and "the first repository" means the
 * first one the user added.
 */
function defaultableWorkspaces(input: Omit<HomeTargetInput, 'pick' | 'sessions'>): ChatWorkspace[] {
  const out: ChatWorkspace[] = [];
  for (const project of input.projects) {
    const id = resolveProjectDefaultWorkspaceId(project.id, input.workspaces);
    const workspace = id ? input.workspaces.find((ws) => ws.id === id) : undefined;
    if (workspace && isTargetableWorkspace(workspace) && workspace.kind !== 'temp') {
      out.push(workspace);
    }
  }
  return out;
}

/**
 * User ruling 2026-10-10: by default the home page targets the most recently
 * active repository — the first folder of the sidebar's activity order
 * (decision 170 ruling 6): the repository whose newest chat is newest; with no
 * chat anywhere, the first repository in the order they were added.
 */
export function resolveHomeDefaultWorkspace(
  input: Omit<HomeTargetInput, 'pick'>
): ChatWorkspace | null {
  const candidates = defaultableWorkspaces(input);
  if (candidates.length === 0) return null;
  const candidateByProject = new Map(candidates.map((ws) => [ws.projectId, ws] as const));
  const workspaceById = new Map(input.workspaces.map((ws) => [ws.id, ws] as const));
  let newest: { projectId: string; at: number } | null = null;
  for (const session of input.sessions) {
    const workspace = workspaceById.get(session.workspaceId);
    if (!workspace || !candidateByProject.has(workspace.projectId)) continue;
    if (newest === null || session.updatedAt > newest.at) {
      newest = { projectId: workspace.projectId, at: session.updatedAt };
    }
  }
  return (newest && candidateByProject.get(newest.projectId)) ?? candidates[0] ?? null;
}

/**
 * The draft target as it stands now. A picked path that no longer (or not yet)
 * resolves to a usable workspace falls back to the default rather than to a
 * temporary chat: the user asked for a repository, not for none.
 */
export function resolveHomeTarget(input: HomeTargetInput): HomeTarget {
  const hasRepositories = defaultableWorkspaces(input).length > 0;
  let workspace: ChatWorkspace | null = null;
  if (input.pick.kind === 'path') {
    const picked = matchWorkspaceByPath(input.pick.path, input.workspaces);
    workspace = picked && isTargetableWorkspace(picked) ? picked : null;
  }
  if (input.pick.kind !== 'unbound' && workspace === null) {
    workspace = resolveHomeDefaultWorkspace(input);
  }
  const repositoryName = workspace
    ? (input.projects.find((project) => project.id === workspace.projectId)?.name ?? workspace.name)
    : null;
  return { workspace, repositoryName, hasRepositories };
}

/**
 * The branch picked on the home page, if it still applies: it belongs to the
 * checkout it was picked in, and a pick of the branch that checkout is already
 * on is no switch at all.
 */
export function resolveHomeDraftBranch(input: {
  branch: HomeDraftBranch | null;
  workspace: ChatWorkspace | null;
}): HomeDraftBranch | null {
  const { branch, workspace } = input;
  if (!branch || !workspace) return null;
  if (canonicalPathKey(branch.workdir) !== canonicalPathKey(workspace.path)) return null;
  if (!branch.create && branch.name === workspace.branch) return null;
  return branch;
}

export type HomeBranchPlan =
  | { kind: 'none' }
  /** A branch was picked, and the checkout is locked now: ask, do not send. */
  | { kind: 'blocked'; branch: string }
  | { kind: 'switch'; workdir: string; branch: string; create: boolean };

/**
 * What the home send does about the branch before it makes the conversation
 * (user ruling 2026-10-10): nothing without a draft; with one, switch — unless
 * the same locks the branch column shows are on now (decision 174), in which
 * case nothing is sent and nothing is switched. A checkout the column no
 * longer offers (`no-checkout`: not a local git checkout any more) drops the
 * draft rather than blocking the message on it.
 */
export function planHomeBranchSwitch(input: {
  draft: HomeDraftBranch | null;
  lock: BranchLockReason | null;
}): HomeBranchPlan {
  const { draft, lock } = input;
  if (!draft || lock === 'no-checkout') return { kind: 'none' };
  if (lock === 'checkout-busy' || lock === 'session-running') {
    return { kind: 'blocked', branch: draft.name };
  }
  return { kind: 'switch', workdir: draft.workdir, branch: draft.name, create: draft.create };
}
