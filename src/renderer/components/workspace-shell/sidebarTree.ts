/**
 * T-26 (D21): pure derivations for the two-level sidebar — folder → session.
 *
 * Workspace is no longer a tree level: sessions from every worktree of a
 * project merge under one folder node. Decision 167 (GitHub issue #3) moved
 * the branch off the rows: the folder row names its main workspace's branch
 * once (`folderPrimaryChip`), and only a chat on another workspace (a linked
 * worktree) shows its own (`chipShownInFolder`). Selection of "where to run"
 * is the Composer target bar's job (T-27); nothing here is selectable or
 * expandable per workspace.
 *
 * Pure so vitest (node env, `.ts` only) can cover it — same pattern as
 * `addRepositoryEntry.ts` / `hostStatus.ts`.
 */

import { englishTranslate, type Locale, type Translate, translate } from '@shared/i18n';
import { PI_AGENT, sessionAgent } from '@shared/types/agentWire';
import { LEGACY_FORK_TITLE_KEY } from '@shared/types/legacyMigration';
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { displaySessionTitle } from '@/components/chat/sessionIndex/sessionTitle';
import { formatAbsoluteDateTime } from '@/lib/relativeTime';
import type { ChatProject, ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { isUsableWorkspace } from './addRepositoryEntry';
import { TEMP_PROJECT_ID } from './deriveChatWorkspaceTree';

/**
 * dsh-rebase P1-9e: what the `1.0.x` mark on a diverged legacy row means
 * (`SidebarSessionRow.legacyDiverged`); a dictionary key, shown as its tooltip.
 */
export const LEGACY_DIVERGED_HINT =
  'This chat was continued in version 1.0.x after it moved to the current engine. Continuing it here moves that newer copy over as a chat of its own.';

/**
 * Decision 137 §4: each folder lists this many rows until "View more" is
 * pressed. Search lifts it (`limitFolderRows`).
 */
export const FOLDER_DEFAULT_LIMIT = 8;

/**
 * Decision 170 (issue #6 ruling 2): the "Active now" region lists this many
 * rows until "View more" is pressed. Search lifts it (`limitActiveRows`).
 */
export const ACTIVE_DEFAULT_LIMIT = 5;

/**
 * The git branch of the workspace a chat runs in. Decision 167 retired the
 * `kind` chips (「临时」「远程」 on every row, decision 144 §2–3): a temporary
 * chat is told by its own section (`SidebarSessionRow.unbound`), a remote
 * repository by its folder row.
 */
export interface SidebarChip {
  variant: 'branch';
  label: string;
}

/**
 * Decision 144: a row as the sidebar paints it — its placeholder title
 * (`displaySessionTitle`) in the UI language. Derivation keeps the identifier
 * (ordering and search read it); only the row component asks for this. The
 * same row comes back when there is nothing to word.
 */
export function sidebarRowForDisplay(
  row: SidebarSessionRow,
  t: Translate = englishTranslate
): SidebarSessionRow {
  const title = displaySessionTitle(row.title, t);
  return title === row.title ? row : { ...row, title };
}

/**
 * Decision 167 §5: the synthetic Temp project keeps the identifier `Temp` as
 * its name (`deriveChatWorkspaceTree`); the sidebar words it here, at display
 * time, the way decision 144 §3 words a placeholder title. Every other folder
 * is a repository and shows its own name.
 */
export function sidebarFolderNameForDisplay(
  projectId: string,
  name: string,
  t: Translate = englishTranslate
): string {
  return projectId === TEMP_PROJECT_ID ? t('Temporary workspaces') : name;
}

export interface SidebarSessionRow {
  sessionId: string;
  workspaceId: string;
  title: string;
  /**
   * The branch of the chat's workspace (main or linked worktree). null when
   * the branch is unknown (detached HEAD / list still loading) — never guess —
   * and for temp, remote and unbound workspaces, which have none. Whether a
   * row SHOWS it is `chipShownInFolder`'s call.
   */
  chip: SidebarChip | null;
  /**
   * U05-b ③: the chat has no folder and works in a private throwaway
   * directory — no workspace, or the empty-path placeholder a fresh install
   * starts on. Present only when true. Decision 167 moved this fact off the
   * row's chip (「临时」) and into its tooltip and section.
   */
  unbound?: true;
  updatedAt: number;
  /** Drives the 6px `--status-running` dot (A07 `.sb-row .live`). */
  busy: boolean;
  /** Failure stays visible after the per-row status badge was dropped. */
  failed: boolean;
  status: SessionRuntimeStatus;
  /**
   * dsh-rebase P1-9e (decision 051): the legacy copy of a migrated chat, with
   * content 1.0.x added after the migration. Present only when true, and only
   * while the row is still that legacy copy: continuing it moves it over, and
   * `session.resumed` rebinding it to DSH clears the mark before any refresh.
   */
  legacyDiverged?: true;
}

export interface SidebarFolder {
  projectId: string;
  name: string;
  /**
   * Flat, updatedAt desc — no workspace grouping (D21-A). Decision 167 shows a
   * row's branch only off the folder's main workspace (`chipShownInFolder`).
   */
  rows: SidebarSessionRow[];
  /** Target for the "+ new chat" row; null hides the row (no usable workspace). */
  newSessionWorkspaceId: string | null;
  /**
   * U13: set on the one folder that is not a repository — the group holding
   * unbound (scratch) chats. Callers render its label from i18n instead of
   * `name`, and must not offer repository actions on it.
   */
  synthetic?: 'unbound';
}

/**
 * Project id of the synthetic unbound group. Not a real project: it exists so
 * the folder has a stable React key and expansion key like every other folder,
 * and is deliberately unlike any generated project id.
 */
export const UNBOUND_FOLDER_ID = '__unbound__';

export interface SidebarTreeInput {
  projects: readonly ChatProject[];
  workspaces: readonly ChatWorkspace[];
  sessions: readonly ChatSession[];
  /** Search text — matches session titles only, never folder or branch names. */
  query?: string;
  /**
   * T091: the session the user is looking at RIGHT NOW. It is exempt from the
   * title query — see `matchesQuery`. Optional, and omitting it restores the
   * pre-T091 behaviour exactly.
   */
  activeSessionId?: string | null;
  /**
   * P1-7e e6 (decision 145): the UI language, so the query also matches a
   * title as the sidebar shows it (`New chat` reads 「新建对话」). English
   * when omitted, where the two are the same.
   */
  t?: Translate;
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
 * Decision 137 §1: the busy statuses in which the turn is parked on the user
 * (an approval card or a question) rather than working. The row marks these
 * with an attention dot instead of the spinner.
 */
export function isWaitingSessionStatus(status: SessionRuntimeStatus): boolean {
  return status === 'waiting_permission' || status === 'waiting_question';
}

/**
 * The branch chip a session row carries: the actual branch of a main or linked
 * worktree, main/master included. Branch unknown → no chip; a display name
 * like "Main" is not a branch and must not be shown as one. Temp, remote and
 * unbound workspaces have no branch (decision 167 retired their kind chips).
 *
 * D21-A (user ruling 2026-07-29) showed this chip on every row; decision 167
 * (user ruling 2026-10-09) shows it only off the folder's main workspace —
 * see `chipShownInFolder`.
 */
export function chipForWorkspace(workspace: ChatWorkspace | undefined): SidebarChip | null {
  if (!workspace || !isUsableWorkspace(workspace)) return null;
  if (workspace.kind !== 'main' && workspace.kind !== 'worktree') return null;
  return workspace.branch ? { variant: 'branch', label: workspace.branch } : null;
}

/**
 * Decision 167 §2: what a folder row says about where its chats run — the
 * main workspace's branch, shown once after the folder name, and whether the
 * repository is remote. null for a folder with no main workspace (the
 * synthetic Temp project holds one temp workspace per directory).
 */
export interface FolderPrimaryChip {
  /** The main (or remote) workspace the folder row speaks for. */
  workspaceId: string;
  /** Its branch; null when unknown, and always for a remote repository. */
  branch: string | null;
  remote: boolean;
}

export function folderPrimaryChip(
  projectId: string,
  workspaces: readonly ChatWorkspace[]
): FolderPrimaryChip | null {
  const primary = workspaces.find(
    (ws) => ws.projectId === projectId && (ws.kind === 'main' || ws.kind === 'remote')
  );
  if (!primary) return null;
  return {
    workspaceId: primary.id,
    branch: primary.kind === 'main' ? (primary.branch ?? null) : null,
    remote: primary.kind === 'remote',
  };
}

/**
 * Decision 167 §2 (replaces D21-A): inside its folder a row shows its branch
 * only when the chat runs on another workspace than the folder's main one —
 * a linked worktree. The folder row already names the main branch, and eight
 * rows repeating it was the issue. Rows in 「正在活动」 never show it (the
 * caller simply does not ask).
 */
export function chipShownInFolder(
  row: Pick<SidebarSessionRow, 'chip' | 'workspaceId'>,
  primary: FolderPrimaryChip | null
): boolean {
  return row.chip !== null && row.workspaceId !== primary?.workspaceId;
}

/**
 * Decision 167 §2: a worktree row shows only the last segment of its branch
 * (`feature/sidebar-redesign` → `sidebar-redesign`); the full name is the
 * tooltip. A name with no segment to drop comes back unchanged.
 */
export function lastBranchSegment(name: string): string {
  const segments = name.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? name;
}

/**
 * Decision 167 §2: the folder row's branch text — the main branch, with
 * 「· 远程」 after it for a remote repository (just 「远程」 when a remote
 * repository has no branch to name, which is always today). null hides it.
 */
export function folderBranchLabel(
  primary: FolderPrimaryChip | null,
  t: Translate = englishTranslate
): string | null {
  if (!primary) return null;
  if (primary.remote) return primary.branch ? `${primary.branch} · ${t('Remote')}` : t('Remote');
  return primary.branch;
}

/** Decision 167 §2: the folder row's tooltip — name / main branch / remote. */
export function folderTooltip(
  name: string,
  primary: FolderPrimaryChip | null,
  t: Translate = englishTranslate
): string {
  const lines = [name];
  if (primary?.branch) lines.push(t('Main branch: {{branch}}', { branch: primary.branch }));
  if (primary?.remote) lines.push(t('Remote repository'));
  return lines.join('\n');
}

/** Where a row's chat runs, for its tooltip's second line (decision 167 §3). */
export interface SidebarRowPlace {
  /** The folder as the sidebar shows it; null for an unbound (temporary) chat. */
  folderName: string | null;
  /** The branch of the chat's own workspace; null when there is none to name. */
  branch: string | null;
  remote: boolean;
}

const UNBOUND_PLACE: SidebarRowPlace = { folderName: null, branch: null, remote: false };

/**
 * Resolves a row's place from the same maps the sidebar renders from. A row
 * whose workspace is gone is never rendered (the derivations drop orphans), so
 * the unbound fallback only ever describes a temporary chat.
 */
export function sidebarRowPlace(
  row: Pick<SidebarSessionRow, 'workspaceId' | 'unbound'>,
  workspaceById: ReadonlyMap<string, ChatWorkspace>,
  folderNameByProjectId: ReadonlyMap<string, string>
): SidebarRowPlace {
  if (row.unbound) return UNBOUND_PLACE;
  const workspace = workspaceById.get(row.workspaceId);
  if (!workspace) return UNBOUND_PLACE;
  return {
    folderName: folderNameByProjectId.get(workspace.projectId) ?? null,
    branch: workspace.branch ?? null,
    remote: workspace.kind === 'remote',
  };
}

/**
 * Decision 167 §3: every chat row's `title`, three lines —
 *
 *   title
 *   folder · branch        (「临时对话」 for an unbound chat; 「（远程）」 after a remote one)
 *   Updated YYYY-MM-DD HH:MM
 *
 * The third line always carries the date (`formatAbsoluteDateTime`): sidebar
 * rows span days, and a bare 「14:32」 is ambiguous the moment it is not today.
 */
export function sidebarRowTooltip(input: {
  /** The title as shown (`sidebarRowForDisplay`). */
  title: string;
  place: SidebarRowPlace;
  updatedAt: number;
  locale?: Locale;
  t?: Translate;
}): string {
  const t = input.t ?? englishTranslate;
  const updated = t('Updated {{time}}', {
    time: formatAbsoluteDateTime(input.updatedAt, input.locale),
  });
  return [input.title, sidebarRowWhere(input.place, t), updated].join('\n');
}

/**
 * The tooltip's second line on its own — 「文件夹 · 分支」, 「临时对话」 for a
 * chat with no repository, 「（远程）」 after a remote one. Decision 174: the
 * home page's 「最近对话」 shows it on the row itself (its L4 text).
 */
export function sidebarRowWhere(place: SidebarRowPlace, t: Translate = englishTranslate): string {
  if (place.folderName === null) return t('Temporary chats');
  const where = place.branch ? `${place.folderName} · ${place.branch}` : place.folderName;
  return place.remote ? t('{{place}} (remote)', { place: where }) : where;
}

function normalizeQuery(query: string | undefined): string {
  return query?.trim().toLowerCase() ?? '';
}

/**
 * T091 — a session that has no repository behind it, in EITHER of the two
 * shapes such a session can take.
 *
 * `session.unbound` is the durable marker: it is written once the scratch
 * directory actually exists (`materializeIndexedPiChatSession`, and the index
 * merge after a restart). But `createUnboundChatSession` deliberately does NOT
 * write it at creation time — the directory has not been allocated yet, and a
 * guessed `workspacePath` is the fake-cwd failure U13 exists to prevent — so a
 * temporary chat started in this run carries nothing but `workspaceId: ''`
 * until its first message lands.
 *
 * The derivations below all keyed on the marker alone, so a just-created
 * temporary chat was filtered out of the Temporary group, out of Recent (the
 * top region of the time), and out of the repository folders — i.e. out of the
 * sidebar entirely — until a send wrote the index and the sidebar remounted.
 * Both shapes mean the same thing, so both belong here.
 *
 * The complement still holds: a genuine orphan carries a NON-EMPTY workspaceId
 * that no longer resolves, and is still dropped.
 */
export function isUnboundSessionRow(
  session: Pick<ChatSession, 'unbound' | 'workspaceId'>
): boolean {
  return session.unbound != null || session.workspaceId.trim().length === 0;
}

/**
 * T091: the ACTIVE session is never filtered out by the title query.
 *
 * A search box with text in it is a filter over a LIST, not a statement about
 * which conversation is open. Hiding the row the user is currently inside makes
 * the sidebar disagree with the main pane, and it is exactly what happened on
 * every New click while a search was active: the new chat is titled `New chat`,
 * the query does not match it, and the row the click was supposed to produce
 * never appeared — indistinguishable from "the button did nothing".
 *
 * `activeSessionId` is optional at every entry point, so a caller that does not
 * pass it keeps the old behaviour unchanged.
 */
function matchesQuery(
  session: ChatSession,
  normalized: string,
  activeSessionId?: string | null,
  t: Translate = englishTranslate
): boolean {
  if (normalized.length === 0) return true;
  if (activeSessionId != null && session.id === activeSessionId) return true;
  if (session.title.toLowerCase().includes(normalized)) return true;
  // P1-7e e6 (decision 145): what the row SHOWS is what the user types. The
  // stored placeholder `New chat` reads 「新建对话」 (decision 144), so 「新建」
  // has to find it; the stored identifier still matches as before.
  const shown = displaySessionTitle(session.title, t);
  return shown !== session.title && shown.toLowerCase().includes(normalized);
}

function toRow(session: ChatSession, workspace: ChatWorkspace | undefined): SidebarSessionRow {
  return {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    title: session.title,
    chip: chipForWorkspace(workspace),
    ...(workspace && isUsableWorkspace(workspace) ? {} : { unbound: true as const }),
    updatedAt: session.updatedAt,
    busy: isBusySessionStatus(session.status),
    failed: session.status === 'failed',
    status: session.status,
    ...(session.legacyDiverged && sessionAgent(session) === PI_AGENT
      ? { legacyDiverged: true as const }
      : {}),
  };
}

/**
 * Decision 174 (issue #6, second wave): the rows of the given conversations,
 * in the sidebar's own shape — for the home page's 「最近对话」, which lists
 * them with the same markers, badges and tooltip. A chat with no repository is
 * read as one (`isUnboundSessionRow`) even when it still names a workspace.
 */
export function sidebarRowsForSessions(
  sessions: readonly ChatSession[],
  workspaces: readonly ChatWorkspace[]
): SidebarSessionRow[] {
  const workspaceById = new Map(workspaces.map((ws) => [ws.id, ws] as const));
  return sessions.map((session) =>
    toRow(
      session,
      isUnboundSessionRow(session) ? undefined : workspaceById.get(session.workspaceId)
    )
  );
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
    // U13: unbound chats belong to `buildUnboundFolder`'s group and nowhere
    // else. Skipped explicitly rather than relying on the workspace lookup
    // failing — one such chat (a store seed session the user typed into before
    // adding any repository) does still carry a workspace id, and would
    // otherwise render twice.
    // T091: `isUnboundSessionRow` also covers the marker-less shape a temporary
    // chat has before its first send. That shape has `workspaceId: ''`, so the
    // lookup above already drops it here — stating it anyway is what keeps all
    // three derivations reading ONE predicate for "this chat has no repository",
    // which is how they came to disagree in the first place.
    if (!workspace || isUnboundSessionRow(session)) {
      continue;
    }
    if (!matchesQuery(session, normalized, input.activeSessionId, input.t)) {
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
 * U13 (D04) — the synthetic group holding unbound chats, or `null` when there
 * are none (the sidebar then looks exactly as it did before).
 *
 * Separate from `buildSidebarFolders` because these sessions have no workspace
 * and no project: folding them in would mean giving the loop a second grouping
 * key and every caller a folder with no repository behind it. They are matched
 * by the SAME title query, so a search either shows them or hides them along
 * with everything else.
 *
 * `newSessionWorkspaceId` is null on purpose — "+ new chat" needs a workspace
 * to create against, and this group has none by definition.
 */
export function buildUnboundFolder(input: {
  sessions: readonly ChatSession[];
  /** Display label; the caller passes a translated string. */
  name: string;
  query?: string;
  /** T091: exempt from the title query — see `matchesQuery`. */
  activeSessionId?: string | null;
  /** Decision 145: see `SidebarTreeInput.t`. */
  t?: Translate;
}): SidebarFolder | null {
  const normalized = normalizeQuery(input.query);
  const rows = input.sessions
    .filter(
      (session) =>
        isUnboundSessionRow(session) &&
        matchesQuery(session, normalized, input.activeSessionId, input.t)
    )
    .map((session) => toRow(session, undefined))
    .sort(byUpdatedAtDesc);
  if (rows.length === 0) return null;
  return {
    projectId: UNBOUND_FOLDER_ID,
    name: input.name,
    rows,
    newSessionWorkspaceId: null,
    synthetic: 'unbound',
  };
}

/** Where the home page opened by the sidebar's 「＋新建」 puts its draft target. */
export interface HomePreselect {
  workspaceId: string;
  path: string;
  /** The folder's name as the sidebar knows it. */
  folderName: string;
}

/**
 * Decision 174 (issue #6, second wave; user ruling 2026-10-10): the sidebar's
 * 「＋新建」 opens the home page with the corresponding repository picked —
 * the folder of the conversation the user last opened from the sidebar, else
 * the open conversation's own. `null` picks nothing, and the home page keeps
 * its own default (the most recently active repository).
 *
 * This replaces `resolveNewSessionTarget`, which chose where a blank
 * conversation was created at once. Two of its rules stay:
 * - a focused folder that has no usable workspace answers `null` rather than
 *   falling through to another folder (R5 round-2 B1: no silent redirect);
 * - a fallback target must still be alive — a usable workspace of a folder
 *   that is on screen.
 * Its last tier ("the first usable workspace") is gone: with nothing to go on,
 * the home page's own default is the better answer — the first repository by
 * activity, not the first one ever added.
 */
export function resolveHomePreselect(input: {
  focusedProjectId: string | null;
  folders: readonly SidebarFolder[];
  activeSession: Pick<ChatSession, 'workspaceId'> | undefined;
  workspaces: readonly ChatWorkspace[];
}): HomePreselect | null {
  const workspaceById = new Map(input.workspaces.map((ws) => [ws.id, ws] as const));
  const focusedFolder = input.folders.find((folder) => folder.projectId === input.focusedProjectId);
  if (focusedFolder) {
    const workspace = focusedFolder.newSessionWorkspaceId
      ? workspaceById.get(focusedFolder.newSessionWorkspaceId)
      : undefined;
    return workspace && isUsableWorkspace(workspace)
      ? { workspaceId: workspace.id, path: workspace.path, folderName: focusedFolder.name }
      : null;
  }
  const active = input.activeSession
    ? workspaceById.get(input.activeSession.workspaceId)
    : undefined;
  const folder = active
    ? input.folders.find((item) => item.projectId === active.projectId)
    : undefined;
  if (!active || !folder || !isUsableWorkspace(active)) return null;
  return { workspaceId: active.id, path: active.path, folderName: folder.name };
}

/**
 * Decision 137 §3 (user ruling 2026-09-29) replaced D29 (open-q #28 A): a
 * folder header click is the collapse / expand gesture and nothing else. It no
 * longer activates the folder's newest session and no longer moves where the
 * next "New" lands — that stays with the selected conversation. Hence no
 * helper here any more: the header's only effect is flipping its own entry in
 * `expandedProjects`.
 */

export interface FolderRowsLimitInput {
  /** The folder's rows as derived — sorted `updatedAt` desc, query applied. */
  rows: readonly SidebarSessionRow[];
  /** The user pressed "View more" on this folder in this run. */
  showAll: boolean;
  /** A search is active: every match is listed, the cap does not apply. */
  queryActive: boolean;
  /** Kept visible below the cap — decision 137 §4. */
  activeSessionId?: string | null;
}

export interface FolderRowsLimitResult {
  rows: SidebarSessionRow[];
  /** Rows behind "View more (N)"; 0 when nothing is hidden. */
  hiddenCount: number;
  /** Show "Show less": the list is expanded AND there is something to fold. */
  collapsible: boolean;
}

/**
 * Decision 137 §4: a folder lists its first {@link FOLDER_DEFAULT_LIMIT} rows
 * and hides the rest behind "View more (N)".
 *
 * - The selected conversation is never hidden: when it sorts past the cap it
 *   is appended after the capped rows (above "View more"), so the sidebar
 *   always shows the row the main pane is displaying. It is not counted in N.
 * - `showAll` lifts the cap; the list then ends in "Show less" when there is
 *   anything to fold back.
 * - A search lists every match — the query already narrowed the list, and
 *   hiding a hit behind a button would read as "no such chat".
 */
export function limitFolderRows(input: FolderRowsLimitInput): FolderRowsLimitResult {
  const total = input.rows.length;
  if (input.queryActive || total <= FOLDER_DEFAULT_LIMIT) {
    return { rows: [...input.rows], hiddenCount: 0, collapsible: false };
  }
  if (input.showAll) {
    return { rows: [...input.rows], hiddenCount: 0, collapsible: true };
  }
  const visible = input.rows.slice(0, FOLDER_DEFAULT_LIMIT);
  const pinned =
    input.activeSessionId != null
      ? input.rows
          .slice(FOLDER_DEFAULT_LIMIT)
          .find((row) => row.sessionId === input.activeSessionId)
      : undefined;
  if (pinned) visible.push(pinned);
  return { rows: visible, hiddenCount: total - visible.length, collapsible: false };
}

/**
 * Decision 170 (issue #6 ruling 2): the "Active now" region lists its first
 * {@link ACTIVE_DEFAULT_LIMIT} rows and hides the rest behind "View more (N)",
 * ending in "Show less" once expanded — the folder cap's words and shape.
 *
 * Unlike a folder it pins nothing: the selected chat past the cap stays behind
 * "View more" (it is still listed, and highlighted, in its own folder). A
 * search lists every match, as in a folder.
 */
export function limitActiveRows(input: {
  /** `deriveActiveRows`' result: running turns first, then last activity. */
  rows: readonly SidebarSessionRow[];
  showAll: boolean;
  queryActive: boolean;
}): FolderRowsLimitResult {
  const total = input.rows.length;
  if (input.queryActive || total <= ACTIVE_DEFAULT_LIMIT) {
    return { rows: [...input.rows], hiddenCount: 0, collapsible: false };
  }
  if (input.showAll) {
    return { rows: [...input.rows], hiddenCount: 0, collapsible: true };
  }
  return {
    rows: input.rows.slice(0, ACTIVE_DEFAULT_LIMIT),
    hiddenCount: total - ACTIVE_DEFAULT_LIMIT,
    collapsible: false,
  };
}

/**
 * Decision 170 (issue #6 ruling 6): when each repository folder last saw
 * activity — the newest `updatedAt` among its chats, grouped the way
 * `buildSidebarFolders` groups them (by the workspace's project; unbound and
 * orphaned chats belong to no folder). A folder with no chat has no entry.
 *
 * Deliberately blind to the search query: typing must not reorder the list.
 */
export function deriveFolderLastActivity(input: {
  workspaces: readonly ChatWorkspace[];
  sessions: readonly ChatSession[];
}): Map<string, number> {
  const workspaceById = new Map(input.workspaces.map((ws) => [ws.id, ws] as const));
  const latest = new Map<string, number>();
  for (const session of input.sessions) {
    const workspace = workspaceById.get(session.workspaceId);
    if (!workspace || isUnboundSessionRow(session)) continue;
    const previous = latest.get(workspace.projectId);
    if (previous === undefined || session.updatedAt > previous) {
      latest.set(workspace.projectId, session.updatedAt);
    }
  }
  return latest;
}

/**
 * Decision 170 (issue #6 ruling 6): the repository list by activity.
 *
 * - Folders with chats come first, newest activity first.
 * - Folders without a chat follow, in their old relative order (the order the
 *   repositories were added in).
 * - The Temp Session project (「临时工作区」) is always last.
 *
 * The sort is stable, so folders with the same activity keep their old order
 * too. Only the display order changes; `aiclient-repositories` is not
 * rewritten.
 */
export function orderFoldersByActivity<T extends Pick<SidebarFolder, 'projectId'>>(
  folders: readonly T[],
  lastActivity: ReadonlyMap<string, number>
): T[] {
  const withChats: T[] = [];
  const withoutChats: T[] = [];
  const temp: T[] = [];
  for (const folder of folders) {
    if (folder.projectId === TEMP_PROJECT_ID) temp.push(folder);
    else if (lastActivity.has(folder.projectId)) withChats.push(folder);
    else withoutChats.push(folder);
  }
  withChats.sort(
    (a, b) => (lastActivity.get(b.projectId) ?? 0) - (lastActivity.get(a.projectId) ?? 0)
  );
  return [...withChats, ...withoutChats, ...temp];
}

/**
 * Decision 170 (issue #6 ruling 6): while the pointer or keyboard focus is in
 * the repository list its order is held — a folder must not move out from
 * under the pointer because a chat elsewhere just finished a turn.
 *
 * `held` is the order captured when the hold began (null: no hold, the live
 * order stands). Folders still present keep that order; a folder that
 * appeared during the hold goes after them in live order; one that went away
 * is dropped. The Temp Session project stays last either way.
 */
export function applyHeldFolderOrder<T extends Pick<SidebarFolder, 'projectId'>>(
  live: readonly T[],
  held: readonly string[] | null
): T[] {
  if (held === null) return [...live];
  const rank = new Map(held.map((projectId, index) => [projectId, index] as const));
  const kept = live
    .filter((folder) => rank.has(folder.projectId))
    .sort((a, b) => (rank.get(a.projectId) ?? 0) - (rank.get(b.projectId) ?? 0));
  const added = live.filter((folder) => !rank.has(folder.projectId));
  const ordered = [...kept, ...added];
  return [
    ...ordered.filter((folder) => folder.projectId !== TEMP_PROJECT_ID),
    ...ordered.filter((folder) => folder.projectId === TEMP_PROJECT_ID),
  ];
}

export interface ActiveRowsInput {
  sessions: readonly ChatSession[];
  workspaces: readonly ChatWorkspace[];
  /** The store's `hostBoundSessionIds`: started on the engine in this run. */
  hostBoundSessionIds: readonly string[];
  query?: string;
  /** T091: exempt from the title query — see `matchesQuery`. */
  activeSessionId?: string | null;
  /** Decision 145: see `SidebarTreeInput.t`. */
  t?: Translate;
}

/**
 * Decision 137 §1 — "Active now". Decision 167 §1 made it the upper segment of
 * a two-part Recent; decision 170 (issue #6 ruling 2, user 2026-10-10) made it
 * the sidebar's whole top region again: Recent and its 48-hour list are gone,
 * the region shows 5 rows behind "View more" (`limitActiveRows`) and is not
 * rendered at all while this returns nothing.
 *
 * A conversation is listed while its session is started on the engine in this
 * run (`hostBoundSessionIds`: a send created or resumed it; a preview never
 * does) or while a turn of it is running. The binding is dropped when the pool
 * reclaims the session, the engine restarts, or the user ends the
 * conversation, so such a row leaves this region by itself.
 *
 * Running turns come first, the rest by last activity. The same orphan and
 * search rules as the folders apply, so a search narrows this region too, and
 * an unbound (temporary) chat is not mistaken for an orphan.
 */
export function deriveActiveRows(input: ActiveRowsInput): SidebarSessionRow[] {
  const normalized = normalizeQuery(input.query);
  const workspaceById = new Map(input.workspaces.map((ws) => [ws.id, ws] as const));
  const bound = new Set(input.hostBoundSessionIds);
  return input.sessions
    .filter((session) => {
      if (!isUnboundSessionRow(session) && !workspaceById.has(session.workspaceId)) {
        return false;
      }
      if (!matchesQuery(session, normalized, input.activeSessionId, input.t)) {
        return false;
      }
      return bound.has(session.id) || isBusySessionStatus(session.status);
    })
    .map((session) =>
      toRow(
        session,
        isUnboundSessionRow(session) ? undefined : workspaceById.get(session.workspaceId)
      )
    )
    .sort((a, b) => Number(b.busy) - Number(a.busy) || byUpdatedAtDesc(a, b));
}

/**
 * The two renderings of the interim title a chat moved over from a 1.0.x
 * continuation carries (`LEGACY_FORK_TITLE_KEY`, written by Main in the locale
 * of the moment): the text that follows `{{title}}`. A locale that puts the
 * title anywhere but first is skipped — splitting it would misread the title.
 */
const BRANCH_SUFFIXES: readonly string[] = (['zh', 'en'] as const)
  .map((locale) => translate(locale, LEGACY_FORK_TITLE_KEY, { title: '\u0000' }).split('\u0000'))
  .filter((parts) => parts.length === 2 && parts[0] === '' && (parts[1]?.trim().length ?? 0) > 0)
  .map((parts) => parts[1] as string);

export interface TitleParts {
  /** The part that may be cut with an ellipsis. */
  base: string;
  /** The branch suffix, trimmed, or null when the title has none. */
  suffix: string | null;
  /** The suffix was separated from the base by whitespace (the English form). */
  spaced: boolean;
}

/**
 * Point-check issue 32 (decision 138): split a title ending in the 1.0.x
 * branch suffix so the row can keep the suffix whole and cut only the part
 * before it. Decision 131 relies on that suffix to tell the moved copy from
 * the original, and at the default sidebar width a long title used to lose it
 * to the ellipsis.
 *
 * Matched on the text rather than on `forkTitlePending`: an image-only first
 * message keeps the interim title for good while clearing the flag.
 */
export function splitBranchSuffix(title: string): TitleParts {
  for (const suffix of BRANCH_SUFFIXES) {
    if (title.length > suffix.length && title.endsWith(suffix)) {
      const base = title.slice(0, title.length - suffix.length);
      if (base.trim().length === 0) break;
      return { base, suffix: suffix.trim(), spaced: /^\s/.test(suffix) };
    }
  }
  return { base: title, suffix: null, spaced: false };
}

/**
 * The sidebar's right-hand age column. The implementation moved to
 * `@/lib/relativeTime` when T-31 (P-18) gave the chat turn footer a relative
 * timestamp too: chat cannot import from `components/workspace-shell`, so the
 * shared bucket table had to sit below both. Re-exported here so this module
 * stays the sidebar's single import surface.
 */
export { formatRelativeAge } from '@/lib/relativeTime';
