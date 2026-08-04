/**
 * T-15: which directory the terminal surface opens in, and — when it cannot
 * open at all — which reason to say out loud.
 *
 * Pure (type-only import from the store, no runtime dependency) so vitest's
 * node env covers it. Same shape as `useGitChangeCount`'s resolution chain:
 * active session → its workspace → that workspace's path. A06: every failure
 * is a named reason, never a silent fallback to the home directory or to the
 * last workspace that happened to work.
 */
import type { WorkspaceKind } from '@/stores/chatSessions';

/** Structural view of the store — the resolver never sees the store itself. */
export interface TerminalWorkspaceSnapshot {
  activeSessionId: string | null;
  sessions: readonly { id: string; workspaceId: string }[];
  workspaces: readonly { id: string; path: string; kind: WorkspaceKind }[];
}

export type TerminalWorkspaceUnavailableReason = 'no-session' | 'no-workspace' | 'no-path';

export type TerminalWorkspaceResolution =
  | {
      status: 'ready';
      /** Passed to `TerminalPanel` as `cwd`; also its per-worktree state key. */
      path: string;
      /**
       * Temp workspaces follow the `autoCreateSessionOnTempActivate` setting
       * rather than `autoCreateSessionOnActivate`, which `TerminalPanel` selects
       * by comparing `repoPath` to TEMP_REPO_ID.
       */
      isTemp: boolean;
    }
  | { status: 'unavailable'; reason: TerminalWorkspaceUnavailableReason };

/**
 * 'no-session'   — nothing selected, or the selected id names no session.
 * 'no-workspace' — the session points at a workspace that is not in the store.
 * 'no-path'      — the workspace exists but carries no usable path.
 */
export function resolveTerminalWorkspace(
  snapshot: TerminalWorkspaceSnapshot
): TerminalWorkspaceResolution {
  const { activeSessionId, sessions, workspaces } = snapshot;
  if (!activeSessionId) {
    return { status: 'unavailable', reason: 'no-session' };
  }

  const session = sessions.find((candidate) => candidate.id === activeSessionId);
  if (!session) {
    return { status: 'unavailable', reason: 'no-session' };
  }

  const workspace = workspaces.find((candidate) => candidate.id === session.workspaceId);
  if (!workspace) {
    return { status: 'unavailable', reason: 'no-workspace' };
  }

  // Trim only: normalisation and case folding belong to TerminalPanel, which
  // keys its per-worktree state with `normalizePath` and spawns with
  // `cleanPath`. Doing it twice, differently, is how the two disagree.
  const path = workspace.path?.trim() ?? '';
  if (!path) {
    return { status: 'unavailable', reason: 'no-path' };
  }

  return { status: 'ready', path, isTemp: workspace.kind === 'temp' };
}
