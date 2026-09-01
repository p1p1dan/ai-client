import type { LegacyImportItemResult, LegacyImportProject, SessionIndexEntry } from '@shared/types';
import { getDisplayPathBasename } from '@shared/utils/path';
import { ArrowLeft, Folder, LayoutGrid, List, RefreshCcw, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Ident } from '@/components/ui/ident';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useLegacyImportMutation,
  useLegacyImportProjects,
  useLegacyImportSessions,
} from '@/hooks/useLegacyImport';
import { cn } from '@/lib/utils';
import { SessionItem } from './SessionItem';
import { formatActivityLabel } from './time';

interface SessionManagerViewProps {
  className?: string;
  onOpenImported?: (session: SessionIndexEntry) => void;
}

export function SessionManagerView({ className, onOpenImported }: SessionManagerViewProps) {
  const projectsQuery = useLegacyImportProjects();
  const projects = projectsQuery.data ?? [];
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [report, setReport] = useState<LegacyImportItemResult[]>([]);
  const importMutation = useLegacyImportMutation();

  const selectedProject = useMemo(() => {
    if (!selectedProjectId) return null;
    return projects.find((project) => project.id === selectedProjectId) ?? null;
  }, [projects, selectedProjectId]);
  const sessionsQuery = useLegacyImportSessions(selectedProject?.id ?? null, {
    enabled: !!selectedProject,
  });
  const sessions = sessionsQuery.data ?? [];
  const allSelected = sessions.length > 0 && selectedSessionIds.size === sessions.length;
  const someSelected = selectedSessionIds.size > 0 && !allSelected;
  const reportBySession = useMemo(
    () => new Map(report.map((item) => [item.source.sourceSessionId, item])),
    [report]
  );

  const chooseProject = (project: LegacyImportProject) => {
    setSelectedProjectId(project.id);
    setSelectedSessionIds(new Set());
    setReport([]);
  };
  const setSelected = (sessionId: string, selected: boolean) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (selected) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  };
  const toggleAll = (selected: boolean) => {
    setSelectedSessionIds(selected ? new Set(sessions.map((session) => session.id)) : new Set());
  };
  const runImport = async () => {
    if (!selectedProject || selectedSessionIds.size === 0) return;
    const result = await importMutation.mutateAsync({
      sources: sessions
        .filter((session) => selectedSessionIds.has(session.id))
        .map((session) => ({
          sourceKind: 'claude-code' as const,
          projectId: selectedProject.id,
          sourceSessionId: session.id,
        })),
    });
    setReport(result.results);
    setSelectedSessionIds(new Set());
  };

  return (
    <div className={cn('flex h-full min-w-0 flex-1 flex-col gap-4 p-4', className)}>
      {selectedProject ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                onClick={() => {
                  setSelectedProjectId(null);
                  setSelectedSessionIds(new Set());
                  setReport([]);
                }}
                size="sm"
                variant="secondary"
              >
                <ArrowLeft className="size-4" />
                返回
              </Button>
              <div className="min-w-0">
                <div className="min-w-0 truncate font-heading text-title leading-none tracking-[-0.01em]">
                  {getDisplayPathBasename(selectedProject.path)}
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-code tracking-normal"
                    title={selectedProject.path}
                  >
                    {selectedProject.path}
                  </span>
                  <span className="shrink-0 tabular-nums">{sessions.length} 个会话</span>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                disabled={sessionsQuery.isFetching || importMutation.isPending}
                onClick={() => sessionsQuery.refetch()}
                size="sm"
                variant="secondary"
              >
                <RefreshCcw className="size-4" />
                刷新
              </Button>
              <Button
                disabled={selectedSessionIds.size === 0 || importMutation.isPending}
                onClick={runImport}
                size="sm"
              >
                <Upload className="size-4" />
                {importMutation.isPending ? '正在导入…' : `导入所选 (${selectedSessionIds.size})`}
              </Button>
            </div>
          </div>

          {sessions.length > 0 ? (
            <label className="flex h-7 items-center gap-2 border-b px-2 text-ui text-muted-foreground">
              <Checkbox
                checked={allSelected}
                disabled={importMutation.isPending}
                indeterminate={someSelected}
                onCheckedChange={(checked) => toggleAll(checked === true)}
              />
              全选当前项目
            </label>
          ) : null}

          {sessionsQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed skeleton list
                <Skeleton className="h-14 w-full" key={index} />
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Folder className="size-4" />
                </EmptyMedia>
                <EmptyTitle>未找到会话</EmptyTitle>
                <EmptyDescription>该项目下没有可导入的 Claude 会话记录。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="min-w-0 flex-1 space-y-1 overflow-auto">
              {sessions.map((session) => {
                const item = reportBySession.get(session.id);
                return (
                  <div className="flex min-w-0 items-center gap-2" key={session.id}>
                    <SessionItem
                      disabled={importMutation.isPending}
                      error={item?.error}
                      onSelectedChange={(selected) => setSelected(session.id, selected)}
                      result={item?.status}
                      selected={selectedSessionIds.has(session.id)}
                      session={session}
                    />
                    {item?.session && item.status !== 'failed' ? (
                      <Button
                        className="shrink-0"
                        onClick={() => onOpenImported?.(item.session as SessionIndexEntry)}
                        size="sm"
                        variant="secondary"
                      >
                        打开
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {report.length > 0 ? (
            <div className="rounded-md border bg-card p-3 text-meta">
              导入报告：{report.filter((item) => item.status === 'imported').length} 个新快照，
              {report.filter((item) => item.status === 'already-imported').length} 个已存在，
              {report.filter((item) => item.status === 'failed').length}{' '}
              个失败。导入完成后不会自动打开会话。
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-heading text-title leading-none tracking-[-0.01em]">
                导入历史
              </div>
              <div className="mt-1 text-meta text-muted-foreground">
                从 <Ident>~/.claude/projects/</Ident> 只读复制历史，并在 Pi 中继续
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center rounded-sm bg-muted p-0.5">
                <Button
                  aria-label="网格视图"
                  onClick={() => setViewMode('grid')}
                  size="icon-sm"
                  variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                >
                  <LayoutGrid className="size-4" />
                </Button>
                <Button
                  aria-label="列表视图"
                  onClick={() => setViewMode('list')}
                  size="icon-sm"
                  variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                >
                  <List className="size-4" />
                </Button>
              </div>
              <Button
                disabled={projectsQuery.isFetching}
                onClick={() => projectsQuery.refetch()}
                size="sm"
                variant="secondary"
              >
                <RefreshCcw className="size-4" />
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
              {Array.from({ length: 6 }).map((_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed skeleton list
                <Skeleton className="h-24 w-full" key={index} />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RefreshCcw className="size-4" />
                </EmptyMedia>
                <EmptyTitle>未找到 Claude 会话</EmptyTitle>
                <EmptyDescription>
                  请确认本机使用过 Claude Code，且会话目录中存在 JSONL 记录。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="min-w-0 flex-1 overflow-auto">
              <div
                className={cn(
                  'grid gap-3',
                  viewMode === 'grid' ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1'
                )}
              >
                {projects.map((project) => {
                  const activityLabel = formatActivityLabel(project.lastActivityAt);
                  return (
                    <button
                      className={cn(
                        'group w-full min-w-0 rounded-md border bg-card text-left transition-colors hover:bg-accent/50',
                        viewMode === 'grid'
                          ? 'flex flex-col gap-3 p-4'
                          : 'flex items-center gap-3 p-3'
                      )}
                      key={project.id}
                      onClick={() => chooseProject(project)}
                      type="button"
                    >
                      <div
                        className={cn(
                          'flex min-w-0 items-start gap-3',
                          viewMode === 'list' && 'flex-1 items-center'
                        )}
                      >
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Folder className="size-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-ui text-foreground group-hover:text-primary">
                            {getDisplayPathBasename(project.path)}
                          </div>
                          <div
                            className="mt-1 truncate font-mono text-code tracking-normal text-muted-foreground"
                            title={project.path}
                          >
                            {project.path}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center justify-between gap-2 text-meta text-muted-foreground tabular-nums">
                        <span>{project.sessionCount} 个会话</span>
                        <span>{activityLabel || '-'}</span>
                      </div>
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
