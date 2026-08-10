/**
 * T-01 bridge: sync derived Project/Workspace tree into chatSessions via external setState.
 * Does not edit chatSessions.ts — pending a proper mainline API (replaceWorkspaceTree).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Repository } from '@/App/constants';
import { TEMP_REPO_ID } from '@/App/constants';
import { ensureRepositoryId, STORAGE_KEYS } from '@/App/storage';
import {
  dropDismissedSessions,
  hasDismissedSessions,
} from '@/components/chat/sessionIndex/dismissedSessions';
import { useWorktreeListMultiple } from '@/hooks/useWorktree';
import { type ChatSession, type ChatWorkspace, useChatSessionsStore } from '@/stores/chatSessions';
import { useTempWorkspaceStore } from '@/stores/tempWorkspace';
import { useWorktreeStore } from '@/stores/worktree';
import {
  deriveChatWorkspaceTree,
  projectIdForRepo,
  resolvePreferredWorkspaceId,
  workspaceIdFor,
  workspaceTreeSignature,
} from './deriveChatWorkspaceTree';

const LIVE_SESSION_TITLE = 'Live Agent Host';

function readRepositoriesFromStorage(): Repository[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.REPOSITORIES);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Repository[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((repo) => ensureRepositoryId(repo))
      .filter((repo) => repo.path && repo.path !== TEMP_REPO_ID);
  } catch {
    return [];
  }
}

function createLiveSession(workspace: ChatWorkspace, now = Date.now()): ChatSession {
  return {
    id: `session-live-${now}`,
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    title: LIVE_SESSION_TITLE,
    status: 'idle',
    updatedAt: now,
  };
}

function seedFallbackWorkspace(
  path: string,
  name: string
): {
  projects: ReturnType<typeof deriveChatWorkspaceTree>['projects'];
  workspaces: ChatWorkspace[];
} {
  const repo: Repository = {
    id: `project:fallback:${path.toLowerCase()}`,
    name,
    path,
    kind: 'local',
  };
  const projectId = projectIdForRepo(repo);
  return {
    projects: [{ id: projectId, name }],
    workspaces: [
      {
        id: workspaceIdFor('main', path),
        projectId,
        name: 'Main',
        kind: 'main',
        path,
      },
    ],
  };
}

export interface RebindResult {
  sessions: ChatSession[];
  hostBoundSessionIds: string[];
  activeSessionId: string | null;
  /** True when a Live session was auto-created by this pass (A4 gate). */
  seeded: boolean;
}

function rebindSessionsToTree(
  sessions: ChatSession[],
  workspaces: ChatWorkspace[],
  preferredWorkspaceId: string | null,
  hostBoundSessionIds: string[],
  allowSeed: boolean
): RebindResult {
  const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
  const preferred =
    (preferredWorkspaceId ? workspaceById.get(preferredWorkspaceId) : undefined) ?? workspaces[0];

  if (!preferred) {
    return { sessions: [], hostBoundSessionIds: [], activeSessionId: null, seeded: false };
  }

  const bound = new Set(hostBoundSessionIds);
  const nextBound = new Set<string>();
  const remapped: ChatSession[] = [];

  for (const session of sessions) {
    // Drop seed welcome demo once real tree is available.
    if (session.id === 'session-welcome') {
      continue;
    }

    const workspace = workspaceById.get(session.workspaceId);
    if (workspace) {
      remapped.push(session);
      if (bound.has(session.id)) {
        nextBound.add(session.id);
      }
      continue;
    }

    // Orphan: only rebind if Host never saw this session (cwd would otherwise stick).
    if (bound.has(session.id)) {
      continue;
    }

    remapped.push({
      ...session,
      projectId: preferred.projectId,
      workspaceId: preferred.id,
      updatedAt: Date.now(),
    });
  }

  const hasLive = remapped.some(
    (session) => session.title === LIVE_SESSION_TITLE || session.id.startsWith('session-live')
  );
  let seeded = false;
  if (!hasLive && allowSeed) {
    remapped.unshift(createLiveSession(preferred));
    seeded = true;
  }

  // Retire the fixed DEMO id `session-live` — Host rejects duplicate createSession.
  for (let i = 0; i < remapped.length; i++) {
    const session = remapped[i];
    if (session?.id === 'session-live') {
      const nextId = `session-live-${Date.now()}`;
      nextBound.delete('session-live');
      remapped[i] = {
        ...session,
        id: nextId,
        projectId: preferred.projectId,
        workspaceId: preferred.id,
        title: LIVE_SESSION_TITLE,
        updatedAt: Date.now(),
      };
    }
  }

  const activeSessionId =
    remapped.find((session) => session.workspaceId === preferred.id)?.id ?? remapped[0]?.id ?? null;

  return {
    sessions: remapped,
    hostBoundSessionIds: [...nextBound],
    activeSessionId,
    seeded,
  };
}

/** Store slice the tree sync reads. */
export interface TreeSyncPrevState {
  sessions: ChatSession[];
  hostBoundSessionIds: string[];
  activeSessionId: string | null;
  recentSessionIds: string[];
}

/** Session-shaped part of the store patch the tree sync writes. */
export interface TreeSyncPatch {
  sessions: ChatSession[];
  hostBoundSessionIds: string[];
  activeSessionId: string | null;
  recentSessionIds: string[];
}

/**
 * The session half of a tree-sync write, as a pure function so vitest can
 * cover the two rules that only exist because of user actions (R5 round-2,
 * A4) — inside the effect body they were unreachable:
 *
 * 1. Auto-seeding a Live session is a first-run convenience, not a repair. It
 *    happens only when the user has never removed a row in this run AND the
 *    session list is empty. Otherwise a later tree signature change (a worktree
 *    list arriving, a repo added) would undo a deliberate Close by putting a
 *    fresh session back into an emptied nav.
 * 2. Rows dismissed in this run are filtered out of the write-back, and
 *    `activeSessionId` is only overwritten when the previous one no longer
 *    exists (or a seed just happened). The removal handover in
 *    `removeSessionRow` already picked the right neighbour; re-deriving
 *    "first session in the preferred workspace" here would silently undo it.
 */
export function resolveTreeSyncPatch(input: {
  prev: TreeSyncPrevState;
  workspaces: ChatWorkspace[];
  preferredWorkspaceId: string | null;
}): TreeSyncPatch {
  const { prev } = input;
  const allowSeed = prev.sessions.length === 0 && !hasDismissedSessions();
  const rebound = rebindSessionsToTree(
    prev.sessions,
    input.workspaces,
    input.preferredWorkspaceId,
    prev.hostBoundSessionIds,
    allowSeed
  );

  const sessions = dropDismissedSessions(rebound.sessions);
  const exists = (id: string | null): boolean =>
    id != null && sessions.some((session) => session.id === id);

  const activeSessionId = exists(prev.activeSessionId)
    ? prev.activeSessionId
    : exists(rebound.activeSessionId)
      ? rebound.activeSessionId
      : (sessions[0]?.id ?? null);

  const recentSessionIds = [
    ...(activeSessionId ? [activeSessionId] : []),
    ...prev.recentSessionIds,
    ...sessions.map((session) => session.id),
  ]
    .filter((id, index, arr) => arr.indexOf(id) === index && exists(id))
    .slice(0, 20);

  return {
    sessions,
    hostBoundSessionIds: rebound.hostBoundSessionIds,
    activeSessionId,
    recentSessionIds,
  };
}

interface UseSyncChatWorkspaceTreeOptions {
  repositories: Repository[];
  selectedRepoPath: string | null;
}

/**
 * Keep chatSessions.projects/workspaces aligned with real repos/worktrees/temps.
 */
export function useSyncChatWorkspaceTree({
  repositories,
  selectedRepoPath,
}: UseSyncChatWorkspaceTreeOptions): void {
  const tempItems = useTempWorkspaceStore((state) => state.items);
  const activeWorktreePath = useWorktreeStore((state) => state.currentWorktree?.path ?? null);

  // Props can be [] on first paint before App hydrates repos from localStorage.
  const [storedRepos, setStoredRepos] = useState<Repository[]>(() => readRepositoriesFromStorage());
  useEffect(() => {
    if (repositories.length > 0) {
      setStoredRepos(repositories);
      return;
    }
    setStoredRepos(readRepositoriesFromStorage());
  }, [repositories]);

  const effectiveRepos = repositories.length > 0 ? repositories : storedRepos;

  const localRepoPaths = useMemo(
    () =>
      effectiveRepos
        .filter((repo) => repo.kind !== 'remote' && !repo.path.startsWith('__'))
        .map((repo) => repo.path),
    [effectiveRepos]
  );

  const { worktreesMap, errorsMap } = useWorktreeListMultiple(localRepoPaths);

  // M4 (2026-08-07): the sidebar showed no branch chip on a test machine and the
  // round could not say why, because nothing on this path is observable — the
  // legacy shell renders worktree errors as text (TreeSidebar), this shell never
  // read errorsMap at all, and deriveChatWorkspaceTree's `?? []` flattens "query
  // failed" into "no worktrees". Both halves are surfaced here so the next round
  // reports a cause instead of a symptom. console.error rather than warn: the
  // renderer logger pins the default level at 'error', so a warn is discarded.
  useEffect(() => {
    for (const [repoPath, error] of Object.entries(errorsMap)) {
      if (error) console.error('[workspace-tree] worktree query failed', { repoPath, error });
    }
  }, [errorsMap]);

  const tree = useMemo(() => {
    const derived = deriveChatWorkspaceTree({
      repositories: effectiveRepos,
      worktreesByRepoPath: worktreesMap,
      tempItems,
    });
    if (derived.workspaces.length > 0) {
      return derived;
    }

    // Last resort so LeftNav / New / Live session stay usable for T-17.
    const fallbackPath =
      (selectedRepoPath && selectedRepoPath !== TEMP_REPO_ID ? selectedRepoPath : null) ??
      effectiveRepos[0]?.path ??
      activeWorktreePath;
    if (!fallbackPath) {
      return derived;
    }
    const name = effectiveRepos[0]?.name ?? fallbackPath.split(/[/\\]/).pop() ?? 'Workspace';
    return { ...seedFallbackWorkspace(fallbackPath, name), diagnostics: derived.diagnostics };
  }, [effectiveRepos, worktreesMap, tempItems, selectedRepoPath, activeWorktreePath]);

  // `branch-unresolved` is the one that would have closed M4 on the day it was
  // reported: it prints both canonical keys, so "the repo path and git's own
  // path are not the same identity" (mapped drive, junction, or a registered
  // subdirectory) is readable straight from the console instead of inferred.
  useEffect(() => {
    for (const d of tree.diagnostics) {
      console.error('[workspace-tree]', d.kind, d);
    }
  }, [tree.diagnostics]);

  const preferredWorkspaceId = useMemo(
    () =>
      resolvePreferredWorkspaceId(tree.workspaces, {
        selectedRepoPath,
        activeWorktreePath,
      }),
    [tree.workspaces, selectedRepoPath, activeWorktreePath]
  );

  const signatureRef = useRef<string>('');

  useEffect(() => {
    // Never clobber DEMO/Live with an empty tree while repos are still hydrating.
    if (tree.workspaces.length === 0) {
      return;
    }

    const signature = workspaceTreeSignature(tree.projects, tree.workspaces, preferredWorkspaceId);
    if (signature === signatureRef.current) {
      return;
    }
    signatureRef.current = signature;

    useChatSessionsStore.setState({
      projects: tree.projects,
      workspaces: tree.workspaces,
      ...resolveTreeSyncPatch({
        prev: useChatSessionsStore.getState(),
        workspaces: tree.workspaces,
        preferredWorkspaceId,
      }),
    });
  }, [tree.projects, tree.workspaces, preferredWorkspaceId]);
}
