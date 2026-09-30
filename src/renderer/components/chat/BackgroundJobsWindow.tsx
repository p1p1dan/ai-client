/**
 * dsh-rebase P1-7b: the background jobs sub-window (prototype scene C;
 * decisions 069, 109, 119; plan P1-7 shard 03 §4).
 *
 * One row of two lines per item, as the prototype draws them: what it is (a
 * command's job id and the command, or 子代理 / 工作流 and its description)
 * and how long it has run; then its state, the 「超时转入」 and exit-code tags,
 * and its controls — open its output (a subagent's recent activity, a
 * workflow's phases), stop it (a continuable subagent is interrupted and can
 * go on, decision 069), or put an ended one away (this window only).
 *
 * Output is read on demand through `worker.job.read` — at the ring's offsets,
 * never the model's cursor — once a second while an open row runs.
 */

import {
  EyeOff,
  Hand,
  Layers,
  ScrollText,
  Square,
  SquareTerminal,
  Users,
  Workflow,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { toastManager } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { type SubwindowPosition, useSessionSubwindowsStore } from '@/stores/sessionSubwindows';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import { SubwindowEmpty, SubwindowFrame } from './SubwindowFrame';
import { panelStripActionClass, panelStripIconButtonClass } from './sessionPanelsLayout';
import { deriveSubagentPanelRows, type SubagentLane } from './subagentActivityModel';
import {
  deriveJobsWindowView,
  formatElapsed,
  type JobRowStatus,
  type JobRowView,
} from './subwindowsModel';
import { normalizeTerminalText } from './toolLiveOutputModel';
import { kilobytesLabel, startAtLine } from './toolOutputHead';
import { useSubwindowClock } from './useSubwindowClock';

const EMPTY: readonly string[] = [];

/** The state word of a row. */
export function jobStatusLabel(
  status: JobRowStatus,
  stop: JobRowView['stop'],
  t: TFunction
): string {
  switch (status) {
    case 'running':
      return t('Running');
    case 'stopping':
      return t('Stopping');
    case 'completed':
      return t('Completed');
    case 'failed':
      return t('Failed');
    case 'killed':
      return stop === 'interrupt' ? t('Interrupted') : t('Stopped');
    case 'lost':
      return t('Engine restarted; the task ended');
    default:
      return '';
  }
}

function kindIcon(row: JobRowView) {
  const className = 'size-3.5 shrink-0 text-muted-foreground';
  switch (row.kind) {
    case 'command':
      return <SquareTerminal className={className} aria-hidden />;
    case 'subagent':
      return <Users className={className} aria-hidden />;
    case 'workflow':
      return <Workflow className={className} aria-hidden />;
    default:
      return <Layers className={className} aria-hidden />;
  }
}

/** The lanes of one session, from the subagent-activity store. */
export function useSessionLanes(sessionId: string): SubagentLane[] {
  const lanes = useSubagentActivityStore((state) => state.lanes);
  return useMemo(
    () => Object.values(lanes).filter((lane) => lane.sessionId === sessionId),
    [lanes, sessionId]
  );
}

export function BackgroundJobsWindow({
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
  const hidden = useSessionSubwindowsStore((state) => state.hiddenJobs[sessionId] ?? EMPTY);
  const lanes = useSessionLanes(sessionId);
  const view = useMemo(
    () => deriveJobsWindowView({ panels, lanes, hidden }),
    [panels, lanes, hidden]
  );
  const now = useSubwindowClock(view.running > 0);
  const [confirming, setConfirming] = useState(false);

  const stop = async (row: JobRowView): Promise<void> => {
    try {
      if (row.stop === 'interrupt' && row.childId) {
        await window.electronAPI.chat.interruptSubagent({ sessionId, childId: row.childId });
      } else if (row.jobId) {
        await window.electronAPI.chat.killSessionJob({ sessionId, jobId: row.jobId });
      }
    } catch (error) {
      toastManager.add({
        type: 'error',
        title: t('The task was not stopped'),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const count =
    view.rows.length === 0
      ? ''
      : view.ended > 0
        ? t('{{running}} running · {{ended}} ended', {
            running: view.running,
            ended: view.ended,
          })
        : t('{{running}} running', { running: view.running });

  const stopAll = view.canStopAll ? (
    <button
      type="button"
      className={panelStripIconButtonClass()}
      aria-label={t('Stop all')}
      title={t('Stop all')}
      onClick={() => setConfirming(true)}
    >
      <Square className="size-3.5" />
    </button>
  ) : null;

  return (
    <SubwindowFrame
      windowKey="jobs"
      icon={<Layers className="size-3.5" />}
      title={t('Background tasks')}
      count={count}
      actions={stopAll}
      layer={layer}
      maxHeight={maxHeight}
      position={position}
    >
      {view.rows.length === 0 ? (
        <SubwindowEmpty>{t('No background tasks right now')}</SubwindowEmpty>
      ) : (
        view.rows.map((row) => (
          <JobRow
            key={row.key}
            sessionId={sessionId}
            row={row}
            now={now}
            lane={row.childId ? lanes.find((lane) => lane.agentId === row.childId) : undefined}
            onStop={() => void stop(row)}
          />
        ))
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('Stop all background tasks?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'Every running command and one-shot subagent stops; running subagents are interrupted and can be continued.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">{t('Cancel')}</Button>} />
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                for (const row of view.rows) if (row.stop) void stop(row);
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

function JobRow({
  sessionId,
  row,
  now,
  lane,
  onStop,
}: {
  sessionId: string;
  row: JobRowView;
  now: number;
  lane: SubagentLane | undefined;
  onStop: () => void;
}) {
  const { t } = useI18n();
  const expandKey = `jobs:${sessionId}:${row.key}`;
  const expanded = useSessionSubwindowsStore((state) => state.expanded[expandKey] === true);
  const toggleExpanded = useSessionSubwindowsStore((state) => state.toggleExpanded);
  const hideJob = useSessionSubwindowsStore((state) => state.hideJob);
  const running = row.status === 'running' || row.status === 'stopping';
  const elapsed = formatElapsed(row.startedAt, running ? now : row.endedAt);
  const expandLabel =
    row.expand === 'activity' ? t('Activity') : row.expand === 'stages' ? t('Stages') : t('Output');
  const idText =
    row.kind === 'command'
      ? row.jobId
      : row.kind === 'subagent'
        ? t('Delegated subagent')
        : row.kind === 'workflow'
          ? t('Workflow')
          : row.jobId;

  return (
    <div data-testid="job-row" data-status={row.status}>
      <div className="rounded-sm px-2 py-0.5 hover:bg-hover">
        <div className="flex h-6 min-w-0 items-center gap-1.5 text-ui">
          {kindIcon(row)}
          {row.kind === 'command' ? (
            <Ident className="shrink-0 text-muted-foreground">{idText}</Ident>
          ) : (
            <span className="shrink-0 text-muted-foreground">{idText}</span>
          )}
          {row.kind === 'command' ? (
            <Ident className="min-w-0 flex-1 truncate text-foreground" title={row.label}>
              {row.label}
            </Ident>
          ) : (
            <span className="min-w-0 flex-1 truncate text-foreground" title={row.label}>
              {row.label}
            </span>
          )}
          {elapsed && (
            <span className="shrink-0 text-muted-foreground tabular-nums">{elapsed}</span>
          )}
        </div>
        <div className="flex h-6 min-w-0 items-center gap-1.5 pl-5 text-muted-foreground">
          <span className="min-w-0 truncate">{jobStatusLabel(row.status, row.stop, t)}</span>
          {row.promoted && (
            <Badge variant="outline" size="sm" className="font-normal">
              {t('Timed out into the background')}
            </Badge>
          )}
          {row.exitCode !== undefined && (
            <Badge variant="outline" size="sm" className="font-normal tabular-nums">
              {t('Exit code {{code}}', { code: row.exitCode })}
            </Badge>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button
              size="xs"
              variant="ghost"
              className={cn(panelStripActionClass(), expanded && 'bg-selection')}
              aria-expanded={expanded}
              onClick={() => toggleExpanded(expandKey)}
            >
              <ScrollText className="size-3.5" />
              {expandLabel}
            </Button>
            {row.stop && (
              <Button
                size="xs"
                variant="ghost"
                className={panelStripActionClass()}
                onClick={onStop}
              >
                {row.stop === 'interrupt' ? (
                  <Hand className="size-3.5" />
                ) : (
                  <Square className="size-3.5" />
                )}
                {row.stop === 'interrupt' ? t('Interrupt') : t('Stop')}
              </Button>
            )}
            {row.removable && row.jobId && (
              <Button
                size="xs"
                variant="ghost"
                className={panelStripActionClass()}
                onClick={() => {
                  if (row.jobId) hideJob(sessionId, row.jobId);
                }}
              >
                <EyeOff className="size-3.5" />
                {t('Remove')}
              </Button>
            )}
          </span>
        </div>
      </div>
      {expanded &&
        (row.expand === 'activity' ? (
          <LaneActivity lane={lane} />
        ) : row.jobId ? (
          <JobOutputPane
            sessionId={sessionId}
            jobId={row.jobId}
            running={running}
            title={row.expand === 'stages' ? t('Stages') : t('Output')}
          />
        ) : null)}
    </div>
  );
}

/** The expanded pane's frame (prototype `.tail`): indented, a rule on its left. */
function tailClass(): string {
  return 'mb-1.5 ml-7 border-l border-border pl-3';
}

/** A continuable subagent's latest lane rows — its activity, not bytes (prototype `.mini-lane`). */
function LaneActivity({ lane }: { lane: SubagentLane | undefined }) {
  const { t } = useI18n();
  const rows = useMemo(
    () => deriveSubagentPanelRows(lane, { parentRunning: true, t })[0]?.detail ?? [],
    [lane, t]
  );
  const recent = rows.slice(-6);
  return (
    <div className={tailClass()}>
      <p className="text-muted-foreground">{t('Recent activity')}</p>
      {recent.length === 0 ? (
        <p className="text-muted-foreground">{t('No output yet')}</p>
      ) : (
        recent.map((row) => (
          <p key={row.key} className="truncate text-muted-foreground">
            {t(row.verb)}
            {row.arg ? ` ${row.arg}` : ''}
          </p>
        ))
      )}
    </div>
  );
}

/** What one pane keeps, in characters: a few reads' worth. */
const PANE_MAX_CHARS = 65_536;

/**
 * One job's output while its row is open: the newest 16 KB at first, then
 * whatever came after, once a second while the job runs. A session whose
 * worker went (the host restarted) answers nothing: the output went with it.
 */
export function JobOutputPane({
  sessionId,
  jobId,
  running,
  title,
}: {
  sessionId: string;
  jobId: string;
  running: boolean;
  title: string;
}) {
  const { t } = useI18n();
  const [pane, setPane] = useState<{
    text: string;
    omitted: number;
    spillPaths?: string[];
    gone: boolean;
    error?: string;
  }>({ text: '', omitted: 0, gone: false });
  const scroller = useRef<HTMLPreElement | null>(null);
  const following = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let next: number | undefined;
    let text = '';
    let omitted = 0;
    const read = async () => {
      const readJob = window.electronAPI?.chat?.readSessionJob;
      if (!readJob) return;
      try {
        const result = await readJob({
          sessionId,
          jobId,
          ...(next !== undefined ? { from: next } : {}),
        });
        if (cancelled) return;
        if (!result) {
          setPane((current) => ({ ...current, gone: true }));
          return;
        }
        if (next === undefined) omitted = result.from;
        text += result.text;
        if (text.length > PANE_MAX_CHARS) {
          omitted += text.length - PANE_MAX_CHARS;
          text = text.slice(-PANE_MAX_CHARS);
        }
        next = result.next;
        setPane({
          text,
          omitted,
          gone: false,
          ...(result.spillPaths ? { spillPaths: result.spillPaths } : {}),
        });
      } catch (error) {
        if (cancelled) return;
        setPane((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
        return;
      }
      if (running && !cancelled) timer = setTimeout(() => void read(), 1_000);
    };
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, jobId, running]);

  // P1-7e (problem 21): output read from a byte offset opens on a whole line;
  // the cut part counts toward what the title says was left out.
  const head = useMemo(
    () => startAtLine(normalizeTerminalText(pane.text), pane.omitted),
    [pane.text, pane.omitted]
  );
  const shown = head.text;

  // Follow the end while the reader is at it; stop once they scroll up.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && following.current && shown) element.scrollTop = element.scrollHeight;
  }, [shown]);

  return (
    <div className={tailClass()} data-testid="job-output">
      <p className="text-muted-foreground">
        {title}
        {head.omittedBytes > 0 &&
          ` · ${t('Earlier {{size}} not shown', { size: kilobytesLabel(head.omittedBytes) })}`}
      </p>
      {pane.gone ? (
        <p className="text-muted-foreground">
          {t('Output unavailable: the engine that ran it is gone')}
        </p>
      ) : pane.error ? (
        <p className="text-muted-foreground">{pane.error}</p>
      ) : shown ? (
        <pre
          ref={scroller}
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8;
          }}
          className="m-0 max-h-40 select-text overflow-auto whitespace-pre-wrap break-words text-code text-muted-foreground leading-[1.55]"
        >
          {shown}
        </pre>
      ) : (
        <p className="text-muted-foreground">{t('No output yet')}</p>
      )}
      {pane.spillPaths?.[0] && (
        <p className="truncate text-muted-foreground" title={pane.spillPaths[0]}>
          {t('Full output: {{path}}', { path: pane.spillPaths[0] })}
        </p>
      )}
    </div>
  );
}
