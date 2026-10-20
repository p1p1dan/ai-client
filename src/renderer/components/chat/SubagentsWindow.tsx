/**
 * dsh-rebase P1-7b: the subagents sub-window (prototype scene D; decisions
 * 068 as revised by 109, 069, 090, 119; plan P1-7 shard 03 §5.2).
 *
 * The direct children running now (user, 2026-10-19: an ended one leaves the
 * list, and background subagents are no longer repeated in the jobs window):
 * a status icon, 子代理 or 分叉 and the
 * description the delegation gave it (DSH's subagents have no names of their
 * own, decision 090), how long it ran, its tokens and calls; then 「打断」 for
 * a running continuable child (its current run stops, the child stays and can
 * be continued, decision 069), 「停止」 for a background one-shot child, and
 * 「定位」, which scrolls the timeline to the row that delegated it.
 *
 * Decision 203: Stop leaves background subagents running, so this window
 * offers 「全部停止」 for them: each stoppable subagent row of the jobs view
 * is interrupted or killed, as the jobs window stops it.
 */

import {
  Circle,
  CircleCheck,
  CircleX,
  Hand,
  LoaderCircle,
  LocateFixed,
  MessagesSquare,
  Square,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { unwrapIpcErrorMessage } from '@/lib/ipcError';
import { cn } from '@/lib/utils';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import type { SubwindowPosition } from '@/stores/sessionSubwindows';
import { useSessionLanes } from './BackgroundJobsWindow';
import { locateToolRow } from './locateToolRow';
import { SubagentConversationDialog } from './SubagentConversationDialog';
import { SubwindowEmpty, SubwindowFrame } from './SubwindowFrame';
import { panelStripActionClass, panelStripIconButtonClass } from './sessionPanelsLayout';
import { isSessionNotRunningError, SESSION_TASKS_ENDED } from './sessionStart';
import {
  deriveStoppableSubagentRows,
  deriveSubagentsWindowView,
  formatElapsed,
  formatTokens,
  type JobRowView,
  type SubagentRowView,
  stoppableRowFor,
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
  // Decision 203: the subagents a 「全部停止」 reaches, as the jobs window stops them.
  const stoppable = useMemo(() => deriveStoppableSubagentRows({ panels, lanes }), [panels, lanes]);
  const [confirming, setConfirming] = useState(false);
  // Decision 203: the child whose sub-conversation page is open.
  const [viewing, setViewing] = useState<string | null>(null);
  const viewingRow = viewing ? view.rows.find((row) => row.childId === viewing) : undefined;

  const stopRow = async (row: JobRowView): Promise<void> => {
    const interrupting = row.stop === 'interrupt' && row.childId !== undefined;
    try {
      if (interrupting && row.childId) {
        await window.electronAPI.chat.interruptSubagent({ sessionId, childId: row.childId });
      } else if (row.jobId) {
        await window.electronAPI.chat.killSessionJob({ sessionId, jobId: row.jobId });
      }
    } catch (error) {
      toastManager.add({
        type: 'error',
        // An interrupted child can be continued; a one-shot one's job is ended.
        title: t(
          interrupting ? 'The subagent was not interrupted' : 'The subagent was not stopped'
        ),
        description: isSessionNotRunningError(error)
          ? t(SESSION_TASKS_ENDED)
          : unwrapIpcErrorMessage(error),
      });
    }
  };

  const stopAll =
    stoppable.length > 0 ? (
      <button
        type="button"
        className={panelStripIconButtonClass()}
        aria-label={t('Stop all subagents')}
        title={t('Stop all subagents')}
        onClick={() => setConfirming(true)}
      >
        <Square className="size-3.5" />
      </button>
    ) : null;

  const interrupt = async (childId: string): Promise<void> => {
    try {
      await window.electronAPI.chat.interruptSubagent({ sessionId, childId });
    } catch (error) {
      toastManager.add({
        type: 'error',
        title: t('The subagent was not interrupted'),
        // Decision 176: in words, not as Main's code — a conversation no longer
        // running took its tasks with it.
        description: isSessionNotRunningError(error)
          ? t(SESSION_TASKS_ENDED)
          : unwrapIpcErrorMessage(error),
      });
    }
  };

  return (
    <SubwindowFrame
      windowKey="agents"
      icon={<Users className="size-3.5" />}
      title={t('Subagents')}
      count={view.running > 0 ? t('{{running}} running', { running: view.running }) : ''}
      actions={stopAll}
      layer={layer}
      maxHeight={maxHeight}
      position={position}
    >
      {view.rows.length === 0 ? (
        <SubwindowEmpty>{t('No subagents running')}</SubwindowEmpty>
      ) : (
        view.rows.map((row) => {
          const elapsed = formatElapsed(
            row.startedAt,
            row.status === 'running' ? now : row.endedAt
          );
          const name = row.agentName ?? (row.name === 'fork' ? t('Fork') : t('Delegated subagent'));
          // A background one-shot child is stopped through its job.
          const stopTarget = row.interruptible
            ? undefined
            : stoppableRowFor(stoppable, row.childId);
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
                {stopTarget && (
                  <Button
                    size="xs"
                    variant="ghost"
                    className={panelStripActionClass()}
                    onClick={() => void stopRow(stopTarget)}
                  >
                    <Square className="size-3.5" />
                    {t('Stop')}
                  </Button>
                )}
                {row.childId && (
                  <Button
                    size="xs"
                    variant="ghost"
                    className={panelStripActionClass()}
                    onClick={() => setViewing(row.childId)}
                  >
                    <MessagesSquare className="size-3.5" />
                    {t('View conversation')}
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
      {viewing && (
        <SubagentConversationDialog
          sessionId={sessionId}
          childId={viewing}
          title={viewingRow?.description || t('Delegated subagent')}
          running={viewingRow?.status === 'running'}
          onClose={() => setViewing(null)}
        />
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Stop all subagents?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Every running subagent stops; a continuable one is interrupted and can be continued. The main conversation is not affected.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">{t('Cancel')}</Button>} />
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                for (const row of stoppable) void stopRow(row);
              }}
            >
              {t('Stop all')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SubwindowFrame>
  );
}
