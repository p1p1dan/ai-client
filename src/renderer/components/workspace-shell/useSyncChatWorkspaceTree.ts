/**
 * T-01 bridge: sync derived Project/Workspace tree into chatSessions via external setState.
 * Does not edit chatSessions.ts — pending a proper mainline API (replaceWorkspaceTree).
 */

import { canonicalPathKey } from '@shared/utils/path';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Repository } from '@/App/constants';
import { TEMP_REPO_ID } from '@/App/constants';
import { ensureRepositoryId, STORAGE_KEYS } from '@/App/storage';
import { dropDismissedSessions } from '@/components/chat/sessionIndex/dismissedSessions';
import { gitRepoQueryKey } from '@/hooks/gitRepoQueryKey';
import { useWorktreeListMultiple } from '@/hooks/useWorktree';
import {
  type ChatSession,
  type ChatSessionsState,
  type ChatWorkspace,
  useChatSessionsStore,
} from '@/stores/chatSessions';
import { markSessionsLive, markSessionsRetired } from '@/stores/sessionRetirement';
import { useTempWorkspaceStore } from '@/stores/tempWorkspace';
import {
  deriveChatWorkspaceTree,
  projectIdForRepo,
  resolvePreferredWorkspaceId,
  workspaceIdFor,
  workspaceTreeSignature,
} from './deriveChatWorkspaceTree';

/**
 * The store's two DEMO rows (`chatSessions.ts`, a red-line file whose initial
 * state is left as it is). Decision 174 (issue #6, second wave): neither
 * survives the first tree sync any more. `session-live` used to be renamed into
 * the start-up chat — a blank 「新建对话」 the app opened on — and the home page
 * replaced that chat: the app now opens on no conversation at all.
 */
const DEMO_SESSION_IDS: ReadonlySet<string> = new Set(['session-live', 'session-welcome']);

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
}

function rebindSessionsToTree(
  sessions: ChatSession[],
  workspaces: ChatWorkspace[],
  preferredWorkspaceId: string | null,
  hostBoundSessionIds: string[]
): RebindResult {
  const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws]));
  const preferred =
    (preferredWorkspaceId ? workspaceById.get(preferredWorkspaceId) : undefined) ?? workspaces[0];

  const bound = new Set(hostBoundSessionIds);
  const nextBound = new Set<string>();
  const remapped: ChatSession[] = [];
  const keep = (session: ChatSession) => {
    remapped.push(session);
    if (bound.has(session.id)) {
      nextBound.add(session.id);
    }
  };

  for (const session of sessions) {
    // Decision 174: the store's DEMO rows are dropped once a real tree exists —
    // `session-welcome` always was; `session-live` used to become the start-up
    // chat, which the home page replaced.
    if (DEMO_SESSION_IDS.has(session.id)) {
      continue;
    }

    if (workspaceById.has(session.workspaceId)) {
      keep(session);
      continue;
    }

    // U13: a chat that was never bound to a project is not an orphan. An empty
    // `workspaceId` is what "unbound" looks like everywhere in this store, and
    // such a chat runs in the scratch directory Main allocated for it — there
    // is no repository for it to have lost, and none for it to move to.
    //
    // `mergeSessionIndex` keeps exactly this row at startup (its `!workspaceId
    // && unbound` arm); this pass had no matching arm, so it fell through to
    // the orphan rule below and DROPPED every temp chat that had already run a
    // turn. That is D6 (dev-box pass 2026-09-17): temp chats vanished from the
    // sidebar the moment anything moved the workspace tree.
    //
    // Decision 174 (issue #6, second wave): an unsent one stays unbound too.
    // U22 adopted it into the first repository the user added, because the
    // start screen's blank chat was the only way to talk before a repository
    // existed; the home page makes the chat at send time, on the target the
    // user picked, so a temporary chat never changes into a repository's. And a
    // machine with no repository at all keeps its temporary chats through a
    // sync, where the old early return dropped every row.
    if (!session.workspaceId) {
      keep(session);
      continue;
    }

    // Orphan: only rebind a true unsent draft. A restored session may not be
    // currently Host-bound yet still carry a persisted runtime identity; moving
    // that identity to another repository would resume one checkout's history
    // against another checkout's cwd.
    if (bound.has(session.id) || session.runtimeIdentity != null || !preferred) {
      continue;
    }

    remapped.push({
      ...session,
      projectId: preferred.projectId,
      workspaceId: preferred.id,
      updatedAt: Date.now(),
    });
  }

  return {
    sessions: remapped,
    hostBoundSessionIds: [...nextBound],
  };
}

/** Store slice the tree sync reads. */
export type TreeSyncPrevState = Pick<
  ChatSessionsState,
  | 'sessions'
  | 'hostBoundSessionIds'
  | 'activeSessionId'
  | 'recentSessionIds'
  | 'messages'
  | 'historyErrors'
  | 'pendingPermissions'
  | 'pendingQuestions'
>;

/** Session-shaped part of the store patch the tree sync writes. */
export type TreeSyncPatch = Pick<
  ChatSessionsState,
  | 'sessions'
  | 'hostBoundSessionIds'
  | 'activeSessionId'
  | 'recentSessionIds'
  | 'messages'
  | 'historyErrors'
  | 'pendingPermissions'
  | 'pendingQuestions'
>;

/**
 * The session half of a tree-sync write, as a pure function so vitest can
 * cover the rules that only exist because of user actions (R5 round-2, A4) —
 * inside the effect body they were unreachable:
 *
 * 1. Rows dismissed in this run are filtered out of the write-back, so a later
 *    tree signature change (a worktree list arriving, a repo added) cannot put
 *    a deliberately closed row back.
 * 2. `activeSessionId` is kept while that conversation still exists, and is
 *    `null` — the home page — otherwise. Decision 174 (issue #6, second wave,
 *    user ruling 2026-10-10): nothing is picked in its place any more. The
 *    start-up chat this pass used to seed (and the "first session of the
 *    preferred workspace" it then selected) is gone; the app opens on the home
 *    page and stays there until the user opens or sends a conversation. The
 *    removal handover in `removeSessionRow` still picks a neighbour when the
 *    open conversation is removed from the list — that write happens before
 *    this pass and is left alone here.
 */
export function resolveTreeSyncPatch(input: {
  prev: TreeSyncPrevState;
  workspaces: ChatWorkspace[];
  preferredWorkspaceId: string | null;
}): TreeSyncPatch {
  const { prev } = input;
  const rebound = rebindSessionsToTree(
    prev.sessions,
    input.workspaces,
    input.preferredWorkspaceId,
    prev.hostBoundSessionIds
  );

  const sessions = dropDismissedSessions(rebound.sessions);
  const exists = (id: string | null): boolean =>
    id != null && sessions.some((session) => session.id === id);

  const activeSessionId = exists(prev.activeSessionId) ? prev.activeSessionId : null;

  const recentSessionIds = [
    ...(activeSessionId ? [activeSessionId] : []),
    ...prev.recentSessionIds,
    ...sessions.map((session) => session.id),
  ]
    .filter((id, index, arr) => arr.indexOf(id) === index && exists(id))
    .slice(0, 20);

  const liveSessionIds = new Set(sessions.map((session) => session.id));
  const messages = Object.fromEntries(
    Object.entries(prev.messages).filter(([sessionId]) => liveSessionIds.has(sessionId))
  );
  const historyErrors = Object.fromEntries(
    Object.entries(prev.historyErrors).filter(([sessionId]) => liveSessionIds.has(sessionId))
  );

  return {
    sessions,
    hostBoundSessionIds: rebound.hostBoundSessionIds,
    activeSessionId,
    recentSessionIds,
    messages,
    historyErrors,
    pendingPermissions: prev.pendingPermissions.filter((item) =>
      liveSessionIds.has(item.sessionId)
    ),
    pendingQuestions: prev.pendingQuestions.filter((item) => liveSessionIds.has(item.sessionId)),
  };
}

/**
 * Ask main whether each directory is a git repository (`folder:checkType` →
 * `isGitRepoRoot`, an `existsSync(<dir>/.git)` probe that answers for a linked
 * worktree's `.git` FILE as well as a normal repo's `.git` directory).
 *
 * This is the second, independent half of `gitEnabled`. `worktree.list` alone
 * cannot distinguish "not a git repository" from "a git repository whose list
 * came back empty" (the E:\C1Algorithm field case) or from "a temp workspace,
 * `git init`-ed at creation but never a member of any registered repo's
 * worktree list" — all three used to render as "Not a Git repository".
 *
 * Keyed by `canonicalPathKey` — the same key the tree derivation already uses
 * for "is this the same directory" (separator + trailing-separator + case
 * normalization), so a repo registered as `D:\Repo\` and a temp item stored as
 * `D:/repo` resolve to one answer instead of silently missing.
 *
 * Returns only settled answers: a path whose query has not resolved is absent
 * from the map, which the derivation reads as "unknown", never as "no".
 */
function useGitRepoByPath(paths: readonly string[]): Record<string, boolean> {
  // Dedupe by canonical key so two spellings of one directory issue one query.
  const uniquePaths = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const path of paths) {
      if (!path || path === TEMP_REPO_ID || path.startsWith('__')) {
        continue;
      }
      const key = canonicalPathKey(path);
      if (!byKey.has(key)) {
        byKey.set(key, path);
      }
    }
    return [...byKey.values()];
  }, [paths]);

  const queries = useQueries({
    queries: uniquePaths.map((path) => ({
      queryKey: gitRepoQueryKey(path),
      queryFn: async (): Promise<boolean> => window.electronAPI.folder.checkType(path),
      // A filesystem probe: no retry storm, but re-checkable — `git init` in a
      // folder that was not a repo when the app started must be picked up on
      // the next invalidation rather than cached for the session. Decision
      // 146: the Git panel re-asks this same key while it shows 「不是 Git
      // 仓库」 (`useGitRepoAppearanceWatch`), so the answer lands here.
      retry: false,
      staleTime: 30_000,
    })),
  });

  return useMemo(() => {
    const map: Record<string, boolean> = {};
    for (let i = 0; i < uniquePaths.length; i++) {
      const data = queries[i]?.data;
      if (typeof data === 'boolean') {
        map[canonicalPathKey(uniquePaths[i])] = data;
      }
    }
    return map;
  }, [queries, uniquePaths]);
}

interface UseSyncChatWorkspaceTreeOptions {
  repositories: Repository[];
  selectedRepoPath: string | null;
  /**
   * Passed in by the caller instead of read from `@/stores/settings` here:
   * `treeSyncPatch.test.ts` imports this module's pure exports, and the
   * settings store's import graph deadlocks the node-env vitest collector
   * (documented trap — keep that store out of this file's imports).
   */
  temporaryWorkspaceEnabled: boolean;
}

/**
 * Keep chatSessions.projects/workspaces aligned with real repos/worktrees/temps.
 */
export function useSyncChatWorkspaceTree({
  repositories,
  selectedRepoPath,
  // Parity with the legacy shells' `{temporaryWorkspaceEnabled && (...)}`
  // gate (RepositorySidebar/TreeSidebar): the Temp group is hidden, not
  // deleted, so re-enabling reveals the same items again.
  temporaryWorkspaceEnabled,
}: UseSyncChatWorkspaceTreeOptions): void {
  const tempItems = useTempWorkspaceStore((state) => state.items);

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

  // Temp workspaces are probed too: they are real (`git init`-ed) repos that
  // no `worktree.list` will ever report, so they can only get `gitEnabled`
  // from this side.
  const gitProbePaths = useMemo(
    () => [...localRepoPaths, ...tempItems.map((item) => item.path)],
    [localRepoPaths, tempItems]
  );
  const gitRepoByPath = useGitRepoByPath(gitProbePaths);

  // M4 (2026-08-07): the sidebar showed no branch chip on a test machine and the
  // round could not say why, because nothing on this path is observable — the
  // legacy shell renders worktree errors as text (TreeSidebar), this shell never
  // read errorsMap at all, and deriveChatWorkspaceTree's `?? []` flattens "query
  // failed" into "no worktrees". Both halves are surfaced here so the next round
  // reports a cause instead of a symptom. console.error rather than warn: the
  // renderer logger pins the default level at 'error', so a warn is discarded.
  //
  // Decision 146 (GW-8): once per distinct content, not once per render.
  // `useWorktreeListMultiple` rebuilds `errorsMap` (and through it the tree's
  // diagnostics) on every render, so these used to print the same failure
  // hundreds of times while a folder stayed non-Git.
  const loggedWorktreeErrorsRef = useRef('');
  useEffect(() => {
    const failures = Object.entries(errorsMap).filter(([, error]) => error);
    const signature = JSON.stringify(failures);
    if (signature === loggedWorktreeErrorsRef.current) return;
    loggedWorktreeErrorsRef.current = signature;
    for (const [repoPath, error] of failures) {
      console.error('[workspace-tree] worktree query failed', { repoPath, error });
    }
  }, [errorsMap]);

  const tree = useMemo(() => {
    const derived = deriveChatWorkspaceTree({
      repositories: effectiveRepos,
      worktreesByRepoPath: worktreesMap,
      tempItems,
      gitRepoByPath,
      temporaryWorkspaceEnabled,
    });
    if (derived.workspaces.length > 0) {
      return derived;
    }

    // Last resort so LeftNav / New / Live session stay usable for T-17.
    const fallbackPath =
      (selectedRepoPath && selectedRepoPath !== TEMP_REPO_ID ? selectedRepoPath : null) ??
      effectiveRepos[0]?.path ??
      null;
    if (!fallbackPath) {
      return derived;
    }
    const name = effectiveRepos[0]?.name ?? fallbackPath.split(/[/\\]/).pop() ?? 'Workspace';
    return { ...seedFallbackWorkspace(fallbackPath, name), diagnostics: derived.diagnostics };
  }, [
    effectiveRepos,
    worktreesMap,
    tempItems,
    gitRepoByPath,
    selectedRepoPath,
    temporaryWorkspaceEnabled,
  ]);

  // `branch-unresolved` is the one that would have closed M4 on the day it was
  // reported: it prints both canonical keys, so "the repo path and git's own
  // path are not the same identity" (mapped drive, junction, or a registered
  // subdirectory) is readable straight from the console instead of inferred.
  // Same once-per-content rule as the worktree failures above (decision 146).
  const loggedDiagnosticsRef = useRef('');
  useEffect(() => {
    const signature = JSON.stringify(tree.diagnostics);
    if (signature === loggedDiagnosticsRef.current) return;
    loggedDiagnosticsRef.current = signature;
    for (const d of tree.diagnostics) {
      console.error('[workspace-tree]', d.kind, d);
    }
  }, [tree.diagnostics]);

  const preferredWorkspaceId = useMemo(
    () => resolvePreferredWorkspaceId(tree.workspaces, { selectedRepoPath }),
    [tree.workspaces, selectedRepoPath]
  );

  const signatureRef = useRef<string>('');

  // A layout effect (decision 174): the first write drops the store's DEMO row
  // and leaves no conversation open, and it has to land before the first paint
  // — after it the column shows the home page, before it the DEMO row's blank
  // start screen, which would flash for a frame on every launch.
  useLayoutEffect(() => {
    const signature = workspaceTreeSignature(tree.projects, tree.workspaces, preferredWorkspaceId);
    if (signature === signatureRef.current) {
      return;
    }
    signatureRef.current = signature;

    const prev = useChatSessionsStore.getState();
    const sessionPatch = resolveTreeSyncPatch({
      prev,
      workspaces: tree.workspaces,
      preferredWorkspaceId,
    });
    const liveSessionIds = new Set(sessionPatch.sessions.map((session) => session.id));
    markSessionsRetired(
      prev.sessions
        .filter((session) => !liveSessionIds.has(session.id))
        .map((session) => session.id)
    );
    markSessionsLive([...liveSessionIds]);

    // A repository removal can retire a bound session without going through
    // the row-level Close/Archive actions. Reap those runtimes best-effort so
    // an empty nav never leaves an unreachable agent running in the Host.
    for (const sessionId of prev.hostBoundSessionIds) {
      if (!liveSessionIds.has(sessionId)) {
        try {
          void Promise.resolve(window.electronAPI.chat.closeSession({ sessionId })).catch(() => {});
        } catch {
          // Host/channel already unavailable — the renderer state still clears.
        }
      }
    }

    // Empty is a real tree state, not a hydration no-op. `storedRepos` above
    // already protects the pre-hydration frame when localStorage has repos;
    // once both props and storage are empty we must clear the last non-empty
    // snapshot immediately (T27-a).
    useChatSessionsStore.setState({
      projects: tree.projects,
      workspaces: tree.workspaces,
      ...sessionPatch,
    });
  }, [tree.projects, tree.workspaces, preferredWorkspaceId]);
}
