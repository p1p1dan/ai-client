import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FolderGit2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { ChatWorkspace, WorkspaceKind } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useResumeSession } from '../chat/sessionIndex/useResumeSession';
import { useSessionIndex, useSessionIndexMutations } from '../chat/sessionIndex/useSessionIndex';
import { createChatSessionOnWorkspace } from './useSyncChatWorkspaceTree';

interface LeftNavProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenSettings?: () => void;
}

const STATUS_VARIANT: Record<
  SessionRuntimeStatus,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'
> = {
  idle: 'secondary',
  starting: 'warning',
  running: 'default',
  waiting_permission: 'warning',
  waiting_question: 'warning',
  stopping: 'outline',
  completed: 'success',
  failed: 'destructive',
  disconnected: 'outline',
};

const KIND_LABEL: Record<WorkspaceKind, string> = {
  main: 'main',
  worktree: 'worktree',
  remote: 'remote',
  temp: 'temp',
};

function statusLabel(status: SessionRuntimeStatus): string {
  return status.replace(/_/g, ' ');
}

export function LeftNav({ collapsed, onToggleCollapsed, onOpenSettings }: LeftNavProps) {
  const [query, setQuery] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  const projects = useChatSessionsStore((state) => state.projects);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const recentSessionIds = useChatSessionsStore((state) => state.recentSessionIds);
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

  const handleSelectSession = (sessionId: string, persistedRuntimeIdentity?: string) => {
    selectSession(sessionId);
    const state = useChatSessionsStore.getState();
    const session = state.sessions.find((item) => item.id === sessionId);
    const workspace = state.workspaces.find((ws) => ws.id === session?.workspaceId);
    const runtimeIdentity = session?.runtimeIdentity ?? persistedRuntimeIdentity;
    const hasTimeline = (state.messages[sessionId]?.length ?? 0) > 0;
    if (runtimeIdentity && workspace && !hasTimeline) {
      void resume(sessionId, { persistedRuntimeIdentity: runtimeIdentity });
    }
  };

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const effectiveWorkspaceId =
    selectedWorkspaceId ?? activeSession?.workspaceId ?? workspaces[0]?.id ?? null;

  const recentSessions = useMemo(
    () =>
      recentSessionIds
        .map((id) => sessions.find((session) => session.id === id))
        .filter((session): session is NonNullable<typeof session> => Boolean(session)),
    [recentSessionIds, sessions]
  );

  const filteredSessions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return sessions;
    }
    return sessions.filter((session) => session.title.toLowerCase().includes(normalized));
  }, [query, sessions]);

  const isProjectExpanded = (projectId: string) => expandedProjects[projectId] !== false;
  const isWorkspaceExpanded = (workspaceId: string) => expandedWorkspaces[workspaceId] !== false;

  const handleNewSession = () => {
    if (!effectiveWorkspaceId) {
      return;
    }
    const sessionId = createChatSessionOnWorkspace(effectiveWorkspaceId);
    if (sessionId) {
      setSelectedWorkspaceId(effectiveWorkspaceId);
    }
  };

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col border-r bg-card/40 transition-[width] duration-150',
        collapsed ? 'w-12' : 'w-72'
      )}
    >
      <div className="flex h-9 items-center gap-1 border-b px-2">
        <Button variant="ghost" size="icon-xs" aria-label="Menu">
          <Menu className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </Button>
      </div>

      {!collapsed && (
        <>
          <div className="space-y-2 border-b p-2">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                className="h-6"
                disabled={!effectiveWorkspaceId}
                onClick={handleNewSession}
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </Button>
              <Button variant="outline" size="xs" className="h-6" disabled>
                <FolderGit2 className="h-3.5 w-3.5" />
                Workspace
              </Button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                size="sm"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search sessions"
                className="h-7 pl-7"
              />
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-3 p-2">
              <section>
                <p className="px-2 text-xs font-medium text-muted-foreground">Recent</p>
                <div className="mt-1 space-y-0.5">
                  {recentSessions.map((session) => (
                    <SessionTreeItem
                      key={`recent-${session.id}`}
                      session={session}
                      active={activeSessionId === session.id}
                      onSelect={() => handleSelectSession(session.id)}
                      onClose={() => void close(session.id)}
                      onRename={(title) => void rename(session.id, title)}
                      onArchive={() => void archive(session.id, true)}
                      disabled={false}
                    />
                  ))}
                </div>
              </section>

              {projects.length === 0 ? (
                <p className="px-2 text-xs text-muted-foreground">
                  还没有可用 Workspace。请先在旧侧栏添加仓库，或确认已打开某个仓库后再回到本壳。
                </p>
              ) : (
                projects.map((project) => {
                  const projectWorkspaces = workspaces.filter((ws) => ws.projectId === project.id);
                  return (
                    <section key={project.id}>
                      <button
                        type="button"
                        className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-sm hover:bg-accent"
                        onClick={() =>
                          setExpandedProjects((prev) => ({
                            ...prev,
                            [project.id]: !isProjectExpanded(project.id),
                          }))
                        }
                      >
                        {isProjectExpanded(project.id) ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-left font-medium">
                          {project.name}
                        </span>
                      </button>

                      {isProjectExpanded(project.id) && (
                        <div className="mt-1 space-y-1 pl-2">
                          {projectWorkspaces.map((workspace) => (
                            <WorkspaceBranch
                              key={workspace.id}
                              workspace={workspace}
                              expanded={isWorkspaceExpanded(workspace.id)}
                              selected={effectiveWorkspaceId === workspace.id}
                              sessions={filteredSessions.filter(
                                (session) => session.workspaceId === workspace.id
                              )}
                              activeSessionId={activeSessionId}
                              onToggleExpanded={() =>
                                setExpandedWorkspaces((prev) => ({
                                  ...prev,
                                  [workspace.id]: !isWorkspaceExpanded(workspace.id),
                                }))
                              }
                              onSelectWorkspace={() => setSelectedWorkspaceId(workspace.id)}
                              onSelectSession={(sessionId) => handleSelectSession(sessionId)}
                              onCloseSession={(sessionId) => void close(sessionId)}
                              onRenameSession={(sessionId, title) => void rename(sessionId, title)}
                              onArchiveSession={(sessionId) => void archive(sessionId, true)}
                            />
                          ))}
                        </div>
                      )}
                    </section>
                  );
                })
              )}
            </div>
          </ScrollArea>

          <Separator />

          <div className="flex items-center gap-1 p-2">
            <Button
              variant="ghost"
              size="xs"
              className="h-6 flex-1 justify-start"
              onClick={onOpenSettings}
            >
              <Settings className="h-3.5 w-3.5" />
              Settings
            </Button>
            <Button variant="ghost" size="xs" className="h-6 flex-1 justify-start">
              <CircleHelp className="h-3.5 w-3.5" />
              Help
            </Button>
          </div>
        </>
      )}
    </aside>
  );
}

interface WorkspaceBranchProps {
  workspace: ChatWorkspace;
  expanded: boolean;
  selected: boolean;
  sessions: Array<{ id: string; title: string; status: SessionRuntimeStatus }>;
  activeSessionId: string | null;
  onToggleExpanded: () => void;
  onSelectWorkspace: () => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onArchiveSession: (sessionId: string) => void;
}

function WorkspaceBranch({
  workspace,
  expanded,
  selected,
  sessions,
  activeSessionId,
  onToggleExpanded,
  onSelectWorkspace,
  onSelectSession,
  onCloseSession,
  onRenameSession,
  onArchiveSession,
}: WorkspaceBranchProps) {
  return (
    <div>
      <div
        className={cn(
          'flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground',
          selected && 'bg-accent/60 text-accent-foreground'
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => {
            onSelectWorkspace();
            onToggleExpanded();
          }}
          title={workspace.path}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
        </button>
        <Badge variant="outline" size="sm" className="shrink-0">
          {KIND_LABEL[workspace.kind]}
        </Badge>
      </div>
      {expanded && (
        <div className="space-y-0.5 pl-3">
          {sessions.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">No sessions</p>
          ) : (
            sessions.map((session) => (
              <SessionTreeItem
                key={session.id}
                session={session}
                active={activeSessionId === session.id}
                onSelect={() => {
                  onSelectWorkspace();
                  onSelectSession(session.id);
                }}
                onClose={() => onCloseSession(session.id)}
                onRename={(title) => onRenameSession(session.id, title)}
                onArchive={() => onArchiveSession(session.id)}
                disabled={false}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface SessionTreeItemProps {
  session: {
    id: string;
    title: string;
    status: SessionRuntimeStatus;
  };
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  disabled: boolean;
}

function SessionTreeItem({
  session,
  active,
  onSelect,
  onClose,
  onRename,
  onArchive,
  disabled,
}: SessionTreeItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.title) {
      onRename(trimmed);
    } else {
      setDraft(session.title);
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
              setDraft(session.title);
              setEditing(false);
            }
          }}
          className="h-6 flex-1 text-sm"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent',
        active && 'bg-accent text-accent-foreground'
      )}
      onClick={onSelect}
      onDoubleClick={() => setEditing(true)}
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
      title={session.title}
    >
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      <Badge variant={STATUS_VARIANT[session.status]} size="sm" className="shrink-0 capitalize">
        {statusLabel(session.status)}
      </Badge>
      {!disabled && (
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
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
      )}
    </div>
  );
}
