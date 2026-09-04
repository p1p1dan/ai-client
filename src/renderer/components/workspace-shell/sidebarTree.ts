/**
 * T-26 (D21): pure derivations for the two-level sidebar — folder → session.
 *
 * Workspace is no longer a tree level: sessions from every worktree of a
 * project merge under one folder node, and each session row carries a branch
 * chip derived from its workspace instead. Selection of "where to run" is the
 * Composer target bar's job (T-27); nothing here is selectable or expandable
 * per workspace.
 *
 * Pure so vitest (node env, `.ts` only) can cover it — same pattern as
 * `addRepositoryEntry.ts` / `hostStatus.ts`.
 */

import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { isUsableWorkspace } from './addRepositoryEntry';

/** Recent keeps a session visible while active or touched within 48h (openchamber rule). */
export const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Recent shows 7 rows by default, the rest behind "Show more" (openchamber rule). */
export const RECENT_DEFAULT_LIMIT = 7;

export interface SidebarChip {
  /**
   * 'branch' renders the actual git branch; 'kind' renders the workspace kind
   * (temp/remote).
   */
  variant: 'branch' | 'kind';
  label: string;
}

export interface SidebarSessionRow {
  sessionId: string;
  workspaceId: string;
  title: string;
  /** null when the branch is unknown (detached HEAD / list still loading) — never guess. */
  chip: SidebarChip | null;
  updatedAt: number;
  /** Drives the 6px `--status-running` dot (A07 `.sb-row .live`). */
  busy: boolean;
  /** Failure stays visible after the per-row status badge was dropped. */
  failed: boolean;
  status: SessionRuntimeStatus;
}

export interface SidebarFolder {
  projectId: string;
  name: string;
  /** Flat, updatedAt desc — no workspace grouping (D21-A: flat + chip). */
  rows: SidebarSessionRow[];
  /** Target for the "+ new chat" row; null hides the row (no usable workspace). */
  newSessionWorkspaceId: string | null;
}

export interface SidebarTreeInput {
  projects: readonly ChatProject[];
  workspaces: readonly ChatWorkspace[];
  sessions: readonly ChatSession[];
  /** Search text — matches session titles only, never folder or branch names. */
  query?: string;
}

const BUSY_STATUSES: ReadonlySet<SessionRuntimeStatus> = new Set([
  'starting',
  'running',
  'stopping',
  'waiting_permission',
  'waiting_question',
]);

export function isBusySessionStatus(status: SessionRuntimeStatus): boolean {
  return BUSY_STATUSES.has(status);
}

/**
 * Chip for a session row (D21-A, user ruling 2026-07-29): every row shows its
 * actual branch — main/master included — while temp/remote workspaces show
 * their kind label. Branch unknown → no chip; a display name like "Main" is
 * not a branch and must not be shown as one.
 */
export function chipForWorkspace(workspace: ChatWorkspace | undefined): SidebarChip | null {
  // U05-b ③: the session-list half of the temporary-chat marker. A missing
  // workspace, or one carrying no path (the seeded placeholder a fresh install
  // starts on), both mean the same thing now that unbound chats can run: this
  // chat has no folder and works in a private throwaway directory instead.
  // Before U05 that state simply could not send, so it needed no label.
  if (!workspace || !isUsableWorkspace(workspace)) {
    return { variant: 'kind', label: 'temporary' };
  }
  if (workspace.kind === 'temp' || workspace.kind === 'remote') {
    return { variant: 'kind', label: workspace.kind };
  }
  return workspace.branch ? { variant: 'branch', label: workspace.branch } : null;
}

function normalizeQuery(query: string | undefined): string {
  return query?.trim().toLowerCase() ?? '';
}

function matchesQuery(session: ChatSession, normalized: string): boolean {
  return normalized.length === 0 || session.title.toLowerCase().includes(normalized);
}

function toRow(session: ChatSession, workspace: ChatWorkspace | undefined): SidebarSessionRow {
  return {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    title: session.title,
    chip: chipForWorkspace(workspace),
    updatedAt: session.updatedAt,
    busy: isBusySessionStatus(session.status),
    failed: session.status === 'failed',
    status: session.status,
  };
}

function byUpdatedAtDesc(a: SidebarSessionRow, b: SidebarSessionRow): number {
  return b.updatedAt - a.updatedAt;
}

/**
 * Default workspace for creating a session from the sidebar's own entry
 * points: the project's main workspace when usable, else its first usable
 * workspace. Empty-path seeds are never a target. Retargeting an existing
 * chat to a different workspace is the Composer target bar's job (T-27).
 *
 * Same rule as composerTarget.ts's `resolveProjectDefaultWorkspaceId`,
 * intentionally duplicated across the chat / workspace-shell boundary.
 */
export function resolveNewSessionWorkspaceId(
  projectId: string,
  workspaces: readonly ChatWorkspace[]
): string | null {
  const usable = workspaces.filter((ws) => ws.projectId === projectId && isUsableWorkspace(ws));
  const main = usable.find((ws) => ws.kind === 'main');
  return main?.id ?? usable[0]?.id ?? null;
}

/**
 * Folder → session rows, two levels only.
 *
 * Invariants (T-26 acceptance ⑤):
 * - Sessions of every worktree of one project land in the same folder node.
 * - Orphan sessions (workspace unknown, or workspace pointing at a project
 *   that does not exist) are dropped — no crash, no fabricated folder.
 * - The query prunes session rows by title only; folders always render, so
 *   an empty folder stays reachable for "+ new chat".
 */
export function buildSidebarFolders(input: SidebarTreeInput): SidebarFolder[] {
  const normalized = normalizeQuery(input.query);
  const workspaceById = new Map(input.workspaces.map((ws) => [ws.id, ws] as const));
  const rowsByProject = new Map<string, SidebarSessionRow[]>();

  for (const session of input.sessions) {
    const workspace = workspaceById.get(session.workspaceId);
    if (!workspace || !matchesQuery(session, normalized)) {
      continue;
    }
    // The workspace is authoritative for grouping: a stale session.projectId
    // must not spawn a phantom folder after a rebind.
    const bucket = rowsByProject.get(workspace.projectId);
    const row = toRow(session, workspace);
    if (bucket) {
      bucket.push(row);
    } else {
      rowsByProject.set(workspace.projectId, [row]);
    }
  }

  return input.projects.map((project) => ({
    projectId: project.id,
    name: project.name,
    rows: (rowsByProject.get(project.id) ?? []).sort(byUpdatedAtDesc),
    newSessionWorkspaceId: resolveNewSessionWorkspaceId(project.id, input.workspaces),
  }));
}

/**
 * F3 (D29 adversarial-review, minor): the ACTIVE session's project, resolved
 * through its workspace — same authority `buildSidebarFolders` groups by, so a
 * stale `session.projectId` cannot misjudge "same folder" after a rebind.
 * `null` when nothing is active or the active session is an orphan.
 *
 * Extracted because LeftNav previously ran this same
 * activeSessionId → sessions → workspaceId → workspaces → projectId chain
 * inline as a render-body snapshot — the fourth inline copy of the chain in
 * this file — and the folder-click handler needs a FRESH read at click time
 * (`resolveActiveProjectId(useChatSessionsStore.getState())`), not the
 * snapshot captured when the render that scheduled the click started.
 *
 * Input shape mirrors the store's own field names so a caller can pass
 * `useChatSessionsStore.getState()` straight through without reshaping it.
 */
export function resolveActiveProjectId(input: {
  activeSessionId: string | null;
  sessions: readonly Pick<ChatSession, 'id' | 'workspaceId'>[];
  workspaces: readonly Pick<ChatWorkspace, 'id' | 'projectId'>[];
}): string | null {
  const session = input.sessions.find((item) => item.id === input.activeSessionId);
  const workspace = input.workspaces.find((ws) => ws.id === session?.workspaceId);
  return workspace?.projectId ?? null;
}

export interface NewSessionTarget {
  workspaceId: string | null;
  /** Folder name for the resolved target — drives the header "New" button's
   * dynamic title (D1, round-5): T-26 removed folder selection state, so the
   * title is the only surface left that makes the implicit target discoverable. */
  folderName: string | null;
}

/**
 * Resolves which workspace the sidebar's own "New" affordances (header
 * button) should target, and which folder that resolves to.
 *
 * Resolution order (round-5 D1 ruling): the folder the user last focused
 * (header click or a session pick inside it) → the active session's
 * workspace (pre-existing fallback) → the first usable workspace that belongs
 * to a folder actually on screen (pre-existing fallback, tightened below).
 *
 * `folders` must be freshly derived (e.g. from `buildSidebarFolders`) on
 * every call, never cached alongside a stored `focusedProjectId` — if the
 * focused project was since deleted it simply won't be found here and
 * resolution falls through to the next tier on its own (self-healing).
 *
 * R5 round-2 (B1) tightened two things:
 *
 * - A focused folder that resolves to no usable workspace now returns a null
 *   target (disabled button) instead of falling through. Falling through would
 *   create the chat in a *different* folder than the one the button's title
 *   names — a silent redirect, which is exactly what D1 set out to remove.
 * - Every fallback target is verified alive: the workspace must still exist,
 *   be usable (non-empty path), and its project must still have a folder row.
 *   A stale `activeSession.workspaceId` (workspace deleted, or its project
 *   removed) otherwise resolved to a target that renders nowhere.
 */
export function resolveNewSessionTarget(input: {
  focusedProjectId: string | null;
  folders: readonly SidebarFolder[];
  activeSession: Pick<ChatSession, 'workspaceId'> | undefined;
  workspaces: readonly ChatWorkspace[];
}): NewSessionTarget {
  const focusedFolder = input.folders.find((folder) => folder.projectId === input.focusedProjectId);
  if (focusedFolder) {
    // Null `newSessionWorkspaceId` is a deliberate disabled state, not a miss.
    return { workspaceId: focusedFolder.newSessionWorkspaceId, folderName: focusedFolder.name };
  }

  const folderByProject = new Map(
    input.folders.map((folder) => [folder.projectId, folder] as const)
  );
  const isReachable = (ws: ChatWorkspace): boolean =>
    isUsableWorkspace(ws) && folderByProject.has(ws.projectId);

  const active = input.activeSession
    ? input.workspaces.find((ws) => ws.id === input.activeSession?.workspaceId)
    : undefined;
  const target = active && isReachable(active) ? active : input.workspaces.find(isReachable);
  if (!target) {
    return { workspaceId: null, folderName: null };
  }
  return {
    workspaceId: target.id,
    folderName: folderByProject.get(target.projectId)?.name ?? null,
  };
}

/**
 * Result of a repository-folder header click: whether to activate a session
 * and what the folder's expansion state should become afterward. A single
 * return value so the two effects can never be applied from two different
 * reads of "did this click cross projects" (F1 adversarial-review fix).
 */
export interface FolderClickActivation {
  /** `null` means "leave the active session alone". */
  activateSessionId: string | null;
  /** What `expandedProjects[folder.projectId]` should become after this click. */
  nextExpanded: boolean;
}

/**
 * D29 (open-q #28, ruling A): which session a repository-folder click should
 * activate, and what the folder's expansion should become.
 *
 * Why this exists: the right-hand git panel, the file tree and the session cwd
 * all follow the ACTIVE session's workspace. A folder header click only moved
 * `focusedProjectId` (where the next "New" lands) and toggled expansion, so
 * clicking a repository produced no visible change anywhere — the field
 * complaint "the git panel does not follow the sidebar". Activating the
 * folder's most recent session gives the click a visible consequence.
 *
 * Rules, exactly as ruled:
 * - Only a click that crosses into a DIFFERENT project activates anything.
 *   Clicking inside the already-active project is the collapse/expand gesture
 *   and must not be hijacked.
 * - An empty folder activates nothing and never auto-creates: the same click
 *   already pointed `focusedProjectId` at this folder, so "New" is one further
 *   click away.
 * - Temp is an ordinary project here — no special case.
 *
 * Expansion (F1 adversarial-review fix): a plain unconditional toggle in the
 * caller collapsed the very folder a cross-repo click just activated whenever
 * it happened to already be expanded — the just-activated session row vanished
 * off-screen instead of coming into view. So expansion is decided HERE,
 * together with activation, instead of the caller toggling blindly first:
 * - Activation succeeds (cross-project click, non-empty folder): `nextExpanded`
 *   is always `true` — the folder must be open for the newly-activated row to
 *   be visible, regardless of its state before the click.
 * - Activation is a no-op (same-project click, or an empty folder): the plain
 *   collapse/expand gesture applies, `nextExpanded = !currentExpanded`.
 *
 * PRECONDITION (F5 adversarial-review fix): `folder.rows` must already be
 * sorted by `updatedAt` descending — exactly what `buildSidebarFolders`
 * hands every caller. Under that precondition the most-recent row is always
 * `rows[0]`, so this no longer scans for a max; a tie is whatever `rows[0]`
 * is, which is also the topmost row on screen.
 */
export function resolveFolderClickActivation(input: {
  folder: {
    projectId: string;
    /** Same rows the folder renders — already query-filtered and sorted
     * `updatedAt` desc, so a click while searching activates a session the
     * user can actually see, and `rows[0]` is always the most recent one. */
    rows: readonly Pick<SidebarSessionRow, 'sessionId'>[];
  };
  /**
   * Project of the ACTIVE session's workspace — the workspace is authoritative
   * for grouping (same rule as `buildSidebarFolders`), so a stale
   * `session.projectId` cannot misjudge "same folder" after a rebind. `null`
   * when nothing is active or the active session is an orphan, which counts as
   * a different project and therefore activates.
   */
  activeProjectId: string | null;
  /** This folder's expansion state BEFORE the click. */
  currentExpanded: boolean;
}): FolderClickActivation {
  if (input.folder.projectId === input.activeProjectId) {
    return { activateSessionId: null, nextExpanded: !input.currentExpanded };
  }
  const newestSessionId = input.folder.rows[0]?.sessionId ?? null;
  if (!newestSessionId) {
    return { activateSessionId: null, nextExpanded: !input.currentExpanded };
  }
  return { activateSessionId: newestSessionId, nextExpanded: true };
}

export interface RecentRowsInput {
  sessions: readonly ChatSession[];
  workspaces: readonly ChatWorkspace[];
  /** Injected clock so tests and callers share one `Date.now()` per render. */
  now: number;
  /** True once the user pressed "Show more" — lifts the 7-row cap. */
  showAll?: boolean;
  query?: string;
}

export interface RecentRowsResult {
  rows: SidebarSessionRow[];
  /** Rows hidden behind "Show more" (0 when showAll or under the cap). */
  hiddenCount: number;
}

/**
 * Cross-folder Recent section, openchamber rule: busy OR touched within 48h,
 * newest first, 7 rows + "Show more". Archived sessions never reach the store
 * (mergeSessionIndex drops them) and child sessions do not exist in this data
 * model yet (subagent layer deferred, open-q #17), so neither is re-filtered
 * here. Orphan sessions are excluded like in the folder tree.
 */
export function deriveRecentRows(input: RecentRowsInput): RecentRowsResult {
  const normalized = normalizeQuery(input.query);
  const workspaceById = new Map(input.workspaces.map((ws) => [ws.id, ws] as const));

  const rows = input.sessions
    .filter((session) => {
      if (!workspaceById.has(session.workspaceId) || !matchesQuery(session, normalized)) {
        return false;
      }
      return (
        isBusySessionStatus(session.status) || input.now - session.updatedAt <= RECENT_WINDOW_MS
      );
    })
    .map((session) => toRow(session, workspaceById.get(session.workspaceId)))
    .sort(byUpdatedAtDesc);

  if (input.showAll || rows.length <= RECENT_DEFAULT_LIMIT) {
    return { rows, hiddenCount: 0 };
  }
  return {
    rows: rows.slice(0, RECENT_DEFAULT_LIMIT),
    hiddenCount: rows.length - RECENT_DEFAULT_LIMIT,
  };
}

/**
 * The sidebar's right-hand age column. The implementation moved to
 * `@/lib/relativeTime` when T-31 (P-18) gave the chat turn footer a relative
 * timestamp too: chat cannot import from `components/workspace-shell`, so the
 * shared bucket table had to sit below both. Re-exported here so this module
 * stays the sidebar's single import surface.
 */
export { formatRelativeAge } from '@/lib/relativeTime';
