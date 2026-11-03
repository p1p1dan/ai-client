/**
 * Decision 207 §8 item 3: the pure half of the session rail's 「子代理」 card.
 * DSH 0.2.1 runs every subagent in the background, so the main turn often
 * ends while they still work; the card is where they stay visible (the
 * reference is open-claude-ui's CoworkAgentCanvas member rows).
 *
 * One row per lane, three lines: name + status; type (or 「分叉」) + model;
 * what it is doing now + its duration, or, once ended, time, tokens and tool
 * count. Ended subagents stay, folded under 「已结束 N」: the card is the
 * session's record, so the tasks pane's 「清除已完成」 does not reach it.
 *
 * No React, no store: node-env tests assert every rule here.
 */
import { englishTranslate, type Translate } from '@shared/i18n';
import { toolDisplayName } from '@/components/chat/piToolNames';
import type { SessionPanels } from '@/components/chat/sessionPanelsModel';
import type { SubagentLane } from '@/components/chat/subagentActivityModel';
import {
  deriveStoppableSubagentRows,
  formatElapsed,
  formatTokens,
  stoppableRowFor,
} from '@/components/chat/subwindowsModel';
import { deriveToolRowView } from '@/components/chat/toolCard';
import type { TaskStop } from '../panes/backgroundTasksModel';

export type SubagentCardStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted';

export interface SubagentCardRow {
  key: string;
  childId: string | null;
  name: string;
  status: SubagentCardStatus;
  /** Second line: 「分叉」 or the subagent's type, then its model; null when neither is known. */
  kind: string | null;
  /** Third line: the current tool call, the pending approval, or the ended run's totals. */
  detail: string | null;
  /** A live row's running time, `m:ss`. */
  duration: string | null;
  /** 「打断」: a running continuable child on a live worker (the tasks pane's target). */
  interrupt: TaskStop | null;
  /**
   * 「停止」: a running one-shot child, stopped as its job (the Claude engine's
   * background subagents). Decision 207 §15: the Running card no longer lists
   * subagents, so this card carries the stop the tasks pane offers.
   */
  stop: TaskStop | null;
  /** 「查看对话」: the child's own conversation (decision 203 §6), ended ones too. */
  conversation: boolean;
}

export interface SubagentsCardView {
  /** Running and waiting, oldest first. */
  live: SubagentCardRow[];
  /** Ended, newest first. */
  ended: SubagentCardRow[];
  running: number;
  waiting: number;
}

export interface SubagentsCardInput {
  panels: SessionPanels | undefined;
  lanes: readonly SubagentLane[];
  now: number;
  t?: Translate;
}

function statusOf(lane: SubagentLane): SubagentCardStatus {
  switch (lane.status) {
    case 'running':
      return lane.pendingPermission ? 'waiting' : 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'truncated':
      return 'failed';
    default:
      return 'interrupted';
  }
}

/** The lane's latest tool call as a row reads it (`读取 src/pay/charge.ts`); a running one first. */
function currentActivity(lane: SubagentLane, t: Translate): string | null {
  const tools = lane.rows.filter((row) => row.kind === 'tool');
  const row = [...tools].reverse().find((item) => item.status === 'running') ?? tools.at(-1);
  if (row) {
    const view = deriveToolRowView(
      {
        toolCallId: row.toolCallId,
        blockIndex: 0,
        blockId: `rail-${row.toolCallId}`,
        toolName: row.name,
        input: row.input,
        status: row.status === 'stopped' ? 'failed' : row.status,
      },
      { t }
    );
    if (view.title) return view.title;
    const verb = t(view.verb);
    return view.arg ? `${verb} ${view.arg}` : verb;
  }
  const lastTool = lane.progress?.lastToolName;
  return lane.progress?.description ?? (lastTool ? toolDisplayName(lastTool) : null);
}

function endedTotals(lane: SubagentLane, t: Translate): string | null {
  const took = formatElapsed(lane.startedAt, lane.endedAt);
  const durationMs = lane.report?.totalDurationMs ?? lane.usage?.durationMs;
  const duration =
    took ?? (durationMs !== undefined ? formatElapsed(0, Math.max(0, durationMs)) : null);
  const tokens = lane.report?.totalTokens ?? lane.usage?.totalTokens;
  const toolUses = lane.report?.totalToolUseCount ?? lane.usage?.toolUses;
  const parts: string[] = [];
  if (duration) parts.push(t('Took {{duration}}', { duration }));
  if (tokens !== undefined && tokens > 0) {
    parts.push(t('{{count}} tokens', { count: formatTokens(tokens) }));
  }
  if (toolUses !== undefined) {
    parts.push(
      toolUses === 1
        ? t('{{count}} tool call', { count: toolUses })
        : t('{{count}} tool calls', { count: toolUses })
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function cardRow(
  lane: SubagentLane,
  input: SubagentsCardInput,
  stoppable: ReturnType<typeof deriveStoppableSubagentRows>,
  t: Translate
): SubagentCardRow {
  const catalog = input.panels?.subagentCatalog ?? [];
  const status = statusOf(lane);
  const live = lane.status === 'running';
  const name =
    lane.description ??
    catalog.find((entry) => entry.id === lane.agentId)?.label ??
    lane.agentType ??
    lane.agentId ??
    '';
  const type = lane.taskType === 'subagent_fork' ? t('Fork') : lane.agentType;
  const kind = [type, lane.report?.resolvedModel].filter(Boolean).join(' · ') || null;
  let detail: string | null;
  if (status === 'waiting' && lane.pendingPermission) {
    detail = t('Waiting for your approval: {{tool}}', {
      tool: toolDisplayName(lane.pendingPermission.toolName),
    });
  } else {
    detail = live ? currentActivity(lane, t) : endedTotals(lane, t);
  }
  const stop = live ? stoppableRowFor(stoppable, lane.agentId) : undefined;
  return {
    key: `lane:${lane.parentToolCallId}`,
    childId: lane.agentId,
    name,
    status,
    kind,
    detail,
    duration: live ? formatElapsed(lane.startedAt, input.now) : null,
    interrupt:
      stop?.stop === 'interrupt' && stop.childId
        ? { type: 'interrupt', childId: stop.childId }
        : null,
    stop: stop?.stop === 'stop' && stop.jobId ? { type: 'stop', jobId: stop.jobId } : null,
    conversation: lane.agentId !== null,
  };
}

/** Null (no card) while the session never started a subagent. */
export function deriveSubagentsCardView(input: SubagentsCardInput): SubagentsCardView | null {
  const t = input.t ?? englishTranslate;
  // A lane with no status yet has not started (the tasks pane's rule).
  const lanes = input.lanes.filter((lane) => lane.status !== null);
  if (lanes.length === 0) return null;
  const stoppable = deriveStoppableSubagentRows({ panels: input.panels, lanes: input.lanes });
  const live = lanes
    .filter((lane) => lane.status === 'running')
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((lane) => cardRow(lane, input, stoppable, t));
  const ended = lanes
    .filter((lane) => lane.status !== 'running')
    .sort((a, b) => (b.endedAt ?? -Infinity) - (a.endedAt ?? -Infinity) || b.ordinal - a.ordinal)
    .map((lane) => cardRow(lane, input, stoppable, t));
  const waiting = live.filter((row) => row.status === 'waiting').length;
  return { live, ended, running: live.length - waiting, waiting };
}
