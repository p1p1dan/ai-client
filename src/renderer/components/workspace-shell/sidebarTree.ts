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
  /** 'branch' renders the actual git branch; 'kind' renders the workspace kind (temp/remote). */
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
  if (!workspace) {
    return null;
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
