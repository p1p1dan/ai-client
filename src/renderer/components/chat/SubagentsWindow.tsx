/**
 * dsh-rebase P1-7b: the subagents sub-window (prototype scene D; decisions
 * 068 as revised by 109, 069, 090, 119; plan P1-7 shard 03 §5.2).
 *
 * Every direct child the session has: a status icon, 子代理 or 分叉 and the
 * description the delegation gave it (DSH's subagents have no names of their
 * own, decision 090), how long it ran, its tokens and calls; then 「打断」 for
 * a running continuable child (its current run stops, the child stays and can
 * be continued, decision 069) and 「定位」, which scrolls the timeline to the
 * row that delegated it. The same child may show in the background jobs
 * window and in its lane at the same time (decision 109 rule 3).
 */

import { Circle, CircleCheck, CircleX, Hand, LoaderCircle, LocateFixed, Users } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import type { SubwindowPosition } from '@/stores/sessionSubwindows';
import { useSessionLanes } from './BackgroundJobsWindow';
import { locateToolRow } from './locateToolRow';
import { SubwindowEmpty, SubwindowFrame } from './SubwindowFrame';
import { panelStripActionClass } from './sessionPanelsLayout';
import {
  deriveSubagentsWindowView,
  formatElapsed,
  formatTokens,
  type SubagentRowView,
} from './subwindowsModel';
import { useSubwindowClock } from './useSubwindowClock';

function StatusIcon({ row }: { row: SubagentRowView }) {
  const className = 'size-3.5 shrink-0';
  switch (row.status) {
    case 'running':
      return (
        <LoaderCircle className={cn(className, 'animate-spin text-status-running')} aria-hidden />
      );
    case 'completed':
      return <CircleCheck className={cn(className, 'text-success')} aria-hidden />;
    case 'failed':
      return <CircleX className={cn(className, 'text-destructive')} aria-hidden />;
    case 'stopped':
    case 'truncated':
    case 'cancelled':
      return <CircleX className={cn(className, 'text-muted-foreground')} aria-hidden />;
    default:
      return <Circle className={cn(className, 'text-muted-foreground')} aria-hidden />;
  }
}

/** The second line's words: tokens and calls, or why it ended. */
export function subagentMeta(row: SubagentRowView, t: TFunction): string {
  if (row.refused) return t('Declined the task');
  const parts: string[] = [];
  if (row.tokens !== undefined && row.tokens > 0) {
    parts.push(t('{{count}} tokens', { count: formatTokens(row.tokens) }));
  }
  if (row.toolUses !== undefined) parts.push(t('{{count}} calls', { count: row.toolUses }));
  switch (row.status) {
    case 'stopped':
      parts.push(t('Interrupted'));
      break;
    case 'failed':
      parts.push(t('Failed'));
      break;
    case 'truncated':
      parts.push(t('Cut off'));
      break;
    case 'cancelled':
      parts.push(t('Ended'));
      break;
    case 'unknown':
      parts.push(t('Earlier run'));
      break;
    default:
      break;
  }
  return parts.join(' · ');
}

export function SubagentsWindow({
  sessionId,
  layer,
  maxHeight,
  position,
}: {
  sessionId: string;
  layer: React.RefObject<HTMLDivElement | null>;
  maxHeight: number;
  position?: SubwindowPosition;
}) {
  const { t } = useI18n();
  const panels = useSessionPanelsStore((state) => state.bySession[sessionId]);
  const lanes = useSessionLanes(sessionId);
  const view = useMemo(() => deriveSubagentsWindowView({ panels, lanes }), [panels, lanes]);
  const now = useSubwindowClock(view.running > 0);

  const interrupt = async (childId: string): Promise<void> => {
    try {
      await window.electronAPI.chat.interruptSubagent({ sessionId, childId });
    } catch (error) {
      toastManager.add({
        type: 'error',
        title: t('The subagent was not interrupted'),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <SubwindowFrame
      windowKey="agents"
      icon={<Users className="size-3.5" />}
      title={t('Subagents')}
      count={view.rows.length > 0 ? t('{{count}} in all', { count: view.rows.length }) : ''}
      layer={layer}
      maxHeight={maxHeight}
      position={position}
    >
      {view.rows.length === 0 ? (
        <SubwindowEmpty>{t('No subagents yet')}</SubwindowEmpty>
      ) : (
        view.rows.map((row) => {
          const elapsed = formatElapsed(
            row.startedAt,
            row.status === 'running' ? now : row.endedAt
          );
          const name = row.agentName ?? (row.name === 'fork' ? t('Fork') : t('Delegated subagent'));
          return (
            <div
              key={row.key}
              className="rounded-sm px-2 py-0.5 hover:bg-hover"
              data-testid="subagent-row"
              data-status={row.status}
            >
              <div className="flex h-6 min-w-0 items-center gap-1.5 text-ui">
                <StatusIcon row={row} />
                <span className="shrink-0 font-medium text-foreground">{name}</span>
                <span className="shrink-0 text-muted-foreground">·</span>
                <span className="min-w-0 flex-1 truncate text-foreground" title={row.description}>
                  {row.description}
                </span>
                {elapsed && (
                  <span className="shrink-0 text-muted-foreground tabular-nums">{elapsed}</span>
                )}
              </div>
              <div className="flex h-6 min-w-0 items-center gap-0.5 pl-5 text-muted-foreground">
                <span className="min-w-0 flex-1 truncate tabular-nums">{subagentMeta(row, t)}</span>
                {row.interruptible && row.childId && (
                  <Button
                    size="xs"
                    variant="ghost"
                    className={panelStripActionClass()}
                    onClick={() => {
                      if (row.childId) void interrupt(row.childId);
                    }}
                  >
                    <Hand className="size-3.5" />
                    {t('Interrupt')}
                  </Button>
                )}
                {row.locatable && row.parentToolCallId && (
                  <Button
                    size="xs"
                    variant="ghost"
                    className={panelStripActionClass()}
                    onClick={() => {
                      if (row.parentToolCallId) locateToolRow(row.parentToolCallId);
                    }}
                  >
                    <LocateFixed className="size-3.5" />
                    {t('Locate')}
                  </Button>
                )}
              </div>
            </div>
          );
        })
      )}
    </SubwindowFrame>
  );
}
