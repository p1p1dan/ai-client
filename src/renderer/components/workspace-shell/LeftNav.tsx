import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  ListFilter,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { useEffect, useReducer, useState } from 'react';
import { STORAGE_KEYS } from '@/App/storage';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { createChatSessionOnWorkspace } from '@/stores/chatSessionActions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { resolveResumeModel } from '../chat/models';
import { useResumeSession } from '../chat/sessionIndex/useResumeSession';
import { useSessionIndex, useSessionIndexMutations } from '../chat/sessionIndex/useSessionIndex';
import { useHostStatus } from '../chat/useHostStatus';
import { useSessionModel } from '../chat/useSessionModel';
import {
  canCreateSessionOnWorkspace,
  shouldShowAddRepositoryEmptyState,
} from './addRepositoryEntry';
import {
  buildSidebarFolders,
  deriveRecentRows,
  formatRelativeAge,
  RECENT_DEFAULT_LIMIT,
  resolveNewSessionTarget,
  type SidebarSessionRow,
} from './sidebarTree';

interface LeftNavProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenSettings?: () => void;
  /** T-24: opens the shared AddRepositoryDialog mounted in App. */
  onAddRepository?: () => void;
}

export function LeftNav({
  collapsed,
  onToggleCollapsed,
  onOpenSettings,
  onAddRepository,
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

  const projects = useChatSessionsStore((state) => state.projects);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const selectSession = useChatSessionsStore((state) => state.selectSession);

  // T-02: hydrate + mutate the persisted session index (chat:listSessions /
  // renameSession / archiveSession / closeSession).
  const { refresh } = useSessionIndex();
  const { rename, archive, close } = useSessionIndexMutations(refresh);
  // T-03: replay history when the user opens a session that has a runtime
  // identity but no timeline yet (Host emits session.history → store folds it
  // into the timeline; messages carry the `h:` prefix).
  const { resume } = useResumeSession();
  // Round-2 P0 fix (model directness): a model-less resume left the Host
  // registry entry's `model` undefined, which every later 'direct' send
  // silently inherited — the gateway's own default served the turn instead
  // of whatever the user picked. Closes the gap at its source instead of
  // only patching the per-send wire path.
  const { getSessionModel } = useSessionModel();
  // F9 (round-2 review fix): resolve the SAME way ModelSelect's own initial
  // value does (explicit selection, else the Host-reported default) instead
  // of hard-pinning the catalog default via `defaultModelId(null)` — the old
  // form silently downgraded an unpicked session's resume to `sonnet` even
  // when the Host reported a different default (e.g. an Opus gateway).
  const { status: hostStatus } = useHostStatus();

  const handleSelectSession = (sessionId: string, persistedRuntimeIdentity?: string) => {
    selectSession(sessionId);
    const state = useChatSessionsStore.getState();
    const session = state.sessions.find((item) => item.id === sessionId);
    const workspace = state.workspaces.find((ws) => ws.id === session?.workspaceId);
    // D1 (round-5): keep the sidebar's own "New" target in sync with whatever
    // folder the just-selected session actually lives under. Grouped by the
    // workspace's project, not `session.projectId`, matching buildSidebarFolders
    // (a stale session.projectId must not point focus at the wrong folder).
    if (workspace) {
      setFocusedProjectId(workspace.projectId);
    }
    const runtimeIdentity = session?.runtimeIdentity ?? persistedRuntimeIdentity;
    const hasTimeline = (state.messages[sessionId]?.length ?? 0) > 0;
    if (runtimeIdentity && workspace && !hasTimeline) {
      void resume(sessionId, {
        persistedRuntimeIdentity: runtimeIdentity,
        model: resolveResumeModel(getSessionModel, sessionId, hostStatus.settings?.model),
      });
    }
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
  const recent = deriveRecentRows({ sessions, workspaces, now, showAll: recentShowAll, query });
  const queryActive = query.trim().length > 0;
  // While searching, folders with zero hits collapse away instead of leaving
  // a wall of empty headers; without a query every folder stays visible so
  // its "+ new chat" row remains reachable.
  const visibleFolders = queryActive ? folders.filter((folder) => folder.rows.length > 0) : folders;
  const noMatches = queryActive && recent.rows.length === 0 && visibleFolders.length === 0;

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

  return (
    <aside
      // Width is owned by the shell wrapper (T-22): it hosts the drag handle and
      // writes px directly during a drag, so the aside must not pin its own width.
      className="flex h-full w-full min-w-0 shrink-0 flex-col border-r bg-card/40"
    >
      <div className="flex h-9 items-center border-b px-2">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={collapsed ? t('Expand sidebar') : t('Collapse sidebar')}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </Button>
      </div>

      {collapsed && (
        // The action row below is hidden while collapsed, so keep one rail
        // button — otherwise adding a repository needs an expand first.
        <div className="flex flex-col items-center gap-1 border-b py-2">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('Add Repository')}
            title={t('Add Repository')}
            onClick={onAddRepository}
          >
            <FolderPlus className="h-4 w-4" />
          </Button>
        </div>
      )}

      {!collapsed && (
        <>
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
                // Seed sessions point at empty-path workspaces and cannot send,
                // so surface the entry point instead of a misleading tree.
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
                    <EmptyTitle className="text-ui tracking-normal">
                      {t('Add Repository')}
                    </EmptyTitle>
                    <EmptyDescription className="text-meta">
                      {t('Add a repository to get started.')}
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button variant="outline" size="xs" className="h-6" onClick={onAddRepository}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('Add Repository')}
                  </Button>
                </Empty>
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
                            {t('Show more')} (
                            <span className="tabular-nums">{recent.hiddenCount}</span>)
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
                              setExpandedProjects((prev) => ({
                                ...prev,
                                [folder.projectId]: !expanded,
                              }));
                            }}
                          >
                            {expanded ? (
                              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-folder" />
                            ) : (
                              <Folder className="h-3.5 w-3.5 shrink-0 text-folder" />
                            )}
                            <span className="min-w-0 flex-1 truncate font-semibold">
                              {folder.name}
                            </span>
                          </button>
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
                            {folder.rows.map((row) => (
                              <SessionRow
                                key={row.sessionId}
                                row={row}
                                now={now}
                                active={activeSessionId === row.sessionId}
                                onSelect={() => handleSelectSession(row.sessionId)}
                                onClose={() => void close(row.sessionId)}
                                onRename={(title) => void rename(row.sessionId, title)}
                                onArchive={() => void archive(row.sessionId, true)}
                              />
                            ))}
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
                </>
              )}
            </div>
          </ScrollArea>

          <Separator />

          <div className="flex items-center p-2">
            {/* Full-width row on purpose (flex-1): the footer is a single
                Settings entry since T-23 removed the dead Help button. */}
            <Button
              variant="ghost"
              size="xs"
              className="h-6 flex-1 justify-start"
              onClick={onOpenSettings}
            >
              <Settings className="h-3.5 w-3.5" />
              {t('Settings')}
            </Button>
          </div>
        </>
      )}
    </aside>
  );
}

interface SessionRowProps {
  row: SidebarSessionRow;
  now: number;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
}

function SessionRow({ row, now, active, onSelect, onClose, onRename, onArchive }: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.title);

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== row.title) {
      onRename(trimmed);
    } else {
      setDraft(row.title);
    }
    setEditing(false);
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
    <div
      className={cn(
        // --hover / --selection are two distinct steps of the same Flexoki
        // interactive ramp; neither takes a /N modifier.
        // The two are mutually exclusive on purpose: `hover:bg-hover` compiles to
        // `.hover\:bg-hover:hover` (0,2,0) and would outrank a plain `.bg-selection`
        // (0,1,0), so pointing at the active row would repaint it as an ordinary
        // hovered row and erase the selection.
        'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ui',
        active ? 'bg-selection text-accent-foreground' : 'hover:bg-hover'
      )}
      onClick={onSelect}
      onDoubleClick={() => {
        // Re-seed on entry: the mount-time draft goes stale when the title
        // changes externally (rename from the Recent twin of this row, or a
        // persisted title landing via mergeSessionIndex) — committing that
        // stale draft would silently revert the rename.
        setDraft(row.title);
        setEditing(true);
      }}
      onContextMenu={(event) => {
        // Right-click archive keeps the focus row without stealing the click.
        event.preventDefault();
        onArchive();
      }}
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
      {row.busy && (
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-running" />
      )}
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {row.failed && (
        <Badge variant="destructive" size="sm" className="shrink-0">
          failed
        </Badge>
      )}
      {/* S2 (b/C14): agent before branch — which runtime answers is the more
          load-bearing fact, and the chip budget for this row is two. Same
          Badge shape as the branch chip so the pair reads as one rank. */}
      <Badge variant="outline" size="sm" className="max-w-28 shrink-0" title={row.agentChip.label}>
        <span className="min-w-0 truncate">{row.agentChip.label}</span>
      </Badge>
      {row.chip && (
        <Badge variant="outline" size="sm" className="max-w-28 shrink-0" title={row.chip.label}>
          <span className="min-w-0 truncate">{row.chip.label}</span>
        </Badge>
      )}
      {/* Age and actions swap on hover so row width never jumps; the row has
          tabIndex=0, so focus-within also reveals the actions and keeps
          Archive/Close reachable by keyboard (display:none alone would drop
          them from the tab order). */}
      <span className="shrink-0 text-meta text-muted-foreground tabular-nums group-hover:hidden group-focus-within:hidden">
        {formatRelativeAge(row.updatedAt, now)}
      </span>
      <div className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
        <Button
          variant="ghost"
          size="icon-xs"
          className="h-5 w-5"
          aria-label="Archive session"
          title="Archive"
          onClick={(event) => {
            event.stopPropagation();
            onArchive();
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
      </div>
    </div>
  );
}
