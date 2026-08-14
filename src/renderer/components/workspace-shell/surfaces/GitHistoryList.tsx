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
 * grew a single-lane graph rail + node dot and a right-aligned author name —
 * still no interactivity (row click / expand is a later batch, same as the
 * multi-lane graph).
 */
import type { GitLogEntry } from '@shared/types';
import { ChevronDown, ChevronRight, GitCommit, History, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { formatCommitTooltip, gitHistoryPanelClass, parseRefBadges } from './gitSurfaceModel';

interface GitHistoryListProps {
  commits: GitLogEntry[];
  expanded: boolean;
  onToggle: () => void;
  isLoading: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

export function GitHistoryList({
  commits,
  expanded,
  onToggle,
  isLoading,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: GitHistoryListProps) {
  const { t } = useI18n();

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
                return (
                  <div
                    key={commit.hash}
                    className={cn(
                      'flex gap-2 rounded-xs px-2 hover:bg-accent/50',
                      singleLine ? 'h-7 items-center' : 'items-start py-1'
                    )}
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
