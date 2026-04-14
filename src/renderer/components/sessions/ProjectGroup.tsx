import type { ClaudeProject, ClaudeSessionMeta } from '@shared/types';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Skeleton } from '@/components/ui/skeleton';
import { useClaudeProjectSessions } from '@/hooks/useClaudeSessions';
import { cn } from '@/lib/utils';
import { SessionItem } from './SessionItem';
import { formatActivityLabel } from './time';

interface ProjectGroupProps {
  project: ClaudeProject;
  defaultOpen?: boolean;
  onResumeSession?: (session: ClaudeSessionMeta, project: ClaudeProject) => void;
  className?: string;
}

export function ProjectGroup({
  project,
  defaultOpen,
  onResumeSession,
  className,
}: ProjectGroupProps) {
  const [open, setOpen] = useState<boolean>(!!defaultOpen);
  const sessionsQuery = useClaudeProjectSessions(project.id, { enabled: open });
  const sessions = sessionsQuery.data ?? [];

  const activityLabel = formatActivityLabel(project.lastActivityAt);

  return (
    <Collapsible className={cn('min-w-0', className)} onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 hover:bg-accent"
        type="button"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={project.path}>
          {project.path}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {project.sessionCount} 个会话
        </span>
        {activityLabel ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {activityLabel}
          </span>
        ) : null}
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-1 space-y-1 pl-6">
        {sessionsQuery.isLoading ? (
          <div className="space-y-1">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">未找到会话</div>
        ) : (
          sessions.map((session) => (
            <SessionItem
              key={session.id}
              onResumeSession={onResumeSession}
              project={project}
              session={session}
            />
          ))
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
