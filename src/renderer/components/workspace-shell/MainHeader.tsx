import {
  AppWindow,
  FolderOpen,
  Globe,
  LayoutGrid,
  PanelRightClose,
  PanelRightOpen,
  Server,
  TerminalSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';

interface MainHeaderProps {
  rightDockOpen: boolean;
  bottomDockOpen: boolean;
  onToggleRightDock: () => void;
  onToggleBottomDock: () => void;
}

export function MainHeader({
  rightDockOpen,
  bottomDockOpen,
  onToggleRightDock,
  onToggleBottomDock,
}: MainHeaderProps) {
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const projects = useChatSessionsStore((state) => state.projects);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeProject = projects.find((project) => project.id === activeSession?.projectId);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-primary">
          {activeSession?.title ?? 'No session selected'}
        </p>
        <p className="truncate text-xs text-muted-foreground" title={activeWorkspace?.path}>
          {activeProject?.name ?? 'Project'}
          {activeWorkspace ? ` · ${activeWorkspace.name}` : ''}
          {activeWorkspace ? ` · ${activeWorkspace.path}` : ''}
        </p>
      </div>

      <UsageRingPlaceholder />

      <Separator orientation="vertical" className="h-6" />

      <div className="flex items-center gap-1">
        <HeaderIconButton label="Layout" icon={LayoutGrid} />
        <HeaderIconButton label="Folder" icon={FolderOpen} />
        <HeaderIconButton label="Host: Local" icon={Server} />
        <HeaderIconButton
          label={bottomDockOpen ? 'Hide terminal dock' : 'Show terminal dock'}
          icon={TerminalSquare}
          active={bottomDockOpen}
          onClick={onToggleBottomDock}
        />
        <HeaderIconButton label="Browser" icon={Globe} />
        <HeaderIconButton
          label={rightDockOpen ? 'Hide right panel' : 'Show right panel'}
          icon={rightDockOpen ? PanelRightClose : PanelRightOpen}
          active={rightDockOpen}
          onClick={onToggleRightDock}
        />
        <HeaderIconButton label="Window" icon={AppWindow} />
      </div>
    </header>
  );
}

function UsageRingPlaceholder() {
  return (
    <div
      className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-[10px] text-muted-foreground"
      role="img"
      aria-label="Usage ring placeholder"
      title="Usage ring placeholder"
    >
      <span>72%</span>
    </div>
  );
}

interface HeaderIconButtonProps {
  label: string;
  icon: typeof LayoutGrid;
  active?: boolean;
  onClick?: () => void;
}

function HeaderIconButton({ label, icon: Icon, active, onClick }: HeaderIconButtonProps) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="icon-xs"
      className={cn('h-6 w-6', active && 'bg-accent')}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}
