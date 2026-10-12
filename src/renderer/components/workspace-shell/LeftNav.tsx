import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import type { TempWorkspaceItem } from '@shared/types';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderGit2,
  FolderMinus,
  FolderPlus,
  ListChecks,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldQuestion,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  type FocusEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Repository } from '@/App/constants';
import { RepositorySettingsDialog } from '@/components/repository/RepositorySettingsDialog';
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { openHome } from '@/stores/homeDraft';
import { useWorktreeActivityStore } from '@/stores/worktreeActivity';
import { useSessionIndex, useSessionIndexMutations } from '../chat/sessionIndex/useSessionIndex';
import { shouldShowAddRepositoryEmptyState } from './addRepositoryEntry';
import { projectIdForRepo, workspaceIdFor } from './deriveChatWorkspaceTree';
import { endSessionRuntime } from './endSessionRuntime';
import { sumFolderDiffTotals } from './folderDiffStats';
import { SURFACE_ESCAPE_HOLD_ATTR } from './shellLayoutModel';
import {
  applyHeldFolderOrder,
  buildSidebarFolders,
  buildUnboundFolder,
  chipShownInFolder,
  deriveFolderLastActivity,
  deriveGroupSummary,
  folderPrimaryChip,
  folderTooltip,
  isUnboundSessionRow,
  isWaitingSessionStatus,
  LEGACY_DIVERGED_HINT,
  lastBranchSegment,
  limitFolderRows,
  orderFoldersByActivity,
  resolveHomePreselect,
  type SidebarGroupSummary,
  type SidebarRowPlace,
  type SidebarSessionRow,
  sidebarFolderNameForDisplay,
  sidebarRowForDisplay,
  sidebarRowPlace,
  sidebarRowTooltip,
  splitBranchSuffix,
  UNBOUND_FOLDER_ID,
} from './sidebarTree';
import { useActivateSession } from './useActivateSession';
import { useFolderDiffStatsPolling } from './useFolderDiffStats';

/**
 * D08 (U15-a): this is the `chat` SURFACE's body now, not a column.
 *
 * The chrome it used to own moved to `LeftDock`, which hosts it: the collapse
 * button (on the rail since H/18 S4), the account pill (`UserFooterPill`, so
 * it survives a surface switch) and the plugin entry + dialog (now the rail's
 * bottom group). What stays is exactly the session list.
 *
 * Decision 183 (prototype in
 * `docs/plantree/plans/dsh-rebase/evidence/sidebar-claude-style-2026-10/`)
 * replaced decision 170's three regions with one scrolling list, top to
 * bottom: a vertical nav (New chat, Add repository), a tool row (search,
 * collapse / expand all, bulk archive), then the groups — Temporary chats
 * pinned first, the repositories by activity after it. No panel title, no
 * region titles, no dividers; groups are told apart by spacing alone. See
 * `docs/design-system.md`, 「侧栏层级（聊天面板）」.
 */
interface LeftNavProps {
  /** T-24: opens the shared AddRepositoryDialog mounted in App. */
  onAddRepository?: () => void;
  onRemoveRepository?: (repoPath: string) => void;
  repositories?: Repository[];
  /** Temp session items (App's `useTempWorkspaceStore`) — matched to a Temp
   * folder row's workspace path so the row's delete button targets the right item. */
  tempWorkspaces?: TempWorkspaceItem[];
  /** Opens the shared `TempWorkspaceDialogs` delete confirmation, same as the
   * legacy shell's `onRequestTempDelete={openTempDelete}` wiring. */
  onRequestTempDelete?: (id: string) => void;
}

export function LeftNav({
  onAddRepository,
  onRemoveRepository,
  repositories = [],
  tempWorkspaces = [],
  onRequestTempDelete,
}: LeftNavProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  // D1 (round-5): sidebar-local "which folder is the user targeting" state.
  // T-26 deliberately removed the cross-cutting store `selectedWorkspaceId`
  // (folder click is UI-only, e.g. expandedProjects above) — this stays local
  // to LeftNav and only feeds the New chat entry's preselection on the home
  // page (decision 174), it never becomes the source of truth for "where to
  // run" (that's the Composer target bar, T-27). Decision 137 §3: only picking
  // a conversation writes it now; a group header click no longer does.
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  // Decision 137 §4: groups whose "View more" was pressed. Memory only, so it
  // holds across conversation switches and a group collapse, and a restart
  // brings every group back to its first rows.
  const [folderShowAll, setFolderShowAll] = useState<Record<string, boolean>>({});
  const [repoToRemove, setRepoToRemove] = useState<Repository | null>(null);
  const [repoToConfigure, setRepoToConfigure] = useState<Repository | null>(null);
  /**
   * U31: bulk archive. `null` = not selecting; a Set = selection mode holding
   * the chosen session ids.
   *
   * One nullable Set rather than a boolean plus a Set: those two would have an
   * illegal fourth state ("not selecting, but things are selected") that every
   * reader would then have to decide what to do about.
   */
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const selecting = selection !== null;

  const toggleSelected = useCallback((sessionId: string) => {
    setSelection((current) => {
      if (!current) return current;
      const next = new Set(current);
      if (!next.delete(sessionId)) next.add(sessionId);
      return next;
    });
  }, []);

  const handleConfirmRemoveRepo = useCallback(() => {
    if (repoToRemove && onRemoveRepository) {
      onRemoveRepository(repoToRemove.path);
    }
    setRepoToRemove(null);
  }, [repoToRemove, onRemoveRepository]);

  // "Reveal in Finder/Explorer" on the repository row — unlike the file tree's
  // same-named action (`file.revealInFileManager`, which highlights an item
  // inside its parent), this opens the repository directory itself, so it goes
  // through `shell.openPath` instead. `openPath` resolves to an error string
  // (never throws) on a normal failure, but the preload rejects outright for a
  // remote virtual path — both are reported the same way here since the menu
  // item is already hidden for remote repositories (see `repoMenuItems`).
  const handleOpenRepositoryFolder = useCallback(
    async (repoPath: string) => {
      try {
        const error = await window.electronAPI.shell.openPath(repoPath);
        if (error) {
          toastManager.add({
            type: 'error',
            title: t('Could not open "{{path}}".', { path: repoPath }),
          });
        }
      } catch {
        toastManager.add({
          type: 'error',
          title: t('Could not open "{{path}}".', { path: repoPath }),
        });
      }
    },
    [t]
  );

  /**
   * Folder → repository by the same key the tree was built with. Matching on
   * display name or a path suffix would let one repo answer for another
   * (`my-app` ends with the folder name `app`) — unacceptable for a remove
   * action. A folder with no entry (the synthetic Temp project) gets no button.
   */
  const repoByProjectId = useMemo(() => {
    const map = new Map<string, Repository>();
    for (const repo of repositories) {
      map.set(projectIdForRepo(repo), repo);
    }
    return map;
  }, [repositories]);

  /**
   * Row's `workspaceId` → temp item id, keyed the same way
   * `deriveChatWorkspaceTree` built the Temp folder's workspace ids
   * (`workspaceIdFor('temp', item.path)`) — so this only ever matches rows
   * that actually live under the synthetic Temp project, never a real repo.
   */
  const tempItemIdByWorkspaceId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of tempWorkspaces) {
      map.set(workspaceIdFor('temp', item.path), item.id);
    }
    return map;
  }, [tempWorkspaces]);

  const projects = useChatSessionsStore((state) => state.projects);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  // D12 (U24): which sessions have a LIVE WORKER. With the tab strip gone this
  // list is the only place "what is still running in the background" is stated,
  // so the marker reads off the real thing (`session.created`/`session.resumed`
  // add to this; `endSessionRuntime` removes) rather than off which tabs were
  // open — a tab could outlive its worker, which is the confusion D09 was
  // opened to fix.
  const hostBoundSessionIds = useChatSessionsStore((state) => state.hostBoundSessionIds);
  // S3 (H/18): sessions that finished or failed while the user was elsewhere.
  // Passed down like `started` rather than folded into `SidebarSessionRow` —
  // the row derivations are pure functions of the session list, and "have I
  // looked at this yet" is not a property of the session.
  const unreadSessionIds = useChatSessionsStore((state) => state.unreadSessionIds);
  // decision 012: the badge used to count parked Extension UI dialogs, the
  // pi-era approval surface. Its replacement is this app's own permission
  // queue — the same list the permission card answers — so a session waiting
  // on an Allow/Deny still shows a count in the sidebar.
  const pendingPermissions = useChatSessionsStore((state) => state.pendingPermissions);
  const pendingApprovalCountBySession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const request of pendingPermissions) {
      if (!request.sessionId) continue;
      counts.set(request.sessionId, (counts.get(request.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [pendingPermissions]);

  // T-02: hydrate + mutate the persisted session index (chat:listSessions /
  // renameSession / archiveSession / closeSession).
  const { refresh } = useSessionIndex();
  const { rename, archive, archiveMany, close } = useSessionIndexMutations(refresh);

  // Point-check issue 34 (decision 138): a rename that did not land says so.
  // A chat that has never been sent is renamed on its live row instead (see
  // `renameSessionOrDraft`), so what is left here is a real failure. Compared
  // with `false` on purpose: only an explicit refusal is reported.
  const renameRow = useCallback(
    async (sessionId: string, title: string) => {
      if ((await rename(sessionId, title)) === false) {
        toastManager.add({ type: 'error', title: t('Could not rename the chat') });
      }
    },
    [rename, t]
  );

  // D08: activation (select + resume-if-needed) moved into `useActivateSession`
  // so the center tab strip can start a session the same way this list does —
  // a persisted tab reopened after a restart has no timeline either.
  const activateSession = useActivateSession();

  const handleSelectSession = (sessionId: string, persistedRuntimeIdentity?: string) => {
    // D1 (round-5): keep the sidebar's own "New" target in sync with whatever
    // folder the just-selected session actually lives under. Grouped by the
    // workspace's project, not `session.projectId`, matching buildSidebarFolders
    // (a stale session.projectId must not point focus at the wrong folder).
    // Read fresh state rather than the render-body snapshot: this handler can
    // fire well after the render that captured it.
    const state = useChatSessionsStore.getState();
    const session = state.sessions.find((item) => item.id === sessionId);
    const workspace = state.workspaces.find((ws) => ws.id === session?.workspaceId);
    if (workspace) {
      setFocusedProjectId(workspace.projectId);
    }
    activateSession(sessionId, persistedRuntimeIdentity);
  };

  const activeSession = sessions.find((session) => session.id === activeSessionId);

  // T-24: the DEMO seed keeps `projects` non-empty on a fresh machine, so the
  // tree looks populated while every workspace path is empty. Gate on usable
  // workspaces instead, otherwise the add entry point is never reachable.
  const showAddRepositoryEmptyState = shouldShowAddRepositoryEmptyState(projects, workspaces);

  const isProjectExpanded = (projectId: string) => expandedProjects[projectId] !== false;

  // T091: `activeSessionId` is passed to every list derivation so a title query
  // never hides the conversation that is currently open — see `matchesQuery`.
  // Decision 145: `t` so a search also matches the titles as shown.
  const folders = buildSidebarFolders({
    projects,
    workspaces,
    sessions,
    query,
    activeSessionId,
    t,
  });
  // Uncommitted-change totals for the group headers. Polls only the
  // directories that have a session running (see `useFolderDiffStats.ts`), so
  // an idle sidebar costs nothing.
  useFolderDiffStatsPolling(folders, workspaces);
  const diffStatsByPath = useWorktreeActivityStore((state) => state.diffStats);
  // U13: rendered beside the repository groups but deliberately NOT part of
  // `folders` — it has no workspace to create a chat in, so letting the "New"
  // target resolver see it would only produce a target that cannot host
  // anything. `null` when there are no such chats.
  const unboundFolder = buildUnboundFolder({
    sessions,
    name: t('Temporary chats'),
    query,
    activeSessionId,
    t,
  });
  // Decision 167 §3: every row's tooltip names where it runs, resolved from
  // the same lists the sidebar renders.
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace] as const)),
    [workspaces]
  );
  const folderNameByProjectId = useMemo(
    () =>
      new Map(
        projects.map(
          (project) =>
            [project.id, sidebarFolderNameForDisplay(project.id, project.name, t)] as const
        )
      ),
    [projects, t]
  );
  const placeOf = (row: SidebarSessionRow): SidebarRowPlace =>
    sidebarRowPlace(row, workspaceById, folderNameByProjectId);
  const queryActive = query.trim().length > 0;
  /**
   * Whether a group shows its rows. A search opens every group that has
   * matches, whatever its stored fold — the hits are what the user is looking
   * for — without writing the fold; its header folds nothing meanwhile.
   * Clearing the search then leaves the last query's groups open
   * (`handleQueryChange`).
   */
  const groupExpanded = (groupId: string) => queryActive || isProjectExpanded(groupId);
  // Decision 170 (issue #6 ruling 6), kept by decision 183 §2.11: repository
  // groups by last activity, the empty ones after them, the Temp Session
  // project last. Display order only — the repository store keeps the order
  // they were added in. Held while the pointer or keyboard focus is in the
  // list, so nothing moves under a click. Temporary chats is pinned above all
  // of them and takes no part in the ordering.
  const liveFolderOrder = orderFoldersByActivity(
    folders,
    deriveFolderLastActivity({ workspaces, sessions })
  );
  const listHold = useRegionHold(!showAddRepositoryEmptyState);
  const heldFolderOrder = useHeldOrder(
    liveFolderOrder.map((folder) => folder.projectId),
    listHold.held
  );
  const orderedFolders = applyHeldFolderOrder(liveFolderOrder, heldFolderOrder);
  // While searching, groups with zero hits collapse away instead of leaving
  // a wall of empty headers; without a query every group stays visible so
  // its header's 「＋」 remains reachable.
  const visibleFolders = queryActive
    ? orderedFolders.filter((folder) => folder.rows.length > 0)
    : orderedFolders;
  const noMatches = queryActive && visibleFolders.length === 0 && !unboundFolder;

  /**
   * User ruling 2026-10-11: clearing a search leaves open the groups its LAST
   * query matched — the ones on screen right before the clear, which this
   * render derived from that query — and writes nothing else. A group that
   * matched only an earlier prefix while typing, or none at all, keeps the
   * fold it had.
   */
  const handleQueryChange = (next: string) => {
    if (queryActive && next.trim().length === 0) {
      const matched = [
        ...(unboundFolder ? [UNBOUND_FOLDER_ID] : []),
        ...(showAddRepositoryEmptyState ? [] : visibleFolders.map((folder) => folder.projectId)),
      ];
      setExpandedProjects((prev) => ({
        ...prev,
        ...Object.fromEntries(matched.map((id) => [id, true])),
      }));
    }
    setQuery(next);
  };

  /**
   * Decision 174 (issue #6, second wave; user ruling 2026-10-10): 「新建对话」
   * opens the home page instead of making a blank conversation, with the
   * corresponding repository picked — the folder of the conversation last
   * opened from here, else the open conversation's (`resolveHomePreselect`).
   * Resolved at click time from the live `folders` list (never `visibleFolders`,
   * which a search narrows). Already on the home page, it changes nothing: the
   * user's own pick there stands.
   */
  const handleNewSession = () => {
    if (activeSessionId === null) {
      openHome();
      return;
    }
    const preselect = resolveHomePreselect({
      focusedProjectId,
      folders,
      activeSession,
      workspaces,
    });
    openHome(preselect ? { kind: 'path', path: preselect.path } : undefined);
  };

  /** Decision 174: a repository group's 「＋」 — the home page, this repository picked. */
  const openHomeInFolder = (workspaceId: string) => {
    const workspace = workspaceById.get(workspaceId);
    openHome(workspace ? { kind: 'path', path: workspace.path } : undefined);
  };

  /**
   * Decision 183 §1.8: one toggle for every group, Temporary chats included.
   * While any group is open it folds them all; once every group is folded it
   * opens them all. It reads and writes the groups the list shows WITHOUT a
   * search: a search opens every group with matches regardless of their fold
   * (see `groupExpanded`), so while one is typed the toggle is disabled and
   * keeps its label (the stored folds); clearing the search opens the last
   * query's groups for good (`handleQueryChange`) and it reads those.
   */
  const toggleGroupIds = [
    ...(sessions.some(isUnboundSessionRow) ? [UNBOUND_FOLDER_ID] : []),
    ...(showAddRepositoryEmptyState ? [] : folders.map((folder) => folder.projectId)),
  ];
  const allGroupsCollapsed =
    toggleGroupIds.length > 0 && toggleGroupIds.every((id) => !isProjectExpanded(id));
  const toggleAllGroups = () => {
    const expand = allGroupsCollapsed;
    setExpandedProjects((prev) => ({
      ...prev,
      ...Object.fromEntries(
        [UNBOUND_FOLDER_ID, ...folders.map((folder) => folder.projectId)].map((id) => [id, expand])
      ),
    }));
  };
  const toggleAllLabel = allGroupsCollapsed ? t('Expand all groups') : t('Collapse all groups');

  /**
   * Every list renders its rows through here, so the row's wiring (markers,
   * selection mode, menus) cannot drift between Temporary chats and the
   * repository groups. `branch` and `onDeleteTemp` are repository-only.
   */
  const renderSessionRow = (row: SidebarSessionRow, branch?: string, onDeleteTemp?: () => void) => (
    <SessionRow
      key={row.sessionId}
      row={row}
      place={placeOf(row)}
      branch={branch}
      active={activeSessionId === row.sessionId}
      started={hostBoundSessionIds.includes(row.sessionId)}
      unread={unreadSessionIds.includes(row.sessionId)}
      {...(selecting
        ? { selected: selection.has(row.sessionId), onToggleSelect: toggleSelected }
        : {})}
      pendingApprovalCount={pendingApprovalCountBySession.get(row.sessionId) ?? 0}
      onSelect={() => handleSelectSession(row.sessionId)}
      onClose={() => void close(row.sessionId)}
      onRename={(title) => void renameRow(row.sessionId, title)}
      onArchive={() => void archive(row.sessionId, true)}
      onDeleteTemp={onDeleteTemp}
    />
  );

  /**
   * Decision 137 §4: the row that ends a capped group — "View more (N)" while
   * rows are hidden, "Show less" once they are all listed. Nothing when the
   * group fits. Shared by the repository groups and Temporary chats so the two
   * read the same.
   */
  const renderFolderLimitToggle = (
    projectId: string,
    limited: ReturnType<typeof limitFolderRows>
  ) => {
    if (limited.hiddenCount > 0) {
      return (
        <SidebarAuxRow onClick={() => setFolderShowAll((prev) => ({ ...prev, [projectId]: true }))}>
          {t('View more ({{count}})', { count: limited.hiddenCount })}
        </SidebarAuxRow>
      );
    }
    if (limited.collapsible) {
      return (
        <SidebarAuxRow
          onClick={() => setFolderShowAll((prev) => ({ ...prev, [projectId]: false }))}
        >
          {t('Show less')}
        </SidebarAuxRow>
      );
    }
    return null;
  };

  /**
   * U13 — the temporary-chat group.
   *
   * Shown whether or not a repository exists: a machine with no repository
   * yet still shows the add-repository call to action, and that is exactly
   * the machine where every chat is unbound — hiding them there would leave
   * the user with a sidebar that admits to no sessions at all.
   *
   * Decision 183 §1.2: a group like any repository's, pinned above them and
   * outside the activity order. Its header folds it (memory only, the same
   * state table under `UNBOUND_FOLDER_ID`), its 「＋」 and its right-click both
   * open the home page with no repository picked (decision 174), and it lists
   * its first rows behind the same "View more" as a repository group.
   */
  const renderTemporaryGroup = () => {
    if (!unboundFolder) return null;
    const expanded = groupExpanded(UNBOUND_FOLDER_ID);
    const limited = limitFolderRows({
      rows: unboundFolder.rows,
      showAll: folderShowAll[UNBOUND_FOLDER_ID] === true,
      queryActive,
      activeSessionId,
    });
    return (
      // S1 (H/18): the group's own right-click. It covers the header and the
      // gaps between rows; a right-click that lands ON a row opens that row's
      // menu instead, because Base UI's context-menu trigger stops the event
      // before it reaches this one.
      <ContextMenuPrimitive.Root>
        <ContextMenuPrimitive.Trigger
          render={
            <section className={SIDEBAR_GROUP_CLASS} data-sidebar-group={UNBOUND_FOLDER_ID} />
          }
        >
          {renderGroupHeader({
            name: unboundFolder.name,
            nameSlot: 'sidebar-temporary-name',
            tooltip: t('Chats that belong to no repository'),
            expanded,
            onToggle: queryActive
              ? undefined
              : () =>
                  setExpandedProjects((prev) => ({
                    ...prev,
                    [UNBOUND_FOLDER_ID]: !expanded,
                  })),
            summary: deriveGroupSummary(unboundFolder.rows, unreadSessionIds),
            actions: (
              // Decision 174: the home page with 「不选仓库（临时对话）」
              // picked; the temporary chat is made by its first send.
              <Button
                variant="ghost"
                size="icon-xs"
                className={GROUP_ACTION_CLASS}
                aria-label={t('New temporary chat')}
                title={t('New temporary chat')}
                onClick={() => openHome({ kind: 'unbound' })}
              >
                <Plus className="size-3.5" />
              </Button>
            ),
          })}
          {expanded && limited.rows.length > 0 && (
            <div className={GROUP_ROWS_CLASS}>
              {limited.rows.map((row) => renderSessionRow(row))}
              {renderFolderLimitToggle(UNBOUND_FOLDER_ID, limited)}
            </div>
          )}
        </ContextMenuPrimitive.Trigger>
        <MenuPopup align="start" side="bottom" className="min-w-40">
          <MenuItem onClick={() => openHome({ kind: 'unbound' })}>
            <Plus className="size-4" />
            {t('New temporary chat')}
          </MenuItem>
        </MenuPopup>
      </ContextMenuPrimitive.Root>
    );
  };

  /** One repository group: its header, then its rows. */
  const renderRepositoryGroup = (folder: (typeof visibleFolders)[number]) => {
    const expanded = groupExpanded(folder.projectId);
    const limited = limitFolderRows({
      rows: folder.rows,
      showAll: folderShowAll[folder.projectId] === true,
      queryActive,
      activeSessionId,
    });
    const newSessionWorkspaceId = folder.newSessionWorkspaceId;
    const folderRepo = repoByProjectId.get(folder.projectId);
    const diffTotals = sumFolderDiffTotals(folder, workspaces, diffStatsByPath);
    // Decision 167 §2: a row below names its own branch only off the main
    // workspace. Decision 183 §2.3: the header no longer names the main
    // branch; its tooltip still does.
    const primary = folderPrimaryChip(folder.projectId, workspaces);
    const folderName = sidebarFolderNameForDisplay(folder.projectId, folder.name, t);
    // S2 (H/18): ONE definition of the repository actions, rendered from both
    // entry points — the hover "more" button and the header's context menu.
    // Two copies would drift apart the first time either gains an action, and
    // "the two give the same menu" is the whole acceptance criterion.
    const repoMenuItems = folderRepo ? (
      <>
        <MenuItem onClick={() => setRepoToConfigure(folderRepo)}>
          <Settings />
          {t('Repository Settings')}
        </MenuItem>
        {/* Remote repositories have no local directory to open — same
            unsupported case `files.ts` throws on for
            `file:revealInFileManager`, handled here by hiding the action
            instead of exposing a click that always fails. */}
        {folderRepo.kind !== 'remote' && (
          <MenuItem onClick={() => void handleOpenRepositoryFolder(folderRepo.path)}>
            <Search />
            {navigator.platform.toUpperCase().indexOf('MAC') >= 0
              ? t('Reveal in Finder')
              : t('Reveal in Explorer')}
          </MenuItem>
        )}
        {onRemoveRepository && (
          <MenuItem variant="destructive" onClick={() => setRepoToRemove(folderRepo)}>
            <FolderMinus />
            {t('Remove repository')}
          </MenuItem>
        )}
      </>
    ) : null;
    const header = renderGroupHeader({
      name: folderName,
      nameSlot: 'sidebar-folder-name',
      tooltip: folderTooltip(folderName, primary, t),
      expanded,
      // Decision 137 §3 (user ruling, replaces D29): the header folds and
      // unfolds this group and does nothing else — no conversation is opened
      // and the "New" target is left to the selected conversation. While a
      // search is typed it does nothing: the group is open for its matches.
      onToggle: queryActive
        ? undefined
        : () =>
            setExpandedProjects((prev) => ({
              ...prev,
              [folder.projectId]: !expanded,
            })),
      summary: deriveGroupSummary(folder.rows, unreadSessionIds),
      trailing: diffTotals && (
        <span
          className="flex items-center gap-1 text-meta tabular-nums"
          title={t('Folder diff totals', {
            insertions: diffTotals.insertions,
            deletions: diffTotals.deletions,
          })}
        >
          {diffTotals.insertions > 0 && (
            <span className="text-success">+{diffTotals.insertions}</span>
          )}
          {diffTotals.deletions > 0 && (
            <span className="text-destructive">-{diffTotals.deletions}</span>
          )}
        </span>
      ),
      actions: (
        <>
          {folderRepo && (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className={cn(GROUP_ACTION_CLASS, 'data-popup-open:opacity-100')}
                    aria-label={t('Repository actions')}
                    title={t('Repository actions')}
                  />
                }
              >
                <MoreHorizontal className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">{repoMenuItems}</MenuPopup>
            </Menu>
          )}
          {newSessionWorkspaceId && (
            <Button
              variant="ghost"
              size="icon-xs"
              className={GROUP_ACTION_CLASS}
              aria-label={t('New chat')}
              title={t('New session in {{folder}}', { folder: folderName })}
              // Decision 174: the home page, this repository picked.
              onClick={() => openHomeInFolder(newSessionWorkspaceId)}
            >
              <Plus className="size-3.5" />
            </Button>
          )}
        </>
      ),
    });
    return (
      <section
        key={folder.projectId}
        className={SIDEBAR_GROUP_CLASS}
        data-sidebar-group={folder.projectId}
      >
        {/* S2: right-click gives the same actions as the "more" button. Only
            wrapped when there ARE actions — the synthetic Temp folder has no
            repository behind it, and a trigger with an empty menu would
            swallow the right-click (Base UI's trigger stops the event) instead
            of letting it reach the list's menu below. */}
        {repoMenuItems ? (
          <ContextMenuPrimitive.Root>
            <ContextMenuPrimitive.Trigger render={header} />
            <MenuPopup align="start" side="bottom" className="min-w-40">
              {repoMenuItems}
            </MenuPopup>
          </ContextMenuPrimitive.Root>
        ) : (
          header
        )}
        {/* Decision 183 §1.5: an empty group shows its header only — its 「＋」
            is the way to start a chat there. */}
        {expanded && limited.rows.length > 0 && (
          <div className={GROUP_ROWS_CLASS}>
            {limited.rows.map((row) => {
              const tempItemId = tempItemIdByWorkspaceId.get(row.workspaceId);
              return renderSessionRow(
                row,
                chipShownInFolder(row, primary) ? row.chip?.label : undefined,
                tempItemId && onRequestTempDelete
                  ? () => onRequestTempDelete(tempItemId)
                  : undefined
              );
            })}
            {renderFolderLimitToggle(folder.projectId, limited)}
          </div>
        )}
      </section>
    );
  };

  return (
    // D08: no width, no border, no bars. `LeftDock` owns the column (and the
    // drag handle on its right edge); this is one surface inside it, laid out
    // over the dock's absolutely-positioned mount stack.
    <aside className="flex h-full w-full min-w-0 flex-col">
      {/* Decision 183 §1.10: the vertical nav, as in the reference. 「新建对话」
          opens the home page (decision 174); 「添加仓库」 the shared dialog. */}
      <div className="flex shrink-0 flex-col gap-px px-2 pt-2.5 pb-0.5">
        <button
          type="button"
          className={NAV_ITEM_CLASS}
          title={t('New chat (opens the home page)')}
          onClick={handleNewSession}
        >
          <span
            aria-hidden
            className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-selection text-foreground"
          >
            <Plus className="size-3.5" />
          </span>
          <span className="min-w-0 truncate">{t('New chat')}</span>
        </button>
        <button type="button" className={NAV_ITEM_CLASS} onClick={onAddRepository}>
          <span
            aria-hidden
            className="flex size-5.5 shrink-0 items-center justify-center text-muted-foreground"
          >
            <FolderPlus className="size-4" />
          </span>
          <span className="min-w-0 truncate">{t('Add Repository')}</span>
        </button>
      </div>

      {/* U31: both modes share this one h-7 row. A second row appearing only
          while selecting would push the list down on entry and pull it back on
          exit — the list is the thing being worked on, so it must not move
          under the pointer. Decision 167: `sm:text-meta` on every xs button
          here; the variant's desktop size is 12px (`sm:text-xs`), and these
          labels are CJK in Chinese, which the design system keeps at 14px or
          more. Decision 183 (user ruling 2026-10-12, prototype v6
          `.sep-line`): the top zone ends 8px below this row in a full-width
          hairline, the same in both modes, so the list starts at the same
          place either way. */}
      <div className={TOP_ZONE_END_CLASS}>
        <div className="flex h-7 items-center gap-0.5">
          {selecting ? (
            <>
              <span className="min-w-0 flex-1 truncate pl-2 text-meta">
                {t('{{count}} selected', { count: selection.size })}
              </span>
              <Button
                variant="outline"
                size="xs"
                className="h-6 shrink-0 sm:text-meta"
                disabled={selection.size === 0}
                title={t('Archive selected')}
                onClick={() => setBulkArchiveOpen(true)}
              >
                <Archive className="h-3.5 w-3.5" />
                {t('Archive')}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 shrink-0 sm:text-meta"
                onClick={() => setSelection(null)}
              >
                {t('Cancel')}
              </Button>
            </>
          ) : (
            <>
              {/* Decision 183 §2.1: always shown, no filter toggle, drawn like the
                prototype's `.search` (see `SIDEBAR_SEARCH_CLASS`). Decision 167
                (issue #3 item 5): coss's InputGroup, input FIRST and the icon
                addon after it — `order-first` draws the addon on the left, and
                its `[data-size=sm]+&` padding only matches in this order.
                `opacity-100` on the icon opts it out of the addon's 80% icon
                fade (`svg:not([class*='opacity-'])`). */}
              <InputGroup className={SIDEBAR_SEARCH_CLASS}>
                <InputGroupInput
                  size="sm"
                  value={query}
                  onChange={(event) => handleQueryChange(event.target.value)}
                  placeholder={t('Search sessions')}
                  aria-label={t('Search sessions')}
                />
                <InputGroupAddon align="inline-start">
                  <Search className="size-3.5 text-muted-foreground opacity-100" />
                </InputGroupAddon>
              </InputGroup>
              <Button
                variant="ghost"
                size="icon-xs"
                className={TOOL_BUTTON_CLASS}
                aria-label={toggleAllLabel}
                title={toggleAllLabel}
                disabled={queryActive || toggleGroupIds.length === 0}
                onClick={toggleAllGroups}
              >
                {allGroupsCollapsed ? (
                  <ChevronsUpDown className="size-4" />
                ) : (
                  <ChevronsDownUp className="size-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className={TOOL_BUTTON_CLASS}
                title={t('Select sessions to archive')}
                aria-label={t('Select sessions to archive')}
                onClick={() => setSelection(new Set())}
              >
                <ListChecks className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Decision 183 §1.10: ONE scrolling list — Temporary chats first, then
          the repositories (or, with none usable yet, the add-repository call
          to action). The list's own right-click offers Add repository
          (decision 183 §2.10); a group header or a row answers its own
          right-click first. A grid row, not a flex box, so the ScrollArea
          root's `height: 100%` resolves and the viewport scrolls; `grid-cols-1`
          keeps nowrap titles from widening the column past the panel. */}
      <ContextMenuPrimitive.Root>
        <ContextMenuPrimitive.Trigger
          render={<div className={LIST_AREA_CLASS} />}
          // Decision 170 ruling 6: hold the group order while the pointer or
          // keyboard focus is in the list (`useRegionHold`).
          {...listHold.regionProps}
        >
          <ScrollArea>
            <div className="px-2 pt-0.5 pb-3">
              {noMatches && (
                <p className="px-2 py-1 text-meta text-muted-foreground">
                  {t('No matching sessions')}
                </p>
              )}
              {renderTemporaryGroup()}
              {showAddRepositoryEmptyState ? (
                // Seed sessions point at empty-path workspaces and cannot send,
                // so surface the entry point instead of a misleading tree. U13:
                // temporary chats run without a repository, so their group
                // stays above the call to action.
                <Empty className="mt-2 gap-3 border-0 p-2 md:p-2">
                  <EmptyMedia variant="icon">
                    <FolderGit2 className="h-4.5 w-4.5" />
                  </EmptyMedia>
                  <EmptyHeader>
                    {/* D25 §3.3: EmptyTitle's shared base now carries a
                        negative tracking meant for its 18px default — this
                        compact sidebar usage shrinks to 15px (text-ui) and may
                        render CJK, so tracking must be cancelled back to
                        normal (negative tracking + CJK is the banned
                        combination). */}
                    <EmptyTitle className="text-ui tracking-normal">
                      {t('Add Repository')}
                    </EmptyTitle>
                    <EmptyDescription className="text-meta">
                      {t('Add a repository to get started.')}
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 sm:text-meta"
                    onClick={onAddRepository}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('Add Repository')}
                  </Button>
                </Empty>
              ) : (
                visibleFolders.map(renderRepositoryGroup)
              )}
            </div>
          </ScrollArea>
        </ContextMenuPrimitive.Trigger>
        <MenuPopup align="start" side="bottom" className="min-w-40">
          <MenuItem onClick={() => onAddRepository?.()}>
            <FolderPlus className="size-4" />
            {t('Add Repository')}
          </MenuItem>
        </MenuPopup>
      </ContextMenuPrimitive.Root>

      {repoToConfigure && (
        <RepositorySettingsDialog
          open
          repoPath={repoToConfigure.path}
          repoName={repoToConfigure.name}
          onOpenChange={(open) => {
            if (!open) setRepoToConfigure(null);
          }}
        />
      )}

      <AlertDialog
        open={!!repoToRemove}
        onOpenChange={(open) => {
          if (!open) setRepoToRemove(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Remove repository')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Are you sure you want to remove {{name}} from the workspace?', {
                name: repoToRemove?.name ?? '',
              })}
              <span className="block mt-2 text-muted-foreground">
                {t('This will only remove it from the app and will not delete local files.')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setRepoToRemove(null)}>
              {t('Cancel')}
            </Button>
            <Button variant="destructive" onClick={handleConfirmRemoveRepo}>
              {t('Remove')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {/* U31: archiving a selection is the one bulk action here, and Archive is
          already the repo's "remove from the nav for good" — so it asks first,
          and says how many, the same way the single-row confirmation names the
          one. */}
      <AlertDialog open={bulkArchiveOpen} onOpenChange={setBulkArchiveOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Archive selected sessions')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Archive {{count}} sessions? They will be removed from the sidebar.', {
                count: selection?.size ?? 0,
              })}
              <span className="mt-2 block text-muted-foreground">
                {t('Their history stays on disk; this only clears them out of the list.')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setBulkArchiveOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const ids = [...(selection ?? [])];
                setBulkArchiveOpen(false);
                // Selection mode ends here rather than after the awaits: the
                // rows are on their way out, and leaving checkboxes on a list
                // that is about to change under them reads as unfinished.
                setSelection(null);
                void archiveMany(ids);
              }}
            >
              {t('Archive')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </aside>
  );
}

/**
 * Decision 183: the list area — the one scroll region below the tool row. A
 * single-row grid, so the ScrollArea root's `height: 100%` resolves against a
 * definite track (a flex item sized by its content never gives it one), and
 * `grid-cols-1` because the implicit `auto` column grows to the rows'
 * min-content width (nowrap titles) and pushes every row past the panel edge.
 */
const LIST_AREA_CLASS = 'grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)]';

/**
 * Decision 183 (user ruling 2026-10-12, prototype v6 `.sep-line`): the top zone
 * (nav + search row) ends 6px + h-7 + 8px down in ONE full-width hairline —
 * the border sits on this full-width box, outside its `px-2`. The other zone
 * line is the account footer's top border (`UserFooterPill`); nothing else in
 * the panel has one.
 */
const TOP_ZONE_END_CLASS = 'shrink-0 border-b px-2 pt-1.5 pb-2';

/**
 * Decision 183 (prototype `.group`): groups are separated by spacing alone —
 * 8px above the first, 14px between the rest. No divider, no region title.
 */
const SIDEBAR_GROUP_CLASS = 'mt-3.5 first:mt-2';

/** Header → first row 2px, rows 2px apart (prototype `.rows`). Not indented. */
const GROUP_ROWS_CLASS = 'mt-0.5 space-y-0.5';

/**
 * The top nav's two entries (prototype `.nav`): h-8, 15px, a 22px icon slot
 * (`size-5.5`), the hover step on hover and keyboard focus.
 */
const NAV_ITEM_CLASS =
  'flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-left text-ui hover:bg-hover focus-visible:bg-hover';

/**
 * The search box (prototype `.search`; user ruling 2026-10-11): coss's
 * InputGroup with its default chrome taken off on this one instance — resting,
 * a transparent fill (light and dark) inside a 1px `--border` line, no drop
 * shadow and no inner shade; focused, the `--background` fill and a
 * `--muted-foreground` line, no ring. `rounded-sm` because the group's
 * `rounded-lg` on an h-7 control breaks the radius clamp rule.
 *
 * Each override names the SAME variant stack as the base class it replaces,
 * so tailwind-merge drops the base one instead of leaving both to a
 * specificity contest (`border-border` / `border-input`, `bg-transparent` /
 * `bg-background`, `dark:bg-transparent` / `dark:bg-input/32`, `shadow-none` /
 * `shadow-xs`, and the `has-[input:focus-visible,…]` trio replacing
 * `border-ring` and `ring-2`). The focused fill is a `has-[…]` variant, whose
 * `:has()` argument outranks `bg-transparent` and `dark:bg-transparent` in
 * specificity. The inner shade lives on the group's `::before` behind two long
 * `not-has-[…]` stacks (light and dark); `before:hidden` removes the pseudo
 * element instead, since nothing else sets its `display`. The placeholder is
 * the full muted ink (the input's own is `/72`): the descendant selector
 * outranks the input's single class. Asserted on the rendered className in
 * `sidebarActiveAndFolders.test.ts`.
 */
const SIDEBAR_SEARCH_CLASS =
  'h-7 min-w-0 flex-1 rounded-sm border-border bg-transparent shadow-none before:hidden dark:bg-transparent has-[input:focus-visible,textarea:focus-visible]:border-muted-foreground has-[input:focus-visible,textarea:focus-visible]:bg-background has-[input:focus-visible,textarea:focus-visible]:ring-0 [&_input]:placeholder:text-muted-foreground';

/**
 * The tool row's icon buttons (prototype `.tb`): 28px, a 16px icon. `sm:size-7`
 * because the `icon-xs` variant's desktop `sm:size-6` would otherwise win.
 */
const TOOL_BUTTON_CLASS = 'size-7 shrink-0 text-muted-foreground sm:size-7';

/**
 * A group header's hover buttons (prototype `.ib`): 20px, shown while the
 * pointer or KEYBOARD focus is in the header — `group-has-focus-visible`, not
 * `group-focus-within`, so the focus a click leaves on the header does not
 * keep them up after the pointer has gone, while Tab still reaches them.
 * `sm:size-5` for the same reason as above.
 */
const GROUP_ACTION_CLASS =
  'size-5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 sm:size-5';

/**
 * Decision 183 §1.3 (prototype `.vA .gh`): the group header shared by every
 * repository and Temporary chats — the reference's grey label, 14px / 400 /
 * muted, the soft ink on hover, no folder icon and no hover fill. The chevron
 * follows the name: ▸ always while folded, ▾ only on hover or keyboard focus
 * while open (§1.6). Folded, a summary of the rows' markers follows it
 * (§2.2), since the rows that carry them are hidden.
 *
 * The header is a `div` holding sibling buttons — a nested button would be
 * invalid HTML (the McpSection trap of d68d3c6). The trailing totals and the
 * hover buttons share ONE grid cell, so the cell is as wide as whichever is
 * wider and the header cannot reflow when the numbers give way on hover.
 *
 * A plain function returning the element, not a component: a repository
 * header is handed to `ContextMenuPrimitive.Trigger render={…}`, which needs a
 * DOM element to put its props on.
 */
function renderGroupHeader({
  name,
  nameSlot,
  tooltip,
  expanded,
  onToggle,
  summary,
  trailing,
  actions,
}: {
  name: string;
  nameSlot: 'sidebar-folder-name' | 'sidebar-temporary-name';
  tooltip: string;
  expanded: boolean;
  /** Undefined while a search is typed: the group is held open for its matches. */
  onToggle?: () => void;
  summary: SidebarGroupSummary | null;
  trailing?: ReactNode;
  actions: ReactNode;
}): ReactElement {
  return (
    <div className="group flex h-7 w-full items-center gap-1 rounded-sm px-2 has-focus-visible:bg-hover">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left text-meta text-muted-foreground group-hover:text-foreground-soft group-has-focus-visible:text-foreground-soft"
        title={tooltip}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span data-slot={nameSlot} className="min-w-0 truncate">
          {name}
        </span>
        <span
          aria-hidden
          data-slot="sidebar-group-chevron"
          className={cn(
            'flex shrink-0 items-center text-muted-foreground',
            expanded && 'opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100'
          )}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
        {!expanded && summary && <GroupSummaryMarks summary={summary} />}
      </button>
      <span className="grid shrink-0 justify-items-end">
        {trailing && (
          <span className="col-start-1 row-start-1 flex items-center group-hover:invisible group-has-focus-visible:invisible">
            {trailing}
          </span>
        )}
        <span className="col-start-1 row-start-1 flex items-center">{actions}</span>
      </span>
    </div>
  );
}

/**
 * Decision 183 §2.2: what a folded group is hiding, in the rows' own marks —
 * a spinner for turns running (with the count past one), the orange dot for a
 * chat waiting on the user, then red for an unseen failure or else green for
 * an unseen result. Each says itself in words for screen readers.
 */
function GroupSummaryMarks({ summary }: { summary: SidebarGroupSummary }) {
  const { t } = useI18n();
  const runningLabel = t('{{count}} chats running', { count: summary.running });
  const unreadLabel =
    summary.unread === 'failed'
      ? t('A chat failed while you were away')
      : t('A chat finished while you were away');
  return (
    <span
      data-slot="sidebar-group-summary"
      className="ml-0.5 flex shrink-0 items-center gap-1 text-meta text-muted-foreground tabular-nums"
    >
      {summary.running > 0 && (
        <span className="flex items-center gap-0.5" title={runningLabel}>
          <Spinner aria-label={runningLabel} className="size-3 shrink-0 text-status-running" />
          {summary.running > 1 && summary.running}
        </span>
      )}
      {summary.waiting && (
        <span
          role="img"
          aria-label={t('A chat is waiting for you')}
          title={t('A chat is waiting for you')}
          className="size-1.5 shrink-0 rounded-full bg-warning"
        />
      )}
      {summary.unread && (
        <span
          role="img"
          aria-label={unreadLabel}
          title={unreadLabel}
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            summary.unread === 'failed' ? 'bg-destructive' : 'bg-success'
          )}
        />
      )}
    </span>
  );
}

/**
 * Decision 170 (issue #6 ruling 6): the order a list had when a hold began,
 * kept until the hold ends (null while there is none). Captured during render
 * — React's "adjust state while rendering" pattern — so the first held render
 * already uses it.
 */
function useHeldOrder(live: readonly string[], held: boolean): readonly string[] | null {
  const [snapshot, setSnapshot] = useState<readonly string[] | null>(null);
  if (held && snapshot === null) {
    setSnapshot(live);
    return live;
  }
  if (!held && snapshot !== null) {
    setSnapshot(null);
  }
  return held ? snapshot : null;
}

/**
 * Keyboard focus, as opposed to the focus a mouse click leaves on a row:
 * `:focus-visible`. A browser that cannot answer counts as keyboard focus —
 * holding the order a moment too long is the safe side.
 */
function hasKeyboardFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Decision 170 (issue #6 ruling 6): is the pointer, or keyboard focus, in a
 * region? Spread `regionProps` on the region (since decision 183, the whole
 * list); `held` says whether it is.
 *
 * - Pointer: React computes enter / leave over its own tree, so a popup
 *   portaled out of the region's DOM (a row's menu) still counts as inside.
 * - Keyboard focus only: the focus a click leaves on a row must not keep the
 *   region held after the pointer has gone. Focus moving into a portaled popup
 *   arrives here as a fresh focus event, because React bubbles through portals.
 * - A focused element that is removed (a row's ✕) takes focus with it and no
 *   blur event follows, and the repositories go away with the last one. The
 *   check after every commit lets go in both cases instead of holding for
 *   good.
 */
function useRegionHold(mounted: boolean) {
  const [pointerInside, setPointerInside] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const focusTargetRef = useRef<EventTarget | null>(null);

  useEffect(() => {
    if (!mounted) {
      if (pointerInside) setPointerInside(false);
      if (keyboardFocus) setKeyboardFocus(false);
      return;
    }
    if (keyboardFocus && document.activeElement !== focusTargetRef.current) {
      setKeyboardFocus(false);
    }
  });

  return {
    held: mounted && (pointerInside || keyboardFocus),
    regionProps: {
      onPointerEnter: () => setPointerInside(true),
      onPointerLeave: () => setPointerInside(false),
      onFocus: (event: FocusEvent<HTMLElement>) => {
        focusTargetRef.current = event.target;
        setKeyboardFocus(hasKeyboardFocus(event.target));
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        setKeyboardFocus(false);
      },
    },
  };
}

/**
 * Decision 167 / 183: the list's own L4 rows — "View more (N)" and "Show
 * less". h-7 like a row (prototype `.aux`), 14px, muted; the empty leading
 * `w-4` slot puts the text in the same column as the chat titles.
 */
function SidebarAuxRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-meta text-muted-foreground tabular-nums hover:bg-hover focus-visible:bg-hover"
      onClick={onClick}
    >
      <span aria-hidden className="flex w-4 shrink-0 items-center justify-center" />
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

/**
 * Issue 26: how many focus thefts one rename edit undoes before it gives up and
 * commits what was typed. Two covers the menu's late focus return plus one
 * straggler; more would only prolong a fight with a dialog's focus trap.
 */
const RENAME_REFOCUS_BUDGET = 2;
/**
 * Issue 26: a blur within this long after a pointer press elsewhere (or Tab,
 * or a shortcut) is the user leaving the editor. The press and the blur are one
 * gesture, so the window only has to cover event dispatch.
 */
const RENAME_LEAVE_INTENT_MS = 1000;
/** Problem 36 (decision 145): marks the rename editor as the owner of Escape. */
const RENAME_EDITOR_HOLDS_ESCAPE = { [SURFACE_ESCAPE_HOLD_ATTR]: '' };

interface SessionRowProps {
  row: SidebarSessionRow;
  /** Decision 167 §3: where the chat runs, for the tooltip's second line. */
  place: SidebarRowPlace;
  /**
   * Decision 167 §2: the full branch of a chat on a non-main workspace (a
   * linked worktree), passed only inside its folder (`chipShownInFolder`).
   * The row shows its last segment; Temporary chats never passes it.
   */
  branch?: string;
  active: boolean;
  pendingApprovalCount: number;
  /**
   * D12: this session has a live worker — it is started and still attached,
   * whether or not it is the one on screen. Clicking a row STARTS the session,
   * so the list has to say which ones already are; without it the only feedback
   * for "it is already running" is that nothing visibly happens.
   */
  started: boolean;
  /**
   * S3 (H/18): this session's last turn ENDED somewhere the user was not
   * looking. Cleared the moment the conversation is opened, so it answers
   * "is there a result here I have not seen", not "did it ever finish".
   */
  unread: boolean;
  /**
   * U31: set only while the sidebar is in selection mode. Presence is what puts
   * the row in that mode — a `selecting` boolean beside them would be a third
   * source for a fact these two already carry.
   */
  selected?: boolean;
  onToggleSelect?: (sessionId: string) => void;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  /** Set only for rows whose workspace is a Temp session (see `tempItemIdByWorkspaceId`
   * in LeftNav) — renders a third hover action that deletes the whole Temp directory. */
  onDeleteTemp?: () => void;
}

function SessionRow({
  row: sourceRow,
  place,
  branch,
  active,
  pendingApprovalCount,
  started,
  unread,
  selected,
  onToggleSelect,
  onSelect,
  onClose,
  onRename,
  onArchive,
  onDeleteTemp,
}: SessionRowProps) {
  const { t, locale } = useI18n();
  // Decision 144: the row as shown. A placeholder title (`New chat`) is an
  // identifier; every use below reads it in the UI language, so a rename that
  // leaves the shown title untouched is still "no change".
  const row = useMemo(() => sidebarRowForDisplay(sourceRow, t), [sourceRow, t]);
  // Decision 167 §3: title / folder · branch / updated at (date and time).
  const tooltip = sidebarRowTooltip({
    title: row.title,
    place,
    updatedAt: row.updatedAt,
    locale,
    t,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.title);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const unreadLabel = row.failed
    ? t('Failed while you were away')
    : t('Finished while you were away');
  const waitingLabel =
    row.status === 'waiting_question' ? t('Waiting for an answer') : t('Waiting for approval');
  const titleParts = splitBranchSuffix(row.title);

  // Point-check issue 26 (decision 138). The editor used to lose focus to the
  // chat composer 1–3 ms after it appeared, and its blur then ended the edit
  // with the old title. The thief was the context menu handing focus back as
  // it unmounted: its trigger (this row) was gone, so Base UI fell back to the
  // last element in its module-wide "previously focused" list — the composer,
  // whenever some earlier popup had been opened from it.
  const inputRef = useRef<HTMLInputElement>(null);
  // Set while an edit is open. The row's menu reads it through `finalFocus` and
  // leaves focus alone instead of returning it.
  const renamingRef = useRef(false);
  // When the pointer or the keyboard last asked to leave the editor. A blur
  // without one was not the user's doing.
  const leaveIntentAtRef = useRef(0);
  // How many times a blur the user did not ask for is undone per edit — a cap
  // so the editor cannot fight a dialog's focus trap forever.
  const refocusBudgetRef = useRef(0);
  // Decision 156 (decision 145's finding 7): the row the editor replaced, and
  // whether focus goes back to it once the editor is gone. Escape cancels from
  // the keyboard; leaving focus on <body> made the next key go nowhere.
  const rowRef = useRef<HTMLDivElement>(null);
  const refocusRowRef = useRef(false);

  const endEditing = () => {
    renamingRef.current = false;
    setEditing(false);
  };

  const commitRename = () => {
    if (!renamingRef.current) return;
    const trimmed = draft.trim();
    if (trimmed && trimmed !== row.title) {
      onRename(trimmed);
    } else {
      setDraft(row.title);
    }
    endEditing();
  };

  const cancelRename = () => {
    setDraft(row.title);
    refocusRowRef.current = true;
    endEditing();
  };

  useEffect(() => {
    if (editing || !refocusRowRef.current) return;
    refocusRowRef.current = false;
    rowRef.current?.focus();
  }, [editing]);

  const beginRename = () => {
    renamingRef.current = true;
    leaveIntentAtRef.current = 0;
    refocusBudgetRef.current = RENAME_REFOCUS_BUDGET;
    setDraft(row.title);
    setEditing(true);
  };

  // A pointer press anywhere but the editor is the user leaving it. Capture
  // phase, so a handler that stops propagation cannot hide the press.
  useEffect(() => {
    if (!editing) return;
    const markLeave = (event: Event) => {
      const input = inputRef.current;
      if (input && event.target instanceof Node && input.contains(event.target)) return;
      leaveIntentAtRef.current = Date.now();
    };
    document.addEventListener('pointerdown', markLeave, true);
    document.addEventListener('mousedown', markLeave, true);
    return () => {
      document.removeEventListener('pointerdown', markLeave, true);
      document.removeEventListener('mousedown', markLeave, true);
    };
  }, [editing]);

  const handleEditorBlur = () => {
    if (!renamingRef.current) return;
    if (Date.now() - leaveIntentAtRef.current < RENAME_LEAVE_INTENT_MS) {
      commitRename();
      return;
    }
    // The window itself lost focus (another app, a devtools window): keep the
    // edit open; the editor gets focus back with the window.
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return;
    // Code moved focus away. Take it back instead of treating it as "done" —
    // committing here is what used to end the edit with the old title.
    if (refocusBudgetRef.current > 0) {
      refocusBudgetRef.current -= 1;
      setTimeout(() => {
        if (renamingRef.current) inputRef.current?.focus();
      }, 0);
      return;
    }
    commitRename();
  };

  const requestArchive = () => {
    setArchiveConfirmOpen(true);
  };

  const confirmArchive = () => {
    setArchiveConfirmOpen(false);
    onArchive();
  };

  if (editing) {
    return (
      // P1-7e e6 (problem 36, decision 145): the editor owns Escape. The dock
      // listens in the capture phase and used to take the key first, folding
      // the whole sidebar away with the edit still open behind it; marked like
      // any other surface that answers Escape itself (`SURFACE_ESCAPE_HOLD_ATTR`).
      <div
        className="flex h-7 w-full items-center gap-1 rounded-sm px-1"
        {...RENAME_EDITOR_HOLDS_ESCAPE}
      >
        <Input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={handleEditorBlur}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelRename();
            } else if (event.key === 'Tab' || event.ctrlKey || event.metaKey || event.altKey) {
              // Tab and shortcuts move focus on the user's behalf.
              leaveIntentAtRef.current = Date.now();
            }
          }}
          // Decision 167: the radius clamp rule (design system, Border
          // Radius) — the primitive's `rounded-lg` on h-6 renders as a pill.
          // Decision 170: the row's own 14px, so a rename does not grow the text.
          className="h-6 flex-1 rounded-sm text-meta before:rounded-[calc(var(--radius-sm)-1px)]"
        />
      </div>
    );
  }

  return (
    <>
      <ContextMenuPrimitive.Root>
        <ContextMenuPrimitive.Trigger
          ref={rowRef}
          className={cn(
            // --hover / --selection are two distinct steps of the same Flexoki
            // interactive ramp; neither takes a /N modifier.
            // The two are mutually exclusive on purpose: `hover:bg-hover` compiles to
            // `.hover\:bg-hover:hover` (0,2,0) and would outrank a plain `.bg-selection`
            // (0,1,0), so pointing at the active row would repaint it as an ordinary
            // hovered row and erase the selection. Keyboard focus (decision 167) lights
            // the same step as hover; the global reset removed the outline.
            // overflow-hidden is load-bearing, not cosmetic: `min-w-20` on the title
            // makes the row's minimum content size exceed the track at the default
            // sidebar width, and without it the trailing items would spill past the
            // rounded edge instead of the branch text absorbing the deficit.
            // Decision 170 (issue #6 rulings 3–4): 14px, and the title one step
            // below the body ink — `--foreground-soft`, never with /N — except
            // on the open chat, which keeps the body colour. `relative`
            // anchors the floating actions (decision 183 §1.4).
            'group relative flex h-7 w-full items-center gap-1.5 overflow-hidden rounded-sm px-2 text-left text-meta',
            active
              ? 'bg-selection text-accent-foreground'
              : 'text-foreground-soft hover:bg-hover focus-visible:bg-hover'
          )}
          onClick={() => (onToggleSelect ? onToggleSelect(row.sessionId) : onSelect())}
          onDoubleClick={onToggleSelect ? undefined : beginRename}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (onToggleSelect) onToggleSelect(row.sessionId);
              else onSelect();
            }
          }}
          title={tooltip}
        >
          {/* Decision 167: ONE fixed `w-4` status slot at the head of every row,
              rendered even when empty, so the title never moves when a run
              starts or ends or selection mode begins (decision 138 §2 accepted
              a 6px shift; this retires it). */}
          <span className="flex w-4 shrink-0 items-center justify-center">
            {/* U31: the checkbox replaces the run-state dot rather than joining
              it. Both want the same slot at the row's head, and while the
              user is choosing what to archive, "is it selected" is the fact
              that matters — the dot comes back the moment selection ends. */}
            {onToggleSelect && (
              <span
                aria-hidden
                className={cn(
                  'flex size-3.5 shrink-0 items-center justify-center rounded-xs border',
                  selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                )}
              >
                {selected && <Check className="size-2.5" />}
              </span>
            )}
            {/* The marker, in one slot so rows never jump: spinner = running,
              filled green/red = an unread result (S3), ring = started (a
              worker is attached in the background), faint ring = not started
              (decision 183 §1.7: every row carries a mark, so they line up).
              One slot, not several — a second dot would widen the row and push
              the title, and only ever one of these is the fact worth acting on.

              Order is urgency, and it is also why nothing is lost by sharing
              the slot: `busy` outranks `unread` because a session cannot be
              running and holding an unseen result at the same time (the result
              is what ends the run), and `unread` outranks `started` because
              "attached in the background" is exactly the state every unread row
              is in — showing the ring there would say the less useful half. */}
            {/* Decision 137 §1: a running turn spins; a turn parked on an
              approval card or a question shows an attention dot instead,
              because the next move is the user's. Both carry their state in
              words for the tooltip and screen readers. */}
            {onToggleSelect ? null : row.busy ? (
              isWaitingSessionStatus(row.status) ? (
                <span
                  role="img"
                  aria-label={waitingLabel}
                  title={waitingLabel}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                />
              ) : (
                <Spinner
                  aria-label={t('Running')}
                  className="size-3 shrink-0 text-status-running"
                />
              )
            ) : unread ? (
              // Not `aria-hidden` like its neighbours: the run-state dots restate
              // something the row's own text already implies, while this one is
              // the ONLY carrier of "there is a result here you have not seen".
              <span
                role="img"
                aria-label={unreadLabel}
                title={unreadLabel}
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  row.failed ? 'bg-destructive' : 'bg-success'
                )}
              />
            ) : started ? (
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground"
                title={t('Running in the background')}
              />
            ) : (
              // `--muted-foreground-faint`: the muted ink mixed toward the
              // sidebar's surface, so "not started" reads a step quieter than
              // "attached in the background". A colour token; never add /N.
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground-faint"
                title={t('Not started')}
              />
            )}
          </span>
          {/* `min-w-20` is the whole point of this row's sizing (S2 b). The title is
          the row's identity and the only user-authored text on it, so it gets a
          floor and everything else yields to it. Without the floor `flex-1
          min-w-0` shrinks to whatever is left. Budget at the 280px default
          (decision 183: rows are not indented and the time box is gone; the
          hover actions float over the row instead of taking width): the
          panel's 280 includes its 1px right border, so 280 - 1 - 16 (the
          list's px-2) - 16 (the row's px-2) = 247px of content; minus the
          16px status slot and one 6px gap, the title gets 225px
          (SIDEBAR_DEFAULT_WIDTH - DOCK_RAIL_WIDTH = 280). */}
          {titleParts.suffix === null ? (
            <span className="min-w-20 flex-1 truncate">{row.title}</span>
          ) : (
            // Point-check issue 32 (decision 138): the 1.0.x branch suffix is
            // what tells a moved copy from its original (decision 131), so it
            // stays whole and only the part before it gives way. The row's
            // tooltip still starts with the whole string.
            <span
              className={cn(
                'flex min-w-20 flex-1 items-baseline overflow-hidden',
                titleParts.spaced && 'gap-1'
              )}
            >
              <span className="min-w-0 truncate">{titleParts.base}</span>
              <span className="shrink-0 text-muted-foreground">{titleParts.suffix}</span>
            </span>
          )}
          {/* Alert badges are state, not context, so they stay on every row.
              Decision 167 unified them at Badge `lg` (14px
              on desktop; revises decisions 144 §2 and 123 §13, which kept the
              Latin-only marks at `sm`'s 10px). */}
          {/* dsh-rebase P1-9e (decision 051): the legacy copy of a migrated
              chat, continued in 1.0.x since. It sits next to the migrated
              chat under the same title, so the mark is what tells the two
              apart; the tooltip says what continuing it does. The label is
              the version alone. */}
          {row.legacyDiverged && (
            <Badge
              variant="warning"
              size="lg"
              className="shrink-0"
              title={t(LEGACY_DIVERGED_HINT)}
              aria-label={t(LEGACY_DIVERGED_HINT)}
            >
              1.0.x
            </Badge>
          )}
          {pendingApprovalCount > 0 && (
            <Badge
              variant="warning"
              size="lg"
              className="shrink-0 gap-0.5 tabular-nums"
              aria-label={t('{{count}} pending approval requests', {
                count: pendingApprovalCount,
              })}
              title={t('{{count}} pending approval requests', {
                count: pendingApprovalCount,
              })}
            >
              <ShieldQuestion className="size-3.5" />
              {pendingApprovalCount}
            </Badge>
          )}
          {/* Decision 144: in the UI language, and at the badge's large size
              (14px on desktop) because the word is CJK in Chinese — the design
              system does not let CJK sit at the small size's 10px. */}
          {row.failed && (
            <Badge variant="destructive" size="lg" className="shrink-0">
              {t('Failed')}
            </Badge>
          )}
          {branch && (
            // Decision 167 §2 (replaces D21-A): context text, only for a chat
            // on a non-main workspace (a linked worktree), only inside its
            // folder, and only the branch's last segment — the full name is
            // its tooltip. It is the row's sole yielder: the only trailing
            // item that is unbounded user data and recoverable elsewhere (the
            // tooltip, the Composer target bar), so when the row runs out of
            // width this gives — never the title. `shrink` + `min-w-0` is what
            // lets flexbox route the deficit here; dropping either sends it
            // back to the title.
            <span
              className="min-w-0 max-w-24 shrink truncate text-meta text-muted-foreground"
              title={branch}
            >
              {lastBranchSegment(branch)}
            </span>
          )}
          {/* Decision 183 §1.4: no time on the row (the absolute time is the
          tooltip's third line). The actions float over the row's right edge on
          hover, painted in the row's own fill with a fade to the left, so the
          title never reflows. KEYBOARD focus also reveals them — on the row
          itself (`group-focus-visible`, the row has tabIndex=0) or on one of
          its buttons (`group-has-focus-visible`) — which keeps Archive /
          Remove reachable by Tab (display:none alone would drop them from the
          tab order). Not `group-focus-within`: the focus a click leaves on the
          row would keep them up after the pointer has gone. Not in selection
          mode: there a click picks the row. Decision 167: the buttons are
          `size-5 sm:size-5` (20px); a bare `size-5` loses to the variant's
          `sm:size-6`. */}
          {!onToggleSelect && (
            <div
              data-slot="sidebar-row-actions"
              className={cn(
                'absolute inset-y-1 right-1.5 hidden items-center group-hover:flex group-focus-visible:flex group-has-focus-visible:flex',
                active
                  ? 'bg-selection shadow-[-10px_0_8px_var(--selection)]'
                  : 'bg-hover shadow-[-10px_0_8px_var(--hover)]'
              )}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-5 sm:size-5"
                // Decision 149 §12 / 156: in the UI language, like the menu's 「归档」.
                aria-label={t('Archive session')}
                title={t('Archive')}
                onClick={(event) => {
                  event.stopPropagation();
                  requestArchive();
                }}
              >
                <Archive className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-5 sm:size-5"
                // Not "Close": this is the list's remove, not the run's end (the
                // context menu's "End conversation" is that one). The title says
                // which of the two it is, because the difference — the row comes
                // back on the next launch — is not visible from an ✕.
                aria-label={t('Remove from the list')}
                title={t('Remove from the list (it comes back after a restart)')}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose();
                }}
              >
                <X className="size-3.5" />
              </Button>
              {onDeleteTemp && <DeleteTempButton onDelete={onDeleteTemp} />}
            </div>
          )}
        </ContextMenuPrimitive.Trigger>

        <MenuPopup
          align="start"
          side="bottom"
          className="min-w-40"
          // Issue 26: once Rename replaced this row with the editor, handing
          // focus "back" can only land on some stale element — the composer.
          // Any other close returns focus as usual.
          finalFocus={() => !renamingRef.current}
        >
          <MenuItem onClick={beginRename}>
            <Pencil className="size-4" />
            {t('Rename')}
          </MenuItem>
          {/* D12: the home D09's action found after the tab strip was deleted.
              Placed above Archive so the repo's three closes read in order of
              severity — end the run, then remove from the list. Only offered
              when there IS a run: on a session with no worker it would be a
              menu item that does nothing. */}
          {started && (
            <MenuItem onClick={() => setEndConfirmOpen(true)}>
              <Square className="size-4" />
              {t('End conversation')}
            </MenuItem>
          )}
          <MenuItem variant="destructive" onClick={requestArchive}>
            <Archive className="size-4" />
            {t('Archive')}
          </MenuItem>
        </MenuPopup>
      </ContextMenuPrimitive.Root>

      <AlertDialog open={endConfirmOpen} onOpenChange={setEndConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('End this conversation?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Ending “{{name}}” stops its agent and releases it from the background.', {
                name: row.title,
              })}
              {row.busy && (
                <span className="mt-2 block text-destructive">
                  {t('This conversation is still running; its current turn will be cut off.')}
                </span>
              )}
              <span className="mt-2 block text-muted-foreground">
                {t(
                  'It stays in the chat list, its history stays readable, and your next message starts it again.'
                )}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setEndConfirmOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setEndConfirmOpen(false);
                // Fire-and-forget: `endSessionRuntime` resets the local state
                // whether or not the detach IPC lands, and a failed detach
                // leaves nothing the user could act on from here.
                void endSessionRuntime(row.sessionId);
              }}
            >
              {t('End conversation')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Archive session')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Archive “{{name}}”? It will be removed from the sidebar.', {
                name: row.title,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setArchiveConfirmOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmArchive}>
              {t('Archive')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * Temp folder rows only (see `SessionRow`'s `onDeleteTemp`). Deletes the
 * whole Temp session directory via the same `openTempDelete` →
 * `TempWorkspaceDialogs` confirmation → `handleRemoveTempWorkspace` chain the
 * legacy shell uses (App.tsx), not a new confirm/remove path.
 */
function DeleteTempButton({ onDelete }: { onDelete: () => void }) {
  const { t } = useI18n();
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="size-5 text-muted-foreground hover:text-destructive sm:size-5"
      aria-label={t('Delete')}
      title={t('Delete')}
      onClick={(event) => {
        event.stopPropagation();
        onDelete();
      }}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}
