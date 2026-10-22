import { Square } from 'lucide-react';
import { StatusIcon } from '@/components/ui/status-icon';
import { useI18n } from '@/i18n';
import type { TaskRow, TaskStop } from '../panes/backgroundTasksModel';
import { RailCard } from './RailCard';

/**
 * Layout 5e: background commands and subagents running now, each with its
 * live duration and a stop button (a continuable subagent is interrupted). A
 * row opens the background-tasks pane. Not drawn while nothing runs.
 */
export function RunningCard({
  rows,
  onOpenTasks,
  onStop,
}: {
  rows: readonly TaskRow[];
  onOpenTasks: () => void;
  onStop: (target: TaskStop) => void;
}) {
  const { t } = useI18n();
  return (
    <RailCard id="running" title={t('Running')} summary={<span>{rows.length}</span>}>
      <ul className="flex flex-col" data-rail-running="">
        {rows.map((row) => (
          <li key={row.key} className="-mx-1 flex h-6 min-w-0 items-center">
            <button
              type="button"
              onClick={onOpenTasks}
              title={row.title}
              className="flex h-6 min-w-0 flex-1 items-center gap-2 rounded-sm px-1 text-left transition-colors hover:bg-fill-ghost-hover"
            >
              <StatusIcon status={row.status} />
              <span className="min-w-0 flex-1 truncate">
                {row.title ||
                  (row.kind === 'subagent' ? t('Delegated subagent') : t('Background tasks'))}
              </span>
              {row.duration && (
                <span className="shrink-0 text-foreground-faint tabular-nums">{row.duration}</span>
              )}
            </button>
            {row.stop && (
              <button
                type="button"
                aria-label={row.stop.type === 'interrupt' ? t('Interrupt') : t('Stop')}
                title={row.stop.type === 'interrupt' ? t('Interrupt') : t('Stop')}
                onClick={() => {
                  if (row.stop) onStop(row.stop);
                }}
                className="ml-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-fill-ghost-hover hover:text-foreground"
              >
                <Square className="size-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </RailCard>
  );
}
