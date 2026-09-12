/**
 * P5-2-4 — what a delegation leaves behind, and what the screen sees while it runs.
 *
 * Two separate jobs that are easy to confuse:
 *
 * - **Persistence.** Delegate messages, tool rows and the delegation's own
 *   start/settle facts are written to the session JSONL as attributed `custom`
 *   entries. `custom` is the whole point: `buildSessionContext` only turns
 *   `message` entries into model context, so a delegate's transcript is saved
 *   in full and reaches the parent's model **never**. The isolation is a
 *   property of the entry type, not of a filter someone has to remember to
 *   apply — which is the kind of rule that survives a refactor.
 * - **Live projection.** The same activity is published as `subagent.activity`
 *   runtime events, which is the channel the renderer's T-34 lane store already
 *   consumes. That channel is a bounded live SUMMARY; it is explicitly not the
 *   record. A capped event stream must never be the reason a terminal status,
 *   a usage number or a full report goes missing — those come off the records
 *   above.
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import type {
  SubagentActivityPayload,
  SubagentRunStatus as WireSubagentStatus,
} from '../../../shared/types/runtimeEvents.ts';
import type { SubagentHistorySummary } from '../../../shared/types/sessionHistory.ts';
import type { SubagentRunResult, SubagentRunStatus } from './run.ts';

/** `customType` of every delegation record. One type, discriminated by `kind`. */
export const SUBAGENT_ENTRY = 'aiclient.subagent';

export interface SubagentStartedRecord {
  kind: 'started';
  delegationId: string;
  agentName: string;
  parentToolCallId: string;
  runId: string;
  /** The brief the parent wrote. Kept whole: it is the delegate's only input. */
  task: string;
  label?: string;
  model: { provider: string; modelId: string };
  startedAt: number;
}

export interface SubagentMessageRecord {
  kind: 'message';
  delegationId: string;
  agentName: string;
  parentToolCallId: string;
  runId: string;
  /** The delegate's own message, verbatim. */
  message: unknown;
  at: number;
}

export interface SubagentSettledRecord {
  kind: 'settled';
  delegationId: string;
  agentName: string;
  parentToolCallId: string;
  runId: string;
  status: SubagentRunStatus;
  turns: number;
  toolCalls: number;
  /** Full report, not the live projection's clamped copy. */
  report: string;
  usage?: Usage;
  error?: { code: string; message: string };
  completedAt: number;
}

export type SubagentRecord = SubagentStartedRecord | SubagentMessageRecord | SubagentSettledRecord;

/** Narrow an arbitrary custom entry payload to a delegation record. */
export function asSubagentRecord(data: unknown): SubagentRecord | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const kind = (data as { kind?: unknown }).kind;
  if (kind !== 'started' && kind !== 'message' && kind !== 'settled') return undefined;
  const delegationId = (data as { delegationId?: unknown }).delegationId;
  return typeof delegationId === 'string' ? (data as SubagentRecord) : undefined;
}

/** One delegation, rebuilt from the session's records. */
export interface SubagentHistoryEntry {
  delegationId: string;
  agentName: string;
  parentToolCallId: string;
  runId: string;
  task: string;
  label?: string;
  model?: { provider: string; modelId: string };
  startedAt: number;
  /**
   * `interrupted` when the session holds a start with no settlement.
   *
   * That is what a hard exit leaves behind, and saying so is the whole point:
   * the delegate is NOT still running, its process is gone. The alternative —
   * showing it as `running` forever, or quietly dropping it — is how a reopened
   * session pretends work is still in flight.
   */
  status: SubagentRunStatus | 'interrupted';
  completedAt?: number;
  turns?: number;
  toolCalls?: number;
  report?: string;
  usage?: Usage;
  error?: { code: string; message: string };
  /** The delegate's own messages, in order, for an on-demand history read. */
  messages: unknown[];
}

/**
 * Rebuild every delegation this session recorded.
 *
 * Deliberately a pure fold over entries the caller already has: reopening a
 * session must not start anything, re-run anything, or replay a `Task` call.
 * It reports facts.
 */
export function readSubagentHistory(
  entries: readonly { type: string; customType?: string; data?: unknown }[]
): SubagentHistoryEntry[] {
  const byId = new Map<string, SubagentHistoryEntry>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== SUBAGENT_ENTRY) continue;
    const record = asSubagentRecord(entry.data);
    if (!record) continue;
    if (record.kind === 'started') {
      byId.set(record.delegationId, {
        delegationId: record.delegationId,
        agentName: record.agentName,
        parentToolCallId: record.parentToolCallId,
        runId: record.runId,
        task: record.task,
        ...(record.label ? { label: record.label } : {}),
        model: record.model,
        startedAt: record.startedAt,
        status: 'interrupted',
        messages: [],
      });
      continue;
    }
    const existing = byId.get(record.delegationId);
    if (!existing) continue;
    if (record.kind === 'message') {
      existing.messages.push(record.message);
      continue;
    }
    existing.status = record.status;
    existing.completedAt = record.completedAt;
    existing.turns = record.turns;
    existing.toolCalls = record.toolCalls;
    existing.report = record.report;
    if (record.usage) existing.usage = record.usage;
    if (record.error) existing.error = record.error;
  }
  return [...byId.values()].sort((left, right) => left.startedAt - right.startedAt);
}

/** Report text carried on a history summary. The full one stays on disk. */
const MAX_HISTORY_REPORT_CHARS = 4_000;

/**
 * The delegation summaries a reopened session needs, off its own entries.
 *
 * Pure and read-only, like {@link readSubagentHistory} it builds on: reopening
 * a session must not start anything, resume anything, or replay a `Task` call.
 * It reports what the file says happened.
 */
export function subagentHistorySummaries(
  entries: readonly { type: string; customType?: string; data?: unknown }[]
): SubagentHistorySummary[] {
  return readSubagentHistory(entries).map((entry) => ({
    delegationId: entry.delegationId,
    parentToolCallId: entry.parentToolCallId,
    agentName: entry.agentName,
    ...(entry.label ? { label: entry.label } : {}),
    status: entry.status,
    startedAt: entry.startedAt,
    ...(entry.completedAt !== undefined ? { completedAt: entry.completedAt } : {}),
    ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
    ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
    ...(entry.usage ? { totalTokens: entry.usage.totalTokens } : {}),
    ...(entry.report
      ? {
          report:
            entry.report.length > MAX_HISTORY_REPORT_CHARS
              ? `${entry.report.slice(0, MAX_HISTORY_REPORT_CHARS)}…`
              : entry.report,
        }
      : {}),
    ...(entry.model ? { model: `${entry.model.provider}/${entry.model.modelId}` } : {}),
  }));
}

/**
 * What this session's delegates cost, summed from settled records only.
 *
 * Separate from the parent's `usage` on purpose: the parent's number is what
 * its provider reported for its own requests, and its context occupancy is
 * derived from it. A session or turn TOTAL is the sum of the two, and that
 * addition belongs to whoever is displaying a total — not to either number.
 */
export function subagentHistoryUsage(history: readonly SubagentHistoryEntry[]): Usage | undefined {
  let total: Usage | undefined;
  for (const entry of history) {
    if (!entry.usage) continue;
    if (!total) {
      total = { ...entry.usage, cost: { ...entry.usage.cost } };
      continue;
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const)
      total[key] += entry.usage[key];
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const)
      total.cost[key] += entry.usage.cost[key];
  }
  return total;
}

/**
 * Our lifecycle status in the wire vocabulary.
 *
 * `aborted` is the one that needs translating: on the wire it is `cancelled`,
 * which is what the renderer's lane store has always called an externally
 * ended run. `stopped` and `truncated` pass through unchanged now that P5-2-4
 * widened the wire type — the whole reason for widening it was that mapping
 * them onto `failed` would have thrown away the distinction a reader needs.
 */
export function wireStatus(status: SubagentRunStatus): WireSubagentStatus {
  switch (status) {
    case 'aborted':
      return 'cancelled';
    case 'timed_out':
      return 'failed';
    default:
      return status;
  }
}

/**
 * Fields of a delegate's tool call the panel may show, by tool.
 *
 * A whitelist, and the negatives are the point: `content` (write), `oldString`/
 * `newString` (edit) and every output body stay off this channel entirely. A
 * delegate writing a file must not push the file through the event stream, and
 * the panel only ever needs enough to say WHICH file.
 *
 * Spelled in OUR tool vocabulary (`path`, `command`, `pattern`), not the
 * reference CLI's (`file_path`): the names here have to match what our own
 * tools actually take, or the whitelist silently matches nothing.
 */
const TOOL_INPUT_FIELDS: Record<string, readonly string[]> = {
  read: ['path', 'offset', 'limit'],
  write: ['path'],
  edit: ['path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path', 'regex'],
  bash: ['command', 'timeoutSeconds'],
  browser_preview: ['path', 'focus'],
};

/** Per-field clamp. One long argument must not become the whole budget. */
const MAX_TOOL_INPUT_FIELD_CHARS = 240;
/** Per-message clamp for a delegate's prose or reasoning. */
const MAX_ACTIVITY_TEXT_CHARS = 4_000;

function clampActivityText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function projectToolInput(
  toolName: string,
  input: unknown
): Record<string, string | number> | undefined {
  const allowed = TOOL_INPUT_FIELDS[toolName];
  if (!allowed || typeof input !== 'object' || input === null) return undefined;
  const source = input as Record<string, unknown>;
  const projected: Record<string, string | number> = {};
  for (const field of allowed) {
    const value = source[field];
    if (typeof value === 'number') projected[field] = value;
    else if (typeof value === 'boolean') projected[field] = String(value);
    else if (typeof value === 'string' && value)
      projected[field] = clampActivityText(value, MAX_TOOL_INPUT_FIELD_CHARS);
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/** Concatenate one kind of block out of an assistant message's content. */
function blockText(content: readonly unknown[], kind: 'text' | 'thinking'): string {
  return content
    .map((block) => {
      const candidate = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (candidate.type !== kind) return '';
      const value = kind === 'text' ? candidate.text : candidate.thinking;
      return typeof value === 'string' ? value : '';
    })
    .join('');
}

/**
 * Turn one delegate event into live-projection payloads.
 *
 * Returns an empty array for events the lane store has no slot for, and for
 * empty bodies — an empty text block is a render artifact, not activity.
 *
 * A message can produce TWO payloads, reasoning and prose, which is why this
 * returns a list. P5-2-6 found reasoning missing entirely: the lane has always
 * had a `thinking` row and nothing on the native side ever filled it, so a
 * delegate that spent a minute thinking showed a panel with nothing in it.
 */
export function activityForEvent(
  event: AgentEvent,
  base: { parentToolCallId: string; agentId: string }
): SubagentActivityPayload[] {
  switch (event.type) {
    case 'message_end': {
      const message = event.message as { role?: string; content?: unknown };
      if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
      // Whole-message granularity, as the channel's contract states: no char
      // stream, so `message_update` contributes nothing here.
      const id = `${base.agentId}:${Date.now()}`;
      const payloads: SubagentActivityPayload[] = [];
      const thinking = blockText(message.content, 'thinking');
      if (thinking.trim()) {
        payloads.push({
          ...base,
          kind: 'thinking',
          id: `${id}:thinking`,
          text: clampActivityText(thinking, MAX_ACTIVITY_TEXT_CHARS),
        });
      }
      const text = blockText(message.content, 'text');
      if (text.trim()) {
        payloads.push({
          ...base,
          kind: 'text',
          id,
          text: clampActivityText(text, MAX_ACTIVITY_TEXT_CHARS),
        });
      }
      return payloads;
    }
    case 'tool_execution_start': {
      const input = projectToolInput(event.toolName, event.args);
      return [
        {
          ...base,
          kind: 'tool.started',
          toolCallId: event.toolCallId,
          name: event.toolName,
          ...(input ? { input } : {}),
        },
      ];
    }
    case 'tool_execution_end':
      return [
        {
          ...base,
          kind: 'tool.completed',
          toolCallId: event.toolCallId,
          ok: event.isError !== true,
          // Only a failure carries text, and only the reason. Tool OUTPUT bodies
          // never travel this channel — that is what the record is for.
          ...(event.isError === true ? { errorText: 'the tool call failed' } : {}),
        },
      ];
    default:
      return [];
  }
}

/** The terminal pair a settled delegation publishes: status, then report. */
export function activityForSettlement(
  result: SubagentRunResult,
  base: { parentToolCallId: string; agentId: string },
  timing: { completedAt: number; durationMs: number },
  model: string
): SubagentActivityPayload[] {
  const status = wireStatus(result.status);
  return [
    {
      ...base,
      kind: 'status',
      status,
      endedAt: timing.completedAt,
      usage: {
        ...(result.usage ? { totalTokens: result.usage.totalTokens } : {}),
        toolUses: result.toolCalls,
        durationMs: timing.durationMs,
      },
    },
    {
      ...base,
      kind: 'report',
      report: {
        status,
        agentType: result.agentName,
        resolvedModel: model,
        totalDurationMs: timing.durationMs,
        ...(result.usage ? { totalTokens: result.usage.totalTokens } : {}),
        totalToolUseCount: result.toolCalls,
      },
    },
  ];
}
