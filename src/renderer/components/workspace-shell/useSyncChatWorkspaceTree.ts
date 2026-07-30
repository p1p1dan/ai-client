/**
 * T-01 bridge: sync derived Project/Workspace tree into chatSessions via external setState.
 * Does not edit chatSessions.ts — pending a proper mainline API (replaceWorkspaceTree).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Repository } from '@/App/constants';
import { TEMP_REPO_ID } from '@/App/constants';
import { ensureRepositoryId, STORAGE_KEYS } from '@/App/storage';
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

function rebindSessionsToTree(
  sessions: ChatSession[],
  workspaces: ChatWorkspace[],
  preferredWorkspaceId: string | null,
  hostBoundSessionIds: string[]
): { sessions: ChatSession[]; hostBoundSessionIds: string[]; activeSessionId: string | null } {
  const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
  const preferred =
    (preferredWorkspaceId ? workspaceById.get(preferredWorkspaceId) : undefined) ?? workspaces[0];

  if (!preferred) {
    return { sessions: [], hostBoundSessionIds: [], activeSessionId: null };
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
  if (!hasLive) {
    remapped.unshift(createLiveSession(preferred));
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

  const { worktreesMap } = useWorktreeListMultiple(localRepoPaths);

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
    return seedFallbackWorkspace(fallbackPath, name);
  }, [effectiveRepos, worktreesMap, tempItems, selectedRepoPath, activeWorktreePath]);

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

    const prev = useChatSessionsStore.getState();
    const rebound = rebindSessionsToTree(
      prev.sessions,
      tree.workspaces,
      preferredWorkspaceId,
      prev.hostBoundSessionIds
    );

    const recentSessionIds = [
      ...(rebound.activeSessionId ? [rebound.activeSessionId] : []),
      ...prev.recentSessionIds,
      ...rebound.sessions.map((session) => session.id),
    ].filter(
      (id, index, arr) => arr.indexOf(id) === index && rebound.sessions.some((s) => s.id === id)
    );

    useChatSessionsStore.setState({
      projects: tree.projects,
      workspaces: tree.workspaces,
      sessions: rebound.sessions,
      hostBoundSessionIds: rebound.hostBoundSessionIds,
      activeSessionId: rebound.activeSessionId ?? prev.activeSessionId,
      recentSessionIds: recentSessionIds.slice(0, 20),
    });
  }, [tree.projects, tree.workspaces, preferredWorkspaceId]);
}
