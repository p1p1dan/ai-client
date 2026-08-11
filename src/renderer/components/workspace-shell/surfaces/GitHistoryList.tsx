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
 */
import type { GitLogEntry } from '@shared/types';
import { ChevronDown, ChevronRight, GitCommit, History, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/i18n';
import { formatCommitTooltip, parseRefBadges } from './gitSurfaceModel';

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
    <Collapsible className="shrink-0 border-t" onOpenChange={onToggle} open={expanded}>
      <CollapsibleTrigger className="flex h-7 w-full items-center gap-2 px-2 text-ui hover:bg-accent/50">
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{t('History')}</span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : commits.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1.5 py-4 text-muted-foreground">
            <GitCommit className="h-5 w-5 opacity-50" />
            <p className="text-meta">{t('No commits yet')}</p>
          </div>
        ) : (
          <ScrollArea className="max-h-60">
            <div className="space-y-0.5 p-1">
              {commits.map((commit) => {
                const badges = parseRefBadges(commit.refs);
                return (
                  <div
                    key={commit.hash}
                    className="rounded-xs px-2 py-1"
                    title={formatCommitTooltip(commit)}
                  >
                    <p className="min-w-0 truncate text-ui">{commit.message}</p>
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
