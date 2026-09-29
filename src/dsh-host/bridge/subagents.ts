/**
 * The session's subagents on the timeline (dsh-rebase P1-7b; decisions 069,
 * 072 rules 6-7, 119; plan P1-7 shard 03 §5).
 *
 * DSH's delegation tools (`subagent`, `subagent_fork`) run each child in a
 * session of its own. This module follows the direct children of one session
 * and projects what they do into 1.0.x's `subagent.activity`, which the
 * renderer draws as a lane under the delegating tool row:
 *
 *   `subagent/catalog` (parent log)   the child and its label: which call it is
 *   `subagent/start` / `subagent/end` a run of the child begins / ends: its
 *                                     status (a second run of a continuable
 *                                     child is `resumed`, in the same lane)
 *   child `assistant/message`         `text` / `thinking` rows, token usage
 *   child `tool/call` / `tool/result` `tool.started` / `tool.completed` rows
 *
 * Which call a child belongs to (decision 072 rule 6, experiment E2): DSH's
 * lifecycle events name no parent call. While a delegation call of the
 * session's own agent is inside `tools/execute`, the catalog entry its child
 * gets carries the call's `description` as its label; the first waiting call
 * with that description takes it. The call's own result, when it arrives,
 * confirms or corrects that: `{kind: 'continuable', subagentId}` names the
 * child, `{kind: 'foreground', runId}` names the run `subagent/start`
 * reported. A one-shot child started in the background (`{kind:
 * 'background', jobId}`) is established after its call returned, so its call
 * waits for the next catalog entry with its description. Activity a child
 * produces before it is paired is held (bounded) and sent once it is.
 *
 * Decision 069 rule 1: a Stop interrupts every running continuable child's
 * current run (`interruptAll`); the child keeps its session and can go on.
 *
 * No value imports from DSH: the runtime hands the services in.
 */

import { PiWorkerSessionError } from '../../agent-host/piWorkerErrors.ts';
import type {
  SubagentActivityPayload,
  SubagentRunStatus,
} from '../../shared/types/runtimeEvents.ts';
import type { WorkerSubagentInterruptResult } from '../../shared/types/workerRpc.ts';
import { WORKER_JOBS_UNAVAILABLE } from '../../shared/types/workerRpc.ts';

// ---- the slice of dsh-subagent read here ----------------------------------------------

/** `SubagentRunInfo` / `SubagentRunEndInfo` of `@deepseek-ai/dsh-subagent`, narrowed. */
export interface DshSubagentRunInfo {
  readonly runId: string;
  readonly id: string;
  readonly stopReason?: string;
  readonly lastAssistantMessage?: readonly unknown[];
}

/** `ctx.subagents` (dsh-subagent), narrowed to the human parent's interrupt. */
export interface DshSubagentsView {
  interrupt(
    targetSessionId: string,
    authority: { readonly kind: 'user'; readonly parentSessionId: string }
  ): void;
}

/** A durable event of a child session, as `session/event` delivers it. */
export interface DshChildEvent {
  readonly type: string;
  readonly seq: number;
  readonly time?: number;
  readonly data?: Record<string, unknown>;
}

/** The delegation tools whose rows carry a lane (DSH's own; decision 090: no custom ones). */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork']);

/** Activity held for a child not paired yet; past it the oldest goes. */
export const UNPAIRED_ACTIVITY_MAX = 200;
/** Per-field clamp of a child tool's input (1.0.x's `MAX_TOOL_INPUT_FIELD_CHARS`). */
export const SUBAGENT_INPUT_FIELD_CHARS = 240;
/** Per-message clamp of a child's prose or reasoning (1.0.x's `MAX_ACTIVITY_TEXT_CHARS`). */
export const SUBAGENT_TEXT_CHARS = 4_000;
/** A failed child tool's reason, clamped. */
export const SUBAGENT_ERROR_CHARS = 400;

/** DSH's stop reasons in the lane's vocabulary (plan P1-7 shard 03 §5.1). */
export function laneStatusOf(stopReason: string | undefined): SubagentRunStatus {
  switch (stopReason) {
    case 'completed':
      return 'completed';
    case 'aborted':
      return 'stopped';
    case 'max-tokens':
      return 'truncated';
    default:
      // `error`, `refusal`, and a reason a newer DSH adds: it did not finish well.
      return 'failed';
  }
}

/**
 * The fields of a child's tool call its lane shows, per DSH tool (the names
 * DSH's tools take), each clamped; `path` mirrors `file_path` because the
 * timeline's rows read `path` (`toolRowInput`).
 */
const INPUT_FIELDS: Record<string, readonly string[]> = {
  read: ['file_path', 'offset', 'limit'],
  read_image: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  glob: ['pattern', 'path'],
  grep: ['pattern', 'path', 'include'],
  bash: ['command', 'timeoutMs'],
  pwsh: ['command', 'timeoutMs'],
  job_output: ['job_id'],
  job_kill: ['job_id'],
  skill: ['name'],
};

const TRUNCATION_MARKER = '…';

/** Cut to `max` characters without splitting a surrogate pair; never longer than `max`. */
export function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = max - TRUNCATION_MARKER.length;
  const last = value.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return value.slice(0, Math.max(0, cut)) + TRUNCATION_MARKER;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string') return recordOf(raw);
  try {
    return recordOf(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function childToolInput(
  name: string,
  raw: unknown
): Record<string, string | number> | undefined {
  const fields = INPUT_FIELDS[name];
  const args = parseArgs(raw);
  if (!fields || !args) return undefined;
  const input: Record<string, string | number> = {};
  for (const field of fields) {
    const value = args[field];
    if (typeof value === 'number' && Number.isFinite(value)) input[field] = value;
    else if (typeof value === 'boolean') input[field] = String(value);
    else if (typeof value === 'string' && value) {
      input[field] = clampText(value, SUBAGENT_INPUT_FIELD_CHARS);
    }
  }
  if (typeof input.file_path === 'string' && input.path === undefined) input.path = input.file_path;
  return Object.keys(input).length > 0 ? input : undefined;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = recordOf(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('');
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** One step's tokens, as dsh-llm's `TokenUsage` reports them. */
function stepTokens(usage: unknown): number {
  const record = recordOf(usage);
  if (!record) return 0;
  const total = numberOf(record.totalTokens);
  if (total > 0) return total;
  return (
    numberOf(record.inputTokens) +
    numberOf(record.outputTokens) +
    numberOf(record.cacheReadTokens) +
    numberOf(record.cacheWriteTokens)
  );
}

// ---- the tracker -----------------------------------------------------------------------

/** What the runtime gives the tracker. */
export interface DshSubagentsHost {
  /** The parent: the session's current DSH session id. A rewind changes it. */
  owner(): string;
  subagents(): DshSubagentsView | undefined;
  /** One lane event; the runtime sends it as `subagent.activity`. */
  emitActivity(payload: SubagentActivityPayload): void;
  log?(...args: unknown[]): void;
  now(): number;
}

/** A delegation call of the session's agent waiting for its child. */
interface Delegation {
  readonly callId: string;
  readonly toolName: string;
  readonly description: string;
  /** Out of `tools/execute` with a background job: waits only for its catalog entry. */
  background: boolean;
  childId?: string;
}

interface Child {
  readonly id: string;
  label?: string;
  mode?: string;
  parentToolCallId?: string;
  toolName?: string;
  /** Activity from before the pairing, sent once paired. */
  held: SubagentActivityPayload[];
  /** A run is going on (between `subagent/start` and `subagent/end`). */
  running: boolean;
  /** Runs that ended; the next start is a resumption. */
  ended: number;
  announced: boolean;
  tokens: number;
  toolUses: number;
}

export class DshSubagentsTracker {
  private readonly host: DshSubagentsHost;
  private readonly delegations: Delegation[] = [];
  private readonly children = new Map<string, Child>();
  /** `subagent/start`'s run -> the child, for a foreground call's result. */
  private readonly runs = new Map<string, string>();
  /** Starts of children whose catalog entry has not arrived yet. */
  private readonly earlyStarts = new Map<string, DshSubagentRunInfo>();

  constructor(host: DshSubagentsHost) {
    this.host = host;
  }

  /** A rewind or a dispose: the children belonged to the session left behind. */
  reset(): void {
    this.delegations.length = 0;
    this.children.clear();
    this.runs.clear();
    this.earlyStarts.clear();
  }

  /** A run of a child is going on: the session is busy (Main must not reclaim it). */
  hasRunning(): boolean {
    for (const child of this.children.values()) if (child.running) return true;
    return false;
  }

  /** Children with a run going on, continuable ones only when asked. */
  running(continuableOnly = false): string[] {
    return [...this.children.values()]
      .filter((child) => child.running && (!continuableOnly || child.mode !== 'one-shot'))
      .map((child) => child.id);
  }

  // ---- the delegation call window (`tools/execute`) ------------------------------------------

  beginCall(callId: string, name: string, args: unknown): void {
    if (!DELEGATION_TOOLS.has(name)) return;
    const description = recordOf(args)?.description;
    this.delegations.push({
      callId,
      toolName: name,
      description: typeof description === 'string' ? description : '',
      background: false,
    });
  }

  /** The call's execution-local result: it names its child, or its run, or its job. */
  endCall(callId: string, value: unknown): void {
    const index = this.delegations.findIndex((entry) => entry.callId === callId);
    if (index < 0) return;
    const delegation = this.delegations[index] as Delegation;
    const result = recordOf(value);
    const childId =
      result?.kind === 'continuable' && typeof result.subagentId === 'string'
        ? result.subagentId
        : result?.kind === 'foreground' && typeof result.runId === 'string'
          ? this.runs.get(result.runId)
          : undefined;
    if (childId) this.pair(childId, delegation);
    if (result?.kind === 'background' && !delegation.childId) {
      delegation.background = true;
      return;
    }
    this.delegations.splice(index, 1);
  }

  // ---- the parent's log --------------------------------------------------------------------

  /** A durable event of the session itself: its catalog entries name its children. */
  onParentEvent(event: DshChildEvent): void {
    if (event.type !== 'subagent/catalog') return;
    const data = event.data ?? {};
    const childId = data.childId;
    if (typeof childId !== 'string') return;
    const child = this.childOf(childId);
    child.label = typeof data.label === 'string' ? data.label : child.label;
    child.mode = typeof data.mode === 'string' ? data.mode : child.mode;
    if (!child.parentToolCallId) {
      const delegation = this.delegations.find(
        (entry) => !entry.childId && entry.description === (child.label ?? '')
      );
      if (delegation) this.pair(childId, delegation);
    }
    const early = this.earlyStarts.get(childId);
    if (early) {
      this.earlyStarts.delete(childId);
      this.onRunStart(early);
    }
  }

  private childOf(id: string): Child {
    let child = this.children.get(id);
    if (!child) {
      child = { id, held: [], running: false, ended: 0, announced: false, tokens: 0, toolUses: 0 };
      this.children.set(id, child);
    }
    return child;
  }

  private pair(childId: string, delegation: Delegation): void {
    const child = this.childOf(childId);
    if (child.parentToolCallId === delegation.callId) {
      delegation.childId = childId;
      return;
    }
    // A result correcting a label pairing: the call it had taken is free again.
    for (const other of this.delegations) {
      if (other !== delegation && other.childId === childId) other.childId = undefined;
    }
    delegation.childId = childId;
    // A moved child is introduced again on its right lane (E2: a label guess
    // the call's own result corrected).
    if (child.parentToolCallId !== undefined) child.announced = false;
    child.parentToolCallId = delegation.callId;
    child.toolName = delegation.toolName;
    child.label ??= delegation.description;
    if (delegation.background) {
      this.delegations.splice(this.delegations.indexOf(delegation), 1);
    }
    this.announce(child);
    const held = child.held.splice(0);
    for (const payload of held) this.send(child, payload);
  }

  /** The lane's first event: who the child is. */
  private announce(child: Child): void {
    if (child.announced || !child.parentToolCallId) return;
    child.announced = true;
    this.host.emitActivity({
      parentToolCallId: child.parentToolCallId,
      agentId: child.id,
      kind: 'started',
      ...(child.label ? { description: child.label } : {}),
      ...(child.toolName ? { taskType: child.toolName } : {}),
    });
  }

  /** Sent now when paired, else held (the oldest dropped past the bound). */
  private send(child: Child, payload: SubagentActivityPayload): void {
    if (!child.parentToolCallId) {
      child.held.push(payload);
      if (child.held.length > UNPAIRED_ACTIVITY_MAX) child.held.shift();
      return;
    }
    this.host.emitActivity({
      ...payload,
      parentToolCallId: child.parentToolCallId,
    } as SubagentActivityPayload);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** `subagent/start`: a run of one of this session's children began (or resumed). */
  onRunStart(info: DshSubagentRunInfo): void {
    if (typeof info?.id !== 'string') return;
    const child = this.children.get(info.id);
    if (!child) {
      // Another session's child, or one whose catalog entry is still coming.
      this.earlyStarts.set(info.id, info);
      if (this.earlyStarts.size > 64) {
        const oldest = this.earlyStarts.keys().next().value;
        if (oldest !== undefined) this.earlyStarts.delete(oldest);
      }
      return;
    }
    if (typeof info.runId === 'string') this.runs.set(info.runId, info.id);
    if (child.running) return;
    child.running = true;
    const resumed = child.ended > 0;
    child.tokens = 0;
    child.toolUses = 0;
    this.send(
      child,
      resumed
        ? { parentToolCallId: '', agentId: child.id, kind: 'resumed', at: this.host.now() }
        : { parentToolCallId: '', agentId: child.id, kind: 'status', status: 'running' }
    );
  }

  /** `subagent/end`: the run ended; its stop reason is the lane's status. */
  onRunEnd(info: DshSubagentRunInfo): void {
    if (typeof info?.id !== 'string') return;
    this.earlyStarts.delete(info.id);
    const child = this.children.get(info.id);
    if (!child) return;
    child.running = false;
    child.ended += 1;
    const status = laneStatusOf(info.stopReason);
    const usage = { totalTokens: child.tokens, toolUses: child.toolUses };
    this.send(child, {
      parentToolCallId: '',
      agentId: child.id,
      kind: 'status',
      status,
      endedAt: this.host.now(),
      usage,
    });
    this.send(child, {
      parentToolCallId: '',
      agentId: child.id,
      kind: 'report',
      report: {
        status,
        totalTokens: child.tokens,
        totalToolUseCount: child.toolUses,
        ...(typeof info.stopReason === 'string' ? { stopReason: info.stopReason } : {}),
      },
    });
  }

  // ---- a child's own log ---------------------------------------------------------------------

  /** A durable event of some session; a child of this one's becomes lane rows. */
  onChildEvent(sessionId: string, event: DshChildEvent): void {
    const child = this.children.get(sessionId);
    if (!child) return;
    const data = event.data ?? {};
    switch (event.type) {
      case 'assistant/message':
        this.onChildMessage(child, event, data);
        return;
      case 'tool/call': {
        const callId = data.callId;
        const name = data.name;
        if (typeof callId !== 'string' || typeof name !== 'string') return;
        child.toolUses += 1;
        const input = childToolInput(name, data.arguments);
        this.send(child, {
          parentToolCallId: '',
          agentId: child.id,
          kind: 'tool.started',
          toolCallId: callId,
          name,
          ...(input ? { input } : {}),
        });
        return;
      }
      case 'tool/result': {
        const message = recordOf(data.message);
        const callId = message?.toolCallId;
        if (typeof callId !== 'string') return;
        const ok = message?.isError !== true;
        const reason = ok ? '' : textOf(message?.content);
        this.send(child, {
          parentToolCallId: '',
          agentId: child.id,
          kind: 'tool.completed',
          toolCallId: callId,
          ok,
          ...(reason ? { errorText: clampText(reason, SUBAGENT_ERROR_CHARS) } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  private onChildMessage(child: Child, event: DshChildEvent, data: Record<string, unknown>): void {
    const content = recordOf(data.message)?.content;
    if (Array.isArray(content)) {
      content.forEach((block, index) => {
        const record = recordOf(block);
        const text = typeof record?.text === 'string' ? record.text.trim() : '';
        if (!text) return;
        const kind =
          record?.type === 'text' ? 'text' : record?.type === 'reasoning' ? 'thinking' : undefined;
        if (!kind) return;
        this.send(child, {
          parentToolCallId: '',
          agentId: child.id,
          kind,
          id: `${child.id}-${event.seq}-${index}`,
          text: clampText(text, SUBAGENT_TEXT_CHARS),
        });
      });
    }
    const tokens = stepTokens(data.usage);
    if (tokens <= 0) return;
    child.tokens += tokens;
    this.send(child, {
      parentToolCallId: '',
      agentId: child.id,
      kind: 'progress',
      usage: { totalTokens: child.tokens, toolUses: child.toolUses },
    });
  }

  // ---- the human parent's controls ---------------------------------------------------------------

  /**
   * `worker.subagent.interrupt`: the child's current run is cancelled as by
   * its human parent; the child keeps its session. DSH treats an idle or an
   * unknown child as a no-op and refuses another session's child.
   */
  interrupt(childId: string): WorkerSubagentInterruptResult {
    const subagents = this.host.subagents();
    if (!subagents) {
      throw new PiWorkerSessionError(WORKER_JOBS_UNAVAILABLE, 'This host has no subagent service');
    }
    try {
      subagents.interrupt(childId, { kind: 'user', parentSessionId: this.host.owner() });
    } catch (error) {
      throw new PiWorkerSessionError(
        'WORKER_SUBAGENT_UNAUTHORIZED',
        `Subagent ${childId} is not a child of this session: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return { interrupted: true };
  }

  /** Decision 069 rule 1: a Stop interrupts every running continuable child. */
  interruptAll(): string[] {
    const subagents = this.host.subagents();
    if (!subagents) return [];
    const interrupted: string[] = [];
    for (const childId of this.running(true)) {
      try {
        subagents.interrupt(childId, { kind: 'user', parentSessionId: this.host.owner() });
        interrupted.push(childId);
      } catch (error) {
        this.host.log?.('[dsh-bridge] subagent not interrupted', childId, error);
      }
    }
    return interrupted;
  }
}
