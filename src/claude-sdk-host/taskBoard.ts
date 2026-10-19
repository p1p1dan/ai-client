/**
 * Route B S-6 feedback 4: the CLI's background work, drawn where DSH's is drawn.
 *
 * The CLI reports every task it runs (`system/task_started`, `task_progress`,
 * `task_notification`, `background_tasks_changed`; 2.1.300). This board folds them into
 * the three things the renderer already draws for DSH chats:
 * - the `jobs` projection (the background-jobs window): background commands, background
 *   subagents, workflows;
 * - the `subagentCatalog` projection (the subagents window's rows without a lane);
 * - `subagent.activity` events (a subagent's lane: started, progress, status, and what it
 *   said and called, from the CLI's messages that carry `parent_tool_use_id`).
 *
 * Ambient tasks (the CLI's own housekeeping) are left out, as the CLI asks. No I/O here.
 */

import type {
  DshJobSummary,
  DshSubagentCatalogEntry,
  SubagentActivityPayload,
  SubagentRunStatus,
  SubagentUsage,
} from '../shared/types/runtimeEvents.ts';

/** Settled jobs kept listed, newest first, as DSH keeps the newest few. */
const KEEP_SETTLED = 20;
/** Clamp of one field of a subagent's tool input in its lane. */
const INPUT_FIELD_MAX = 160;
/** The fields of a tool input a lane shows: names and paths, never file bodies. */
const INPUT_FIELDS = [
  'description',
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'subagent_type',
];

interface TaskRecord {
  id: string;
  kind: string;
  label: string;
  status: DshJobSummary['status'];
  startedAt: number;
  finishedAt?: number;
  detail?: string;
  progress?: string;
  outputFile?: string;
  agent: boolean;
  /** Listed as a job: background work only (a foreground subagent is not one). */
  job: boolean;
  /** The Agent call that started a subagent: its lane's key. */
  toolUseId?: string;
}

export interface BoardChange {
  jobs: boolean;
  catalog: boolean;
  activity: SubagentActivityPayload[];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function usageOf(value: unknown): SubagentUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const usage: SubagentUsage = {
    ...(typeof raw.total_tokens === 'number' ? { totalTokens: raw.total_tokens } : {}),
    ...(typeof raw.tool_uses === 'number' ? { toolUses: raw.tool_uses } : {}),
    ...(typeof raw.duration_ms === 'number' ? { durationMs: raw.duration_ms } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The job kind the renderer knows (`jobRowKind`): `bash`, `subagent`, `workflow`, or the CLI's own. */
export function jobKindOf(taskType: string | undefined, agent: boolean): string {
  if (agent) return 'subagent';
  if (taskType === 'local_bash') return 'bash';
  if (taskType === 'local_workflow') return 'workflow';
  return taskType?.replace(/^local_/, '') || 'task';
}

function clampInput(input: unknown): Record<string, string | number> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const field of INPUT_FIELDS) {
    const value = raw[field];
    if (typeof value === 'number') out[field] = value;
    else if (typeof value === 'string' && value.length > 0) {
      out[field] = value.length > INPUT_FIELD_MAX ? `${value.slice(0, INPUT_FIELD_MAX)}…` : value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class TaskBoard {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly catalog: DshSubagentCatalogEntry[] = [];
  /** A subagent's Agent call id → its task id, for the lane's `agentId`. */
  private readonly agentByToolUse = new Map<string, string>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A `system` message of the CLI; anything that is not a task message changes nothing. */
  ingestSystem(message: Record<string, unknown>): BoardChange {
    const change: BoardChange = { jobs: false, catalog: false, activity: [] };
    const id = str(message.task_id);
    switch (message.subtype) {
      case 'task_started': {
        if (!id || message.ambient === true || message.skip_transcript === true) return change;
        const taskType = str(message.task_type);
        const agent = /agent/i.test(taskType ?? '') || typeof message.subagent_type === 'string';
        const toolUseId = str(message.tool_use_id);
        const record: TaskRecord = {
          id,
          kind: jobKindOf(taskType, agent),
          label: str(message.description) ?? str(message.workflow_name) ?? id,
          status: 'running',
          startedAt: this.tasks.get(id)?.startedAt ?? this.now(),
          agent,
          job: !agent || message.is_backgrounded !== false,
          ...(toolUseId ? { toolUseId } : {}),
        };
        this.tasks.set(id, record);
        change.jobs = record.job;
        if (agent) {
          if (!this.catalog.some((entry) => entry.id === id)) {
            this.catalog.push({
              id,
              createdAt: record.startedAt,
              mode: 'one-shot',
              label: record.label,
            });
            change.catalog = true;
          }
          if (toolUseId) {
            this.agentByToolUse.set(toolUseId, id);
            change.activity.push({
              kind: 'started',
              parentToolCallId: toolUseId,
              agentId: id,
              ...(str(message.subagent_type) ? { agentType: str(message.subagent_type) } : {}),
              description: record.label,
              ...(taskType ? { taskType } : {}),
            });
          }
        }
        return change;
      }
      case 'task_progress': {
        const record = id ? this.tasks.get(id) : undefined;
        if (!record) return change;
        const line = str(message.summary) ?? str(message.last_tool_name);
        if (line && line !== record.progress) {
          record.progress = line;
          change.jobs = record.job;
        }
        if (record.agent && record.toolUseId) {
          const usage = usageOf(message.usage);
          change.activity.push({
            kind: 'progress',
            parentToolCallId: record.toolUseId,
            agentId: record.id,
            ...(str(message.description) ? { description: str(message.description) } : {}),
            ...(str(message.last_tool_name) ? { lastToolName: str(message.last_tool_name) } : {}),
            ...(usage ? { usage } : {}),
          });
        }
        return change;
      }
      case 'task_notification': {
        const record = id ? this.tasks.get(id) : undefined;
        if (!record) return change;
        const status = message.status;
        record.status =
          status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'killed';
        record.finishedAt = this.now();
        record.progress = undefined;
        const summary = str(message.summary);
        if (summary) record.detail = summary;
        const outputFile = str(message.output_file);
        if (outputFile) record.outputFile = outputFile;
        change.jobs = record.job;
        if (record.agent && record.toolUseId) {
          const usage = usageOf(message.usage);
          const runStatus: SubagentRunStatus =
            status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped';
          change.activity.push({
            kind: 'status',
            parentToolCallId: record.toolUseId,
            agentId: record.id,
            status: runStatus,
            endedAt: record.finishedAt,
            ...(usage ? { usage } : {}),
          });
        }
        this.trim();
        return change;
      }
      case 'task_updated': {
        // Decision 203: a foreground subagent moved to the background (「转到后台」, the
        // CLI's Ctrl+B) is background work from then on: the jobs window lists it.
        const record = id ? this.tasks.get(id) : undefined;
        const patch = message.patch && typeof message.patch === 'object' ? message.patch : null;
        if (
          !record ||
          record.job ||
          (patch as { is_backgrounded?: unknown })?.is_backgrounded !== true
        ) {
          return change;
        }
        record.job = true;
        change.jobs = true;
        return change;
      }
      case 'background_tasks_changed': {
        // Replace semantics for the live set: a task listed here that we never saw start
        // (the host came up mid-run) still gets its row.
        const tasks = Array.isArray(message.tasks) ? message.tasks : [];
        for (const task of tasks) {
          if (!task || typeof task !== 'object') continue;
          const raw = task as Record<string, unknown>;
          const taskId = str(raw.task_id);
          if (!taskId || raw.ambient === true) continue;
          // Decision 203: one known as a foreground subagent is in the background now.
          const known = this.tasks.get(taskId);
          if (known) {
            if (!known.job && known.status === 'running') {
              known.job = true;
              change.jobs = true;
            }
            continue;
          }
          const agent =
            /agent/i.test(str(raw.task_type) ?? '') || typeof raw.subagent_type === 'string';
          this.tasks.set(taskId, {
            id: taskId,
            kind: jobKindOf(str(raw.task_type), agent),
            label: str(raw.description) ?? taskId,
            status: 'running',
            startedAt: this.now(),
            agent,
            job: true,
          });
          change.jobs = true;
        }
        return change;
      }
      default:
        return change;
    }
  }

  /**
   * One message of a subagent's own thread (`parent_tool_use_id` set): what it said and
   * which tools it called, for its lane. Nothing when the thread is not a known subagent's.
   */
  ingestSubagentMessage(message: Record<string, unknown>): SubagentActivityPayload[] {
    const parent = str(message.parent_tool_use_id);
    if (!parent) return [];
    const agentId = this.agentByToolUse.get(parent);
    const base = { parentToolCallId: parent, ...(agentId ? { agentId } : {}) };
    const inner = message.message as { content?: unknown } | undefined;
    const content = Array.isArray(inner?.content) ? inner.content : [];
    const out: SubagentActivityPayload[] = [];
    if (message.type === 'assistant') {
      const text = content
        .filter(
          (b): b is { type: string; text: string } =>
            b?.type === 'text' && typeof b.text === 'string'
        )
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text)
        out.push({
          ...base,
          kind: 'text',
          id: str(message.uuid) ?? `${parent}-${this.now()}`,
          text,
        });
      for (const block of content) {
        if (block?.type !== 'tool_use' || !str(block.id) || !str(block.name)) continue;
        const input = clampInput(block.input);
        out.push({
          ...base,
          kind: 'tool.started',
          toolCallId: block.id,
          name: block.name,
          ...(input ? { input } : {}),
        });
      }
    } else if (message.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result' || !str(block.tool_use_id)) continue;
        const ok = block.is_error !== true;
        const errorText =
          !ok && typeof block.content === 'string'
            ? block.content.slice(0, INPUT_FIELD_MAX)
            : undefined;
        out.push({
          ...base,
          kind: 'tool.completed',
          toolCallId: block.tool_use_id,
          ok,
          ...(errorText ? { errorText } : {}),
        });
      }
    }
    return out;
  }

  /** The `jobs` projection: running first in start order, then the newest settled. */
  jobs(): DshJobSummary[] {
    return [...this.tasks.values()]
      .filter((task) => task.job)
      .map((task) => ({
        id: task.id,
        kind: task.kind,
        label: task.label,
        status: task.status,
        startedAt: task.startedAt,
        ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
        ...(task.detail ? { detail: task.detail } : {}),
        ...(task.progress ? { progress: task.progress } : {}),
      }));
  }

  subagentCatalog(): DshSubagentCatalogEntry[] {
    return this.catalog.map((entry) => ({ ...entry }));
  }

  /** The file the CLI writes a task's output to, once it named it. */
  outputFile(id: string): string | undefined {
    return this.tasks.get(id)?.outputFile;
  }

  /** When the board first saw a task start. */
  startedAt(id: string): number | undefined {
    return this.tasks.get(id)?.startedAt;
  }

  /** The job kind of a task the board knows (`bash`, `subagent`, ...). */
  kindOf(id: string): string | undefined {
    return this.tasks.get(id)?.kind;
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  isRunning(id: string): boolean {
    const status = this.tasks.get(id)?.status;
    return status === 'running' || status === 'stopping';
  }

  /** A stop the user asked for: `stopping` until the CLI's notification settles it. */
  markStopping(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return false;
    task.status = 'stopping';
    return true;
  }

  /** The CLI process went away: what it ran is gone with it. */
  settleAll(): boolean {
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.status === 'running' || task.status === 'stopping') {
        task.status = 'killed';
        task.finishedAt = this.now();
        task.progress = undefined;
        changed = true;
      }
    }
    return changed;
  }

  private trim(): void {
    const settled = [...this.tasks.values()]
      .filter((task) => task.finishedAt !== undefined)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const task of settled.slice(KEEP_SETTLED)) this.tasks.delete(task.id);
  }
}
