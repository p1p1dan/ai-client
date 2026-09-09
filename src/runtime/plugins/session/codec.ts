import type { AgentMessage, Entry, JsonlV4Header } from '@earendil-works/pi-agent-core';
import { RuntimeHostError } from '../../host/errors.ts';

export interface SessionDocument {
  header: JsonlV4Header;
  entries: Entry[];
  leafId: string | null;
  seq: number;
  name?: string;
  labels?: Record<string, string>;
  /** Valid prefix, only used while holding the writer lock to repair a torn tail. */
  repair?: string;
}

function invalid(message: string): never {
  throw new RuntimeHostError('session_invalid', message);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected JSON object');
  return value as Record<string, unknown>;
}

function message(value: unknown): void {
  const m = object(value);
  if (typeof m.timestamp !== 'number') invalid('invalid message timestamp');
  switch (m.role) {
    case 'user':
    case 'assistant':
    case 'toolResult':
    case 'custom':
      if (typeof m.content !== 'string' && !Array.isArray(m.content))
        invalid('invalid message content');
      if (m.role === 'assistant' && (!Array.isArray(m.content) || typeof m.stopReason !== 'string'))
        invalid('invalid assistant message');
      if (
        m.role === 'toolResult' &&
        (typeof m.toolCallId !== 'string' || typeof m.toolName !== 'string')
      )
        invalid('invalid tool result');
      if (m.role === 'custom' && typeof m.customType !== 'string')
        invalid('invalid custom message');
      break;
    case 'compactionSummary':
    case 'branchSummary':
      if (typeof m.summary !== 'string') invalid('invalid summary message');
      break;
    case 'bashExecution':
      if (typeof m.command !== 'string' || typeof m.output !== 'string')
        invalid('invalid bash message');
      break;
    default:
      invalid(`unsupported message role: ${String(m.role)}`);
  }
}

function entry(value: Record<string, unknown>): Entry {
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    (value.parentId !== null && typeof value.parentId !== 'string') ||
    !Number.isSafeInteger(value.timestamp)
  )
    invalid('invalid entry identity');
  switch (value.type) {
    case 'message':
      message(value.message);
      break;
    case 'compaction':
      if (
        typeof value.summary !== 'string' ||
        typeof value.tokensBefore !== 'number' ||
        !Array.isArray(value.retainedTail)
      )
        invalid('invalid compaction');
      value.retainedTail.forEach(message);
      break;
    case 'branch_summary':
      if (typeof value.summary !== 'string' || typeof value.fromId !== 'string')
        invalid('invalid branch summary');
      break;
    case 'model_change':
      if (typeof value.provider !== 'string' || typeof value.modelId !== 'string')
        invalid('invalid model change');
      break;
    case 'thinking_level_change':
      if (typeof value.thinkingLevel !== 'string') invalid('invalid thinking level');
      break;
    case 'active_tools_change':
      if (
        !Array.isArray(value.activeToolNames) ||
        !value.activeToolNames.every((name) => typeof name === 'string')
      )
        invalid('invalid tools');
      break;
    case 'custom':
      if (typeof value.customType !== 'string') invalid('invalid custom entry');
      break;
    default:
      invalid(`unsupported entry type: ${String(value.type)}`);
  }
  const { kind: _kind, lane: _lane, ...fields } = value;
  return fields as unknown as Entry;
}

// Adapt pi 0.84.4's v4 codec and state invariants; IO remains entirely ours.
export function decodeSession(content: string): SessionDocument {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let headerValue: Record<string, unknown>;
  try {
    headerValue = object(JSON.parse(lines[0] ?? ''));
  } catch {
    invalid('missing or invalid session header');
  }
  if (headerValue.kind !== 'header' || headerValue.version !== 4) {
    throw new RuntimeHostError(
      'session_format_unsupported',
      'expected Pi JSONL v4; convert legacy sessions before opening'
    );
  }
  if (
    typeof headerValue.id !== 'string' ||
    typeof headerValue.cwd !== 'string' ||
    !Number.isSafeInteger(headerValue.createdAt)
  )
    invalid('invalid session header');
  const result: SessionDocument = {
    header: headerValue as unknown as JsonlV4Header,
    entries: [],
    leafId: null,
    seq: 0,
  };
  const ids = new Set<string>();
  const recordIds = new Set<string>();
  const openOperations = new Set<string>();
  const lanes = new Map<string, string | null>([['main', null]]);
  for (let index = 1; index < lines.length; index++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      if (index === lines.length - 1 && !content.endsWith('\n')) {
        result.repair = `${lines.slice(0, index).join('\n')}\n`;
        break;
      }
      invalid(`invalid JSON at line ${index + 1}`);
    }
    const row = object(parsed);
    if (row.seq !== result.seq + 1) invalid(`non-consecutive seq at line ${index + 1}`);
    result.seq++;
    switch (row.kind) {
      case 'entry': {
        const item = entry(row);
        if (
          ids.has(item.id) ||
          recordIds.has(item.id) ||
          (item.parentId !== null && !ids.has(item.parentId))
        )
          invalid('duplicate id or missing parent');
        if (row.lane !== undefined) {
          if (
            typeof row.lane !== 'string' ||
            !lanes.has(row.lane) ||
            lanes.get(row.lane) !== item.parentId
          )
            invalid('entry does not chain to lane');
          lanes.set(row.lane, item.id);
        }
        ids.add(item.id);
        result.entries.push(item);
        break;
      }
      case 'lane':
        if (
          typeof row.lane !== 'string' ||
          (row.leafId !== null && (typeof row.leafId !== 'string' || !ids.has(row.leafId)))
        )
          invalid('invalid lane pointer');
        lanes.set(row.lane, row.leafId as string | null);
        break;
      case 'record':
        if (
          typeof row.id !== 'string' ||
          ids.has(row.id) ||
          recordIds.has(row.id) ||
          typeof row.lane !== 'string' ||
          !lanes.has(row.lane) ||
          !Number.isSafeInteger(row.timestamp)
        )
          invalid('invalid record identity or lane');
        if (
          ![
            'operation_started',
            'abort_requested',
            'operation_finished',
            'step_attempt',
            'tool_started',
            'queue_enqueued',
            'queue_cancelled',
            'write_deferred',
            'usage',
          ].includes(String(row.type))
        )
          invalid('unsupported record type');
        recordIds.add(row.id);
        if (row.type === 'operation_started') openOperations.add(row.id);
        if (row.type === 'operation_finished') {
          if (typeof row.runId !== 'string') invalid('missing finished operation id');
          openOperations.delete(row.runId);
        }
        break;
      case 'fact':
        if (row.fact === 'name') {
          if (row.name !== undefined && typeof row.name !== 'string')
            invalid('invalid session name');
          result.name = row.name as string | undefined;
        } else if (row.fact === 'label') {
          if (
            typeof row.targetId !== 'string' ||
            !ids.has(row.targetId) ||
            (row.label !== undefined && typeof row.label !== 'string')
          )
            invalid('invalid session label');
          result.labels ??= {};
          if (row.label === undefined) delete result.labels[row.targetId as string];
          else result.labels[row.targetId as string] = row.label as string;
        } else invalid('unsupported fact');
        break;
      default:
        invalid(`unsupported JSONL kind: ${String(row.kind)}`);
    }
  }
  result.leafId = lanes.get('main') ?? null;
  if (openOperations.size)
    throw new RuntimeHostError(
      'session_operation_unfinished',
      'unfinished SDK operations require explicit recovery before native resume'
    );
  if (!result.repair && !content.endsWith('\n')) result.repair = `${content}\n`;
  return result;
}

export function branchEntries(document: SessionDocument, leafId = document.leafId): Entry[] {
  const byId = new Map(document.entries.map((item) => [item.id, item]));
  const path: Entry[] = [];
  for (let id = leafId; id !== null; ) {
    const item = byId.get(id);
    if (!item) invalid('missing branch entry');
    path.push(item);
    id = item.parentId;
  }
  return path.reverse();
}

export function isSuccessfulMessage(m: AgentMessage): boolean {
  return m.role !== 'assistant' || !['error', 'aborted', 'deferred'].includes(m.stopReason);
}
