/**
 * Loop guards for the subagent tool family: `Task`, `TaskWait`, `TaskList`,
 * `TaskStop`.
 *
 * Two shapes of the same failure, measured on a real session (2026-09-24):
 *
 * - **Within one reply.** The model degenerates while it is still writing and
 *   emits the same `TaskList {} → TaskStop {} → TaskWait {}` triple over and
 *   over in ONE assistant message — thousands of calls, none of them executed,
 *   because pi only runs tool calls once the message is complete. The turn
 *   ceiling counts replies, so it never fires; the stream just runs until the
 *   provider's output limit or the user's quota gives out. The only place this
 *   can be stopped is the stream itself, which is what
 *   {@link guardReplyRepetition} is for: it watches the tool calls as they are
 *   dictated and ends the reply the moment one repeats too often.
 * - **Across replies.** Every delegate has finished and every report has been
 *   delivered, yet the model keeps asking the delegation tools for more. The
 *   tools themselves answer that (the subagent plugin refuses from the second
 *   idle call on); what lives here is the rule the agent loop uses to end the
 *   run once refusals stop working: {@link MAX_IDLE_DELEGATION_REPLIES}
 *   consecutive replies made of nothing but idle delegation calls.
 *
 * A leaf module on purpose: the agent loop imports it, and the subagent plugin
 * already imports the loop's retry layer, so the family's names are written
 * here as data rather than imported from the plugin (a drift test pins them).
 */

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';

/** The subagent tool family, by wire name. Must match `SUBAGENT_TOOL_NAMES`. */
export const DELEGATION_TOOL_NAMES: readonly string[] = [
  'Task',
  'TaskWait',
  'TaskList',
  'TaskStop',
];

/** The three family members that never start work, only inspect or end it. */
const DELEGATION_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'TaskWait',
  'TaskList',
  'TaskStop',
]);

/**
 * How many times one normalized delegation call may appear in one reply before
 * the reply is cut; the call that reaches this count trips it.
 *
 * Three, because a second identical call can still be a model being careful,
 * and a third never is: a control call returns the same answer every time it is
 * repeated within a reply, and a parallel fan-out writes a DIFFERENT brief per
 * `Task`. On the measured session the periodic part repeated byte-for-byte, so
 * this trips within the first ten calls of the cycle.
 */
export const MAX_IDENTICAL_DELEGATION_CALLS_PER_REPLY = 3;

/**
 * Delegation calls one reply may carry before it is cut, whatever their
 * arguments.
 *
 * The concurrency ceiling (ten `Task`s) plus room for a handful of waits and
 * stops. Past this there is no plan that needs more in one message, and a
 * degenerating model that varies an argument per call would otherwise slip
 * under the identical-call rule.
 */
export const MAX_DELEGATION_CALLS_PER_REPLY = 16;

/**
 * Consecutive replies made only of idle delegation calls before the run is
 * wrapped up.
 *
 * Two: the first idle reply is where the model is TOLD there is nothing left
 * (its first idle call gets the full answer, the rest of that reply's calls are
 * refused with the same instruction). A second idle reply means it read that
 * and asked again anyway; a third request would cost another full-context
 * round trip to learn nothing new.
 */
export const MAX_IDLE_DELEGATION_REPLIES = 2;

/** `RuntimeRunResult.error.code` of a run whose reply was cut by this guard. */
export const TOOL_CALL_REPETITION = 'tool_call_repetition';

/** Longest signature written into a record or a message. */
const MAX_SIGNATURE_DISPLAY_CHARS = 200;

export type RepetitionRule = 'identical_call' | 'call_count';

export interface RepetitionVerdict {
  rule: RepetitionRule;
  /** The normalized call that tripped the rule. */
  signature: string;
  /** How many times that signature appeared in the reply, the tripping one included. */
  occurrences: number;
  /** Delegation calls in the reply, the tripping one included. */
  delegationCalls: number;
  /** Every tool call the model had started writing when the reply was cut. */
  toolCalls: number;
  /** Content index of the tripping call; nothing after it is kept. */
  blockIndex: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * What makes two delegation calls "the same call".
 *
 * Control calls are identified by their targets alone: `TaskStop {}` and
 * `TaskStop {"delegationIds":[]}` mean the same thing, and a wait on the same
 * delegations is the same wait whatever its timeout or mode. `Task` is
 * identified by who is asked to do what (agent, brief, model); its display
 * label is not part of the work.
 */
export function delegationCallSignature(name: string, args: unknown): string {
  const record = asRecord(args);
  if (DELEGATION_CONTROL_TOOL_NAMES.has(name)) {
    const ids = Array.isArray(record.delegationIds)
      ? [...new Set(record.delegationIds.map(String))].sort()
      : [];
    return `${name} ${JSON.stringify(ids.length ? { delegationIds: ids } : {})}`;
  }
  const brief: Record<string, string> = {};
  for (const key of ['agent', 'task', 'model']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) brief[key] = value.trim();
  }
  return `${name} ${JSON.stringify(brief)}`;
}

/** A signature cut to a size a log line or a message can carry. */
export function displaySignature(signature: string): string {
  return signature.length <= MAX_SIGNATURE_DISPLAY_CHARS
    ? signature
    : `${signature.slice(0, MAX_SIGNATURE_DISPLAY_CHARS - 1)}…`;
}

function isToolCallBlock(block: unknown): block is { type: 'toolCall'; name?: unknown } {
  return asRecord(block).type === 'toolCall';
}

/**
 * Counts one reply's delegation calls as they become complete.
 *
 * A call is judged once, when its arguments are final: when a LATER block has
 * started (every provider writes blocks in order), when the provider closes
 * that block itself, or when the reply ends. Judging the block still being
 * written would compare half-parsed arguments, and two different briefs
 * truncated at the same point would look identical.
 */
export class ReplyRepetitionTracker {
  private judged = 0;
  private delegationCalls = 0;
  private readonly counts = new Map<string, number>();

  /** Judge every block up to `completeThrough` not judged yet. */
  inspect(content: readonly unknown[], completeThrough: number): RepetitionVerdict | undefined {
    const last = Math.min(completeThrough, content.length - 1);
    while (this.judged <= last) {
      const index = this.judged;
      this.judged += 1;
      const block = content[index];
      if (!isToolCallBlock(block) || typeof block.name !== 'string') continue;
      if (!DELEGATION_TOOL_NAMES.includes(block.name)) continue;
      this.delegationCalls += 1;
      const signature = delegationCallSignature(
        block.name,
        (block as { arguments?: unknown }).arguments
      );
      const occurrences = (this.counts.get(signature) ?? 0) + 1;
      this.counts.set(signature, occurrences);
      const rule: RepetitionRule | undefined =
        occurrences >= MAX_IDENTICAL_DELEGATION_CALLS_PER_REPLY
          ? 'identical_call'
          : this.delegationCalls > MAX_DELEGATION_CALLS_PER_REPLY
            ? 'call_count'
            : undefined;
      if (rule) {
        return {
          rule,
          signature,
          occurrences,
          delegationCalls: this.delegationCalls,
          toolCalls: content.filter(isToolCallBlock).length,
          blockIndex: index,
        };
      }
    }
    return undefined;
  }
}

/** The one-sentence account of a cut, for the run's error and the session file. */
export function describeRepetition(verdict: RepetitionVerdict): string {
  const what =
    verdict.rule === 'identical_call'
      ? `The model wrote the same subagent tool call ${verdict.occurrences} times in one reply (${displaySignature(verdict.signature)})`
      : `The model wrote ${verdict.delegationCalls} subagent tool calls in one reply, more than the ${MAX_DELEGATION_CALLS_PER_REPLY} this app allows`;
  return `${what}, with ${verdict.toolCalls} tool calls in that reply so far. The app interrupted the reply and ran none of its tool calls.`;
}

/**
 * Streaming scratch fields providers keep on a block while it is being
 * written. `openai-completions` strips them when it finishes a block itself;
 * a reply cut here never gets that far.
 */
const SCRATCH_FIELDS = ['partialArgs', 'customInput', 'streamIndex', 'index'] as const;

/**
 * The message a cut reply ends as.
 *
 * `stopReason: 'error'` is what makes the rest of the system do the right
 * thing without a special case each: pi executes none of the reply's tool
 * calls and ends the loop there; the session store keeps the message on disk
 * (the record of what happened) but out of every later request's context,
 * because `isSuccessfulMessage` drops failed replies; the projector settles the
 * tool rows it had opened as "never started". Content after the tripping call
 * is dropped — it is the part of the degenerate output nobody needs a copy of.
 */
export function interruptedReply(
  partial: AssistantMessage,
  verdict: RepetitionVerdict
): AssistantMessage {
  const content = structuredClone(partial.content.slice(0, verdict.blockIndex + 1));
  for (const block of content) {
    const scratch = block as unknown as Record<string, unknown>;
    for (const field of SCRATCH_FIELDS) delete scratch[field];
  }
  return {
    ...partial,
    content,
    stopReason: 'error',
    errorMessage: describeRepetition(verdict),
    timestamp: Date.now(),
  };
}

/** Which blocks an event proves complete, or undefined when it proves nothing new. */
function completeThrough(event: AssistantMessageEvent): number | undefined {
  switch (event.type) {
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
      return event.contentIndex - 1;
    case 'toolcall_end':
      return event.contentIndex;
    case 'done':
      return event.message.content.length - 1;
    default:
      return undefined;
  }
}

export interface ReplyRepetitionHooks {
  /** Cancel the provider request behind `source`; called before the cut is published. */
  abort: () => void;
  /** Told once, with the verdict and the message the reply ends as. */
  onTrip: (verdict: RepetitionVerdict, message: AssistantMessage) => void;
}

/**
 * Pass a reply's stream through, cutting it the moment a delegation call
 * repeats past the limits above.
 *
 * On a trip the provider request is cancelled first (the point is to stop
 * paying for the output), then the reply ends as {@link interruptedReply}.
 * Every other event — including a provider error or the user's own abort — is
 * forwarded untouched, so this layer is invisible to any reply that never
 * trips it.
 */
export function guardReplyRepetition(
  source: AssistantMessageEventStream,
  hooks: ReplyRepetitionHooks
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  const tracker = new ReplyRepetitionTracker();
  // No `.catch`: iterating an `EventStream` cannot throw, and its `result()`
  // always settles once the source ends, so `out` always gets its terminal.
  void (async () => {
    for await (const event of source) {
      const through = completeThrough(event);
      const partial =
        event.type === 'done' ? event.message : 'partial' in event ? event.partial : undefined;
      const verdict =
        through !== undefined && partial ? tracker.inspect(partial.content, through) : undefined;
      if (verdict && partial) {
        hooks.abort();
        const message = interruptedReply(partial, verdict);
        // A listener fault must not cost the terminal event: without it pi
        // would wait on this reply forever.
        try {
          hooks.onTrip(verdict, message);
        } catch {}
        out.push({ type: 'error', reason: 'error', error: message });
        out.end(message);
        return;
      }
      out.push(event);
    }
    out.end(await source.result());
  })();
  return out;
}

/**
 * Whether a tool result is an idle delegation call: one the subagent plugin
 * answered while nothing was running and nothing was waiting to be delivered.
 * The plugin marks those in `details.idle`; nothing else sets the field.
 */
export function isIdleDelegationResult(result: { toolName?: unknown; details?: unknown }): boolean {
  return (
    typeof result.toolName === 'string' &&
    DELEGATION_CONTROL_TOOL_NAMES.has(result.toolName) &&
    asRecord(result.details).idle === true
  );
}
