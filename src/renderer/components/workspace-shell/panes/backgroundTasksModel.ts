/**
 * Layout 5d: the pure half of the background-tasks pane.
 *
 * One list for what the two floating sub-windows used to split: background
 * jobs (commands, workflows; `deriveJobsWindowView` already leaves subagent
 * jobs out) and the session's subagent lanes. Running rows first, oldest
 * first; then everything that ended, newest first.
 *
 * `children` is always empty today: DSH reports no link between a subagent
 * and the jobs it started. The field stays so the view's 「N 个任务」 group
 * works once that link exists.
 *
 * No React, no store: node-env tests assert the rows.
 */
import type { SessionPanels } from '@/components/chat/sessionPanelsModel';
import type { SubagentLane } from '@/components/chat/subagentActivityModel';
import {
  deriveJobsWindowView,
  deriveStoppableSubagentRows,
  formatElapsed,
  formatTokens,
  type JobRowStatus,
  type JobRowView,
  stoppableRowFor,
} from '@/components/chat/subwindowsModel';
import type { RunStatus } from '@/components/ui/status-icon';

/** How many finished rows show before 「显示更多」. */
export const FINISHED_PAGE = 10;

export type TaskRowKind = 'command' | 'subagent' | 'workflow' | 'other';

export type TaskStop = { type: 'stop'; jobId: string } | { type: 'interrupt'; childId: string };

export type TaskOpen =
  | { type: 'output'; jobId: string; stages: boolean }
  | { type: 'conversation'; childId: string }
  | { type: 'activity' };

export interface TaskRow {
  key: string;
  kind: TaskRowKind;
  title: string;
  /** `m:ss`; a running row counts to `now`. */
  duration: string | null;
  running: boolean;
  status: RunStatus;
  /** Second line (a subagent's): its model and its tokens (`formatTokens`), when known. */
  meta: { model: string | null; tokens: string | null } | null;
  stop: TaskStop | null;
  open: TaskOpen | null;
  children: TaskRow[];
  /** What 「清除已完成」 remembers the row by (`hiddenJobs`). */
  hideKey?: string;
  /** Sort keys. */
  startedAt: number | null;
  endedAt: number | null;
}

export interface BackgroundTasksView {
  running: TaskRow[];
  finished: TaskRow[];
  finishedCount: number;
  /** Every finished row's hide key, for 「清除已完成」. */
  clearableHideKeys: string[];
}

export interface BackgroundTasksInput {
  panels: SessionPanels | undefined;
  /** The session's lanes. */
  lanes: readonly SubagentLane[];
  /** `useSessionSubwindowsStore().hiddenJobs[sessionId]`. */
  hidden: readonly string[];
  now: number;
}

function jobRunStatus(status: JobRowStatus): RunStatus {
  switch (status) {
    case 'running':
    case 'stopping':
      return 'running';
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    default:
      return 'stopped';
  }
}

function laneRunStatus(status: SubagentLane['status']): RunStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    default:
      return 'stopped';
  }
}

function stopOf(row: JobRowView | undefined): TaskStop | null {
  if (!row?.stop) return null;
  if (row.stop === 'interrupt' && row.childId) return { type: 'interrupt', childId: row.childId };
  return row.jobId ? { type: 'stop', jobId: row.jobId } : null;
}

function jobTaskRow(row: JobRowView, now: number): TaskRow {
  const running = row.status === 'running' || row.status === 'stopping';
  return {
    key: `job:${row.key}`,
    kind: row.kind,
    title: row.label,
    duration: formatElapsed(row.startedAt, running ? now : row.endedAt),
    running,
    status: jobRunStatus(row.status),
    meta: null,
    stop: stopOf(row),
    // A former worker's job has no output left to read.
    open:
      row.former || !row.jobId
        ? null
        : { type: 'output', jobId: row.jobId, stages: row.kind === 'workflow' },
    children: [],
    ...(row.removable && row.hideKey ? { hideKey: row.hideKey } : {}),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

/** What 「清除已完成」 hides an ended lane by. */
export function laneHideKey(lane: SubagentLane): string {
  return `lane:${lane.parentToolCallId}`;
}

function laneTaskRow(
  lane: SubagentLane,
  input: BackgroundTasksInput,
  stoppable: readonly JobRowView[]
): TaskRow {
  const running = lane.status === 'running';
  const catalog = input.panels?.subagentCatalog ?? [];
  const title =
    lane.description ??
    catalog.find((entry) => entry.id === lane.agentId)?.label ??
    lane.agentType ??
    lane.agentId ??
    '';
  const model = lane.report?.resolvedModel ?? null;
  const tokens = lane.report?.totalTokens ?? lane.usage?.totalTokens;
  const tokenLabel = tokens !== undefined && tokens > 0 ? formatTokens(tokens) : null;
  const meta = model || tokenLabel ? { model, tokens: tokenLabel } : null;
  return {
    key: `lane:${lane.parentToolCallId}`,
    kind: 'subagent',
    title,
    duration: formatElapsed(lane.startedAt, running ? input.now : lane.endedAt),
    running,
    status: laneRunStatus(lane.status),
    meta,
    stop: running ? stopOf(stoppableRowFor(stoppable, lane.agentId)) : null,
    open: lane.agentId ? { type: 'conversation', childId: lane.agentId } : null,
    children: [],
    ...(running ? {} : { hideKey: laneHideKey(lane) }),
    startedAt: lane.startedAt,
    endedAt: lane.endedAt,
  };
}

export function deriveBackgroundTasksView(input: BackgroundTasksInput): BackgroundTasksView {
  const hidden = new Set(input.hidden);
  const jobs = deriveJobsWindowView({
    panels: input.panels,
    lanes: input.lanes,
    hidden: input.hidden,
  });
  const stoppable = deriveStoppableSubagentRows({ panels: input.panels, lanes: input.lanes });
  const rows: TaskRow[] = [
    ...jobs.rows.map((row) => jobTaskRow(row, input.now)),
    // A lane with no status yet has not started; one put away stays away.
    ...input.lanes
      .filter((lane) => lane.status !== null && !hidden.has(laneHideKey(lane)))
      .map((lane) => laneTaskRow(lane, input, stoppable)),
  ];
  const running = rows
    .filter((row) => row.running)
    .sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  const finished = rows
    .filter((row) => !row.running)
    .sort((a, b) => (b.endedAt ?? -Infinity) - (a.endedAt ?? -Infinity));
  return {
    running,
    finished,
    finishedCount: finished.length,
    clearableHideKeys: finished.flatMap((row) => (row.hideKey ? [row.hideKey] : [])),
  };
}
