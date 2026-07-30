/**
 * T-27: pure decision/derivation functions for the Composer target bar (D22).
 *
 * Only type imports plus the pure `normalizePath` helper are allowed here —
 * no components, hooks, or `window`. Store writes live in
 * `stores/chatSessionActions.ts`; this module only decides what should
 * happen and derives read-only view data.
 */

import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { normalizePath } from '@shared/utils/path';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';

// ---- Three-tier rule ----

export type TargetChangeOutcome = 'retarget' | 'fork' | 'blocked';

export interface TargetChangeInput {
  /** `undefined` is treated as `'idle'` (default when the session does not exist). */
  status: SessionRuntimeStatus | undefined;
  messageCount: number;
  /** Ever host-bound: includes sessions carrying a persisted runtimeIdentity. */
  hostBound: boolean;
  /** A send is in flight but `status` has not flipped yet (ChatComposer's `sending`). */
  sending?: boolean;
}

const BLOCKING_STATUSES: ReadonlySet<SessionRuntimeStatus> = new Set([
  'starting',
  'running',
  'stopping',
  'waiting_permission',
  'waiting_question',
]);

/**
 * Decide whether changing the Composer target should retarget the active
 * session in place, fork a new session onto the target, or be blocked.
 */
export function decideTargetChange(input: TargetChangeInput): TargetChangeOutcome {
  if (input.sending === true) {
    return 'blocked';
  }
  const status = input.status ?? 'idle';
  if (BLOCKING_STATUSES.has(status)) {
    return 'blocked';
  }
  if (input.messageCount === 0 && input.hostBound === false) {
    return 'retarget';
  }
  return 'fork';
}

// ---- Plan (the only entry point the UI calls) ----

export type TargetChangePlan =
  | { kind: 'noop'; reason: 'same-workspace' | 'unknown-workspace' }
  | { kind: 'blocked' }
  | { kind: 'retarget'; sessionId: string; workspaceId: string; projectId: string }
  | { kind: 'fork'; workspaceId: string; title: string };

export interface PlanTargetChangeInput {
  nextWorkspaceId: string;
  activeSession: Pick<ChatSession, 'id' | 'workspaceId' | 'status'> | undefined;
  workspaces: readonly ChatWorkspace[];
  messageCount: number;
  hostBound: boolean;
  sending?: boolean;
  /** Defaults to `'New chat'` (same default as `createChatSessionOnWorkspace`). */
  forkTitle?: string;
}

/**
 * Turn a user's target selection into one of noop / blocked / retarget /
 * fork. Guard order matters and mirrors the design doc exactly:
 * unknown target -> same workspace -> blocked -> no active session (fork) ->
 * decided outcome (retarget or fork).
 */
export function planTargetChange(input: PlanTargetChangeInput): TargetChangePlan {
  const workspace = input.workspaces.find((ws) => ws.id === input.nextWorkspaceId);
  if (!workspace || !isTargetableWorkspace(workspace)) {
    return { kind: 'noop', reason: 'unknown-workspace' };
  }

  if (input.activeSession && input.activeSession.workspaceId === input.nextWorkspaceId) {
    return { kind: 'noop', reason: 'same-workspace' };
  }

  const outcome = decideTargetChange({
    status: input.activeSession?.status,
    messageCount: input.messageCount,
    hostBound: input.hostBound,
    sending: input.sending,
  });

  if (outcome === 'blocked') {
    return { kind: 'blocked' };
  }

  if (input.activeSession === undefined) {
    return {
      kind: 'fork',
      workspaceId: input.nextWorkspaceId,
      title: input.forkTitle ?? 'New chat',
    };
  }

  if (outcome === 'retarget') {
    return {
      kind: 'retarget',
      sessionId: input.activeSession.id,
      workspaceId: input.nextWorkspaceId,
      projectId: workspace.projectId,
    };
  }

  return { kind: 'fork', workspaceId: input.nextWorkspaceId, title: input.forkTitle ?? 'New chat' };
}

// ---- Active target derivation (shared by ChatComposer and the target bar) ----

export interface ActiveTarget {
  session: ChatSession | undefined;
  workspace: ChatWorkspace | undefined;
  project: ChatProject | undefined;
  /** cwd to hand to createSession; missing or empty paths are always `null`. */
  cwd: string | null;
}

export function resolveActiveTarget(input: {
  activeSessionId: string | null;
  sessions: readonly ChatSession[];
  workspaces: readonly ChatWorkspace[];
  projects?: readonly ChatProject[];
}): ActiveTarget {
  const session = input.activeSessionId
    ? input.sessions.find((item) => item.id === input.activeSessionId)
    : undefined;
  const workspace = session
    ? input.workspaces.find((ws) => ws.id === session.workspaceId)
    : undefined;
  const project =
    workspace && input.projects
      ? input.projects.find((item) => item.id === workspace.projectId)
      : undefined;
  const cwd = workspace && isTargetableWorkspace(workspace) ? workspace.path : null;

  return { session, workspace, project, cwd };
}

/** `= resolveActiveTarget(...).cwd`, a narrow interface for flow assertions. */
export function resolveSendCwd(input: {
  activeSessionId: string | null;
  sessions: readonly ChatSession[];
  workspaces: readonly ChatWorkspace[];
}): string | null {
  return resolveActiveTarget(input).cwd;
}

// ---- Target availability and labels ----

export function isTargetableWorkspace(ws: ChatWorkspace | undefined): boolean {
  return !!ws && ws.path.trim() !== '';
}

export function shouldShowBranchSelect(ws: ChatWorkspace | undefined): boolean {
  // T-27 fix: gitEnabled must be exactly `true` — undefined (unknown/loading)
  // and false (worktree.list failed or is still empty) both hide the branch
  // dropdown, since the dropdown's data source (buildBranchMenu) would have
  // nothing real to show yet.
  return !!ws && (ws.kind === 'main' || ws.kind === 'worktree') && ws.gitEnabled === true;
}

export function targetWorktreeLabel(ws: ChatWorkspace | undefined): string | null {
  return ws ? (ws.branch ?? ws.name) : null;
}

/**
 * Default workspace for a project when the target bar needs one without a
 * specific worktree pick. Same rule as workspace-shell/sidebarTree.ts's
 * `resolveNewSessionWorkspaceId`, intentionally duplicated across the chat /
 * workspace-shell architecture boundary (T-27 decision #9).
 */
export function resolveProjectDefaultWorkspaceId(
  projectId: string,
  workspaces: readonly ChatWorkspace[]
): string | null {
  const usable = workspaces.filter((ws) => ws.projectId === projectId && isTargetableWorkspace(ws));
  const main = usable.find((ws) => ws.kind === 'main');
  return main?.id ?? usable[0]?.id ?? null;
}

/**
 * Run location is a repository property, not a worktree property: resolve
 * the project's main/remote workspace path, falling back to the given
 * workspace's own path when the project has no root workspace.
 */
export function resolveRuntimeRepoPath(
  activeWorkspaceId: string | null,
  workspaces: readonly ChatWorkspace[]
): string | null {
  if (!activeWorkspaceId) {
    return null;
  }
  const active = workspaces.find((ws) => ws.id === activeWorkspaceId);
  if (!active) {
    return null;
  }
  const root = workspaces.find(
    (ws) => ws.projectId === active.projectId && (ws.kind === 'main' || ws.kind === 'remote')
  );
  const candidate = root ?? active;
  return isTargetableWorkspace(candidate) ? candidate.path : null;
}

export function matchWorkspaceByPath(
  path: string,
  workspaces: readonly ChatWorkspace[]
): ChatWorkspace | undefined {
  const normalized = normalizePath(path).toLowerCase();
  return workspaces.find((ws) => normalizePath(ws.path).toLowerCase() === normalized);
}

// ---- Dropdown data assembly ----

export interface FolderMenuEntry {
  workspaceId: string; // selecting it becomes the target
  projectId: string;
  label: string; // project.name
  secondary?: string; // Recents row only: targetWorktreeLabel(ws) ?? undefined
  current: boolean; // workspaceId === activeWorkspaceId
}

export interface FolderMenuModel {
  recents: FolderMenuEntry[]; // <= limit (default 5)
  local: FolderMenuEntry[];
  remote: FolderMenuEntry[];
}

/**
 * Recents depends on `sessions`, which is only populated once LeftNav mounts
 * `useSessionIndex()` and folds session-index.json into the store. If LeftNav
 * is ever lazy-loaded or removed, Recents silently degrades to this-run-only
 * sessions.
 */
export function buildFolderMenu(input: {
  projects: readonly ChatProject[];
  workspaces: readonly ChatWorkspace[];
  sessions: readonly ChatSession[];
  activeWorkspaceId: string | null;
  recentsLimit?: number;
}): FolderMenuModel {
  const recentsLimit = input.recentsLimit ?? 5;
  const workspaceById = new Map(input.workspaces.map((ws) => [ws.id, ws] as const));
  const projectById = new Map(input.projects.map((project) => [project.id, project] as const));

  const sortedSessions = [...input.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const recents: FolderMenuEntry[] = [];
  const seenWorkspaceIds = new Set<string>();
  for (const session of sortedSessions) {
    if (recents.length >= recentsLimit) {
      break;
    }
    const ws = workspaceById.get(session.workspaceId);
    if (!ws || !isTargetableWorkspace(ws) || seenWorkspaceIds.has(ws.id)) {
      continue;
    }
    seenWorkspaceIds.add(ws.id);
    recents.push({
      workspaceId: ws.id,
      projectId: ws.projectId,
      label: projectById.get(ws.projectId)?.name ?? '',
      secondary: targetWorktreeLabel(ws) ?? undefined,
      current: ws.id === input.activeWorkspaceId,
    });
  }

  // Repos section intentionally does not exclude entries already shown in
  // Recents (Cursor-style); deduping would make the fixed positions drift.
  const local: FolderMenuEntry[] = [];
  const remote: FolderMenuEntry[] = [];
  for (const project of input.projects) {
    const defaultId = resolveProjectDefaultWorkspaceId(project.id, input.workspaces);
    if (!defaultId) {
      continue;
    }
    const ws = workspaceById.get(defaultId);
    if (!ws) {
      continue;
    }
    const entry: FolderMenuEntry = {
      workspaceId: ws.id,
      projectId: project.id,
      label: project.name,
      current: ws.id === input.activeWorkspaceId,
    };
    if (ws.kind === 'remote') {
      remote.push(entry);
    } else {
      local.push(entry);
    }
  }

  return { recents, local, remote };
}

export interface BranchMenuEntry {
  workspaceId: string;
  label: string; // targetWorktreeLabel
  path: string; // right-hand secondary text
  kind: ChatWorkspace['kind'];
  current: boolean;
}

export interface BranchMenuModel {
  main: BranchMenuEntry | null;
  recent: BranchMenuEntry[]; // <= limit (default 3), excludes main
  others: BranchMenuEntry[]; // the rest, excludes main / recent
  total: number;
}

export function buildBranchMenu(input: {
  projectId: string | null;
  workspaces: readonly ChatWorkspace[];
  sessions: readonly ChatSession[];
  activeWorkspaceId: string | null;
  recentLimit?: number;
}): BranchMenuModel {
  if (input.projectId === null) {
    return { main: null, recent: [], others: [], total: 0 };
  }

  const recentLimit = input.recentLimit ?? 3;
  const candidates = input.workspaces.filter(
    (ws) =>
      ws.projectId === input.projectId &&
      (ws.kind === 'main' || ws.kind === 'worktree') &&
      isTargetableWorkspace(ws)
  );

  const toEntry = (ws: ChatWorkspace): BranchMenuEntry => ({
    workspaceId: ws.id,
    label: targetWorktreeLabel(ws) ?? ws.name,
    path: ws.path,
    kind: ws.kind,
    current: ws.id === input.activeWorkspaceId,
  });

  const mainWs = candidates.find((ws) => ws.kind === 'main');
  const main = mainWs ? toEntry(mainWs) : null;
  const nonMainCandidates = candidates.filter((ws) => ws.id !== mainWs?.id);

  const lastUpdatedByWorkspace = new Map<string, number>();
  for (const session of input.sessions) {
    const current = lastUpdatedByWorkspace.get(session.workspaceId);
    if (current === undefined || session.updatedAt > current) {
      lastUpdatedByWorkspace.set(session.workspaceId, session.updatedAt);
    }
  }

  const recentWorkspaces = nonMainCandidates
    .filter((ws) => lastUpdatedByWorkspace.has(ws.id))
    .sort((a, b) => lastUpdatedByWorkspace.get(b.id)! - lastUpdatedByWorkspace.get(a.id)!)
    .slice(0, recentLimit);
  const recentIds = new Set(recentWorkspaces.map((ws) => ws.id));

  const others = nonMainCandidates
    .filter((ws) => !recentIds.has(ws.id))
    .map(toEntry)
    .sort((a, b) => a.label.localeCompare(b.label));

  const recent = recentWorkspaces.map(toEntry);

  return {
    main,
    recent,
    others,
    total: (main ? 1 : 0) + recent.length + others.length,
  };
}

// ---- Run location text ----

export function runLocationLabel(input: {
  context: { kind: 'local' | 'remote'; connectionId?: string } | undefined;
  profiles?: readonly { id: string; name: string }[];
  repoPath: string | null;
}): { text: string; tone: 'local' | 'remote' } | null {
  if (!input.repoPath || input.repoPath.trim() === '') {
    return null;
  }
  if (!input.context) {
    return null;
  }
  if (input.context.kind === 'local') {
    return { text: 'This PC', tone: 'local' };
  }
  // T-27 fix: a remote run location hides entirely (returns null) unless a
  // connection name is actually resolvable — no more generic "Remote"
  // fallback (spec §2.1's "shows Remote" sentence is void). Covers a missing
  // connectionId, profiles that are still loading / failed to load
  // (undefined or empty), and a connectionId with no matching profile.
  if (!input.context.connectionId) {
    return null;
  }
  const profile = input.profiles?.find((item) => item.id === input.context?.connectionId);
  if (!profile?.name) {
    return null;
  }
  return { text: profile.name, tone: 'remote' };
}
