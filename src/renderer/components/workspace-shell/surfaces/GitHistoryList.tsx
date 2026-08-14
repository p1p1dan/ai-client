/**
 * D30(a) (2026-08-11): the git surface's History section — a flat commit
 * list with ref badges, rendered below `CommitBox` inside `changesPane`
 * (`GitSurfaceView.tsx`).
 *
 * Forked from `source-control/CommitHistoryList.tsx` instead of reused: that
 * component drags in a revert/reset context menu (destructive git actions
 * outside D30(a)'s display-only scope), toast wiring, and legacy hardcoded
 * Tailwind colors (`text-green-500` etc. — `source-control/` hasn't migrated
 * to the semantic tokens yet, design-system.md's T-25 backlog). This file
 * only ever renders a commit's subject + ref badges — no actions, no
 * `components/source-control/` imports.
 *
 * D34 (2026-08-14, VS Code SCM panel visual polish): the panel now fills its
 * half of the docked 50/50 split (`gitHistoryPanelClass()`, see that
 * function's header for why the Collapsible's default measured-height
 * animation has to be overridden) instead of capping at `max-h-60`. Each row
 * grew a single-lane graph rail + node dot and a right-aligned author name.
 *
 * D34 (2026-08-14, click-to-expand): a row click toggles an inline file list
 * below it (VS Code SCM graph-expand reference —
 * docs/design/refs/vscode-20260814-gitxvqiu/vscode-scm-panel-graph-expand.png).
 * Only one commit's file list is ever fetched at a time (`expandedCommitHash`
 * lives in `gitSurfaceModel.ts`'s reducer, not local state here), so
 * `useCommitFiles` is called once at the list level, not per row. Still no
 * revert/reset/context-menu — same display-only scope as the rest of this
 * file; the multi-lane graph is still a later batch.
 */
import type { CommitFileChange, FileChangeStatus, GitLogEntry } from '@shared/types';
import { ChevronDown, ChevronRight, GitCommit, History, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCommitFiles } from '@/hooks/useGitHistory';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { GitSurfaceCommitFile } from './gitSurfaceModel';
import { formatCommitTooltip, gitHistoryPanelClass, parseRefBadges } from './gitSurfaceModel';

// D34: status letter colors for the expanded commit's inline file list.
// Mirrors ChangesList.tsx:65-73's semantic token mapping (kept local instead
// of importing ChangesList — see this file's header for the reuse-vs-fork
// rationale). R/C have no dedicated mapping table entry so they take the
// nearest semantic hue (text-info), same call ChangesList made.
const commitFileStatusColors: Partial<Record<FileChangeStatus, string>> = {
  M: 'text-warning',
  A: 'text-success',
  D: 'text-destructive',
  R: 'text-info',
  C: 'text-info',
};

interface GitHistoryListProps {
  commits: GitLogEntry[];
  expanded: boolean;
  onToggle: () => void;
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  /** Resolved git workdir — needed locally to fetch the expanded commit's file list. */
  workdir: string;
  /** D34: hash of the row whose inline file list is open. null = none. */
  expandedCommitHash: string | null;
  onToggleCommit: (hash: string) => void;
  /** D34: which file (if any) inside the expanded commit is driving the diff view. */
  selectedCommitFile: GitSurfaceCommitFile | null;
  onSelectCommitFile: (file: GitSurfaceCommitFile) => void;
}

export function GitHistoryList({
  commits,
  expanded,
  onToggle,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  workdir,
  expandedCommitHash,
  onToggleCommit,
  selectedCommitFile,
  onSelectCommitFile,
}: GitHistoryListProps) {
  const { t } = useI18n();
  // Single query for whichever commit is expanded — never one per row.
  const commitFilesQuery = useCommitFiles(workdir, expandedCommitHash);

  return (
    <Collapsible className="flex h-full min-h-0 flex-col" onOpenChange={onToggle} open={expanded}>
      <CollapsibleTrigger className="flex h-7 w-full shrink-0 items-center gap-2 px-2 text-ui hover:bg-accent/50">
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{t('History')}</span>
      </CollapsibleTrigger>

      <CollapsibleContent className={gitHistoryPanelClass()}>
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : commits.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 text-muted-foreground">
            <GitCommit className="h-5 w-5 opacity-50" />
            <p className="text-meta">{t('No commits yet')}</p>
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-0.5 p-1">
              {commits.map((commit) => {
                const badges = parseRefBadges(commit.refs);
                const singleLine = badges.length === 0;
                const isExpanded = commit.hash === expandedCommitHash;
                return (
                  <div key={commit.hash}>
                    <div
                      aria-expanded={isExpanded}
                      className={cn(
                        'flex cursor-pointer gap-2 rounded-xs px-2 hover:bg-accent/50',
                        singleLine ? 'h-7 items-center' : 'items-start py-1'
                      )}
                      onClick={() => onToggleCommit(commit.hash)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onToggleCommit(commit.hash);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      title={formatCommitTooltip(commit)}
                    >
                      {/* Single-lane graph decoration: a vertical rail running
                          through the row's full height with an 8px node dot
                          centered on it. Plain CSS, no graph library — multi-lane
                          branching is a later batch. */}
                      <div aria-hidden className="relative w-4 shrink-0 self-stretch">
                        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
                        <span className="absolute top-1/2 left-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="min-w-0 flex-1 truncate text-ui">{commit.message}</p>
                          <span
                            className="max-w-24 shrink-0 truncate text-meta text-muted-foreground"
                            title={commit.author_name}
                          >
                            {commit.author_name}
                          </span>
                        </div>
                        {badges.length > 0 && (
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {badges.map((badge) => (
                              <Badge className="shrink-0" key={badge} size="sm" variant="outline">
                                {badge}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="py-1 pr-1 pl-9">
                        {/* Meta line: short hash · author · date — same data
                            `formatCommitTooltip` already formats for the row's
                            hover title, now surfaced visibly under the row. */}
                        <p className="truncate text-meta text-muted-foreground">
                          {formatCommitTooltip(commit)}
                        </p>
                        <div className="mt-1 space-y-0.5">
                          {commitFilesQuery.isLoading ? (
                            <div className="flex items-center justify-center py-2">
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                            </div>
                          ) : (commitFilesQuery.data ?? []).length === 0 ? (
                            <p className="py-1 text-meta text-muted-foreground">{t('No files')}</p>
                          ) : (
                            (commitFilesQuery.data as CommitFileChange[]).map((file) => {
                              const isFileSelected =
                                selectedCommitFile?.hash === commit.hash &&
                                selectedCommitFile.path === file.path;
                              return (
                                <button
                                  className={cn(
                                    'flex h-7 w-full items-center gap-2 rounded-xs px-2 text-left',
                                    isFileSelected ? 'bg-accent' : 'hover:bg-accent/50'
                                  )}
                                  key={file.path}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onSelectCommitFile({
                                      hash: commit.hash,
                                      path: file.path,
                                      status: file.status,
                                    });
                                  }}
                                  title={file.path}
                                  type="button"
                                >
                                  <span
                                    className={cn(
                                      'w-3 shrink-0 text-center font-mono text-[10px]',
                                      commitFileStatusColors[file.status] ?? 'text-muted-foreground'
                                    )}
                                  >
                                    {file.status}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-ui">
                                    {file.path}
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {hasNextPage && (
                <Button
                  className="h-6 w-full text-meta text-muted-foreground"
                  disabled={isFetchingNextPage}
                  onClick={onLoadMore}
                  size="sm"
                  variant="ghost"
                >
                  {isFetchingNextPage ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t('Load more')
                  )}
                </Button>
              )}
            </div>
          </ScrollArea>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
