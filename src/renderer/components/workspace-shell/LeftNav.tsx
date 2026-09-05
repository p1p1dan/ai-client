import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import type { TempWorkspaceItem } from '@shared/types';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  ListFilter,
  Pencil,
  Plus,
  Search,
  ShieldQuestion,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { Repository } from '@/App/constants';
import { STORAGE_KEYS } from '@/App/storage';
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
import { MenuItem, MenuPopup } from '@/components/ui/menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { createChatSessionOnWorkspace } from '@/stores/chatSessionActions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useExtensionUiStore } from '@/stores/extensionUi';
import { useSessionTabsStore } from '@/stores/sessionTabs';
import { useSessionIndex, useSessionIndexMutations } from '../chat/sessionIndex/useSessionIndex';
import {
  canCreateSessionOnWorkspace,
  shouldShowAddRepositoryEmptyState,
} from './addRepositoryEntry';
import { projectIdForRepo, workspaceIdFor } from './deriveChatWorkspaceTree';
import {
  buildSidebarFolders,
  buildUnboundFolder,
  deriveRecentRows,
  formatRelativeAge,
  RECENT_DEFAULT_LIMIT,
  resolveActiveProjectId,
  resolveFolderClickActivation,
  resolveNewSessionTarget,
  type SidebarSessionRow,
  UNBOUND_FOLDER_ID,
} from './sidebarTree';
import { useActivateSession } from './useActivateSession';

/**
 * D08 (U15-a): this is the `chat` SURFACE's body now, not a column.
 *
 * The chrome it used to own moved to `LeftDock`, which hosts it: the h-9 bar
 * (now the dock's title row), the collapse button (now on that row and on the
 * rail), the account pill (`UserFooterPill`, so it survives a surface switch)
 * and the plugin entry + dialog (now the rail's bottom group). What stays is
 * exactly the session list — search, New / Add repository, Recent, the folder
 * tree and the temporary-chat group.
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
  // to LeftNav and only feeds the header "New" button's target resolution,
  // it never becomes the source of truth for "where to run" (that's the
  // Composer target bar, T-27).
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const [recentCollapsed, setRecentCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.SIDEBAR_RECENT_COLLAPSED) === 'true';
    } catch {
      return false;
    }
  });
  const [recentShowAll, setRecentShowAll] = useState(false);
  const [searchVisible, setSearchVisible] = useState(true);
  const [repoToRemove, setRepoToRemove] = useState<Repository | null>(null);

  const handleConfirmRemoveRepo = useCallback(() => {
    if (repoToRemove && onRemoveRepository) {
      onRemoveRepository(repoToRemove.path);
    }
    setRepoToRemove(null);
  }, [repoToRemove, onRemoveRepository]);

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
  // D08: which sessions have a center-column tab. Rows show it so "click =
  // start" does not invite a second click on something already running.
  const openSessionIds = useSessionTabsStore((state) => state.openSessionIds);
  const extensionUiPending = useExtensionUiStore((state) => state.pending);
  const pendingApprovalCountBySession = useMemo(() => {
    const counts = new Map<string, number>();
    for (const request of extensionUiPending) {
      if (!request.sessionId) continue;
      counts.set(request.sessionId, (counts.get(request.sessionId) ?? 0) + 1);
    }
    return counts;
  }, [extensionUiPending]);

  // T-02: hydrate + mutate the persisted session index (chat:listSessions /
  // renameSession / archiveSession / closeSession).
  const { refresh } = useSessionIndex();
  const { rename, archive, close } = useSessionIndexMutations(refresh);

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

  const toggleRecentCollapsed = () => {
    setRecentCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEYS.SIDEBAR_RECENT_COLLAPSED, String(next));
      } catch {
        // Ignore storage errors (private mode / quota exceeded), same as other collapsed flags.
      }
      return next;
    });
  };

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
  // it the age column freezes and the 48h Recent window never expires.
  const [, bumpClock] = useReducer((tick: number) => tick + 1, 0);
  useEffect(() => {
    const timer = setInterval(bumpClock, 60_000);
    return () => clearInterval(timer);
  }, []);

  // Cheap at sidebar scale; a useMemo would be defeated by the per-render
  // `now` anyway (Recent's 48h window needs a fresh clock every render).
  const now = Date.now();
  const folders = buildSidebarFolders({ projects, workspaces, sessions, query });
  // U13: rendered next to the repository folders but deliberately NOT part of
  // `folders` — it has no workspace to create a chat in, so letting the "New"
  // target resolver see it would only produce a disabled button pointing at a
  // folder that cannot host anything. `null` when there are no such chats.
  const unboundFolder = buildUnboundFolder({ sessions, name: t('Temporary chats'), query });
  const recent = deriveRecentRows({ sessions, workspaces, now, showAll: recentShowAll, query });
  const queryActive = query.trim().length > 0;
  // While searching, folders with zero hits collapse away instead of leaving
  // a wall of empty headers; without a query every folder stays visible so
  // its "+ new chat" row remains reachable.
  const visibleFolders = queryActive ? folders.filter((folder) => folder.rows.length > 0) : folders;
  const noMatches =
    queryActive && recent.rows.length === 0 && visibleFolders.length === 0 && !unboundFolder;

  // D1 (round-5): resolved fresh every render from the live `folders` list —
  // never cache `newSessionTarget.workspaceId` itself — so a deleted focused
  // project self-heals to the next fallback tier instead of pointing at
  // nothing. `folders` is always the full project list — `visibleFolders`
  // must NOT be used here: while a search is active it hides folders with no
  // title hits, which would make the resolver skip the focused/active folder
  // and silently create the chat somewhere else.
  const newSessionTarget = resolveNewSessionTarget({
    focusedProjectId,
    folders,
    activeSession,
    workspaces,
  });
  const effectiveWorkspaceId = newSessionTarget.workspaceId;
  // The fallback target can be a seed workspace with an empty path, and while
  // the empty state is up the created session would render nowhere.
  const canStartNewSession = canCreateSessionOnWorkspace(effectiveWorkspaceId, workspaces);
  // No folder selection visual (T-26 decision holds) — the title is the only
  // surface that makes the resolved target discoverable.
  const newSessionButtonTitle = newSessionTarget.folderName
    ? t('New session in {{folder}}', { folder: newSessionTarget.folderName })
    : undefined;

  const handleNewSession = () => {
    if (!effectiveWorkspaceId || !canStartNewSession) {
      return;
    }
    createChatSessionOnWorkspace(effectiveWorkspaceId);
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
   * The header only expands/collapses: the cross-folder activation rule
   * (D29) is about following a repository into its git/file panels, and this
   * group has no repository behind it.
   */
  const renderUnboundSection = () => {
    if (!unboundFolder) return null;
    const expanded = isProjectExpanded(UNBOUND_FOLDER_ID);
    return (
      <section>
        <div className="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-ui hover:bg-hover">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
            onClick={() =>
              setExpandedProjects((prev) => ({ ...prev, [UNBOUND_FOLDER_ID]: !expanded }))
            }
          >
            {expanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-folder" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-folder" />
            )}
            <span className="min-w-0 flex-1 truncate font-semibold">{unboundFolder.name}</span>
          </button>
        </div>
        {expanded && (
          <div className="mt-1 space-y-0.5 pl-3">
            {unboundFolder.rows.map((row) => (
              <SessionRow
                key={row.sessionId}
                row={row}
                now={now}
                active={activeSessionId === row.sessionId}
                opened={openSessionIds.includes(row.sessionId)}
                pendingApprovalCount={pendingApprovalCountBySession.get(row.sessionId) ?? 0}
                onSelect={() => handleSelectSession(row.sessionId)}
                onClose={() => void close(row.sessionId)}
                onRename={(title) => void rename(row.sessionId, title)}
                onArchive={() => void archive(row.sessionId, true)}
              />
            ))}
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
      <div className="space-y-2 border-b p-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="xs"
            className="h-6"
            disabled={!canStartNewSession}
            title={newSessionButtonTitle}
            onClick={handleNewSession}
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
          {/* Replaces a permanently disabled "Workspace" placeholder: the
                  new shell had no reachable way to register a repository. */}
          <Button
            variant="outline"
            size="xs"
            className="h-6 min-w-0"
            title={t('Add Repository')}
            onClick={onAddRepository}
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{t('Add Repository')}</span>
          </Button>
        </div>
        {searchVisible && (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search sessions')}
              className="h-7 pl-7"
            />
          </div>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-2">
          {showAddRepositoryEmptyState ? (
            <>
              {/* Seed sessions point at empty-path workspaces and cannot send,
                      so surface the entry point instead of a misleading tree.
                      U13: temporary chats are the exception — they run without a
                      repository, so they are listed below the call to action. */}
              <Empty className="gap-3 border-0 p-2 md:p-2">
                <EmptyMedia variant="icon">
                  <FolderGit2 className="h-4.5 w-4.5" />
                </EmptyMedia>
                <EmptyHeader>
                  {/* D25 §3.3: EmptyTitle's shared base now carries a
                        negative tracking meant for its 18px default — this
                        compact sidebar usage shrinks to 14px (text-ui) and
                        may render CJK, so tracking must be cancelled back to
                        normal (negative tracking + CJK is the banned
                        combination). */}
                  <EmptyTitle className="text-ui tracking-normal">{t('Add Repository')}</EmptyTitle>
                  <EmptyDescription className="text-meta">
                    {t('Add a repository to get started.')}
                  </EmptyDescription>
                </EmptyHeader>
                <Button variant="outline" size="xs" className="h-6" onClick={onAddRepository}>
                  <Plus className="h-3.5 w-3.5" />
                  {t('Add Repository')}
                </Button>
              </Empty>
              {renderUnboundSection()}
            </>
          ) : (
            <>
              <section>
                <div className="flex h-7 items-center px-2">
                  <p className="text-ui font-medium tracking-[0.04em] text-muted-foreground">
                    {t('Recent')}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="ml-auto h-5 w-5"
                    aria-label={recentCollapsed ? t('Expand Recent') : t('Collapse Recent')}
                    onClick={toggleRecentCollapsed}
                  >
                    {recentCollapsed ? (
                      <ChevronRight className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                {!recentCollapsed && (
                  <div className="mt-1 space-y-0.5">
                    {recent.rows.map((row) => (
                      <SessionRow
                        key={`recent-${row.sessionId}`}
                        row={row}
                        now={now}
                        active={activeSessionId === row.sessionId}
                        opened={openSessionIds.includes(row.sessionId)}
                        pendingApprovalCount={pendingApprovalCountBySession.get(row.sessionId) ?? 0}
                        onSelect={() => handleSelectSession(row.sessionId)}
                        onClose={() => void close(row.sessionId)}
                        onRename={(title) => void rename(row.sessionId, title)}
                        onArchive={() => void archive(row.sessionId, true)}
                      />
                    ))}
                    {recent.hiddenCount > 0 ? (
                      <button
                        type="button"
                        className="flex h-7 w-full items-center rounded-md px-2 pl-5 text-ui text-muted-foreground hover:bg-hover"
                        onClick={() => setRecentShowAll(true)}
                      >
                        {t('Show more')} (<span className="tabular-nums">{recent.hiddenCount}</span>
                        )
                      </button>
                    ) : (
                      recentShowAll &&
                      recent.rows.length > RECENT_DEFAULT_LIMIT && (
                        <button
                          type="button"
                          className="flex h-7 w-full items-center rounded-md px-2 pl-5 text-ui text-muted-foreground hover:bg-hover"
                          onClick={() => setRecentShowAll(false)}
                        >
                          {t('Show less')}
                        </button>
                      )
                    )}
                  </div>
                )}
              </section>

              <div className="flex h-7 items-center px-2">
                <p className="text-ui font-medium tracking-[0.04em] text-muted-foreground">
                  {t('Repositories')}
                </p>
                <div className="ml-auto flex items-center">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="h-5 w-5"
                    aria-label={t('Filter sessions')}
                    title={t('Filter sessions')}
                    aria-pressed={searchVisible}
                    onClick={toggleSearchVisible}
                  >
                    <ListFilter className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="h-5 w-5"
                    aria-label={t('Add Repository')}
                    title={t('Add Repository')}
                    onClick={onAddRepository}
                  >
                    <FolderPlus className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              {noMatches && (
                <p className="px-2 py-1 text-meta text-muted-foreground">
                  {t('No matching sessions')}
                </p>
              )}

              {visibleFolders.map((folder) => {
                const expanded = isProjectExpanded(folder.projectId);
                const newSessionWorkspaceId = folder.newSessionWorkspaceId;
                const folderRepo = repoByProjectId.get(folder.projectId);
                return (
                  <section key={folder.projectId}>
                    {/* Toggle and "+ new chat" are sibling buttons in a flex
                            row — a nested button would be invalid HTML (same
                            trap as the McpSection fix in d68d3c6). */}
                    <div
                      // Project headers have no selected state, so the plain
                      // hover step is enough; --hover is the semantic alias.
                      className="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-ui hover:bg-hover"
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                        onClick={() => {
                          // D1 (round-5): a folder header click also targets
                          // the global "New" button at this folder, in sync
                          // with handleSelectSession's session-pick path.
                          setFocusedProjectId(folder.projectId);
                          // F3 (D29 adversarial-review, minor): read fresh
                          // store state at click time rather than the
                          // render-body `activeSession` snapshot — this
                          // handler can fire well after the render that
                          // captured it scheduled this closure.
                          const activeProjectId = resolveActiveProjectId(
                            useChatSessionsStore.getState()
                          );
                          // D29 (open-q #28 A) + F1 (adversarial-review
                          // major): activation and expansion are decided
                          // together by one pure call, so a cross-repo
                          // click can never toggle the just-activated
                          // folder closed — the old code toggled expansion
                          // unconditionally BEFORE deciding activation,
                          // which could collapse the row it had just
                          // activated. Routed through the very same
                          // handler a session row click uses — no second
                          // activation path.
                          const { activateSessionId, nextExpanded } = resolveFolderClickActivation({
                            folder,
                            activeProjectId,
                            currentExpanded: expanded,
                          });
                          setExpandedProjects((prev) => ({
                            ...prev,
                            [folder.projectId]: nextExpanded,
                          }));
                          if (activateSessionId) {
                            handleSelectSession(activateSessionId);
                          }
                        }}
                      >
                        {expanded ? (
                          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-folder" />
                        ) : (
                          <Folder className="h-3.5 w-3.5 shrink-0 text-folder" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-semibold">{folder.name}</span>
                      </button>
                      {onRemoveRepository && folderRepo && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="hidden h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive group-hover:flex group-focus-within:flex"
                          aria-label={t('Remove repository')}
                          title={t('Remove repository')}
                          onClick={(event) => {
                            event.stopPropagation();
                            setRepoToRemove(folderRepo);
                          }}
                        >
                          <FolderMinus className="h-3 w-3" />
                        </Button>
                      )}
                      {newSessionWorkspaceId && (
                        // The header New button targets the active session's
                        // workspace only, so a repo that already has sessions
                        // needs its own entry point (T-26 review should-fix).
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="hidden h-5 w-5 shrink-0 group-hover:flex group-focus-within:flex"
                          aria-label={t('New chat')}
                          title={t('New chat')}
                          onClick={() => createChatSessionOnWorkspace(newSessionWorkspaceId)}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      )}
                    </div>

                    {expanded && (
                      <div className="mt-1 space-y-0.5 pl-3">
                        {folder.rows.map((row) => {
                          const tempItemId = tempItemIdByWorkspaceId.get(row.workspaceId);
                          return (
                            <SessionRow
                              key={row.sessionId}
                              row={row}
                              now={now}
                              active={activeSessionId === row.sessionId}
                              opened={openSessionIds.includes(row.sessionId)}
                              pendingApprovalCount={
                                pendingApprovalCountBySession.get(row.sessionId) ?? 0
                              }
                              onSelect={() => handleSelectSession(row.sessionId)}
                              onClose={() => void close(row.sessionId)}
                              onRename={(title) => void rename(row.sessionId, title)}
                              onArchive={() => void archive(row.sessionId, true)}
                              onDeleteTemp={
                                tempItemId && onRequestTempDelete
                                  ? () => onRequestTempDelete(tempItemId)
                                  : undefined
                              }
                            />
                          );
                        })}
                        {folder.rows.length === 0 && !query.trim() && newSessionWorkspaceId && (
                          <button
                            type="button"
                            className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-ui text-muted-foreground hover:bg-hover"
                            onClick={() => createChatSessionOnWorkspace(newSessionWorkspaceId)}
                          >
                            <Plus className="h-3 w-3 shrink-0" />
                            {t('New chat')}
                          </button>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}

              {renderUnboundSection()}
            </>
          )}
        </div>
      </ScrollArea>

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
    </aside>
  );
}

interface SessionRowProps {
  row: SidebarSessionRow;
  now: number;
  active: boolean;
  pendingApprovalCount: number;
  /**
   * D08: this session has a center-column tab. Clicking a row now STARTS the
   * session rather than switching to it, so the list has to say which ones are
   * already started — otherwise the only feedback for "it is already open" is
   * that nothing visibly happens, and the user clicks again.
   */
  opened: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  /** Set only for rows whose workspace is a Temp session (see `tempItemIdByWorkspaceId`
   * in LeftNav) — renders a third hover action that deletes the whole Temp directory. */
  onDeleteTemp?: () => void;
}

function SessionRow({
  row,
  now,
  active,
  pendingApprovalCount,
  opened,
  onSelect,
  onClose,
  onRename,
  onArchive,
  onDeleteTemp,
}: SessionRowProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.title);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== row.title) {
      onRename(trimmed);
    } else {
      setDraft(row.title);
    }
    setEditing(false);
  };

  const beginRename = () => {
    setDraft(row.title);
    setEditing(true);
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
      <div className="flex h-7 w-full items-center gap-1 rounded-md px-1">
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(row.title);
              setEditing(false);
            }
          }}
          className="h-6 flex-1 text-ui"
        />
      </div>
    );
  }

  return (
    <>
      <ContextMenuPrimitive.Root>
        <ContextMenuPrimitive.Trigger
          className={cn(
            // --hover / --selection are two distinct steps of the same Flexoki
            // interactive ramp; neither takes a /N modifier.
            // The two are mutually exclusive on purpose: `hover:bg-hover` compiles to
            // `.hover\:bg-hover:hover` (0,2,0) and would outrank a plain `.bg-selection`
            // (0,1,0), so pointing at the active row would repaint it as an ordinary
            // hovered row and erase the selection.
            // overflow-hidden is load-bearing, not cosmetic: `min-w-20` on the title
            // makes the row's minimum content size exceed the track at the default
            // sidebar width, and without it the trailing items would spill past the
            // rounded edge instead of the branch chip absorbing the deficit.
            'group flex h-7 w-full items-center gap-1.5 overflow-hidden rounded-md px-2 text-left text-ui',
            active ? 'bg-selection text-accent-foreground' : 'hover:bg-hover'
          )}
          onClick={onSelect}
          onDoubleClick={beginRename}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSelect();
            }
          }}
          title={row.title}
        >
          {/* D08's three-state marker, in one 6px slot so rows never jump:
              filled = running, ring = started (has a tab), nothing = not started.
              `busy` wins when both are true — "it is working" is the more urgent
              of the two facts. */}
          {row.busy ? (
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-running"
              title={t('Running')}
            />
          ) : opened ? (
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground"
              title={t('Open in a tab')}
            />
          ) : null}
          {/* `min-w-20` is the whole point of this row's sizing (S2 b). The title is
          the row's identity and the only user-authored text on it, so it gets a
          floor and everything else yields to it. Without the floor `flex-1
          min-w-0` shrinks to whatever is left, and at SIDEBAR_DEFAULT_WIDTH the
          leftovers are ~16px — a bare ellipsis. Budget for an indented row at
          the 280px default: 280 - 16 (p-2) - 12 (pl-3) - 16 (px-2) = 236px, and
          the agent chip alone claims ~63 of it. */}
          <span className="min-w-20 flex-1 truncate">{row.title}</span>
          {pendingApprovalCount > 0 && (
            <Badge
              variant="warning"
              size="sm"
              className="shrink-0 gap-0.5 tabular-nums"
              aria-label={t('{{count}} pending approval requests', {
                count: pendingApprovalCount,
              })}
              title={t('{{count}} pending approval requests', {
                count: pendingApprovalCount,
              })}
            >
              <ShieldQuestion className="size-3" />
              {pendingApprovalCount}
            </Badge>
          )}
          {row.failed && (
            <Badge variant="destructive" size="sm" className="shrink-0">
              failed
            </Badge>
          )}
          {row.chip && (
            // The branch chip is the row's sole yielder. It is the only trailing
            // item whose text is unbounded user data, and it is the only one that
            // is recoverable elsewhere (row `title` tooltip + the Composer target
            // bar, T-27), so when the row runs out of width this is what gives —
            // never the title. `shrink` + `min-w-0` is what lets flexbox route the
            // deficit here; dropping either sends it back to the title.
            <Badge
              variant="outline"
              size="sm"
              className="min-w-0 max-w-24 shrink"
              title={row.chip.label}
            >
              {/* Inner span, not `truncate` on the Badge: Badge is `inline-flex`,
              and text-overflow does not ellipsize the anonymous flex item that
              bare text becomes — it needs a real block child to clip. */}
              <span className="min-w-0 truncate">{row.chip.label}</span>
            </Badge>
          )}
          {/* Age and actions swap on hover; the shared width box is what actually
          keeps the row from jumping — the two are different natural widths (a
          relative age is ~21px, two icon buttons are 40px), so before the
          fixed box the swap silently re-flowed every other item. The row has
          tabIndex=0, so focus-within also reveals the actions and keeps
          Archive/Close reachable by keyboard (display:none alone would drop
          them from the tab order). Temp rows get a third (delete) button, so
          both this span and the actions box below widen to `w-[60px]`
          together — otherwise only the temp rows would jump on hover. */}
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
              className="h-5 w-5"
              aria-label="Archive session"
              title="Archive"
              onClick={(event) => {
                event.stopPropagation();
                requestArchive();
              }}
            >
              <Archive className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-5 w-5"
              aria-label="Close session"
              title="Close"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              <X className="h-3 w-3" />
            </Button>
            {onDeleteTemp && <DeleteTempButton onDelete={onDeleteTemp} />}
          </div>
        </ContextMenuPrimitive.Trigger>

        <MenuPopup align="start" side="bottom" className="min-w-40">
          <MenuItem onClick={beginRename}>
            <Pencil className="size-4" />
            {t('Rename')}
          </MenuItem>
          <MenuItem variant="destructive" onClick={requestArchive}>
            <Archive className="size-4" />
            {t('Archive')}
          </MenuItem>
        </MenuPopup>
      </ContextMenuPrimitive.Root>

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
      className="h-5 w-5 text-muted-foreground hover:text-destructive"
      aria-label={t('Delete')}
      title={t('Delete')}
      onClick={(event) => {
        event.stopPropagation();
        onDelete();
      }}
    >
      <Trash2 className="h-3 w-3" />
    </Button>
  );
}
