import type {
  DshJobSummary,
  DshSubagentCatalogEntry,
  SubagentRunStatus,
} from '@shared/types/runtimeEvents';
import type { SessionPanels } from './sessionPanelsModel';
import type { SubagentLane } from './subagentActivityModel';

/**
 * dsh-rebase P1-7b (decisions 069, 109, 119; plan P1-7 shard 03 §4, §5.2;
 * prototype 2026-09-28 scenes C / D): the pure half of the two floating
 * sub-windows the session bar opens.
 *
 * **Background jobs** — the session's jobs as the bridge's `jobs` projection
 * lists them (background commands, commands their timeout moved to the
 * background, one-shot background subagents, workflows), plus every
 * continuable subagent that is running now: DSH counts both as the session's
 * work in the background, and the user decided the same subagent may show
 * here, in the subagents window and in its lane at once (decision 109 rule 3).
 *
 * **Subagents** — every direct child the session has: its lane when this
 * window saw it run (status, time, tokens, calls), otherwise just its catalog
 * entry (a child from before the app opened the chat).
 *
 * No React, no store: node-env tests assert the rows.
 */

// ---- background jobs ------------------------------------------------------------------

export type JobRowKind = 'command' | 'subagent' | 'workflow' | 'other';

/**
 * Where a row stands. `lost`: the list says running but the session has no
 * live worker any more — the host went and took its jobs with it (plan P1-7
 * shard 03 §4: 「引擎重启，任务已结束」).
 */
export type JobRowStatus = 'running' | 'stopping' | 'completed' | 'failed' | 'killed' | 'lost';

export interface JobRowView {
  /** Unique in the window: the job id, or `subagent:<child id>`. */
  key: string;
  /** The job behind a job row; absent on a continuable subagent's row. */
  jobId?: string;
  /** The child behind a subagent's row. */
  childId?: string;
  kind: JobRowKind;
  label: string;
  status: JobRowStatus;
  /** A foreground command its timeout moved here (「超时转入」). */
  promoted: boolean;
  /** Parsed off DSH's `exit code: N` detail; never marks a row red by itself. */
  exitCode?: number;
  startedAt: number | null;
  endedAt: number | null;
  /**
   * The stop control: `stop` kills a job (DSH's `job_kill`); `interrupt`
   * cancels a continuable subagent's current run and keeps the child
   * (decision 069); none on a row that already ended.
   */
  stop: 'stop' | 'interrupt' | null;
  /** What the row opens: a job's output bytes, a subagent's lane rows, a workflow's phase log. */
  expand: 'output' | 'activity' | 'stages';
  /** An ended row can be put away (this window only). */
  removable: boolean;
}

export interface JobsWindowView {
  rows: JobRowView[];
  running: number;
  ended: number;
  /** 「全部停止」 is offered only past one stoppable row (prototype detail 2). */
  canStopAll: boolean;
}

const EXIT_CODE = /exit code:?\s*(-?\d+)/i;

export function jobRowKind(kind: string): JobRowKind {
  if (kind === 'bash' || kind === 'pwsh') return 'command';
  if (kind === 'subagent') return 'subagent';
  if (kind === 'workflow') return 'workflow';
  return 'other';
}

function isRunningStatus(status: JobRowStatus): boolean {
  return status === 'running' || status === 'stopping';
}

function jobRow(job: DshJobSummary, live: boolean): JobRowView {
  const kind = jobRowKind(job.kind);
  const exit = job.detail ? EXIT_CODE.exec(job.detail) : null;
  const liveStatus = job.status === 'running' || job.status === 'stopping';
  const status: JobRowStatus = liveStatus && !live ? 'lost' : job.status;
  const running = isRunningStatus(status);
  return {
    key: job.id,
    jobId: job.id,
    kind,
    label: job.label,
    status,
    promoted: job.promoted === true,
    ...(exit ? { exitCode: Number(exit[1]) } : {}),
    startedAt: job.startedAt,
    endedAt: job.finishedAt ?? null,
    stop: running && status === 'running' ? 'stop' : null,
    expand: kind === 'workflow' ? 'stages' : 'output',
    removable: !running,
  };
}

/** The session's children that are continuable, by id. */
function continuableIds(catalog: readonly DshSubagentCatalogEntry[] | undefined): Set<string> {
  return new Set((catalog ?? []).filter((e) => e.mode === 'continuable').map((e) => e.id));
}

export function deriveJobsWindowView(input: {
  panels: SessionPanels | undefined;
  /** The session's lanes (the subagent-activity store's, filtered to the session). */
  lanes: readonly SubagentLane[];
  hidden: readonly string[];
}): JobsWindowView {
  const live = input.panels?.live === true;
  const hidden = new Set(input.hidden);
  const rows: JobRowView[] = (input.panels?.jobs ?? [])
    .filter((job) => !hidden.has(job.id))
    .map((job) => jobRow(job, live));
  // Continuable children running now: DSH's other kind of background work.
  const continuable = continuableIds(input.panels?.subagentCatalog);
  for (const lane of input.lanes) {
    if (!lane.agentId || !continuable.has(lane.agentId) || lane.status !== 'running') continue;
    rows.push({
      key: `subagent:${lane.agentId}`,
      childId: lane.agentId,
      kind: 'subagent',
      label: lane.description ?? lane.agentType ?? lane.agentId,
      status: live ? 'running' : 'lost',
      promoted: false,
      startedAt: lane.startedAt,
      endedAt: null,
      stop: live ? 'interrupt' : null,
      expand: 'activity',
      removable: false,
    });
  }
  const running = rows.filter((row) => isRunningStatus(row.status)).length;
  return {
    rows,
    running,
    ended: rows.length - running,
    canStopAll: rows.filter((row) => row.stop !== null).length > 1,
  };
}

// ---- subagents ------------------------------------------------------------------------------

/** How a child is named (decision 090: no custom subagents, so no agent names on DSH). */
export type SubagentRowName = 'subagent' | 'fork';

export type SubagentRowStatus = SubagentRunStatus | 'unknown';

export interface SubagentRowView {
  key: string;
  childId: string | null;
  /** The delegating row in the timeline, when this window saw the child start. */
  parentToolCallId: string | null;
  name: SubagentRowName;
  /** A 1.0.x delegate's own name (`explore`), when the lane has one. */
  agentName: string | null;
  description: string;
  status: SubagentRowStatus;
  /** The child declined the task (DSH `refusal`): 「拒绝了任务」 rather than a bare failure. */
  refused: boolean;
  startedAt: number | null;
  endedAt: number | null;
  tokens?: number;
  toolUses?: number;
  /** A running continuable child on a live worker: 「打断」. */
  interruptible: boolean;
  /** Its delegating row can be found in the timeline: 「定位」. */
  locatable: boolean;
}

export interface SubagentsWindowView {
  rows: SubagentRowView[];
  running: number;
}

export function deriveSubagentsWindowView(input: {
  panels: SessionPanels | undefined;
  lanes: readonly SubagentLane[];
}): SubagentsWindowView {
  const live = input.panels?.live === true;
  const catalog = input.panels?.subagentCatalog ?? [];
  const continuable = continuableIds(catalog);
  const lanes = [...input.lanes].sort((a, b) => a.ordinal - b.ordinal);
  const seen = new Set<string>();
  const rows: SubagentRowView[] = lanes.map((lane) => {
    if (lane.agentId) seen.add(lane.agentId);
    const running = lane.status === 'running';
    const usage = lane.usage;
    const tokens = lane.report?.totalTokens ?? usage?.totalTokens;
    const toolUses = lane.report?.totalToolUseCount ?? usage?.toolUses;
    return {
      key: `lane:${lane.parentToolCallId}`,
      childId: lane.agentId,
      parentToolCallId: lane.parentToolCallId,
      name: lane.taskType === 'subagent_fork' ? 'fork' : 'subagent',
      agentName: lane.agentType,
      description:
        lane.description ??
        catalog.find((entry) => entry.id === lane.agentId)?.label ??
        lane.agentId ??
        '',
      status: lane.status ?? 'unknown',
      refused: lane.report?.stopReason === 'refusal',
      startedAt: lane.startedAt,
      endedAt: running ? null : lane.endedAt,
      ...(tokens !== undefined ? { tokens } : {}),
      ...(toolUses !== undefined ? { toolUses } : {}),
      interruptible: running && live && lane.agentId !== null && continuable.has(lane.agentId),
      locatable: true,
    };
  });
  for (const entry of catalog) {
    if (seen.has(entry.id)) continue;
    rows.push({
      key: `child:${entry.id}`,
      childId: entry.id,
      parentToolCallId: null,
      name: 'subagent',
      agentName: null,
      description: entry.label ?? entry.id,
      status: 'unknown',
      refused: false,
      startedAt: entry.createdAt,
      endedAt: null,
      interruptible: false,
      locatable: false,
    });
  }
  return { rows, running: rows.filter((row) => row.status === 'running').length };
}

// ---- shared ---------------------------------------------------------------------------------

/** `m:ss` (or `h:mm:ss`) between two stamps; null when either is unknown. */
export function formatElapsed(fromMs: number | null, toMs: number | null): string | null {
  if (fromMs === null || toMs === null || toMs < fromMs) return null;
  const seconds = Math.floor((toMs - fromMs) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `45k` / `1.2M` for a token count (the prototype's 「45k tokens」). */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/**
 * The layer's two windows, stacked at the top right when not dragged: the
 * height each may take (prototype `layoutOverlayWindows`: two open share the
 * room above the composer, each at most 420 px, never under 88 px).
 */
export const SUBWINDOW_MAX_HEIGHT_PX = 420;
export const SUBWINDOW_MIN_HEIGHT_PX = 88;
export const SUBWINDOW_GAP_PX = 8;

export function subwindowMaxHeight(available: number, openCount: number): number {
  const share =
    openCount > 1 ? Math.floor((available - SUBWINDOW_GAP_PX) / openCount) : Math.floor(available);
  return Math.max(SUBWINDOW_MIN_HEIGHT_PX, Math.min(share, SUBWINDOW_MAX_HEIGHT_PX));
}

/** A dragged corner kept inside the layer, with room to grab the header back. */
export function clampSubwindowPosition(
  position: { left: number; top: number },
  size: { width: number; height: number },
  layer: { width: number; height: number }
): { left: number; top: number } {
  const HEADER_GRIP = 40;
  return {
    left: Math.max(0, Math.min(position.left, Math.max(0, layer.width - size.width))),
    top: Math.max(0, Math.min(position.top, Math.max(0, layer.height - HEADER_GRIP))),
  };
}
