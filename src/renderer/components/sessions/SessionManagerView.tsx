import type { ClaudeProject, ClaudeSessionMeta } from '@shared/types';
import { getDisplayPathBasename } from '@shared/utils/path';
import { ArrowLeft, Folder, LayoutGrid, List, RefreshCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useClaudeProjects, useClaudeProjectSessions } from '@/hooks/useClaudeSessions';
import { cn } from '@/lib/utils';
import { SessionItem } from './SessionItem';
import { formatActivityLabel } from './time';

interface SessionManagerViewProps {
  className?: string;
  onResumeSession?: (session: ClaudeSessionMeta, project: ClaudeProject) => void;
}

export function SessionManagerView({ className, onResumeSession }: SessionManagerViewProps) {
  const projectsQuery = useClaudeProjects();
  const projects = projectsQuery.data ?? [];

  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const selectedProject = useMemo(() => {
    if (!selectedProjectId) return null;
    return projects.find((p) => p.id === selectedProjectId) ?? null;
  }, [projects, selectedProjectId]);

  const sessionsQuery = useClaudeProjectSessions(selectedProject?.id ?? null, {
    enabled: !!selectedProject,
  });
  const sessions = sessionsQuery.data ?? [];

  return (
    <div className={cn('flex h-full min-w-0 flex-1 flex-col gap-4 p-4', className)}>
      {selectedProject ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                onClick={() => setSelectedProjectId(null)}
                size="sm"
                variant="secondary"
              >
                <ArrowLeft className="h-4 w-4" />
                返回
              </Button>
              <div className="min-w-0">
                <div className="min-w-0 truncate font-heading text-lg leading-none">
                  {getDisplayPathBasename(selectedProject.path)}
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate font-mono" title={selectedProject.path}>
                    {selectedProject.path}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums">
                    {sessions.length} 个会话
                  </span>
                  {formatActivityLabel(selectedProject.lastActivityAt) ? (
                    <span className="shrink-0 text-xs tabular-nums">
                      {formatActivityLabel(selectedProject.lastActivityAt)}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            <Button
              disabled={sessionsQuery.isFetching}
              onClick={() => sessionsQuery.refetch()}
              size="sm"
              variant="secondary"
            >
              <RefreshCcw className="h-4 w-4" />
              刷新
            </Button>
          </div>

          {sessionsQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : sessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Folder className="h-4 w-4" />
                </EmptyMedia>
                <EmptyTitle>未找到会话</EmptyTitle>
                <EmptyDescription>该项目下没有可显示的 Claude 会话记录。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="min-w-0 flex-1 space-y-1 overflow-auto">
              {sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  onResumeSession={onResumeSession}
                  project={selectedProject}
                  session={session}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-heading text-lg leading-none">会话历史</div>
              <div className="mt-1 text-sm text-muted-foreground">
                扫描 ~/.claude/projects/ 的 Claude 会话
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-lg bg-muted p-0.5">
                <Button
                  aria-label="网格视图"
                  onClick={() => setViewMode('grid')}
                  size="icon-sm"
                  variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                >
                  <LayoutGrid className="h-4 w-4" />
                </Button>
                <Button
                  aria-label="列表视图"
                  onClick={() => setViewMode('list')}
                  size="icon-sm"
                  variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                >
                  <List className="h-4 w-4" />
                </Button>
              </div>

              <Button
                disabled={projectsQuery.isFetching}
                onClick={() => projectsQuery.refetch()}
                size="sm"
                variant="secondary"
              >
                <RefreshCcw className="h-4 w-4" />
                刷新
              </Button>
            </div>
          </div>

          {projectsQuery.isLoading ? (
            <div
              className={cn(
                'grid gap-3',
                viewMode === 'grid' ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1'
              )}
            >
              {Array.from({ length: 6 }).map((_, idx) => (
                <Skeleton className="h-24 w-full" key={idx} />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RefreshCcw className="h-4 w-4" />
                </EmptyMedia>
                <EmptyTitle>未找到 Claude 会话</EmptyTitle>
                <EmptyDescription>
                  请确认本机已安装并使用过 Claude Code，且{' '}
                  <span className="font-mono">~/.claude/projects/</span> 下存在会话记录。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="min-w-0 flex-1 overflow-auto">
              <div
                className={cn(
                  'grid gap-3',
                  viewMode === 'grid'
                    ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
                    : 'grid-cols-1'
                )}
                role="list"
              >
                {projects.map((project) => {
                  const projectName = getDisplayPathBasename(project.path);
                  const activityLabel = formatActivityLabel(project.lastActivityAt);

                  return (
                    <button
                      className={cn(
                        'group w-full min-w-0 rounded-xl border bg-card text-left shadow-xs transition-colors hover:bg-accent',
                        viewMode === 'grid' ? 'flex flex-col gap-3 p-4' : 'flex items-center gap-3 p-3'
                      )}
                      key={project.id}
                      onClick={() => setSelectedProjectId(project.id)}
                      role="listitem"
                      type="button"
                    >
                      <div
                        className={cn(
                          'flex min-w-0 items-start gap-3',
                          viewMode === 'list' ? 'flex-1 items-center' : null
                        )}
                      >
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Folder className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-foreground group-hover:text-primary transition-colors">
                            {projectName}
                          </div>
                          <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={project.path}>
                            {project.path}
                          </div>
                        </div>
                      </div>

                      {viewMode === 'grid' ? (
                        <div className="flex items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                          <span className="shrink-0 tabular-nums">{project.sessionCount} 个会话</span>
                          {activityLabel ? (
                            <span className="shrink-0 tabular-nums">{activityLabel}</span>
                          ) : (
                            <span className="shrink-0 tabular-nums">-</span>
                          )}
                        </div>
                      ) : (
                        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
                          <span>{project.sessionCount} 个会话</span>
                          {activityLabel ? <span>{activityLabel}</span> : <span>-</span>}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
