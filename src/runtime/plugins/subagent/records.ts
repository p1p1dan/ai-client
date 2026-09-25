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
 *
 *   subagent-core-06 — "bounded" means bounded in BOTH directions now. This
 *   module clamps each payload's size ({@link MAX_TOOL_INPUT_FIELD_CHARS},
 *   {@link MAX_ACTIVITY_TEXT_CHARS}); the per-delegation event COUNT is capped
 *   by `SubagentPlugin` ({@link MAX_ACTIVITY_EVENTS_PER_DELEGATION}), which
 *   emits one `kind: 'capped'` and then goes quiet. Until it did, the word here
 *   described an intention rather than the code.
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import type {
  SubagentActivityPayload,
  SubagentRunStatus as WireSubagentStatus,
} from '../../../shared/types/runtimeEvents.ts';
import type { SubagentHistorySummary } from '../../../shared/types/sessionHistory.ts';
import { base64Bytes } from '../agent-loop/attachments.ts';
import { addUsage, type SubagentRunResult, type SubagentRunStatus } from './run.ts';

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

/** Error code a restored delegation carries when its process died before it settled. */
export const DELEGATION_INTERRUPTED = 'delegation_interrupted';

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : '';
    })
    .join('\n');
}

function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    const id = (item as { delegationId?: unknown } | null)?.delegationId;
    return typeof id === 'string' ? [id] : [];
  });
}

/**
 * Which delegations the conversation on disk shows the parent model received.
 *
 * Read off the messages rather than off a marker of our own, for two reasons:
 * sessions written before this existed have no marker to read, and a marker
 * written when the runtime DECIDED to deliver could claim a delivery whose
 * message never reached the file. The deliveries all leave a trace the model
 * actually saw:
 *
 * - a `TaskWait` result names every target with its status (`running` ones
 *   were a heartbeat, not a report);
 * - a `TaskStop` result lists what it delivered (`delivered`), or — before
 *   that field existed — what it stopped and what it found finished;
 * - the auto-resume message and the turn-ceiling wrap-up carry each report
 *   under a `## agent (id) — status` heading, which a heartbeat line
 *   (`agent (id), running, …`) never matches.
 */
export function deliveredDelegationIds(
  entries: readonly { type: string; message?: unknown }[]
): (delegationId: string) => boolean {
  const delivered = new Set<string>();
  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = entry.message as {
      role?: unknown;
      toolName?: unknown;
      details?: unknown;
      content?: unknown;
    };
    if (message?.role === 'user') {
      prompts.push(messageText(message.content));
      continue;
    }
    if (message?.role !== 'toolResult') continue;
    const details = (message.details ?? {}) as Record<string, unknown>;
    if (message.toolName === 'TaskWait') {
      for (const item of Array.isArray(details.delegations) ? details.delegations : []) {
        const { delegationId, status } = (item ?? {}) as {
          delegationId?: unknown;
          status?: unknown;
        };
        if (typeof delegationId === 'string' && status !== 'running') delivered.add(delegationId);
      }
    } else if (message.toolName === 'TaskStop') {
      const named = Array.isArray(details.delivered)
        ? idsOf(details.delivered)
        : [...idsOf(details.stopped), ...idsOf(details.alreadyFinished)];
      for (const id of named) delivered.add(id);
    }
  }
  return (delegationId) =>
    delivered.has(delegationId) || prompts.some((text) => text.includes(`(${delegationId}) — `));
}

/**
 * The registry records a reopened session starts with.
 *
 * Every one is settled. A delegation with a start and no settlement is what a
 * worker that died mid-run leaves behind; it is restored as ended (`aborted`,
 * error {@link DELEGATION_INTERRUPTED}) and counted as delivered, because there
 * is no report to hand over and "still running" would be a lie the auto-resume
 * pass would then wait on. Its report says what happened, for a `TaskWait` or
 * `TaskList` that asks.
 */
export function restorableDelegations(
  entries: readonly { type: string; customType?: string; data?: unknown; message?: unknown }[]
): {
  delegationId: string;
  agentName: string;
  label?: string;
  status: SubagentRunStatus;
  startedAt: number;
  completedAt: number;
  result: SubagentRunResult;
  deliveredAt?: number;
  turns: number;
  toolCalls: number;
  lastActivityAt: number;
}[] {
  const wasDelivered = deliveredDelegationIds(entries);
  return readSubagentHistory(entries).map((entry) => {
    const interrupted = entry.status === 'interrupted';
    const status: SubagentRunStatus = interrupted ? 'aborted' : (entry.status as SubagentRunStatus);
    const completedAt = entry.completedAt ?? entry.startedAt;
    const turns = entry.turns ?? 0;
    const toolCalls = entry.toolCalls ?? 0;
    const error = interrupted
      ? {
          code: DELEGATION_INTERRUPTED,
          message: 'the app or its worker stopped before this subagent finished',
        }
      : entry.error;
    const report = interrupted
      ? `The ${entry.agentName} subagent was interrupted: the app or its worker stopped before it finished, and it left no report.`
      : (entry.report ?? `(${status} without a report)`);
    // A start failure was answered as the `Task` call's own result, which is
    // why the live path marks it delivered at once.
    const delivered =
      interrupted ||
      entry.error?.code === 'delegation_start_failed' ||
      wasDelivered(entry.delegationId);
    return {
      delegationId: entry.delegationId,
      agentName: entry.agentName,
      ...(entry.label ? { label: entry.label } : {}),
      status,
      startedAt: entry.startedAt,
      completedAt,
      result: {
        agentName: entry.agentName,
        status,
        report,
        turns,
        toolCalls,
        ...(entry.usage ? { usage: entry.usage } : {}),
        ...(error ? { error } : {}),
      },
      ...(delivered ? { deliveredAt: completedAt } : {}),
      turns,
      toolCalls,
      lastActivityAt: completedAt,
    };
  });
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
    // subagent-data-17 — the fourth clamp, and the one that used to be written
    // out inline: same helper as the other three so a report cut at 4k cannot
    // end in half an emoji.
    ...(entry.report ? { report: clampSubagentText(entry.report, MAX_HISTORY_REPORT_CHARS) } : {}),
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
export function subagentHistoryUsage(history: readonly SubagentHistoryEntry[]): {
  usage: Usage | undefined;
  delegations: number;
} {
  let usage: Usage | undefined;
  let delegations = 0;
  for (const entry of history) {
    if (!entry.usage) continue;
    delegations += 1;
    // subagent-data-12 — `addUsage` rather than a second summation written out
    // here. The local copy summed only the five required token fields and the
    // five costs, so `reasoning` and `cacheWrite1h` came out of a multi-entry
    // fold as the FIRST delegate's value (it seeded the total with a shallow
    // copy) rather than as a sum or a zero. One adder, one answer.
    usage = addUsage(usage, entry.usage);
  }
  return { usage, delegations };
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
export const MAX_TOOL_INPUT_FIELD_CHARS = 240;
/** Per-message clamp for a delegate's prose or reasoning. */
export const MAX_ACTIVITY_TEXT_CHARS = 4_000;

/** Appended in place of what was cut, never in addition to the budget. */
const TRUNCATION_MARKER = '…';

/**
 * Cut a string to `maxChars` without splitting a character in half.
 *
 * subagent-data-17 — this is the legacy host's `clampSubagentText` brought back
 * (it was lost when the projection was rewritten native-side, along with the
 * module it lived in). Two properties the bare `slice(0, max)` it replaces did
 * not have:
 *
 * - **Surrogate-safe.** Slicing by UTF-16 code unit can land BETWEEN the halves
 *   of an astral character — an emoji, many CJK extension glyphs — leaving a
 *   lone high surrogate. Structured clone carries that orphan through to the
 *   renderer unchanged, and the browser draws it as a replacement box, so the
 *   user sees garbage our truncation invented and blames the model. Backing off
 *   one unit costs at most one character.
 * - **Never longer than the budget.** The marker replaces the last character
 *   rather than extending past the limit, so `clamp(x, n).length <= n` holds. A
 *   clamp that can return `max + 1` is not a bound anything downstream can size
 *   a buffer from.
 */
export function clampSubagentText(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  let cut = maxChars - TRUNCATION_MARKER.length;
  if (cut > 0) {
    const lastKept = value.charCodeAt(cut - 1);
    // High surrogate at the boundary: its low half is on the other side of the
    // cut, so drop the orphan rather than emit half a character.
    if (lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1;
  }
  return value.slice(0, Math.max(0, cut)) + TRUNCATION_MARKER;
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
      projected[field] = clampSubagentText(value, MAX_TOOL_INPUT_FIELD_CHARS);
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
 * Longest string kept inside a persisted delegate message.
 *
 * subagent-data-05 — a delegate's transcript is written to the parent's session
 * JSONL verbatim, tool results included, and those results are only bounded by
 * the tools layer's own 50 KiB per call. That shares one 32 MiB session budget
 * with the parent's messages, and crossing it does not degrade: `appendMessage`
 * throws `session_size_limit` and the conversation becomes a read-only artifact
 * the user cannot send another message to. 8 KiB is enough to recognise what a
 * call returned, which is what a transcript read is for; the full result was
 * never model context on either side of the cut.
 */
export const MAX_RECORDED_TEXT_CHARS = 8_000;

/**
 * How deep the clamp walks a message before it stops copying.
 *
 * Bounded because the value comes from a provider and a tool's arguments can
 * nest arbitrarily; past this the sub-tree is dropped rather than copied, which
 * keeps one pathological message from costing the recursion.
 */
const MAX_RECORDED_DEPTH = 8;

/**
 * A delegate message as it should be WRITTEN, not as it arrived.
 *
 * Clamps every string in the message — prose, reasoning, tool results and the
 * arguments of a `write`/`edit` call alike — to {@link MAX_RECORDED_TEXT_CHARS}.
 * One walker rather than a per-block whitelist because the failure being
 * prevented is about bytes, and a whitelist that missed a new block type would
 * fail open in exactly the case that matters.
 *
 * An image block becomes a text placeholder naming its type and size. Cutting
 * its base64 at the string limit would write a corrupt image into the parent's
 * session, and a whole one is up to megabytes of a budget the parent shares.
 *
 * The delegate's REPORT is not affected: it is carried whole on the `settled`
 * record, which is deliberately the copy a reader is promised.
 */
export function clampRecordedMessage(message: unknown): unknown {
  return clampDeep(message, 0);
}

function clampDeep(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return clampSubagentText(value, MAX_RECORDED_TEXT_CHARS);
  if (Array.isArray(value)) {
    if (depth >= MAX_RECORDED_DEPTH) return [];
    return value.map((item) => clampDeep(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= MAX_RECORDED_DEPTH) return {};
    const image = value as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (image.type === 'image' && typeof image.data === 'string')
      return {
        type: 'text',
        text: `[image omitted: ${
          typeof image.mimeType === 'string' ? clampSubagentText(image.mimeType, 64) : 'image'
        }, ${base64Bytes(image.data)} bytes]`,
      };
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = clampDeep(item, depth + 1);
    return out;
  }
  return value;
}

/**
 * Monotonic suffix for activity ids, unique for the life of the process.
 *
 * Deliberately not `randomUUID()`: an id that sorts in emission order is worth
 * having when a transcript is being read back by a person, and the collision
 * this exists to stop needs nothing stronger than "never the same twice".
 */
let activitySequence = 0;
function nextActivitySequence(): number {
  activitySequence += 1;
  return activitySequence;
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
      //
      // subagent-data-11 — the id carries a monotonic sequence, not just a
      // millisecond clock. The renderer's lane reducer is idempotent by
      // `(kind, id)` and DROPS a repeat, so two messages minted inside the same
      // millisecond made the second one — which can be the delegate's final
      // report — disappear from the panel with nothing to show it happened. A
      // counter cannot collide; a clock can.
      const id = `${base.agentId}:${Date.now()}:${nextActivitySequence()}`;
      const payloads: SubagentActivityPayload[] = [];
      const thinking = blockText(message.content, 'thinking');
      if (thinking.trim()) {
        payloads.push({
          ...base,
          kind: 'thinking',
          id: `${id}:thinking`,
          text: clampSubagentText(thinking, MAX_ACTIVITY_TEXT_CHARS),
        });
      }
      const text = blockText(message.content, 'text');
      if (text.trim()) {
        payloads.push({
          ...base,
          kind: 'text',
          id,
          text: clampSubagentText(text, MAX_ACTIVITY_TEXT_CHARS),
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
