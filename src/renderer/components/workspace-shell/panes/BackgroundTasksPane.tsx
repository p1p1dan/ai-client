/**
 * Layout 5d: background tasks as a pane card (the reference desktop app's
 * 「后台任务」 pane). Replaces the title bar's floating jobs / subagents
 * windows; it reads the same stores they read.
 *
 * The card draws the title, expand and close; this view adds 「清除已完成」 to
 * the card header and draws two sections: 运行中, then a collapsible 已完成 N
 * (a page at a time). A running row can be stopped (a continuable subagent is
 * interrupted, decision 069); a finished one opens its output — a job's bytes
 * inline, a subagent's own conversation in its dialog.
 */
import { ChevronDown, ChevronRight, Square, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { JobOutputPane, useSessionLanes } from '@/components/chat/BackgroundJobsWindow';
import { SubagentConversationDialog } from '@/components/chat/SubagentConversationDialog';
import { isSessionNotRunningError, SESSION_TASKS_ENDED } from '@/components/chat/sessionStart';
import { useSubwindowClock } from '@/components/chat/useSubwindowClock';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { unwrapIpcErrorMessage } from '@/lib/ipcError';
import { cn } from '@/lib/utils';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { useSessionSubwindowsStore } from '@/stores/sessionSubwindows';
import {
  deriveBackgroundTasksView,
  FINISHED_PAGE,
  type TaskRow,
  type TaskStop,
} from './backgroundTasksModel';
import { PaneHeaderPortal } from './paneSlots';

const EMPTY: readonly string[] = [];

export function BackgroundTasksPane({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const panels = useSessionPanelsStore((state) => state.bySession[sessionId]);
  const hidden = useSessionSubwindowsStore((state) => state.hiddenJobs[sessionId] ?? EMPTY);
  const hideJobs = useSessionSubwindowsStore((state) => state.hideJobs);
  const lanes = useSessionLanes(sessionId);
  // The clock ticks only while something runs.
  const anyRunning =
    lanes.some((lane) => lane.status === 'running') ||
    (panels?.live === true &&
      (panels.jobs ?? []).some((job) => job.status === 'running' || job.status === 'stopping'));
  const now = useSubwindowClock(anyRunning);
  const view = useMemo(
    () => deriveBackgroundTasksView({ panels, lanes, hidden, now }),
    [panels, lanes, hidden, now]
  );

  const [finishedOpen, setFinishedOpen] = useState(true);
  const [shown, setShown] = useState(FINISHED_PAGE);
  const [viewing, setViewing] = useState<TaskRow | null>(null);

  const stop = async (target: TaskStop): Promise<void> => {
    try {
      if (target.type === 'interrupt') {
        await window.electronAPI.chat.interruptSubagent({ sessionId, childId: target.childId });
      } else {
        await window.electronAPI.chat.killSessionJob({ sessionId, jobId: target.jobId });
      }
    } catch (error) {
      toastManager.add({
        type: 'error',
        title: t('The task was not stopped'),
        description: isSessionNotRunningError(error)
          ? t(SESSION_TASKS_ENDED)
          : unwrapIpcErrorMessage(error),
      });
    }
  };

  const empty = view.running.length === 0 && view.finishedCount === 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="background-tasks-pane">
      <PaneHeaderPortal slot="actions">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t('Clear finished')}
          title={t('Clear finished')}
          disabled={view.clearableHideKeys.length === 0}
          onClick={() => hideJobs(sessionId, view.clearableHideKeys)}
        >
          <Trash2 className="size-4" />
        </Button>
      </PaneHeaderPortal>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {empty ? (
          <p className="px-3 py-3 text-small text-foreground-faint">
            {t('No background tasks right now')}
          </p>
        ) : (
          <>
            {view.running.length > 0 && (
              <section>
                <p className="px-3 pt-2 pb-1 text-small text-foreground-faint">{t('Running')}</p>
                <TaskList
                  rows={view.running}
                  sessionId={sessionId}
                  now={now}
                  onStop={(target) => void stop(target)}
                  onView={setViewing}
                />
              </section>
            )}
            {view.finishedCount > 0 && (
              <section>
                <button
                  type="button"
                  aria-expanded={finishedOpen}
                  onClick={() => setFinishedOpen((open) => !open)}
                  className="flex items-center gap-1 px-3 pt-2 pb-1 text-small text-foreground-faint hover:text-muted-foreground"
                >
                  {t('Completed')}
                  <span className="tabular-nums">{view.finishedCount}</span>
                  <ChevronDown
                    className={cn(
                      'size-3.5 transition-transform duration-150',
                      !finishedOpen && '-rotate-90'
                    )}
                  />
                </button>
                {finishedOpen && (
                  <>
                    <TaskList
                      rows={view.finished.slice(0, shown)}
                      sessionId={sessionId}
                      now={now}
                      onStop={(target) => void stop(target)}
                      onView={setViewing}
                    />
                    {view.finishedCount > shown && (
                      <button
                        type="button"
                        onClick={() => setShown((count) => count + FINISHED_PAGE)}
                        className="w-full px-3 py-1.5 text-left text-small text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground"
                      >
                        {t('Show more tasks')}
                      </button>
                    )}
                  </>
                )}
              </section>
            )}
          </>
        )}
      </div>

      {viewing?.open?.type === 'conversation' && (
        <SubagentConversationDialog
          sessionId={sessionId}
          childId={viewing.open.childId}
          title={viewing.title || t('Delegated subagent')}
          running={viewing.running}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

interface TaskListProps {
  rows: readonly TaskRow[];
  sessionId: string;
  now: number;
  onStop: (target: TaskStop) => void;
  onView: (row: TaskRow) => void;
}

/** Rows separated by hairlines. */
function TaskList({ rows, ...rest }: TaskListProps) {
  return (
    <ul className="divide-y divide-border-soft">
      {rows.map((row) => (
        <li key={row.key}>
          <TaskRowView row={row} {...rest} />
        </li>
      ))}
    </ul>
  );
}

function TaskRowView({
  row,
  sessionId,
  now,
  onStop,
  onView,
  depth = 0,
}: Omit<TaskListProps, 'rows'> & { row: TaskRow; depth?: number }) {
  const { t } = useI18n();
  const [outputOpen, setOutputOpen] = useState(false);
  const [childrenOpen, setChildrenOpen] = useState(false);
  const open = () => {
    if (!row.open) return;
    if (row.open.type === 'output') setOutputOpen((value) => !value);
    else if (row.open.type === 'conversation') onView(row);
  };
  // A finished row opens on a click anywhere; a running one only through its ›.
  const rowClickable = !row.running && row.open !== null;
  const meta = row.meta
    ? [
        row.meta.model,
        row.meta.tokens ? t('{{count}} tokens', { count: row.meta.tokens }) : null,
      ].filter(Boolean)
    : [];

  return (
    <div data-testid="task-row" data-running={row.running ? 'true' : 'false'}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the › button is the keyboard path */}
      <div
        className={cn(
          'px-3 py-1.5 hover:bg-fill-ghost-hover',
          rowClickable && 'cursor-pointer',
          depth > 0 && 'pl-7'
        )}
        onClick={rowClickable ? open : undefined}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-ui text-foreground" title={row.title}>
            {row.title}
          </span>
          {row.duration && (
            <span className="shrink-0 text-small text-foreground-faint tabular-nums">
              {row.duration}
            </span>
          )}
          {row.running && row.stop && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={row.stop.type === 'interrupt' ? t('Interrupt') : t('Stop')}
              title={row.stop.type === 'interrupt' ? t('Interrupt') : t('Stop')}
              onClick={(event) => {
                event.stopPropagation();
                if (row.stop) onStop(row.stop);
              }}
            >
              <Square />
            </Button>
          )}
          {row.open && row.open.type !== 'activity' && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={
                row.open.type === 'conversation'
                  ? t('View conversation')
                  : row.open.stages
                    ? t('Stages')
                    : t('Output')
              }
              aria-expanded={row.open.type === 'output' ? outputOpen : undefined}
              onClick={(event) => {
                event.stopPropagation();
                open();
              }}
            >
              <ChevronRight
                className={cn('transition-transform duration-150', outputOpen && 'rotate-90')}
              />
            </Button>
          )}
        </div>
        {meta.length > 0 && (
          <p className="truncate text-small text-foreground-faint tabular-nums">
            {meta.join(' · ')}
          </p>
        )}
        {row.children.length > 0 && (
          <button
            type="button"
            aria-expanded={childrenOpen}
            onClick={(event) => {
              event.stopPropagation();
              setChildrenOpen((value) => !value);
            }}
            className="mt-0.5 flex items-center gap-1 text-small text-muted-foreground hover:text-foreground"
          >
            {t('{{count}} tasks', { count: row.children.length })}
            <ChevronDown
              className={cn(
                'size-3.5 transition-transform duration-150',
                !childrenOpen && '-rotate-90'
              )}
            />
          </button>
        )}
      </div>
      {outputOpen && row.open?.type === 'output' && (
        <JobOutputPane
          sessionId={sessionId}
          jobId={row.open.jobId}
          running={row.running}
          title={row.open.stages ? t('Stages') : t('Output')}
        />
      )}
      {childrenOpen && row.children.length > 0 && (
        <ChildRows
          rows={row.children}
          sessionId={sessionId}
          now={now}
          onStop={onStop}
          onView={onView}
          depth={depth + 1}
        />
      )}
    </div>
  );
}

/** A subagent's own tasks: running ones listed, ended ones behind 「N 个已完成 ›」. */
function ChildRows({ rows, depth, ...rest }: TaskListProps & { depth: number }) {
  const { t } = useI18n();
  const [finishedOpen, setFinishedOpen] = useState(false);
  const running = rows.filter((row) => row.running);
  const finished = rows.filter((row) => !row.running);
  return (
    <div>
      {running.map((row) => (
        <TaskRowView key={row.key} row={row} depth={depth} {...rest} />
      ))}
      {finished.length > 0 && (
        <button
          type="button"
          aria-expanded={finishedOpen}
          onClick={() => setFinishedOpen((value) => !value)}
          className="flex w-full items-center gap-1 py-1.5 pr-3 pl-7 text-small text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground"
        >
          {t('{{count}} finished', { count: finished.length })}
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform duration-150',
              finishedOpen && 'rotate-90'
            )}
          />
        </button>
      )}
      {finishedOpen &&
        finished.map((row) => <TaskRowView key={row.key} row={row} depth={depth} {...rest} />)}
    </div>
  );
}
