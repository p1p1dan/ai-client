import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import type { TempWorkspaceItem } from '@shared/types';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Folder,
  FolderGit2,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  ListChecks,
  ListFilter,
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
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
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
  deriveActiveRows,
  deriveFolderLastActivity,
  folderBranchLabel,
  folderPrimaryChip,
  folderTooltip,
  formatRelativeAge,
  isWaitingSessionStatus,
  LEGACY_DIVERGED_HINT,
  lastBranchSegment,
  limitActiveRows,
  limitFolderRows,
  orderFoldersByActivity,
  resolveHomePreselect,
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
 * The chrome it used to own moved to `LeftDock`, which hosts it: the h-9 bar
 * (now the dock's title row), the collapse button (on the rail since H/18 S4),
 * the account pill (`UserFooterPill`, so it survives a surface switch)
 * and the plugin entry + dialog (now the rail's bottom group). What stays is
 * exactly the session list — search, New / Add repository, the active chats,
 * the folder tree and the temporary chats.
 *
 * Decision 167 (GitHub issue #3) set the five levels; decision 170 (GitHub
 * issue #6, prototype in
 * `docs/plantree/plans/dsh-rebase/evidence/sidebar-regions-2026-10/`) split the
 * list into three regions, each with its own h-8 title and its own scroll
 * area: Active now (content-sized, at most 33% of the list area, gone while
 * nothing is active), Repositories (the rest) and Temporary chats
 * (content-sized, at most 25%, at the bottom). Sizes 16 / 15 / 14 for region /
 * folder / chat, weights 400 / 600 only; see `docs/design-system.md`,
 * 「侧栏层级（聊天面板）」.
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
  // to LeftNav and only feeds the header "New" button's preselection on the
  // home page (decision 174), it never becomes the source of truth for "where
  // to run" (that's the Composer target bar, T-27). Decision 137 §3: only
  // picking a conversation writes it now; a folder header click no longer does.
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  // Decision 170 (issue #6 ruling 2): the Active now region's chevron folds
  // its whole list. Memory only and open by default, like Temporary chats: the
  // region is the one meant to be read at a glance. Decision 137 §2's stored
  // "Recent collapsed" flag went away with Recent and is not migrated.
  const [activeCollapsed, setActiveCollapsed] = useState(false);
  // "View more" pressed on Active now — this run only, like a folder's.
  const [activeShowAll, setActiveShowAll] = useState(false);
  // Decision 137 §4: folders whose "View more" was pressed. Memory only, so it
  // holds across conversation switches and a folder collapse, and a restart
  // brings every folder back to its first rows.
  const [folderShowAll, setFolderShowAll] = useState<Record<string, boolean>>({});
  const [searchVisible, setSearchVisible] = useState(true);
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

  const toggleSearchVisible = () => {
    setSearchVisible((prev) => {
      const next = !prev;
      if (!next) {
        // A hidden filter must not silently prune the tree via a stale query.
        setQuery('');
      }
      return next;
    });
  };

  // Coarse minute tick: nothing else re-renders an idle sidebar, so without
  // it the age column freezes.
  const [, bumpClock] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    const timer = setInterval(bumpClock, 60_000);
    return () => clearInterval(timer);
  }, []);

  // Cheap at sidebar scale; a useMemo would be defeated by the per-render
  // `now` anyway (the age column needs a fresh clock every render).
  const now = Date.now();
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
  // U13: rendered next to the repository folders but deliberately NOT part of
  // `folders` — it has no workspace to create a chat in, so letting the "New"
  // target resolver see it would only produce a disabled button pointing at a
  // folder that cannot host anything. `null` when there are no such chats.
  // Uncommitted-change totals for the folder rows. Polls only the directories
  // that have a session running (see `useFolderDiffStats.ts`), so an idle
  // sidebar costs nothing.
  useFolderDiffStatsPolling(folders, workspaces);
  const diffStatsByPath = useWorktreeActivityStore((state) => state.diffStats);
  const unboundFolder = buildUnboundFolder({
    sessions,
    name: t('Temporary chats'),
    query,
    activeSessionId,
    t,
  });
  // Decision 137 §1: started on the engine in this run, or running a turn.
  // Decision 170 (issue #6 ruling 2): the whole top region — Recent and its
  // 48-hour list are gone (they move to the home page).
  const activeRows = deriveActiveRows({
    sessions,
    workspaces,
    hostBoundSessionIds,
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
  const limitedActive = limitActiveRows({
    rows: activeRows,
    showAll: activeShowAll,
    queryActive,
  });
  // Decision 170 (issue #6 ruling 6): folders by last activity, the empty ones
  // after them, the Temp Session project last. Display order only — the
  // repository store keeps the order they were added in. Held while the
  // pointer or keyboard focus is in the region, so nothing moves under a click.
  const liveFolderOrder = orderFoldersByActivity(
    folders,
    deriveFolderLastActivity({ workspaces, sessions })
  );
  const reposHold = useRegionHold(!showAddRepositoryEmptyState);
  const heldFolderOrder = useHeldOrder(
    liveFolderOrder.map((folder) => folder.projectId),
    reposHold.held
  );
  const orderedFolders = applyHeldFolderOrder(liveFolderOrder, heldFolderOrder);
  // While searching, folders with zero hits collapse away instead of leaving
  // a wall of empty headers; without a query every folder stays visible so
  // its "+ new chat" row remains reachable.
  const visibleFolders = queryActive
    ? orderedFolders.filter((folder) => folder.rows.length > 0)
    : orderedFolders;
  const noMatches =
    queryActive && activeRows.length === 0 && visibleFolders.length === 0 && !unboundFolder;

  /**
   * Decision 174 (issue #6, second wave; user ruling 2026-10-10): 「＋新建」
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

  /** Decision 174: a folder's 「＋」 and its empty 「新建对话」 row — the home page, this repository picked. */
  const openHomeInFolder = (workspaceId: string) => {
    const workspace = workspaceById.get(workspaceId);
    openHome(workspace ? { kind: 'path', path: workspace.path } : undefined);
  };

  /**
   * Decision 137 §4: the row that ends a capped folder — "View more (N)" while
   * rows are hidden, "Show less" once they are all listed. Nothing when the
   * folder fits. Shared by the repository folders and the temporary-chat group
   * so the two read the same.
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
   * Decision 170 (issue #6 ruling 7): fold every folder in Repositories, the
   * Temp Session project included. Over `folders` (all of them), not
   * `visibleFolders`, which a search narrows. One entry per folder rather than
   * a reset: the Temporary chats region keeps its own flag in the same map
   * (`UNBOUND_FOLDER_ID`) and is not part of this. Fold only — there is no
   * "expand all".
   */
  const collapseAllFolders = () =>
    setExpandedProjects((prev) => ({
      ...prev,
      ...Object.fromEntries(folders.map((folder) => [folder.projectId, false])),
    }));

  /**
   * Decision 170 (issue #6 ruling 2): the top region, 「正在活动」 only —
   * decision 137 §1's list, 5 rows behind "View more (N)". Not rendered at all
   * (title included) while nothing is active, so Repositories is then the
   * first region. The chevron folds the whole list (memory only).
   */
  const renderActiveRegion = () => {
    if (activeRows.length === 0) return null;
    return (
      <section className={ACTIVE_REGION_CLASS}>
        <SidebarSectionHeader title={t('Active now')}>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-6 text-muted-foreground"
            aria-label={activeCollapsed ? t('Expand active chats') : t('Collapse active chats')}
            title={activeCollapsed ? t('Expand active chats') : t('Collapse active chats')}
            onClick={() => setActiveCollapsed((prev) => !prev)}
          >
            {activeCollapsed ? (
              <ChevronRight className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </Button>
        </SidebarSectionHeader>
        {!activeCollapsed && (
          // Ruling 5: the bottom fade says the region holds more than it shows.
          <ScrollArea scrollFade="bottom">
            <div className="px-2 pt-0.5 pb-2">
              <div className="space-y-0.5">
                {limitedActive.rows.map((row) => (
                  <SessionRow
                    key={`active-${row.sessionId}`}
                    row={row}
                    place={placeOf(row)}
                    now={now}
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
                  />
                ))}
                {limitedActive.hiddenCount > 0 ? (
                  // Decision 145 §13's words, as on a folder.
                  <SidebarAuxRow onClick={() => setActiveShowAll(true)}>
                    {t('View more ({{count}})', { count: limitedActive.hiddenCount })}
                  </SidebarAuxRow>
                ) : (
                  limitedActive.collapsible && (
                    <SidebarAuxRow onClick={() => setActiveShowAll(false)}>
                      {t('Show less')}
                    </SidebarAuxRow>
                  )
                )}
              </div>
            </div>
          </ScrollArea>
        )}
      </section>
    );
  };

  /**
   * U13 — the temporary-chat group.
   *
   * Rendered from a helper rather than folded into the `visibleFolders` map
   * because it is shown in BOTH branches below: a machine with no repository
   * yet still shows the add-repository call to action, and that is exactly the
   * machine where every chat is unbound — hiding them there would leave the
   * user with a sidebar that admits to no sessions at all while their history
   * sits on disk.
   *
   * Decision 167 §5 (variant X): an L1 section of its own, not a folder in
   * Repositories — these chats belong to no repository. Its rows sit directly
   * under the title; the title's chevron folds them (the same memory-only state
   * the old folder header kept), and the section lists its first rows behind
   * the same "View more" as a repository folder (decision 137 §4, decision
   * 138 §5). Decision 170 (issue #6 ruling 1): a region of its own at the
   * bottom, content-sized up to 25% of the list area, scrolling inside itself.
   */
  const renderUnboundSection = () => {
    if (!unboundFolder) return null;
    const expanded = isProjectExpanded(UNBOUND_FOLDER_ID);
    const limited = limitFolderRows({
      rows: unboundFolder.rows,
      showAll: folderShowAll[UNBOUND_FOLDER_ID] === true,
      queryActive,
      activeSessionId,
    });
    return (
      // S1 (H/18): the partition's own right-click. It covers the header and
      // the gaps between rows; a right-click that lands ON a row opens that
      // row's menu instead, because Base UI's context-menu trigger stops the
      // event before it reaches this one.
      <ContextMenuPrimitive.Root>
        <ContextMenuPrimitive.Trigger render={<section className={TEMPORARY_REGION_CLASS} />}>
          <SidebarSectionHeader title={unboundFolder.name}>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground"
              aria-label={expanded ? t('Collapse temporary chats') : t('Expand temporary chats')}
              title={expanded ? t('Collapse temporary chats') : t('Expand temporary chats')}
              onClick={() =>
                setExpandedProjects((prev) => ({ ...prev, [UNBOUND_FOLDER_ID]: !expanded }))
              }
            >
              {expanded ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
            </Button>
          </SidebarSectionHeader>
          {expanded && (
            // Ruling 5: the bottom fade, as on Active now.
            <ScrollArea scrollFade="bottom">
              <div className="px-2 pt-0.5 pb-2">
                <div className="space-y-0.5">
                  {limited.rows.map((row) => (
                    <SessionRow
                      key={row.sessionId}
                      row={row}
                      place={placeOf(row)}
                      now={now}
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
                    />
                  ))}
                  {renderFolderLimitToggle(UNBOUND_FOLDER_ID, limited)}
                </div>
              </div>
            </ScrollArea>
          )}
        </ContextMenuPrimitive.Trigger>
        <MenuPopup align="start" side="bottom" className="min-w-40">
          {/* Decision 174: the home page with 「不选仓库（临时对话）」 picked;
              the temporary chat is made by its first send. */}
          <MenuItem onClick={() => openHome({ kind: 'unbound' })}>
            <Plus className="size-4" />
            {t('New temporary chat')}
          </MenuItem>
        </MenuPopup>
      </ContextMenuPrimitive.Root>
    );
  };

  return (
    // D08: no width, no border, no bars. `LeftDock` owns the column (and the
    // drag handle on its right edge); this is one surface inside it, laid out
    // over the dock's absolutely-positioned mount stack.
    <aside className="flex h-full w-full min-w-0 flex-col">
      <div className="space-y-2 border-b p-2">
        {/* U31: both modes share this one row. A second row appearing only
            while selecting would push the list down on entry and pull it back
            on exit — the list is the thing being worked on, so it must not move
            under the pointer. */}
        {/* Decision 167: `sm:text-meta` on every xs button here. The variant's
            desktop size is 12px (`sm:text-xs`), and these labels are CJK in
            Chinese, which the design system keeps at 14px or more; a plain
            `text-meta` would lose to the variant's media-query class. */}
        {selecting ? (
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-ui">
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
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="xs"
              className="h-6 sm:text-meta"
              title={t('New chat (opens the home page)')}
              onClick={handleNewSession}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('New')}
            </Button>
            {/* Replaces a permanently disabled "Workspace" placeholder: the
                    new shell had no reachable way to register a repository. */}
            <Button
              variant="outline"
              size="xs"
              className="h-6 min-w-0 sm:text-meta"
              title={t('Add Repository')}
              onClick={onAddRepository}
            >
              <FolderPlus className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{t('Add Repository')}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto h-6 w-6 shrink-0"
              title={t('Select sessions to archive')}
              aria-label={t('Select sessions to archive')}
              onClick={() => setSelection(new Set())}
            >
              <ListChecks className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {searchVisible && (
          // Decision 167 (issue #3 item 5): coss's InputGroup, input FIRST and
          // the icon addon after it — `order-first` draws the addon on the
          // left, and its `[data-size=sm]+&` padding only matches in this
          // order. The old absolutely positioned icon sat BEFORE an `Input`
          // whose wrapper is `relative` and opaque, so the wrapper painted
          // over it and the magnifier never showed in the light theme.
          // `rounded-sm` (and the hairline's matching radius) because the
          // group's `rounded-lg` on an h-7 control breaks the radius clamp
          // rule (design system, Border Radius).
          <InputGroup className="h-7 rounded-sm before:rounded-[calc(var(--radius-sm)-1px)]">
            <InputGroupInput
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search sessions')}
              aria-label={t('Search sessions')}
            />
            <InputGroupAddon align="inline-start">
              <Search className="size-4 text-muted-foreground" />
            </InputGroupAddon>
          </InputGroup>
        )}
      </div>

      {/* Decision 170 (issue #6 ruling 1): the list area is three regions in
          a column — Active now, Repositories, Temporary chats — each a
          two-row grid of its title and its own ScrollArea, so a long folder
          list never pushes the other two out of view. The `max-h-*` caps
          resolve against this column, whose height the dock's `absolute
          inset-0` layer makes definite; no wrapper that sizes itself to its
          content may go between the two. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {renderActiveRegion()}
        {showAddRepositoryEmptyState ? (
          // Seed sessions point at empty-path workspaces and cannot send, so
          // surface the entry point instead of a misleading tree. U13:
          // temporary chats are the exception — they run without a
          // repository, so their region stays below the call to action.
          <section
            className={cn(
              'grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)]',
              activeRows.length > 0 && 'border-t'
            )}
          >
            <ScrollArea>
              <div className="p-2">
                <Empty className="gap-3 border-0 p-2 md:p-2">
                  <EmptyMedia variant="icon">
                    <FolderGit2 className="h-4.5 w-4.5" />
                  </EmptyMedia>
                  <EmptyHeader>
                    {/* D25 §3.3: EmptyTitle's shared base now carries a
                        negative tracking meant for its 18px default — this
                        compact sidebar usage shrinks to 15px (text-ui) and
                        may render CJK, so tracking must be cancelled back to
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
              </div>
            </ScrollArea>
          </section>
        ) : (
          // S1 (H/18): the projects partition's own right-click, covering its
          // title row, the gaps between folders and any folder header with no
          // repository behind it. Rendered AS the region.
          <ContextMenuPrimitive.Root>
            <ContextMenuPrimitive.Trigger
              render={
                <section
                  className={cn(REPOSITORIES_REGION_CLASS, activeRows.length > 0 && 'border-t')}
                />
              }
              // Ruling 6: hold the folder order while the pointer or keyboard
              // focus is here (`useRegionHold`).
              {...reposHold.regionProps}
            >
              {/* D21's filter / add slot, with Collapse all in front (ruling 7). */}
              <SidebarSectionHeader title={t('Repositories')}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-6 text-muted-foreground"
                  aria-label={t('Collapse all repositories')}
                  title={t('Collapse all repositories')}
                  onClick={collapseAllFolders}
                >
                  <ChevronsDownUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-6 text-muted-foreground"
                  aria-label={t('Filter sessions')}
                  title={t('Filter sessions')}
                  aria-pressed={searchVisible}
                  onClick={toggleSearchVisible}
                >
                  <ListFilter className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-6 text-muted-foreground"
                  aria-label={t('Add Repository')}
                  title={t('Add Repository')}
                  onClick={onAddRepository}
                >
                  <FolderPlus className="size-3.5" />
                </Button>
              </SidebarSectionHeader>

              <ScrollArea>
                <div className="px-2 pt-0.5 pb-2">
                  <div className="space-y-1">
                    {noMatches && (
                      <p className="px-2 py-1 text-meta text-muted-foreground">
                        {t('No matching sessions')}
                      </p>
                    )}

                    {visibleFolders.map((folder) => {
                      const expanded = isProjectExpanded(folder.projectId);
                      const limited = limitFolderRows({
                        rows: folder.rows,
                        showAll: folderShowAll[folder.projectId] === true,
                        queryActive,
                        activeSessionId,
                      });
                      const newSessionWorkspaceId = folder.newSessionWorkspaceId;
                      const folderRepo = repoByProjectId.get(folder.projectId);
                      const diffTotals = sumFolderDiffTotals(folder, workspaces, diffStatsByPath);
                      // Decision 167 §2: the folder row names its main
                      // workspace's branch once (and says remote); a row
                      // below shows its own branch only off that workspace.
                      const primary = folderPrimaryChip(folder.projectId, workspaces);
                      const folderName = sidebarFolderNameForDisplay(
                        folder.projectId,
                        folder.name,
                        t
                      );
                      const branchLabel = folderBranchLabel(primary, t);
                      // S2 (H/18): ONE definition of the repository actions, rendered
                      // from both entry points — the hover "more" button and the
                      // row's new context menu. Two copies would drift apart the
                      // first time either gains an action, and "the two give the same
                      // menu" is the whole acceptance criterion.
                      const repoMenuItems = folderRepo ? (
                        <>
                          <MenuItem onClick={() => setRepoToConfigure(folderRepo)}>
                            <Settings />
                            {t('Repository Settings')}
                          </MenuItem>
                          {/* Remote repositories have no local directory to open —
                            same unsupported case `files.ts` throws on for
                            `file:revealInFileManager`, handled here by hiding the
                            action instead of exposing a click that always fails. */}
                          {folderRepo.kind !== 'remote' && (
                            <MenuItem
                              onClick={() => void handleOpenRepositoryFolder(folderRepo.path)}
                            >
                              <Search />
                              {navigator.platform.toUpperCase().indexOf('MAC') >= 0
                                ? t('Reveal in Finder')
                                : t('Reveal in Explorer')}
                            </MenuItem>
                          )}
                          {onRemoveRepository && (
                            <MenuItem
                              variant="destructive"
                              onClick={() => setRepoToRemove(folderRepo)}
                            >
                              <FolderMinus />
                              {t('Remove repository')}
                            </MenuItem>
                          )}
                        </>
                      ) : null;
                      // Toggle and "+ new chat" are sibling buttons in a flex row — a
                      // nested button would be invalid HTML (same trap as the
                      // McpSection fix in d68d3c6).
                      const header = (
                        <div
                          // Project headers have no selected state, so the plain
                          // hover step is enough; --hover is the semantic alias.
                          // Keyboard focus on either button lights the same step.
                          className="group flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-ui hover:bg-hover has-focus-visible:bg-hover"
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                            title={folderTooltip(folderName, primary, t)}
                            // Decision 137 §3 (user ruling, replaces D29): the
                            // header folds and unfolds this folder and does
                            // nothing else — no conversation is opened and the
                            // "New" target is left to the selected conversation.
                            onClick={() =>
                              setExpandedProjects((prev) => ({
                                ...prev,
                                [folder.projectId]: !expanded,
                              }))
                            }
                          >
                            {expanded ? (
                              <FolderOpen className="size-4 shrink-0 text-folder" />
                            ) : (
                              <Folder className="size-4 shrink-0 text-folder" />
                            )}
                            <span
                              data-slot="sidebar-folder-name"
                              className="min-w-0 truncate font-semibold"
                            >
                              {folderName}
                            </span>
                            {branchLabel && (
                              // The branch gives way first (`shrink-[1000]`
                              // takes almost all of the deficit); the name is
                              // the last thing cut.
                              <span className="min-w-0 shrink-[1000] truncate text-meta text-muted-foreground">
                                {branchLabel}
                              </span>
                            )}
                          </button>
                          {/* Trailing slot. The totals and the row's two hover
                          buttons share ONE grid cell, so the cell is as wide as
                          whichever is wider and the row cannot reflow when the
                          numbers give way on hover — the same reason the session
                          row below boxes its age and actions together. */}
                          <span className="grid shrink-0 justify-items-end">
                            {diffTotals && (
                              <span
                                className="col-start-1 row-start-1 flex items-center gap-1 text-meta tabular-nums group-hover:invisible group-focus-within:invisible"
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
                            )}
                            <span className="col-start-1 row-start-1 flex items-center">
                              {folderRepo && (
                                <Menu>
                                  <MenuTrigger
                                    render={
                                      <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="size-5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-popup-open:opacity-100 sm:size-5"
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
                                // The header New button targets the active session's
                                // workspace only, so a repo that already has sessions
                                // needs its own entry point (T-26 review should-fix).
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  className="size-5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 sm:size-5"
                                  aria-label={t('New chat')}
                                  title={t('New session in {{folder}}', { folder: folderName })}
                                  // Decision 174: the home page, this repository picked.
                                  onClick={() => openHomeInFolder(newSessionWorkspaceId)}
                                >
                                  <Plus className="size-3.5" />
                                </Button>
                              )}
                            </span>
                          </span>
                        </div>
                      );
                      return (
                        <section key={folder.projectId}>
                          {/* S2: right-click gives the same actions as the "more"
                        button. Only wrapped when there ARE actions — the
                        synthetic Temp folder has no repository behind it, and a
                        trigger with an empty menu would swallow the right-click
                        (Base UI's trigger stops the event) instead of letting it
                        reach the section menu below. */}
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

                          {expanded && (
                            <div className="mt-0.5 space-y-0.5 pl-3">
                              {limited.rows.map((row) => {
                                const tempItemId = tempItemIdByWorkspaceId.get(row.workspaceId);
                                return (
                                  <SessionRow
                                    key={row.sessionId}
                                    row={row}
                                    place={placeOf(row)}
                                    branch={
                                      chipShownInFolder(row, primary) ? row.chip?.label : undefined
                                    }
                                    now={now}
                                    active={activeSessionId === row.sessionId}
                                    started={hostBoundSessionIds.includes(row.sessionId)}
                                    unread={unreadSessionIds.includes(row.sessionId)}
                                    {...(selecting
                                      ? {
                                          selected: selection.has(row.sessionId),
                                          onToggleSelect: toggleSelected,
                                        }
                                      : {})}
                                    pendingApprovalCount={
                                      pendingApprovalCountBySession.get(row.sessionId) ?? 0
                                    }
                                    onSelect={() => handleSelectSession(row.sessionId)}
                                    onClose={() => void close(row.sessionId)}
                                    onRename={(title) => void renameRow(row.sessionId, title)}
                                    onArchive={() => void archive(row.sessionId, true)}
                                    onDeleteTemp={
                                      tempItemId && onRequestTempDelete
                                        ? () => onRequestTempDelete(tempItemId)
                                        : undefined
                                    }
                                  />
                                );
                              })}
                              {renderFolderLimitToggle(folder.projectId, limited)}
                              {folder.rows.length === 0 &&
                                !query.trim() &&
                                newSessionWorkspaceId && (
                                  <SidebarAuxRow
                                    icon={<Plus className="size-3.5" />}
                                    onClick={() => openHomeInFolder(newSessionWorkspaceId)}
                                  >
                                    {t('New chat')}
                                  </SidebarAuxRow>
                                )}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
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
        )}
        {renderUnboundSection()}
      </div>

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
 * Decision 170 (issue #6 ruling 1): the list area's three regions. Each is a
 * two-row grid — the h-8 title (`auto`), then the region's own `ScrollArea`
 * (`minmax(0,1fr)`) — so no title is inside a scroll viewport and nothing has
 * to stick (decision 167's sticky titles, their two-layer background, the
 * background-image fallback, `isolate` and `scroll-pt-8` are gone with it).
 * Active now and Temporary chats are content-sized up to 33% / 25% of the list
 * area; Repositories takes the rest. Regions meet at a full-width `border-t`.
 *
 * Two parts are load-bearing, both found on the prototype
 * (`docs/plantree/plans/dsh-rebase/evidence/sidebar-regions-2026-10/`):
 * - `grid-cols-1`: the implicit `auto` column grows to the rows' min-content
 *   width (nowrap titles) and pushes every row past the panel's right edge.
 * - grid, not flex: a flex region's height is indefinite, so the ScrollArea
 *   root's `height: 100%` never resolves and its viewport grows with the
 *   content instead of scrolling. In the grid the capped region's second row
 *   is definite and the viewport scrolls inside it.
 */
const ACTIVE_REGION_CLASS =
  'grid max-h-[33%] min-h-0 shrink-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)]';
const REPOSITORIES_REGION_CLASS = 'grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)]';
const TEMPORARY_REGION_CLASS =
  'grid max-h-[25%] min-h-0 shrink-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] border-t';

/**
 * Decision 167 / 170: a region title (L1) — 16px / 600 / foreground, +0.04em,
 * h-8. It is the region grid's first row, outside the region's scroll area.
 */
function SidebarSectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-8 items-center px-4">
      <p className="min-w-0 truncate text-section font-semibold tracking-[0.04em] text-foreground">
        {title}
      </p>
      {children && <div className="ml-auto flex shrink-0 items-center gap-0.5">{children}</div>}
    </div>
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
 * region? Spread `regionProps` on the region; `held` says whether it is.
 *
 * - Pointer: React computes enter / leave over its own tree, so a popup
 *   portaled out of the region's DOM (a row's menu) still counts as inside.
 * - Keyboard focus only: the focus a click leaves on a row must not keep the
 *   region held after the pointer has gone. Focus moving into a portaled popup
 *   arrives here as a fresh focus event, because React bubbles through portals.
 * - A focused element that is removed (a row's ✕, 「新建对话」 in an empty
 *   folder) takes focus with it and no blur event follows, and the region
 *   itself goes away with the last repository. The check after every commit
 *   lets go in both cases instead of holding for good.
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
 * Decision 167: the list's own L4 rows — "View more (N)", "Show less", "New
 * chat". h-6, 14px, muted; the leading `w-4` slot (empty, or the plus of
 * "New chat") puts the text in the same column as the titles at that depth.
 */
function SidebarAuxRow({
  icon,
  onClick,
  children,
}: {
  icon?: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="flex h-6 w-full items-center gap-1.5 rounded-sm px-2 text-meta text-muted-foreground tabular-nums hover:bg-hover focus-visible:bg-hover"
      onClick={onClick}
    >
      <span aria-hidden className="flex w-4 shrink-0 items-center justify-center">
        {icon}
      </span>
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
   * The row shows its last segment; Active now never passes it.
   */
  branch?: string;
  now: number;
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
  now,
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
            // below the folder name's ink — `--foreground-soft`, never with /N
            // — except on the open chat, which keeps the body colour.
            'group flex h-7 w-full items-center gap-1.5 overflow-hidden rounded-sm px-2 text-left text-meta',
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
              worker is attached in the background), nothing = not started.
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
            ) : null}
          </span>
          {/* `min-w-20` is the whole point of this row's sizing (S2 b). The title is
          the row's identity and the only user-authored text on it, so it gets a
          floor and everything else yields to it. Without the floor `flex-1
          min-w-0` shrinks to whatever is left. Budget for an indented row at the
          280px default (decision 167, measured on the prototype; decision 170
          kept it): the panel's 280 includes its 1px right border, so 280 - 1 -
          16 (the region list's px-2) - 12 (pl-3) - 16 (px-2) = 235px of
          content; minus the 16px status slot, two 6px gaps and the 40px time
          box, the title gets 167px (SIDEBAR_DEFAULT_WIDTH - DOCK_RAIL_WIDTH =
          280). */}
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
          {/* Alert badges are state, not context, so they stay on every row —
              Active now's included. Decision 167 unified them at Badge `lg` (14px
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
          {/* Age and actions swap on hover; the shared width box is what actually
          keeps the row from jumping — the two are different natural widths (a
          relative age is ~21px, two icon buttons are 40px), so before the
          fixed box the swap silently re-flowed every other item. The row has
          tabIndex=0, so focus-within also reveals the actions and keeps
          Archive/Close reachable by keyboard (display:none alone would drop
          them from the tab order). Temp rows get a third (delete) button, so
          both this span and the actions box below widen to `w-[60px]`
          together — otherwise only the temp rows would jump on hover.
          Decision 167: the buttons are `size-5 sm:size-5` (20px, two fill the
          40px box exactly); a bare `size-5` loses to the variant's
          `sm:size-6`, and 48px of buttons overflowed the box. */}
          <span
            className={cn(
              'shrink-0 text-right text-meta text-muted-foreground tabular-nums group-hover:hidden group-focus-within:hidden',
              onDeleteTemp ? 'w-[60px]' : 'w-10'
            )}
          >
            {formatRelativeAge(row.updatedAt, now)}
          </span>
          <div
            className={cn(
              'hidden shrink-0 items-center justify-end group-hover:flex group-focus-within:flex',
              onDeleteTemp ? 'w-[60px]' : 'w-10'
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
