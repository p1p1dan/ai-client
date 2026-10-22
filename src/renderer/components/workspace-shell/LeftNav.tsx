import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import type { TempWorkspaceItem } from '@shared/types';
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderGit2,
  FolderMinus,
  FolderPlus,
  FolderTree,
  MoreHorizontal,
  Pencil,
  Plus,
  Puzzle,
  Search,
  Settings,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
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
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '@/components/ui/menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusIcon } from '@/components/ui/status-icon';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { openHome } from '@/stores/homeDraft';
import { useSettingsIntentStore } from '@/stores/settingsIntent';
import { orderGroups, UNGROUPED_GROUP_ID, useSidebarArchiveStore } from '@/stores/sidebarArchive';
import { useWorktreeActivityStore } from '@/stores/worktreeActivity';
import { useSessionIndex, useSessionIndexMutations } from '../chat/sessionIndex/useSessionIndex';
import { shouldShowAddRepositoryEmptyState } from './addRepositoryEntry';
import { projectIdForRepo, workspaceIdFor } from './deriveChatWorkspaceTree';
import { endSessionRuntime } from './endSessionRuntime';
import { sumFolderDiffTotals } from './folderDiffStats';
import { SURFACE_ESCAPE_HOLD_ATTR } from './shellLayoutModel';
import { GroupingModeRadio, SidebarListMenu } from './sidebar/SidebarListMenu';
import { bucketSessions } from './sidebar/sidebarGrouping';
import {
  resolveGroupDrop,
  resolveRovingKey,
  resolveSidebarNavKey,
  SIDEBAR_SESSION_DRAG_TYPE,
  type SidebarNavItem,
  sidebarAuxNavKey,
  sidebarHeaderNavKey,
  sidebarRowNavKey,
} from './sidebarNavModel';
import {
  applyHeldFolderOrder,
  buildGroupFolder,
  buildSidebarFolders,
  buildUnboundFolder,
  chipShownInFolder,
  deriveGroupSummary,
  folderPrimaryChip,
  folderTooltip,
  isUnboundSessionRow,
  isWaitingSessionStatus,
  LEGACY_DIVERGED_HINT,
  lastBranchSegment,
  limitFolderRows,
  orderFoldersByAddedAt,
  resolveHomePreselect,
  type SidebarFolder,
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
 *
 * Layout 5b (ui-cohesion §6, the Claude Code desktop screenshot): the vertical
 * nav is four entries — 新对话, 搜索 (the global search), 仓库 (the
 * repositories and 添加仓库), 技能与插件 (the Extensions settings page). The
 * tool row and its hairline are gone: its tools moved into the menu a group
 * heading shows on hover (`SidebarListMenu`), and the filter field appears at
 * the top of the list only while it is in use. Rows are text only with their
 * state as a trailing mark; the grouping is switchable (ruling L2).
 */
export interface SidebarSearchEntry {
  onOpen: () => void;
  /** False while there is no workspace to search (a home page with no repository). */
  enabled: boolean;
  /** The search shortcut as shown, faint at the entry's right. */
  shortcut: string;
}

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
  /**
   * Layout 5b: the 「搜索」 entry — the shell's global search, resolved by
   * `LeftDock` (whether there is a workspace to search, and the shortcut as
   * shown). Absent, the entry is disabled.
   */
  search?: SidebarSearchEntry;
}

export function LeftNav({
  onAddRepository,
  onRemoveRepository,
  repositories = [],
  tempWorkspaces = [],
  onRequestTempDelete,
  search,
}: LeftNavProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  /**
   * Layout 5b: the filter field is shown while opened (from the list menu or
   * by typing in the list) or while it holds a query.
   */
  const [filterOpen, setFilterOpen] = useState(false);
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
   * Issue #15 phase 2 (decision 187): the group whose name is being edited in
   * place, and the group whose delete is being confirmed. `creatingGroup` is
   * the 「新建分组」 header that appears at the top of the list and takes the
   * name directly — a boolean rather than an id, because the group does not
   * exist until the name does.
   */
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupToDelete, setGroupToDelete] = useState<string | null>(null);
  /**
   * The chat that asked for 「移到分组 ▸ 新建分组…」, so the move lands when the
   * new group's name does. A ref, not state: nothing renders from it.
   */
  const pendingMoveSessionId = useRef<string | null>(null);
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

  // "Reveal in Finder/Explorer" on the repository row, and issue #15's 「跳转到
  // 工作目录」 on a chat row — unlike the file tree's same-named action
  // (`file.revealInFileManager`, which highlights an item inside its parent),
  // these open the directory itself, so they go through `shell.openPath`
  // instead. `openPath` resolves to an error string (never throws) on a normal
  // failure, but the preload rejects outright for a remote virtual path — both
  // are reported the same way here since every menu item that calls this is
  // already hidden for remote repositories and for chats with no directory.
  const handleOpenFolder = useCallback(
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
  // Issue #15: 「按工作目录」 orders groups by when each repository was added
  // (`Repository.addedAt`, backfilled on load for older installs). Keyed by
  // the same project id the tree was built with — `projectIdForRepo` — so a
  // folder always finds its own repository and never a same-named other one.
  const addedAtByProjectId = useMemo(
    () => new Map(repositories.map((repo) => [projectIdForRepo(repo), repo.addedAt ?? 0] as const)),
    [repositories]
  );
  const archiveMode = useSidebarArchiveStore((state) => state.archiveMode);
  const setArchiveMode = useSidebarArchiveStore((state) => state.setArchiveMode);
  const groups = useSidebarArchiveStore((state) => state.groups);
  const groupAssignments = useSidebarArchiveStore((state) => state.assignments);
  const createGroup = useSidebarArchiveStore((state) => state.createGroup);
  const renameGroup = useSidebarArchiveStore((state) => state.renameGroup);
  const deleteGroup = useSidebarArchiveStore((state) => state.deleteGroup);
  const assignSession = useSidebarArchiveStore((state) => state.assignSession);
  const groupingByGroup = archiveMode === 'group';
  /** Layout 5b (ruling L2): 「按状态」 / 「按时间」, buckets derived from the sessions. */
  const groupingDerived = archiveMode === 'status' || archiveMode === 'date' ? archiveMode : null;
  // Issue #15 phase 2 (decision 187): the user's groups, newest first like the
  // repositories, then the fixed 「未分组」 bucket LAST — it is the least
  // specific group on the list and a permanently-first slot would push the
  // user's own groups down every time a chat is started.
  const orderedGroups = useMemo(() => orderGroups(groups), [groups]);
  const groupFolders = useMemo(() => {
    if (!groupingByGroup) return [];
    const folders = orderedGroups.map((group) =>
      buildGroupFolder({
        // A group holds the conversations filed under it and nothing else —
        // the bucketing is the caller's (the store keeps the map), so this
        // derivation stays pure.
        sessions: sessions.filter((session) => groupAssignments[session.id] === group.id),
        groupId: group.id,
        name: group.name,
        query,
        activeSessionId,
        t,
      })
    );
    folders.push(
      buildGroupFolder({
        // No entry in the assignment map IS membership of 「未分组」 (see the
        // store's `SessionAssignments`), so this is the complement of the map
        // rather than a second list to keep in step.
        sessions: sessions.filter((session) => {
          const assigned = groupAssignments[session.id];
          return !assigned || !orderedGroups.some((group) => group.id === assigned);
        }),
        groupId: UNGROUPED_GROUP_ID,
        name: t('Ungrouped'),
        query,
        activeSessionId,
        t,
      })
    );
    return folders;
  }, [groupingByGroup, orderedGroups, groupAssignments, sessions, query, activeSessionId, t]);
  /**
   * Layout 5b: the buckets of 「按状态」 / 「按时间」, as folders so they render
   * through the same header, fold, row budget and search as every group.
   * `Date.now()` is read per derivation: a chat crosses midnight into 「昨天」
   * on the next change to the list, which is soon enough for a list that
   * changes with every turn.
   */
  const bucketFolders = useMemo(() => {
    if (!groupingDerived) return [];
    const pendingApprovalSessionIds = new Set(pendingApprovalCountBySession.keys());
    return bucketSessions(sessions, groupingDerived, {
      now: Date.now(),
      pendingApprovalSessionIds,
    }).map((bucket) =>
      buildGroupFolder({
        sessions: bucket.sessions,
        groupId: bucket.id,
        name: t(bucket.label),
        query,
        activeSessionId,
        t,
      })
    );
  }, [groupingDerived, sessions, pendingApprovalCountBySession, query, activeSessionId, t]);
  /** The ids the list shows in 「按分组」 — the mode's groups, bucket included. */
  const groupFolderIds = groupFolders.map((folder) => folder.projectId);
  const queryActive = query.trim().length > 0;
  /**
   * Whether a group shows its rows. A search opens every group that has
   * matches, whatever its stored fold — the hits are what the user is looking
   * for — without writing the fold; its header folds nothing meanwhile.
   * Clearing the search then leaves the last query's groups open
   * (`handleQueryChange`).
   */
  const groupExpanded = (groupId: string) => queryActive || isProjectExpanded(groupId);

  // ---- Issue #26 item 7: drag a chat onto a group, and keyboard navigation ----

  /** The chat row being dragged (「按分组」 only), and the header it is over. */
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const endSessionDrag = () => {
    setDraggingSessionId(null);
    setDropTargetGroupId(null);
  };
  /**
   * A group header's drop wiring while a chat is dragged. Only a header the
   * chat could move to takes the drop (not its own group); the drop calls the
   * same `assignSession` as the row's 「移到分组」 menu.
   */
  const groupDropProps = (
    groupId: string
  ): { active: boolean; handlers: GroupDropHandlers } | undefined => {
    const target = resolveGroupDrop({
      sessionId: draggingSessionId,
      targetGroupId: groupId,
      assignments: groupAssignments,
      groupIds: orderedGroups.map((group) => group.id),
    });
    if (!target || !draggingSessionId) return undefined;
    const sessionId = draggingSessionId;
    return {
      active: dropTargetGroupId === groupId,
      handlers: {
        onDragOver: (event) => {
          if (!event.dataTransfer.types.includes(SIDEBAR_SESSION_DRAG_TYPE)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          if (dropTargetGroupId !== groupId) setDropTargetGroupId(groupId);
        },
        onDragLeave: (event) => {
          // Moving onto a child of the header is not leaving it.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDropTargetGroupId((current) => (current === groupId ? null : current));
        },
        onDrop: (event) => {
          event.preventDefault();
          assignSession(sessionId, target);
          endSessionDrag();
        },
      },
    };
  };

  /**
   * Roving tabindex: the one list item Tab lands on. Set by focus; when that
   * item leaves the list (its group folded, a search narrowed it) the effect
   * below moves it to the open chat's row or the first item.
   */
  const [navFocusKey, setNavFocusKey] = useState<string | null>(null);
  const navListRef = useRef<HTMLDivElement>(null);
  const navItemElements = (): HTMLElement[] => [
    ...(navListRef.current?.querySelectorAll<HTMLElement>('[data-sidebar-nav-key]') ?? []),
  ];
  // Every commit: the list's items come from the DOM it just rendered (order,
  // not geometry), so no derivation has to mirror the render's branches.
  useEffect(() => {
    const keys = navItemElements().map((element) => element.dataset.sidebarNavKey ?? '');
    const next = resolveRovingKey(
      keys,
      navFocusKey,
      activeSessionId ? sidebarRowNavKey(activeSessionId) : null
    );
    if (next !== navFocusKey) setNavFocusKey(next);
  });
  const handleNavFocus = (event: FocusEvent<HTMLElement>) => {
    const key = event.target.dataset?.sidebarNavKey;
    if (key && key !== navFocusKey) setNavFocusKey(key);
  };
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [filterFocusSeq, setFilterFocusSeq] = useState(0);
  const openFilter = () => {
    setSelection(null);
    setFilterOpen(true);
    setFilterFocusSeq((seq) => seq + 1);
  };
  // After the commit that shows the field, and a task later: the menu that
  // asked for it settles its own focus as it closes.
  useEffect(() => {
    if (filterFocusSeq === 0) return;
    filterInputRef.current?.focus();
    const timer = setTimeout(() => filterInputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [filterFocusSeq]);
  const closeFilter = () => {
    handleQueryChange('');
    setFilterOpen(false);
    navItemElements()
      .find((element) => element.tabIndex === 0)
      ?.focus();
  };
  const handleNavKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const elements = navItemElements();
    const index = elements.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    // Layout 5b: typing on the list filters it — the field the tool row used
    // to show at all times opens with the typed character.
    if (
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.nativeEvent.isComposing &&
      !selecting
    ) {
      event.preventDefault();
      handleQueryChange(query + event.key);
      openFilter();
      return;
    }
    if (event.shiftKey) return;
    const items: SidebarNavItem[] = elements.map((element) => ({
      kind: (element.dataset.sidebarNav as SidebarNavItem['kind']) ?? 'row',
      key: element.dataset.sidebarNavKey ?? '',
      groupId: element.dataset.sidebarNavGroup,
      expanded: element.getAttribute('aria-expanded') === 'true',
    }));
    const action = resolveSidebarNavKey(items, index, event.key);
    if (!action) return;
    event.preventDefault();
    if (action.type === 'focus') {
      elements[action.index]?.focus();
      return;
    }
    // A search holds every group with matches open; its headers fold nothing.
    if (queryActive) return;
    setExpandedProjects((prev) => ({ ...prev, [action.groupId]: action.expanded }));
  };
  /**
   * What 「按分组」 renders. A search narrows it the way it narrows the
   * repository tree below: a group with no hits collapses away instead of
   * leaving a wall of empty headers. Without a query every group stays,
   * because that is where its rename, its delete and its 「＋」 live.
   */
  const visibleGroupFolders = queryActive
    ? groupFolders.filter((folder) => folder.rows.length > 0)
    : groupFolders;
  // Issue #15: which repository a row belongs to, by display name — null for a
  // chat that has none (a temporary chat, an orphan). Only 「按分组」 asks:
  // there the row has no folder header above it to say so.
  const repositoryNameForRow = (row: SidebarSessionRow): string | null => {
    const workspace = workspaceById.get(row.workspaceId);
    if (!workspace) return null;
    return folderNameByProjectId.get(workspace.projectId) ?? null;
  };
  // Issue #15 (decision 186): repository groups are ordered by when the
  // repository was ADDED, newest first, instead of by each group's last
  // activity. Decision 170's activity order moved a folder as soon as a chat
  // anywhere finished a turn; the user asked for the arrangement they made.
  // The hold stays (it also keeps Temporary chats and the Temp Session project
  // in place while the pointer is in the list) but is now nearly inert: this
  // order only changes when a repository is added or removed.
  const liveFolderOrder = orderFoldersByAddedAt(folders, addedAtByProjectId);
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
  const visibleBucketFolders = queryActive
    ? bucketFolders.filter((folder) => folder.rows.length > 0)
    : bucketFolders;
  const noMatches =
    queryActive &&
    (groupingDerived
      ? visibleBucketFolders.length === 0
      : groupingByGroup
        ? visibleGroupFolders.length === 0
        : visibleFolders.length === 0 && !unboundFolder);

  /**
   * User ruling 2026-10-11: clearing a search leaves open the groups its LAST
   * query matched — the ones on screen right before the clear, which this
   * render derived from that query — and writes nothing else. A group that
   * matched only an earlier prefix while typing, or none at all, keeps the
   * fold it had.
   */
  const handleQueryChange = (next: string) => {
    if (queryActive && next.trim().length === 0) {
      // Layout 5b: in the other groupings, the groups or buckets on screen.
      const matched = groupingDerived
        ? visibleBucketFolders.map((folder) => folder.projectId)
        : groupingByGroup
          ? visibleGroupFolders.map((folder) => folder.projectId)
          : [
              ...(unboundFolder ? [UNBOUND_FOLDER_ID] : []),
              ...(showAddRepositoryEmptyState
                ? []
                : visibleFolders.map((folder) => folder.projectId)),
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
  const toggleGroupIds = groupingByGroup
    ? groupFolderIds
    : groupingDerived
      ? bucketFolders.map((folder) => folder.projectId)
      : [
          ...(sessions.some(isUnboundSessionRow) ? [UNBOUND_FOLDER_ID] : []),
          ...(showAddRepositoryEmptyState ? [] : folders.map((folder) => folder.projectId)),
        ];
  const allGroupsCollapsed =
    toggleGroupIds.length > 0 && toggleGroupIds.every((id) => !isProjectExpanded(id));
  const toggleAllGroups = () => {
    const expand = allGroupsCollapsed;
    setExpandedProjects((prev) => ({
      ...prev,
      ...Object.fromEntries(toggleGroupIds.map((id) => [id, expand])),
    }));
  };
  const toggleAllLabel = allGroupsCollapsed ? t('Expand all groups') : t('Collapse all groups');
  /** Layout 5b: the list menu a group heading shows on hover (`SidebarListMenu`). */
  const listMenu = (
    <SidebarListMenu
      className={GROUP_ACTION_CLASS}
      mode={archiveMode}
      onModeChange={setArchiveMode}
      onFilter={openFilter}
      foldAll={{
        label: toggleAllLabel,
        collapsed: allGroupsCollapsed,
        disabled: queryActive || toggleGroupIds.length === 0,
        onToggle: toggleAllGroups,
      }}
      onSelectToArchive={() => setSelection(new Set())}
      onNewGroup={groupingByGroup ? () => setCreatingGroup(true) : undefined}
    />
  );

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
      // Issue #15: this row's own directory in the system file manager. Hidden
      // for rows with no local directory (temporary chats, remote repos) — see
      // the prop's note.
      {...(() => {
        const workspace = workspaceById.get(row.workspaceId);
        return workspace && workspace.kind !== 'remote'
          ? { onJumpToWorkspace: () => void handleOpenFolder(workspace.path) }
          : {};
      })()}
      // Issue #15 phase 2: filing, offered only in the mode that has groups.
      // Every conversation is listed in exactly one of them, so the tick can
      // always say which — `null` is 「未分组」, which is the absence of an
      // assignment rather than a group id.
      navKey={sidebarRowNavKey(row.sessionId)}
      tabbable={navFocusKey === sidebarRowNavKey(row.sessionId)}
      // Issue #26 item 7: in 「按分组」 a row drags onto a group header. Not
      // while choosing rows to archive: there a press picks the row.
      {...(groupingByGroup && !selecting
        ? {
            drag: {
              dragging: draggingSessionId === row.sessionId,
              onStart: () => setDraggingSessionId(row.sessionId),
              onEnd: endSessionDrag,
            },
          }
        : {})}
      {...(groupingByGroup
        ? {
            groupMove: {
              groups: orderedGroups.map((group) => ({ id: group.id, name: group.name })),
              currentGroupId: groupAssignments[row.sessionId] ?? null,
              onMove: (groupId: string) => assignSession(row.sessionId, groupId),
              onCreateGroup: () => {
                pendingMoveSessionId.current = row.sessionId;
                setCreatingGroup(true);
              },
            },
          }
        : {})}
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
        <SidebarAuxRow
          navKey={sidebarAuxNavKey(projectId)}
          tabbable={navFocusKey === sidebarAuxNavKey(projectId)}
          onClick={() => setFolderShowAll((prev) => ({ ...prev, [projectId]: true }))}
          // Layout 5b: the screenshot's quiet 「显示更多」; the count is the tooltip.
          title={t('View more ({{count}})', { count: limited.hiddenCount })}
        >
          {t('Show more chats')}
        </SidebarAuxRow>
      );
    }
    if (limited.collapsible) {
      return (
        <SidebarAuxRow
          navKey={sidebarAuxNavKey(projectId)}
          tabbable={navFocusKey === sidebarAuxNavKey(projectId)}
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
            groupId: UNBOUND_FOLDER_ID,
            tabbable: navFocusKey === sidebarHeaderNavKey(UNBOUND_FOLDER_ID),
            actions: (
              <>
                {listMenu}
                {/* Decision 174: the home page with 「不选仓库（临时对话）」
                    picked; the temporary chat is made by its first send. */}
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
              </>
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

  /**
   * Issue #15 (phase 1 decision 186, phase 2 decision 187) — one group of
   * 「按分组」 mode: the user's own groups and the fixed 「未分组」 bucket alike.
   *
   * Same header, same fold, same 8-row budget and same search behaviour as a
   * repository group, because these are the list's other face and must not be
   * a different kind of thing. What they do not have is a repository: no diff
   * totals, no repository menu, no 「＋」 that could pick a target (the group's
   * 「＋」 starts a chat with no repository, which is what a group without one
   * can offer). Rows name their repository in the context slot instead, which
   * is the job the missing folder headers used to do.
   *
   * Group actions come from `groupMenuItems` — one definition, rendered from
   * both the header's hover 「···」 and its context menu, the same rule the
   * repository header follows.
   */
  const renderGroupSection = (folder: SidebarFolder) => {
    const groupId = folder.projectId;
    const isUngrouped = groupId === UNGROUPED_GROUP_ID;
    const expanded = groupExpanded(groupId);
    const limited = limitFolderRows({
      rows: folder.rows,
      showAll: folderShowAll[groupId] === true,
      queryActive,
      activeSessionId,
    });
    if (renamingGroupId === groupId) return renderGroupRename(folder);
    const actions = (
      <>
        {listMenu}
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(GROUP_ACTION_CLASS, 'data-popup-open:opacity-100')}
                aria-label={t('Group actions')}
                title={t('Group actions')}
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">{groupMenuItems(groupId)}</MenuPopup>
        </Menu>
        <Button
          variant="ghost"
          size="icon-xs"
          className={GROUP_ACTION_CLASS}
          aria-label={t('New chat')}
          // Decision 174 + 187: a group has no repository to preselect, so its
          // 「＋」 is the home page with nothing picked — the same target the
          // Temporary chats group's 「＋」 has, and the only one a group without
          // a repository could honestly offer.
          title={t('New chat in {{group}}', { group: folder.name })}
          onClick={() => openHome()}
        >
          <Plus className="size-3.5" />
        </Button>
      </>
    );
    const header = renderGroupHeader({
      name: folder.name,
      nameSlot: 'sidebar-group-name',
      mark: true,
      tooltip: isUngrouped
        ? t('Chats you have not put in a group yet')
        : t('Group: {{name}}', { name: folder.name }),
      expanded,
      onToggle: queryActive
        ? undefined
        : () =>
            setExpandedProjects((prev) => ({
              ...prev,
              [groupId]: !expanded,
            })),
      summary: deriveGroupSummary(folder.rows, unreadSessionIds),
      actions,
      groupId,
      tabbable: navFocusKey === sidebarHeaderNavKey(groupId),
      drop: groupDropProps(groupId),
    });
    return (
      <section key={groupId} className={SIDEBAR_GROUP_CLASS} data-sidebar-group={groupId}>
        <ContextMenuPrimitive.Root>
          <ContextMenuPrimitive.Trigger render={header} />
          {!isUngrouped && (
            <MenuPopup align="start" side="bottom" className="min-w-40">
              {groupMenuItems(groupId)}
            </MenuPopup>
          )}
        </ContextMenuPrimitive.Root>
        {/* Decision 187: an empty group keeps its header — that is where its
            rename, its delete and its 「＋」 live, and a group that vanished
            the moment its last chat left would read as deleted. The
            placeholder quotes 「暂无对话」 rather than the row's own title. */}
        {expanded &&
          (limited.rows.length > 0 ? (
            <div className={GROUP_ROWS_CLASS}>
              {limited.rows.map((row) =>
                renderSessionRow(row, repositoryNameForRow(row) ?? undefined)
              )}
              {renderFolderLimitToggle(groupId, limited)}
            </div>
          ) : (
            <p className="px-2 py-0.5 pl-5 text-small text-muted-foreground">{t('No chats yet')}</p>
          ))}
      </section>
    );
  };

  /**
   * Layout 5b (ruling L2): one bucket of 「按状态」 / 「按时间」. The same
   * header, fold, row budget and search as every group; no menu, no drop and
   * no filing — a chat moves between buckets by itself. Rows name their
   * repository at the end, as in 「按分组」. The 「＋」 opens the home page
   * with nothing picked: a bucket has no repository to offer.
   */
  const renderBucketSection = (folder: SidebarFolder) => {
    const bucketId = folder.projectId;
    const expanded = groupExpanded(bucketId);
    const limited = limitFolderRows({
      rows: folder.rows,
      showAll: folderShowAll[bucketId] === true,
      queryActive,
      activeSessionId,
    });
    return (
      <section key={bucketId} className={SIDEBAR_GROUP_CLASS} data-sidebar-group={bucketId}>
        {renderGroupHeader({
          name: folder.name,
          nameSlot: 'sidebar-bucket-name',
          tooltip: folder.name,
          expanded,
          onToggle: queryActive
            ? undefined
            : () => setExpandedProjects((prev) => ({ ...prev, [bucketId]: !expanded })),
          summary: deriveGroupSummary(folder.rows, unreadSessionIds),
          groupId: bucketId,
          tabbable: navFocusKey === sidebarHeaderNavKey(bucketId),
          actions: (
            <>
              {listMenu}
              <Button
                variant="ghost"
                size="icon-xs"
                className={GROUP_ACTION_CLASS}
                aria-label={t('New chat')}
                title={t('New chat')}
                onClick={() => openHome()}
              >
                <Plus className="size-3.5" />
              </Button>
            </>
          ),
        })}
        {expanded && limited.rows.length > 0 && (
          <div className={GROUP_ROWS_CLASS}>
            {limited.rows.map((row) =>
              renderSessionRow(row, repositoryNameForRow(row) ?? undefined)
            )}
            {renderFolderLimitToggle(bucketId, limited)}
          </div>
        )}
      </section>
    );
  };

  /**
   * Decision 187: naming a group happens IN the header, not in a dialog — the
   * menu item turns the label into an input in place, which is one keystroke
   * away from where the user already is. Enter commits, Escape and blur
   * cancel; a name that is empty after trimming cancels, because an unnamed
   * group would be unreadable.
   */
  const renderGroupRename = (folder: SidebarFolder) => (
    <section key={folder.projectId} className={SIDEBAR_GROUP_CLASS}>
      <div className="flex h-8 w-full items-center gap-1 rounded-xs bg-fill-ghost-hover px-2">
        <GroupMark />
        <input
          // biome-ignore lint/a11y/noAutofocus: the menu item that opened this asked for a name; typing must not need a second click.
          autoFocus
          defaultValue={folder.projectId === UNGROUPED_GROUP_ID ? '' : folder.name}
          aria-label={t('Group name')}
          className="h-5.5 min-w-0 flex-1 rounded-xs border-0 bg-surface-1 px-1 text-small font-medium text-foreground outline-none ring-2 ring-ring/24"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              renameGroup(folder.projectId, event.currentTarget.value);
              setRenamingGroupId(null);
            } else if (event.key === 'Escape') {
              setRenamingGroupId(null);
            }
          }}
          onBlur={() => setRenamingGroupId(null)}
        />
      </div>
    </section>
  );

  /**
   * Decision 187: the group actions, in one place. 「未分组」 has neither a
   * rename nor a delete — it is the bucket every chat falls back to, so
   * removing it would leave those chats nowhere to be, and a name the user
   * could change would make the fallback's identity a per-install accident.
   */
  const groupMenuItems = (groupId: string) => (
    <>
      <MenuItem onClick={() => setCreatingGroup(true)}>
        <Plus />
        {t('New group…')}
      </MenuItem>
      {groupId !== UNGROUPED_GROUP_ID && (
        <>
          <MenuItem onClick={() => setRenamingGroupId(groupId)}>
            <Pencil />
            {t('Rename')}
          </MenuItem>
          <MenuItem variant="destructive" onClick={() => setGroupToDelete(groupId)}>
            <Trash2 />
            {t('Delete group')}
          </MenuItem>
        </>
      )}
    </>
  );

  /**
   * Decision 187: 「新建分组」 is a header that appears at the top of the list
   * and takes the name directly (the inline option the user chose). Creating
   * puts it in the store at once and leaves the name to the same editor the
   * rename uses, so Enter / Escape / blur behave identically in both.
   *
   * The chat that asked for it through 「移到分组 ▸ 新建分组…」 is moved into it
   * by {@link commitGroupName}.
   */
  const renderNewGroup = () => (
    <section className={SIDEBAR_GROUP_CLASS}>
      <div className="flex h-8 w-full items-center gap-1 rounded-xs bg-fill-ghost-hover px-2">
        <GroupMark />
        <input
          // biome-ignore lint/a11y/noAutofocus: the menu item that opened this asked for a name; typing must not need a second click.
          autoFocus
          placeholder={t('Group name')}
          aria-label={t('Group name')}
          className="h-5.5 min-w-0 flex-1 rounded-xs border-0 bg-surface-1 px-1 text-small font-medium text-foreground outline-none ring-2 ring-ring/24 placeholder:text-muted-foreground"
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitGroupName(event.currentTarget.value);
            else if (event.key === 'Escape') cancelGroupName();
          }}
          onBlur={cancelGroupName}
        />
      </div>
    </section>
  );

  /**
   * Decision 187: the name is what creates the group. An empty name cancels —
   * a group with no name would be unreadable, and one that appeared and then
   * could not be found again would be worse than not appearing.
   */
  const commitGroupName = (rawName: string) => {
    const name = rawName.trim();
    setCreatingGroup(false);
    if (name) {
      const group = createGroup(name);
      const moving = pendingMoveSessionId.current;
      if (moving) assignSession(moving, group.id);
    }
    pendingMoveSessionId.current = null;
  };

  const cancelGroupName = () => {
    setCreatingGroup(false);
    pendingMoveSessionId.current = null;
  };

  /**
   * S2 (H/18): ONE definition of the repository actions, rendered from every
   * entry point — a repository heading's hover 「···」, its context menu, and
   * (layout 5b) the 「仓库」 entry's submenu for that repository.
   */
  const repositoryMenuItems = (repo: Repository) => (
    <>
      <MenuItem onClick={() => setRepoToConfigure(repo)}>
        <Settings />
        {t('Repository Settings')}
      </MenuItem>
      {/* Remote repositories have no local directory to open — same
          unsupported case `files.ts` throws on for
          `file:revealInFileManager`, handled here by hiding the action
          instead of exposing a click that always fails. */}
      {repo.kind !== 'remote' && (
        <MenuItem onClick={() => void handleOpenFolder(repo.path)}>
          <Search />
          {navigator.platform.toUpperCase().indexOf('MAC') >= 0
            ? t('Reveal in Finder')
            : t('Reveal in Explorer')}
        </MenuItem>
      )}
      {onRemoveRepository && (
        <MenuItem variant="destructive" onClick={() => setRepoToRemove(repo)}>
          <FolderMinus />
          {t('Remove repository')}
        </MenuItem>
      )}
    </>
  );

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
    const repoMenuItems = folderRepo ? repositoryMenuItems(folderRepo) : null;
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
      groupId: folder.projectId,
      tabbable: navFocusKey === sidebarHeaderNavKey(folder.projectId),
      trailing: diffTotals && (
        <span
          className="flex items-center gap-1 text-small tabular-nums"
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
          {listMenu}
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
      {/* Layout 5b (the desktop screenshot): four frameless entries right
          under the dock's top row — 新对话 (the home page, decision 174),
          搜索 (the global search, its shortcut faint at the right), 仓库 (each
          repository's actions, and 添加仓库), 技能与插件 (the Extensions
          settings page: skills and the DSH plugins). */}
      <div className="flex shrink-0 flex-col gap-px px-2 pb-2">
        <button
          type="button"
          className={NAV_ITEM_CLASS}
          title={t('New chat (opens the home page)')}
          onClick={handleNewSession}
        >
          <Plus className={NAV_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate">{t('New chat')}</span>
        </button>
        <button
          type="button"
          className={NAV_ITEM_CLASS}
          disabled={!search?.enabled}
          title={search?.enabled ? t('Search') : t('Open a chat in a repository to search it')}
          onClick={() => search?.onOpen()}
        >
          <Search className={NAV_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate">{t('Search')}</span>
          {search && (
            <span className="shrink-0 text-2xs text-foreground-faint">{search.shortcut}</span>
          )}
        </button>
        <Menu>
          <MenuTrigger render={<button type="button" className={NAV_ITEM_CLASS} />}>
            <FolderGit2 className={NAV_ICON_CLASS} />
            <span className="min-w-0 flex-1 truncate">{t('Repositories')}</span>
          </MenuTrigger>
          <MenuPopup align="start" side="bottom" className="min-w-52">
            {repositories.map((repo) => {
              const folder = folders.find((item) => item.projectId === projectIdForRepo(repo));
              const workspaceId = folder?.newSessionWorkspaceId ?? null;
              return (
                <MenuSub key={repo.path}>
                  <MenuSubTrigger>
                    <FolderGit2 />
                    <span className="min-w-0 truncate">{repo.name}</span>
                  </MenuSubTrigger>
                  <MenuSubPopup className="min-w-40">
                    {workspaceId && (
                      <>
                        <MenuItem onClick={() => openHomeInFolder(workspaceId)}>
                          <Plus />
                          {t('New chat')}
                        </MenuItem>
                        <MenuSeparator />
                      </>
                    )}
                    {repositoryMenuItems(repo)}
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
            {repositories.length > 0 && <MenuSeparator />}
            <MenuItem onClick={() => onAddRepository?.()}>
              <FolderPlus />
              {t('Add Repository')}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <button
          type="button"
          className={NAV_ITEM_CLASS}
          onClick={() => useSettingsIntentStore.getState().requestSettings('extensions')}
        >
          <Puzzle className={NAV_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate">{t('Skills and plugins')}</span>
        </button>
      </div>

      {/* U31: selecting to archive swaps in its bar. Layout 5b: otherwise the
          filter field, only while it is open or holds a query — opened from
          the list menu, or by typing on the list. Design system v2 §3.1:
          buttons are `text-ui` (13px), so every xs button here overrides the
          variant's 12px `text-small`. */}
      {selecting ? (
        <div className="flex h-8 shrink-0 items-center gap-0.5 px-2">
          <span className="min-w-0 flex-1 truncate pl-2 text-small">
            {t('{{count}} selected', { count: selection.size })}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="h-6 shrink-0 text-ui"
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
            className="h-6 shrink-0 text-ui"
            onClick={() => setSelection(null)}
          >
            {t('Cancel')}
          </Button>
        </div>
      ) : filterOpen || queryActive ? (
        // Decision 167 (issue #3 item 5): coss's InputGroup, input FIRST and
        // the icon addon after it — `order-first` draws the addon on the
        // left, and its `[data-size=sm]+&` padding only matches in this order.
        // `opacity-100` on the icon opts it out of the addon's 80% icon fade.
        // The field owns Escape (it clears and closes), like the rename editor.
        <div className="shrink-0 px-2 pb-1" {...FILTER_HOLDS_ESCAPE}>
          <InputGroup className={SIDEBAR_SEARCH_CLASS}>
            <InputGroupInput
              ref={filterInputRef}
              size="sm"
              autoFocus
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              onFocus={(event) => {
                const end = event.currentTarget.value.length;
                event.currentTarget.setSelectionRange(end, end);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeFilter();
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  navItemElements()[0]?.focus();
                }
              }}
              placeholder={t('Search sessions')}
              aria-label={t('Search sessions')}
            />
            <InputGroupAddon align="inline-start">
              <Search className="size-3.5 text-muted-foreground opacity-100" />
            </InputGroupAddon>
            <InputGroupAddon align="inline-end">
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-5 sm:size-5"
                aria-label={t('Close filter')}
                title={t('Close filter')}
                onClick={closeFilter}
              >
                <X className="size-3.5" />
              </Button>
            </InputGroupAddon>
          </InputGroup>
        </div>
      ) : null}

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
            {/* Layout 5b: no hairline above the list any more (decision 188's
                pt 4 measured from it); the nav's own pb-2 and the first
                group's mt-1 set the gap. pb-3 above the footer's hairline. */}
            {/* Issue #26 item 7: arrow keys move between the list's headers,
                rows and "View more" lines; focus sets the roving tab stop. The
                items keep their own roles and Enter handling. */}
            <div
              ref={navListRef}
              data-slot="sidebar-list"
              className="px-2 pt-0 pb-3"
              onKeyDown={handleNavKeyDown}
              onFocus={handleNavFocus}
            >
              {noMatches && (
                <p className="px-2 py-1 text-small text-muted-foreground">
                  {t('No matching sessions')}
                </p>
              )}
              {showAddRepositoryEmptyState ? (
                // Seed sessions point at empty-path workspaces and cannot send,
                // so surface the entry point instead of a misleading tree. U13:
                // temporary chats run without a repository, so their group
                // stays above the call to action.
                // Issue #15: 「按分组」 mode does not replace this — with no
                // repository added there is nothing to group BY, and the way
                // out of that state is still this button.
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
                    <EmptyDescription className="text-small">
                      {t('Add a repository to get started.')}
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 text-ui"
                    onClick={onAddRepository}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('Add Repository')}
                  </Button>
                </Empty>
              ) : groupingDerived ? (
                // Layout 5b (ruling L2): the derived buckets, Temporary chats
                // included — the mode is about the chats' state, not where
                // they run.
                <>
                  {visibleBucketFolders.map(renderBucketSection)}
                  {!queryActive && bucketFolders.length === 0 && (
                    <p className="px-2 py-1 text-small text-muted-foreground">
                      {t('No chats yet')}
                    </p>
                  )}
                </>
              ) : groupingByGroup ? (
                // Issue #15 phase 2: the user's groups, then 「未分组」 last.
                // Temporary chats and the Temp Session project are INSIDE a
                // group rather than beside one — the mode is about
                // conversations, and a group that hid half of them would not
                // be one.
                <>
                  {creatingGroup && renderNewGroup()}
                  {visibleGroupFolders.map(renderGroupSection)}
                </>
              ) : (
                <>
                  {visibleFolders.map(renderRepositoryGroup)}
                  {/* Issue #13: Temporary chats is LAST, below every repository.
                      Decision 183 §1.2 pinned it above them; the user's ruling
                      on 2026-10-12 (decision 186) reverses that — a chat with
                      no repository is the least specific group on the list, and
                      a permanently-first slot made the repositories move under
                      it every time a temporary chat was started. */}
                  {renderTemporaryGroup()}
                </>
              )}
            </div>
          </ScrollArea>
        </ContextMenuPrimitive.Trigger>
        <MenuPopup align="start" side="bottom" className="min-w-40">
          {/* Layout 5b: the grouping, reachable with no heading on screen. */}
          <MenuSub>
            <MenuSubTrigger>
              <FolderTree className="size-4" />
              {t('Group chats')}
            </MenuSubTrigger>
            <MenuSubPopup className="min-w-40">
              <GroupingModeRadio mode={archiveMode} onModeChange={setArchiveMode} />
            </MenuSubPopup>
          </MenuSub>
          <MenuSeparator />
          {groupingByGroup && (
            <MenuItem onClick={() => setCreatingGroup(true)}>
              <Plus className="size-4" />
              {t('New group…')}
            </MenuItem>
          )}
          <MenuItem onClick={() => openHome()}>
            <Plus className="size-4" />
            {t('New chat')}
          </MenuItem>
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

      {/* Issue #15 phase 2 (decision 187): deleting a group asks first, and
          says where its conversations go. The alternative — archiving them
          with the group — is not what 「删除分组」 says, and the dialog is the
          only place that can make that plain before it happens. */}
      <AlertDialog
        open={!!groupToDelete}
        onOpenChange={(open) => {
          if (!open) setGroupToDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Delete group')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('Delete “{{name}}”?', {
                name: orderedGroups.find((group) => group.id === groupToDelete)?.name ?? '',
              })}
              <span className="mt-2 block text-muted-foreground">
                {t('Its chats stay and go back to Ungrouped.')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setGroupToDelete(null)}>
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (groupToDelete) deleteGroup(groupToDelete);
                setGroupToDelete(null);
              }}
            >
              {t('Delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

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
 * Decision 183 (prototype `.group`): groups are separated by spacing alone —
 * no divider, no region title. Layout 5b (the desktop screenshot): 16px above
 * every heading but the first (4px under the nav's own 8px).
 */
const SIDEBAR_GROUP_CLASS = 'mt-4 first:mt-1';

/** Header → first row and rows to each other: flush, as in the screenshot. Not indented. */
const GROUP_ROWS_CLASS = 'flex flex-col';

/**
 * Layout 5b: the top nav's entries — 28px rows, 13px text, a 16px Lucide icon,
 * frameless with the ghost hover (design system v2 §7.12, `rounded-xs`).
 */
const NAV_ITEM_CLASS =
  'flex h-7 w-full items-center gap-2 rounded-xs px-2 text-left text-ui text-foreground-soft hover:bg-fill-ghost-hover hover:text-foreground focus-visible:bg-fill-ghost-hover disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-fill-ghost-hover';

const NAV_ICON_CLASS = 'size-4 shrink-0 text-muted-foreground';

/** The filter field owns Escape (it clears and closes) — see `SURFACE_ESCAPE_HOLD_ATTR`. */
const FILTER_HOLDS_ESCAPE = { [SURFACE_ESCAPE_HOLD_ATTR]: '' };

/**
 * The search box (prototype `.search`; user ruling 2026-10-11), redrawn for
 * design system v2 §7.12: a FILLED field — `--fill-neutral`, no border line,
 * no drop shadow, no inner shade — in light and dark alike; focused, a
 * `--border-strong` line and no ring. `rounded-sm` because the group's
 * `rounded-lg` on an h-8 control breaks the radius clamp rule.
 *
 * Each override names the SAME variant stack as the base class it replaces,
 * so tailwind-merge drops the base one instead of leaving both to a
 * specificity contest (`border-transparent` / `border-input`,
 * `bg-fill-neutral` / `bg-background`, `dark:bg-fill-neutral` /
 * `dark:bg-input/32`, `shadow-none` / `shadow-xs`, and the
 * `has-[input:focus-visible,…]` pair replacing `border-ring` and `ring-2`).
 * The inner shade lives on the group's `::before` behind two long
 * `not-has-[…]` stacks (light and dark); `before:hidden` removes the pseudo
 * element instead, since nothing else sets its `display`. The placeholder is
 * the full muted ink (the input's own is `/72`): the descendant selector
 * outranks the input's single class. Asserted on the rendered className in
 * `sidebarActiveAndFolders.test.ts`.
 */
const SIDEBAR_SEARCH_CLASS =
  'h-8 min-w-0 flex-1 rounded-sm border-transparent bg-fill-neutral shadow-none before:hidden dark:bg-fill-neutral has-[input:focus-visible,textarea:focus-visible]:border-border-strong has-[input:focus-visible,textarea:focus-visible]:ring-0 [&_input]:placeholder:text-muted-foreground';

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
  mark,
  tooltip,
  expanded,
  onToggle,
  summary,
  trailing,
  actions,
  groupId,
  tabbable,
  drop,
}: {
  name: string;
  nameSlot:
    | 'sidebar-folder-name'
    | 'sidebar-temporary-name'
    | 'sidebar-group-name'
    | 'sidebar-bucket-name';
  /** Decision 187: draw the 2px group mark before the label (groups only). */
  mark?: boolean;
  tooltip: string;
  expanded: boolean;
  /** Undefined while a search is typed: the group is held open for its matches. */
  onToggle?: () => void;
  summary: SidebarGroupSummary | null;
  trailing?: ReactNode;
  actions: ReactNode;
  /** Issue #26 item 7: the group this header folds, for the keyboard model. */
  groupId: string;
  /** Roving tabindex: whether Tab lands on this header. */
  tabbable: boolean;
  /** 「按分组」 only: the header as a drop target for a dragged chat. */
  drop?: { active: boolean; handlers: GroupDropHandlers };
}): ReactElement {
  return (
    <div
      className={cn(
        'group flex h-7 w-full items-center gap-1 rounded-xs px-2 has-focus-visible:bg-fill-ghost-hover',
        // Design system v2 §1 rule 7: the drag target is one of clay's few places.
        drop?.active && 'ring-2 ring-primary/60 ring-inset'
      )}
      data-drop-target={drop?.active || undefined}
      {...drop?.handlers}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left text-small font-medium text-foreground-faint group-hover:text-foreground-soft group-has-focus-visible:text-foreground-soft"
        title={tooltip}
        aria-expanded={expanded}
        onClick={onToggle}
        tabIndex={tabbable ? 0 : -1}
        data-sidebar-nav="header"
        data-sidebar-nav-key={sidebarHeaderNavKey(groupId)}
        data-sidebar-nav-group={groupId}
      >
        {mark && <GroupMark />}
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

/** A group header's drop handlers (issue #26 item 7). */
interface GroupDropHandlers {
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}

/**
 * Decision 187 (user ruling 2026-10-13): the mark in front of a group label in
 * 「按分组」 mode — a 2px vertical rule, user-created group and 「未分组」 alike.
 *
 * It replaced the folder glyph. A folder says "a directory on disk", which is
 * exactly what a repository group is; a group of conversations is not one, and
 * reusing the glyph would leave the two kinds of header telling the same lie.
 * A rule is the smallest mark that still reads as "a section starts here", and
 * it takes no colour of its own (the label's grey already carries the tier).
 *
 * Hidden from the accessibility tree: the header's button already announces
 * the group by name and fold state, so the mark is decoration.
 */
function GroupMark() {
  return <span aria-hidden className="h-3 w-0.5 shrink-0 rounded-full bg-border" />;
}

/**
 * Decision 183 §2.2: what a folded group is hiding, in the rows' own marks —
 * a spinner for turns running (with the count past one), the clay
 * waiting-on-you dot (design system v2 §6: both drawn by `StatusIcon`), then red for an unseen failure or else green for
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
      className="ml-0.5 flex shrink-0 items-center gap-1 text-small text-muted-foreground tabular-nums"
    >
      {summary.running > 0 && (
        <span className="flex items-center gap-0.5" title={runningLabel}>
          <StatusIcon status="running" label={runningLabel} />
          {summary.running > 1 && summary.running}
        </span>
      )}
      {summary.waiting && (
        <StatusIcon
          status="waiting"
          label={t('A chat is waiting for you')}
          title={t('A chat is waiting for you')}
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
 * Decision 167 / 183: the list's own L4 rows — 「显示更多」 and "Show less".
 * Layout 5b: h-7 like a row, 12px in the faint ink, starting in the titles'
 * column (rows no longer have a leading slot).
 */
function SidebarAuxRow({
  onClick,
  navKey,
  tabbable,
  title,
  children,
}: {
  onClick: () => void;
  navKey: string;
  tabbable: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      tabIndex={tabbable ? 0 : -1}
      data-sidebar-nav="aux"
      data-sidebar-nav-key={navKey}
      title={title}
      className="flex h-7 w-full items-center rounded-xs px-2 text-small text-foreground-faint tabular-nums hover:bg-fill-ghost-hover hover:text-muted-foreground focus-visible:bg-fill-ghost-hover"
      onClick={onClick}
    >
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
  /**
   * Issue #15: the row's own directory, opened in the system file manager.
   * Absent for a chat with no local directory: an unbound one has none, and a
   * remote repository's virtual path cannot be opened (`shell.openPath`
   * rejects it — see `handleOpenFolder`), so the item is hidden rather than
   * offered and then failed.
   */
  onJumpToWorkspace?: () => void;
  /**
   * Issue #15 phase 2 (decision 187): 「移到分组 ▸」 — the groups this chat can
   * be filed under, and which one holds it now. Passed only in 「按分组」 mode:
   * in 「按工作目录」 the list has no groups to move between, and an item that
   * led nowhere would be worse than no item.
   */
  groupMove?: {
    groups: readonly { id: string; name: string }[];
    currentGroupId: string | null;
    onMove: (groupId: string) => void;
    /** 「新建分组…」: the new group is made with the name and this chat goes in. */
    onCreateGroup: () => void;
  };
  /** Issue #26 item 7: the row's roving-tabindex key, and whether Tab lands on it. */
  navKey: string;
  tabbable: boolean;
  /**
   * Issue #26 item 7: present when the row can be dragged onto a group header
   * (「按分组」, not selecting). Rows without it are not draggable.
   */
  drag?: { dragging: boolean; onStart: () => void; onEnd: () => void };
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
  onJumpToWorkspace,
  groupMove,
  navKey,
  tabbable,
  drag,
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
  // Layout 5b: a pending approval is waiting-on-you even before the status
  // says so; the count moved from its badge into this mark's words.
  const rowWaiting = (row.busy && isWaitingSessionStatus(row.status)) || pendingApprovalCount > 0;
  const waitingLabel =
    pendingApprovalCount > 0
      ? t('{{count}} pending approval requests', { count: pendingApprovalCount })
      : row.status === 'waiting_question'
        ? t('Waiting for an answer')
        : t('Waiting for approval');
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

  /**
   * `refocus`: Enter committed it, so focus goes back to the row as Esc does
   * (decision 193 rule 5). A blur commit leaves focus where the user moved it.
   */
  const commitRename = (refocus = false) => {
    if (!renamingRef.current) return;
    if (refocus) refocusRowRef.current = true;
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
        className="flex h-8 w-full items-center gap-1 rounded-sm px-1"
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
              commitRename(true);
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
          // Decision 170: the row's own size (`text-ui`), so a rename does not grow the text.
          className="h-6 flex-1 rounded-sm text-ui before:rounded-[calc(var(--radius-sm)-1px)]"
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
            // Design system v2 §7.12: --fill-ghost-hover / --fill-ghost-selected
            // are two solid steps of one ramp; neither takes a /N modifier.
            // The two are mutually exclusive on purpose: `hover:bg-fill-ghost-hover` compiles to
            // `.hover\:bg-fill-ghost-hover:hover` (0,2,0) and would outrank a plain `.bg-fill-ghost-selected`
            // (0,1,0), so pointing at the active row would repaint it as an ordinary
            // hovered row and erase the selection. Keyboard focus (decision 167) lights
            // the same step as hover; the global reset removed the outline.
            // overflow-hidden is load-bearing, not cosmetic: `min-w-20` on the title
            // makes the row's minimum content size exceed the track at the default
            // sidebar width, and without it the trailing items would spill past the
            // rounded edge instead of the branch text absorbing the deficit.
            // Decision 170 (issue #6 rulings 3–4): `text-ui`, and the title one step
            // below the body ink — `--foreground-soft`, never with /N — except
            // on the open chat, which keeps the body colour. `relative`
            // anchors the floating actions (decision 183 §1.4).
            // Layout 5b: 28px (h-7), text only — the state is a trailing mark.
            'group relative flex h-7 w-full items-center gap-1.5 overflow-hidden rounded-xs px-2 text-left text-ui',
            active
              ? 'bg-fill-ghost-selected text-foreground'
              : 'text-foreground-soft hover:bg-fill-ghost-hover focus-visible:bg-fill-ghost-hover',
            drag?.dragging && 'opacity-50'
          )}
          onClick={() => (onToggleSelect ? onToggleSelect(row.sessionId) : onSelect())}
          onDoubleClick={onToggleSelect ? undefined : beginRename}
          role="button"
          // Issue #26 item 7: roving tabindex — still focusable, one Tab stop.
          tabIndex={tabbable ? 0 : -1}
          data-sidebar-nav="row"
          data-sidebar-nav-key={navKey}
          // Native drag: the platform's drag threshold (a few px, like the
          // reference's 4px dead zone) keeps a click from starting one.
          draggable={drag ? true : undefined}
          onDragStart={
            drag
              ? (event: DragEvent<HTMLElement>) => {
                  event.dataTransfer.setData(SIDEBAR_SESSION_DRAG_TYPE, row.sessionId);
                  event.dataTransfer.effectAllowed = 'move';
                  drag.onStart();
                }
              : undefined
          }
          onDragEnd={drag ? drag.onEnd : undefined}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (onToggleSelect) onToggleSelect(row.sessionId);
              else onSelect();
            }
          }}
          title={tooltip}
        >
          {/* U31: while choosing what to archive, a checkbox leads the row —
              the one time a row has a leading slot (layout 5b moved the
              run-state mark to the end). */}
          {onToggleSelect && (
            <span
              aria-hidden
              className={cn(
                'flex size-3.5 shrink-0 items-center justify-center rounded-xs border',
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border-soft'
              )}
            >
              {selected && <Check className="size-2.5" />}
            </span>
          )}
          {/* `min-w-20` is the whole point of this row's sizing (S2 b). The title is
          the row's identity and the only user-authored text on it, so it gets a
          floor and everything else yields to it. Without the floor `flex-1
          min-w-0` shrinks to whatever is left. Budget at the 272px default
          (layout 5a: SIDEBAR_DEFAULT_WIDTH = 272, no rail; layout 5b: no
          leading slot): the sidebar's 272 includes its 1px right border, so
          272 - 1 - 16 (the list's px-2) - 16 (the row's px-2) = 239px of
          content; minus the trailing 14px mark and one 6px gap, the title
          gets 219px. */}
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
          {branch && (
            // Decision 167 §2 (replaces D21-A): context text, only for a chat
            // on a non-main workspace (a linked worktree), only inside its
            // folder, and only the branch's last segment — the full name is
            // its tooltip. It is the row's sole yielder: the only trailing
            // item that is unbounded user data and recoverable elsewhere (the
            // tooltip, the Composer target bar), so when the row runs out of
            // width this gives — never the title. `shrink` + `min-w-0` is what
            // lets flexbox route the deficit here; dropping either sends it
            // back to the title. Layout 5b: the faint ink, so it reads as
            // context next to the soft title.
            <span
              className="min-w-0 max-w-24 shrink truncate text-small text-foreground-faint"
              title={branch}
            >
              {lastBranchSegment(branch)}
            </span>
          )}
          {/* dsh-rebase P1-9e (decision 051): the legacy copy of a migrated
              chat, continued in 1.0.x since. It sits next to the migrated
              chat under the same title, so the mark is what tells the two
              apart; the tooltip says what continuing it does. The label is
              the version alone. Decision 167: Badge `lg`. */}
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
          {/* Layout 5b (the screenshot): the row's state is ONE small mark at
              its end, not a leading dot. Order is urgency, which is also why
              one slot loses nothing: waiting-on-you (a parked turn, or a
              pending approval — the count is its tooltip) outranks running;
              a running session cannot hold an unseen result (the result is
              what ends the run); a failure stays marked after it was seen,
              only quieter; "attached in the background" is the faint dot,
              and a chat not started shows nothing. Design system v2 §6: run
              states are drawn by `StatusIcon`. */}
          {!onToggleSelect &&
            (rowWaiting ? (
              <StatusIcon status="waiting" label={waitingLabel} title={waitingLabel} />
            ) : row.busy ? (
              <StatusIcon status="running" label={t('Running')} />
            ) : row.failed ? (
              <span
                role="img"
                aria-label={unread ? unreadLabel : t('Failed')}
                title={unread ? unreadLabel : t('Failed')}
                className="inline-grid size-3.5 shrink-0 place-items-center"
              >
                <AlertTriangle
                  className={cn('size-3.5', unread ? 'text-destructive' : 'text-muted-foreground')}
                />
              </span>
            ) : unread ? (
              // Not `aria-hidden` like the background dot: this is the ONLY
              // carrier of "there is a result here you have not seen".
              <span
                role="img"
                aria-label={unreadLabel}
                title={unreadLabel}
                className="inline-grid size-3.5 shrink-0 place-items-center"
              >
                <span className="size-1.5 rounded-full bg-success" />
              </span>
            ) : started ? (
              // Issue #16: an attached session is a FILLED dot.
              <span
                aria-hidden
                className="inline-grid size-3.5 shrink-0 place-items-center"
                title={t('Running in the background')}
              >
                <span className="size-1.5 rounded-full bg-muted-foreground-faint" />
              </span>
            ) : null)}
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
                  ? 'bg-fill-ghost-selected shadow-[-10px_0_8px_var(--fill-ghost-selected)]'
                  : 'bg-fill-ghost-hover shadow-[-10px_0_8px_var(--fill-ghost-hover)]'
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
          {/* Issue #15: the way back to where this chat lives. Sits right below
              Rename because both are "about the chat's identity and place",
              and above the destructive entries below. */}
          {onJumpToWorkspace && (
            <MenuItem onClick={onJumpToWorkspace}>
              <FolderTree className="size-4" />
              {t('Jump to working directory')}
            </MenuItem>
          )}
          {/* Issue #15 phase 2 (decision 187): the way a chat is filed. Right
              here rather than behind a drag: a menu covers every filing action
              — put it in a group, take it out, make a group for it — without a
              drag layer, without auto-scroll across the scroll area, and
              without having to tell a drag apart from the click that opens the
              conversation. The current group is ticked, so the submenu also
              answers "where is this chat filed now". */}
          {groupMove && (
            <MenuSub>
              <MenuSubTrigger>
                <CornerDownRight className="size-4" />
                {t('Move to group')}
              </MenuSubTrigger>
              <MenuSubPopup className="min-w-40">
                <MenuItem onClick={() => groupMove.onMove(UNGROUPED_GROUP_ID)}>
                  <Check
                    className={cn('size-4', groupMove.currentGroupId !== null && 'invisible')}
                  />
                  {t('Ungrouped')}
                </MenuItem>
                {groupMove.groups.map((group) => (
                  <MenuItem key={group.id} onClick={() => groupMove.onMove(group.id)}>
                    <Check
                      className={cn('size-4', groupMove.currentGroupId !== group.id && 'invisible')}
                    />
                    {group.name}
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem onClick={groupMove.onCreateGroup}>
                  <Plus className="size-4" />
                  {t('New group…')}
                </MenuItem>
              </MenuSubPopup>
            </MenuSub>
          )}
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
