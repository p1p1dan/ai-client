/**
 * Rule B (decision 065): one reply that keeps writing the same delegation or
 * background-work call is cut while it streams. A port of 1.0.x's
 * `delegationLoopGuard.ts` form B to DSH's chunk protocol.
 *
 * The measured failure (glm-5.2, 2026-09-24): one assistant message with 5709
 * tool calls, the same `TaskList → TaskStop → TaskWait` triple over and over,
 * streamed for about 19 minutes. DSH would execute every one of them once the
 * reply ended (`dsh-agent-loop` runs a reply's calls in full), so the stream
 * is the only place to stop it.
 *
 * A call is judged once, at its `block-end`, where DSH hands over the whole
 * block with its final arguments; a block still being dictated is never
 * compared. On a trip the downstream stream is closed first (dsh-llm closes
 * the adapter's iterator and llm-pi-ai aborts the provider request), then the
 * reply ends with one terminal `error` finish: the loop records it as an
 * `assistant/attempt`, runs none of its calls, keeps it out of every later
 * request and ends the turn with `turn/end {kind:'error'}`.
 */

import {
  DELEGATION_TOOL_NAMES,
  MAX_DELEGATION_CALLS_PER_REPLY,
  MAX_IDENTICAL_DELEGATION_CALLS_PER_REPLY,
  TOOL_CALL_REPETITION,
} from './constants.ts';
import type { DshStreamChunk, DshToolCallBlock } from './dshTypes.ts';

export type RepetitionRule = 'identical_call' | 'call_count';

export interface RepetitionVerdict {
  rule: RepetitionRule;
  /** The normalized call that tripped the rule. */
  signature: string;
  /** How many times that signature appeared in the reply, the tripping one included. */
  occurrences: number;
  /** Family calls in the reply, the tripping one included. */
  delegationCalls: number;
  /** Every tool call the model had started writing when the reply was cut. */
  toolCalls: number;
}

/** Longest signature written into a log line or a message. */
const MAX_SIGNATURE_DISPLAY_CHARS = 200;

/**
 * The fields that make two calls "the same call". Control calls are named by
 * their target alone (a wait's timeout does not make it a different wait);
 * work-carrying calls by who is asked to do what, never by the display label.
 */
const SIGNATURE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  subagent: ['prompt', 'provider', 'model', 'reasoning_effort'],
  subagent_fork: ['prompt', 'provider', 'model', 'reasoning_effort'],
  delegate: ['agent', 'prompt', 'model'],
  send_message: ['agent_id', 'message'],
  interrupt_agent: ['agent_id'],
  list_agents: ['scope'],
  job_output: ['job_id'],
  job_list: [],
  job_kill: ['job_id'],
};

/** Values a field takes when the model leaves it out. */
const FIELD_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  list_agents: { scope: 'children' },
};

function parseArguments(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The normalized identity of one family call. */
export function delegationCallSignature(name: string, rawArguments: unknown): string {
  const args = parseArguments(rawArguments);
  const picked: Record<string, string> = {};
  for (const field of SIGNATURE_FIELDS[name] ?? []) {
    const value = args[field];
    const text =
      typeof value === 'string'
        ? value.trim()
        : value === undefined || value === null
          ? ''
          : JSON.stringify(value);
    const normalized = text || FIELD_DEFAULTS[name]?.[field] || '';
    if (normalized) picked[field] = normalized;
  }
  return `${name} ${JSON.stringify(picked)}`;
}

/** A signature cut to a size a log line or a message can carry. */
export function displaySignature(signature: string): string {
  return signature.length <= MAX_SIGNATURE_DISPLAY_CHARS
    ? signature
    : `${signature.slice(0, MAX_SIGNATURE_DISPLAY_CHARS - 1)}…`;
}

/** Counts one reply's family calls as their blocks complete. */
export class ReplyRepetitionTracker {
  private toolCalls = 0;
  private delegationCalls = 0;
  private readonly counts = new Map<string, number>();

  /** A tool-call block started: it counts toward `toolCalls` from now on. */
  noteToolCallStarted(): void {
    this.toolCalls += 1;
  }

  /** Judge one completed tool-call block. */
  inspect(block: Pick<DshToolCallBlock, 'name' | 'arguments'>): RepetitionVerdict | undefined {
    if (!DELEGATION_TOOL_NAMES.includes(block.name)) return undefined;
    this.delegationCalls += 1;
    const signature = delegationCallSignature(block.name, block.arguments);
    const occurrences = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, occurrences);
    const rule: RepetitionRule | undefined =
      occurrences >= MAX_IDENTICAL_DELEGATION_CALLS_PER_REPLY
        ? 'identical_call'
        : this.delegationCalls > MAX_DELEGATION_CALLS_PER_REPLY
          ? 'call_count'
          : undefined;
    if (!rule) return undefined;
    return {
      rule,
      signature,
      occurrences,
      delegationCalls: this.delegationCalls,
      toolCalls: Math.max(this.toolCalls, this.delegationCalls),
    };
  }
}

/** 1.0.x `describeRepetition`, verbatim: the failure message of a cut reply. */
export function describeRepetition(verdict: RepetitionVerdict): string {
  const what =
    verdict.rule === 'identical_call'
      ? `The model wrote the same subagent tool call ${verdict.occurrences} times in one reply (${displaySignature(verdict.signature)})`
      : `The model wrote ${verdict.delegationCalls} subagent tool calls in one reply, more than the ${MAX_DELEGATION_CALLS_PER_REPLY} this app allows`;
  return `${what}, with ${verdict.toolCalls} tool calls in that reply so far. The app interrupted the reply and ran none of its tool calls.`;
}

/** The one terminal chunk a cut reply ends with. */
export function repetitionFinish(verdict: RepetitionVerdict): DshStreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { code: TOOL_CALL_REPETITION, message: describeRepetition(verdict) },
    },
  };
}

function isToolCallBlock(block: unknown): block is DshToolCallBlock {
  const record = block as { type?: unknown; name?: unknown } | null;
  return record?.type === 'tool-call' && typeof record.name === 'string';
}

export interface GuardStreamHooks {
  /** Told once, after the downstream stream was closed and before the terminal chunk. */
  onTrip?: (verdict: RepetitionVerdict) => void;
}

/**
 * Pass a reply's chunks through, cutting the reply at the call that trips a
 * rule. Every other chunk, a provider's own error included, is forwarded
 * untouched, so a reply that never trips cannot tell this layer is there.
 */
export async function* guardReplyStream(
  source: AsyncIterable<DshStreamChunk>,
  hooks: GuardStreamHooks = {}
): AsyncGenerator<DshStreamChunk, void, undefined> {
  const iterator = source[Symbol.asyncIterator]();
  const tracker = new ReplyRepetitionTracker();
  let settled = false;
  try {
    while (true) {
      const item = await iterator.next();
      if (item.done) {
        settled = true;
        return;
      }
      const chunk = item.value;
      if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
        tracker.noteToolCallStarted();
      }
      yield chunk;
      if (chunk.type !== 'block-end' || !isToolCallBlock(chunk.block)) continue;
      const verdict = tracker.inspect(chunk.block);
      if (!verdict) continue;
      // Stop paying for output first: closing the downstream iterator is what
      // makes llm-pi-ai abort the provider request.
      settled = true;
      try {
        await iterator.return?.();
      } catch {
        // A teardown fault must not cost the terminal chunk.
      }
      try {
        hooks.onTrip?.(verdict);
      } catch {
        // Same: the loop would wait on this reply forever without its finish.
      }
      yield repetitionFinish(verdict);
      return;
    }
  } finally {
    if (!settled) await iterator.return?.();
  }
}
