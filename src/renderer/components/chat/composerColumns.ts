/**
 * The composer target row's three columns: repository / branch / run location.
 *
 * ## What this replaced
 *
 * The row used to carry a "worktree" dropdown (`buildBranchMenu` +
 * `TargetBranchSelect`) whose options were WORKSPACES filtered to
 * `kind: 'main' || 'worktree'`, but each option was labelled with
 * `ws.branch ?? ws.name` and drawn with a branch icon, and selecting one called
 * `selectTarget()` — which re-points the SESSION at another checkout rather than
 * running `git checkout`.
 *
 * The two questions ("which checkout does this conversation work in" and "what
 * commit is that checkout on") therefore wore the same clothes: a branch icon
 * and a branch name, in one slot. The visible symptoms were a repository with no
 * worktrees showing a single entry that appeared to do nothing, and no control
 * anywhere that actually switched branches.
 *
 * As-built, the worktree concept is dropped from this row entirely (user ruling
 * 2026-09-24: worktrees are not needed here for now; use the default checkout).
 * Column 1 picks a REPOSITORY and the conversation lands on its default
 * checkout; column 2 is a real `git checkout`. Worktree creation still lives in
 * the folder dropdown's footer actions, which this module does not touch.
 *
 * Pure module: type-only imports plus pure helpers, so it stays testable under
 * the node-env vitest run (same posture as `composerTarget.ts`).
 */

import { canonicalPathKey } from '@shared/utils/path';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import {
  isSessionBusy,
  isTargetableWorkspace,
  resolveProjectDefaultWorkspaceId,
  shouldShowBranchSelect,
} from './composerTarget';

// ---- column 1: repository ----

export interface RepoEntry {
  /** The default workspace this repository resolves to. */
  workspaceId: string;
  projectId: string;
  label: string;
  /** Physical directory that becomes — or already is — the session's cwd. */
  path: string;
  current: boolean;
}

export interface RepoColumnModel {
  entries: readonly RepoEntry[];
  /** The active conversation's repository, for the locked (session) form. */
  currentLabel: string | null;
  currentPath: string | null;
  /** Non-null in session mode: the conversation is bound, so column 1 is a label. */
  locked: boolean;
}

/**
 * One entry per repository, in sidebar order, plus the active one's identity.
 *
 * Each entry's target workspace comes from `resolveProjectDefaultWorkspaceId`
 * (the established rule: prefer `kind: 'main'`, else the first targetable one).
 * A repository with no targetable workspace is skipped rather than shown
 * unselectable — the sidebar's own tree drops those for the same reason.
 *
 * `current` is decided by the ACTIVE WORKSPACE's repository, not by comparing
 * workspace ids: the active session may sit in a worktree while the entry points
 * at its `main`, and the question column 1 answers is "which repository".
 *
 * ## Why `locked`
 *
 * In session mode the binding is already made and changing it is not this row's
 * business — it is a FORK (see `planTargetChange`), which the sidebar and the
 * empty-state card already offer. Drawn as a plain label, it also stops the row
 * from offering a control that looks like it will re-point the conversation but
 * would actually start a different one.
 */
export function buildRepoColumn(input: {
  projects: readonly ChatProject[];
  workspaces: readonly ChatWorkspace[];
  activeWorkspaceId: string | null;
  mode: 'empty' | 'session';
}): RepoColumnModel {
  const activeWorkspace = input.activeWorkspaceId
    ? input.workspaces.find((ws) => ws.id === input.activeWorkspaceId)
    : undefined;
  const activeProjectId = activeWorkspace?.projectId ?? null;

  const entries: RepoEntry[] = [];
  for (const project of input.projects) {
    const defaultId = resolveProjectDefaultWorkspaceId(project.id, input.workspaces);
    if (!defaultId) continue;
    const ws = input.workspaces.find((item) => item.id === defaultId);
    if (!ws) continue;
    entries.push({
      workspaceId: ws.id,
      projectId: project.id,
      label: project.name,
      path: ws.path,
      current: project.id === activeProjectId,
    });
  }

  const currentEntry = entries.find((entry) => entry.current) ?? null;
  return {
    entries,
    // In session mode the label must describe the checkout the session is
    // actually in — which can be a worktree whose repository is `currentEntry`.
    // The repository name is the same either way; the path is not.
    currentLabel: currentEntry?.label ?? null,
    currentPath: activeWorkspace?.path ?? currentEntry?.path ?? null,
    locked: input.mode === 'session',
  };
}

// ---- column 2: branch ----

export type BranchLockReason = 'session-running' | 'checkout-busy' | 'no-checkout';

export interface BranchColumnModel {
  /** The checkout this column is about; `null` when there is nothing to switch. */
  workdir: string | null;
  currentBranch: string | null;
  /** Non-null when switching must be blocked, with the reason to show the user. */
  lock: BranchLockReason | null;
}

const NO_CHECKOUT: BranchColumnModel = { workdir: null, currentBranch: null, lock: 'no-checkout' };

/**
 * Whether a branch switch is allowed right now, and the checkout it applies to.
 *
 * The checkout is the active session's workspace. With no active session — or
 * one whose workspace is not in the tree — it is `fallbackWorkspaceId`, the
 * composer's target workspace: the checkout the conversation would start in.
 * A session whose workspace IS known never borrows the fallback, or the column
 * would offer a switch in a directory this conversation is not in.
 *
 * The column only exists for a local `main` / `worktree` git checkout
 * (`shouldShowBranchSelect`). Elsewhere it has nothing to switch: a non-git
 * folder got an empty picker whose "create branch" had nowhere to land.
 *
 * Two locks, applied on BOTH paths, because what they protect is the
 * directory, not whichever conversation happens to be on screen:
 *
 *  - `session-running` — this conversation is mid-turn, or a send is in flight.
 *    `sending` is folded in because `ChatComposer` latches a send before the
 *    session status flips, so a status-only check would leave a window where
 *    the first message is on its way and the store has not said so yet.
 *  - `checkout-busy` — some OTHER conversation is live in the same directory.
 *    A checkout rewrites every file there, and an idle (or not yet started)
 *    conversation's UI must not let that happen to a peer still reading that
 *    tree. A new conversation lands on the repository's default checkout,
 *    which is exactly where a peer is most likely to be running.
 */
export function buildBranchColumn(input: {
  sessions: readonly ChatSession[];
  workspaces: readonly ChatWorkspace[];
  activeSessionId: string | null;
  /** The composer's target workspace, used when there is no session checkout. */
  fallbackWorkspaceId?: string | null;
  sending?: boolean;
}): BranchColumnModel {
  const active = input.activeSessionId
    ? input.sessions.find((item) => item.id === input.activeSessionId)
    : undefined;
  const sessionWorkspace = active
    ? input.workspaces.find((ws) => ws.id === active.workspaceId)
    : undefined;
  const checkout =
    active && sessionWorkspace
      ? sessionWorkspace
      : input.fallbackWorkspaceId
        ? input.workspaces.find((ws) => ws.id === input.fallbackWorkspaceId)
        : undefined;

  if (!checkout || !isTargetableWorkspace(checkout) || !shouldShowBranchSelect(checkout)) {
    return NO_CHECKOUT;
  }
  return {
    workdir: checkout.path,
    currentBranch: checkout.branch ?? null,
    lock: resolveBranchLock({
      sessions: input.sessions,
      workspaces: input.workspaces,
      checkout,
      own: active,
      sending: input.sending,
    }),
  };
}

/**
 * The lock for switching `checkout`, `own` being the conversation on screen
 * (if any). "Same directory" compares canonical paths rather than workspace
 * ids: one directory can back two workspaces (a parent repository's worktree
 * entry and a registered folder's own `main`), and git does not care which id
 * a peer was opened under.
 */
function resolveBranchLock(input: {
  sessions: readonly ChatSession[];
  workspaces: readonly ChatWorkspace[];
  checkout: ChatWorkspace;
  own: ChatSession | undefined;
  sending?: boolean;
}): BranchLockReason | null {
  if (input.sending === true || isSessionBusy(input.own?.status)) {
    return 'session-running';
  }
  const checkoutKey = canonicalPathKey(input.checkout.path);
  const pathById = new Map(input.workspaces.map((ws) => [ws.id, ws.path] as const));
  const peerBusy = input.sessions.some((session) => {
    if (session.id === input.own?.id || !isSessionBusy(session.status)) return false;
    if (session.workspaceId === input.checkout.id) return true;
    const peerPath = pathById.get(session.workspaceId);
    return (
      peerPath !== undefined && peerPath.trim() !== '' && canonicalPathKey(peerPath) === checkoutKey
    );
  });
  return peerBusy ? 'checkout-busy' : null;
}
