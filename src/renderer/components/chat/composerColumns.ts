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
 * 2026-09-24: 「暂时不需要这个 worktree 的概念，就用默认的」). Column 1 picks a
 * REPOSITORY and the conversation lands on its default checkout; column 2 is a
 * real `git checkout`. Worktree creation still lives in the folder dropdown's
 * footer actions, which this module does not touch.
 *
 * Pure module: type-only imports plus pure helpers, so it stays testable under
 * the node-env vitest run (same posture as `composerTarget.ts`).
 */

import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { isTargetableWorkspace, resolveProjectDefaultWorkspaceId } from './composerTarget';

// ---- is this session busy? ----

/**
 * Statuses during which a conversation owns its checkout and must not have the
 * ground moved under it.
 *
 * Deliberately the same set `decideTargetChange` (`composerTarget.ts`) blocks
 * on, reached through one exported predicate rather than a second literal — two
 * lists that mean "busy" and drift apart is how a control ends up enabled in one
 * place and disabled in the other.
 */
const BUSY_STATUSES: ReadonlySet<SessionRuntimeStatus> = new Set([
  'starting',
  'running',
  'stopping',
  'waiting_permission',
  'waiting_question',
]);

/** Whether a session in this status is mid-work and locks the controls. */
export function isSessionBusy(status: SessionRuntimeStatus | undefined): boolean {
  return BUSY_STATUSES.has(status ?? 'idle');
}

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

/**
 * Whether a branch switch is allowed right now, and the checkout it applies to.
 *
 * Empty mode has no session yet, so the checkout is the one the conversation
 * WOULD land on: the target repository's default workspace. There is nothing to
 * lock against — the row's own `disabled` prop covers the composer being
 * unusable — and this is the control the old layout was missing entirely, so a
 * user could not pick a branch before starting a conversation at all.
 *
 * Session mode locks twice, because two different things can be broken:
 *
 *  - `session-running` — the ACTIVE conversation is mid-turn.
 *  - `checkout-busy` — some OTHER conversation is live in the SAME directory.
 *    A checkout rewrites every file there, and an idle conversation's UI must
 *    not let that happen to a peer still reading that tree. This is the lock the
 *    old single-dropdown layout had no way to express, because nothing there
 *    named the directory.
 *
 * `sending` is folded into `session-running`: `ChatComposer` latches a send
 * before the session status flips, so a status-only check would leave a window
 * where the turn has started and the store has not said so yet.
 */
export function buildBranchColumn(input: {
  sessions: readonly ChatSession[];
  workspaces: readonly ChatWorkspace[];
  activeSessionId: string | null;
  /** Fallback checkout for empty mode — the repository column's current entry. */
  fallbackWorkspaceId?: string | null;
  sending?: boolean;
}): BranchColumnModel {
  const active = input.activeSessionId
    ? input.sessions.find((item) => item.id === input.activeSessionId)
    : undefined;
  const sessionWorkspace = active
    ? input.workspaces.find((ws) => ws.id === active.workspaceId)
    : undefined;

  // Session mode: the checkout is the session's own workspace.
  if (active && sessionWorkspace) {
    if (!sessionWorkspace.path || !isTargetableWorkspace(sessionWorkspace)) {
      return { workdir: null, currentBranch: null, lock: 'no-checkout' };
    }
    const locked: BranchLockReason | null = (() => {
      if (input.sending === true || isSessionBusy(active.status)) return 'session-running';
      const peerBusy = input.sessions.some(
        (session) =>
          session.id !== active.id &&
          session.workspaceId === active.workspaceId &&
          isSessionBusy(session.status)
      );
      return peerBusy ? 'checkout-busy' : null;
    })();
    return {
      workdir: sessionWorkspace.path,
      currentBranch: sessionWorkspace.branch ?? null,
      lock: locked,
    };
  }

  // Empty mode: the checkout the conversation would land on.
  const fallback = input.fallbackWorkspaceId
    ? input.workspaces.find((ws) => ws.id === input.fallbackWorkspaceId)
    : undefined;
  if (!fallback || !fallback.path || !isTargetableWorkspace(fallback)) {
    return { workdir: null, currentBranch: null, lock: 'no-checkout' };
  }
  return {
    workdir: fallback.path,
    currentBranch: fallback.branch ?? null,
    lock: null,
  };
}
