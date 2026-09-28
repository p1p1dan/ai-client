/**
 * Where a rewind or a fork cuts a DSH session, and the seed the child session
 * starts from (dsh-rebase P1-4b, decision 027; plan P1-4 shard 03 §4-§5).
 *
 * Pure: it reads the events `sessionQuery.observeSession` returned and names
 * no DSH package, because the bundled bridge may import none but
 * `@deepseek-ai/dsh-llm` (scripts/dsh-host-build-lib.mjs `BRIDGE_EXTERNALS`).
 * `buildDshForkSeed` is therefore a copy of `buildForkSeed` and its
 * `openTurnClosers` from `@deepseek-ai/dsh-session` 0.1.7-rc.2: the prefix,
 * the inherited marker, and `forked` closers for an open tail.
 * `forkSeed.test.ts` compares the two whenever the DSH package is installed,
 * and `agents.create` validates every seed it is handed.
 *
 * Node ids are the ones the history projection mints
 * (`src/shared/dshHistory/projection.ts`): a message's DSH `MessageId`, the
 * `entryId` of a migrated `aiclient/*` row, and `<turn anchor>:end` /
 * `<turn anchor>:interrupted` for the rows a turn end synthesizes.
 */

import type { DshLogEvent } from '../../shared/dshHistory/types.ts';

/** `@deepseek-ai/dsh-session` `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`. */
const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED';
const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN';

/** DSH's model-visible wording of a forked closer (`CLOSER_TEXT.forked`), verbatim. */
const FORKED_CLOSER_TEXT = {
  started:
    'The history inherited by this branch records this tool call starting but does not include its result. The parent session may have completed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
  notStarted:
    'The history inherited by this branch has no record of this tool call starting. The parent session may have executed it after the fork point. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
} as const;

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(recordOf)
    .flatMap((block) =>
      block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    )
    .join('');
}

/** `aiclient/<name>` or `plugin:aiclient/<name>` (decision 053), as the projection reads them. */
function aiclientEventName(type: string): string | undefined {
  if (type.startsWith('aiclient/')) return type.slice('aiclient/'.length) || undefined;
  if (type.startsWith('plugin:aiclient/'))
    return type.slice('plugin:aiclient/'.length) || undefined;
  return undefined;
}

// ---- the seed ---------------------------------------------------------------------

/** A seed boundary that names no event of `events`. */
export class DshForkBoundaryError extends Error {
  override readonly name = 'DshForkBoundaryError';
}

/**
 * The synthetic events that close an open tail turn with the `forked` cause:
 * an error result per call its open step never answered, `step/end`, then
 * `turn/end`. Empty when the log is balanced. `openTurnClosers(events,
 * {kind: 'forked'})` of dsh-session.
 */
export function forkedTurnClosers(events: readonly DshLogEvent[]): DshLogEvent[] {
  let openTurn: unknown = null;
  let openStep: unknown = null;
  const pending = new Map<string, { step: unknown; callSeq?: number }>();
  for (const event of events) {
    const data = recordOf(event.data);
    switch (event.type) {
      case 'turn/start':
        openTurn = data?.turn;
        openStep = null;
        pending.clear();
        break;
      case 'turn/end':
        openTurn = null;
        openStep = null;
        pending.clear();
        break;
      case 'step/start':
        openStep = data?.step;
        break;
      case 'step/end':
        pending.clear();
        openStep = null;
        break;
      case 'assistant/message': {
        const content = recordOf(data?.message)?.content;
        if (!Array.isArray(content)) break;
        for (const block of content.map(recordOf)) {
          const id = block?.type === 'tool-call' ? stringOf(block.id) : undefined;
          if (id) pending.set(id, { step: data?.step });
        }
        break;
      }
      case 'tool/call': {
        const entry = pending.get(String(data?.callId));
        if (entry) entry.callSeq = event.seq;
        break;
      }
      case 'tool/result':
        pending.delete(String(recordOf(recordOf(data?.message)?.source)?.callId));
        break;
      default:
        break;
    }
  }
  const last = events.at(-1);
  if (openTurn === null || last === undefined) return [];
  let seq = last.seq + 1;
  const time = last.time;
  const closers: DshLogEvent[] = [];
  for (const [callId, { step, callSeq }] of pending) {
    const started = callSeq !== undefined;
    closers.push({
      type: 'tool/result',
      seq: seq,
      time,
      data: {
        turn: openTurn,
        step,
        message: {
          id: `forked-tool-result-${callId}-${seq}`,
          role: 'tool',
          toolCallId: callId,
          isError: true,
          source: { kind: 'tool', callId },
          content: [
            {
              type: 'text',
              text: started ? FORKED_CLOSER_TEXT.started : FORKED_CLOSER_TEXT.notStarted,
            },
          ],
        },
        error: started
          ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
          : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
      },
      surfaceOp: 'append',
      ...(started ? { sourceEventSeqs: [callSeq] } : {}),
    });
    seq += 1;
  }
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq, time, data: { turn: openTurn, step: openStep } });
    seq += 1;
  }
  closers.push({
    type: 'turn/end',
    seq: seq,
    time,
    data: { turn: openTurn, reason: { kind: 'forked' } },
  });
  return closers;
}

/**
 * `buildForkSeed(events, boundary)` of dsh-session: events `0..boundary`
 * (the same objects, so every `MessageId` survives), the inherited marker,
 * and closers for a tail turn the cut left open. The child is created with
 * `inheritedEventCount: boundary + 1`.
 */
export function buildDshForkSeed(events: readonly DshLogEvent[], boundary: number): DshLogEvent[] {
  if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary >= events.length) {
    throw new DshForkBoundaryError(`fork boundary ${boundary} is not in a log of ${events.length}`);
  }
  const cut = events[boundary];
  if (cut?.seq !== boundary) {
    throw new DshForkBoundaryError(`fork boundary ${boundary} is not a contiguous event seq`);
  }
  const prefix: DshLogEvent[] = events.slice(0, boundary + 1);
  prefix.push({
    type: 'session/end-seed',
    seq: boundary + 1,
    time: cut.time,
    data: { inherited: true },
  });
  return prefix.concat(forkedTurnClosers(prefix));
}

// ---- the cut ----------------------------------------------------------------------

/** What a node of the tree is in the log. */
type NodeKind =
  /** A message the human typed: a rewind cuts before its turn. */
  | 'prompt'
  /** A model step: its `step/end`, or its turn's end when it was the last one. */
  | 'step'
  /** A compaction checkpoint: through the compaction's end. */
  | 'checkpoint'
  /** A row a turn end synthesized, or any other single event. */
  | 'event';

interface LocatedNode {
  kind: NodeKind;
  seq: number;
  /** `turn/start` of the turn the node is in. */
  turnStartSeq?: number;
  /** The step's coordinates, for `step`. */
  turn?: unknown;
  step?: unknown;
  /** The prompt's text, for `prompt`. */
  text?: string;
}

function locate(events: readonly DshLogEvent[], nodeId: string): LocatedNode | undefined {
  let turnStartSeq: number | undefined;
  let anchor: string | undefined;
  for (const event of events) {
    const data = recordOf(event.data);
    switch (event.type) {
      case 'turn/start':
        turnStartSeq = event.seq;
        anchor = undefined;
        break;
      case 'user/message': {
        const id = stringOf(data?.id) ?? `seq-${event.seq}`;
        if (turnStartSeq !== undefined && anchor === undefined) anchor = id;
        if (id !== nodeId) break;
        const source = recordOf(data?.source);
        if (source?.kind === 'user') {
          return { kind: 'prompt', seq: event.seq, turnStartSeq, text: textOf(data?.content) };
        }
        if (source?.kind === 'compact-checkpoint') {
          return { kind: 'checkpoint', seq: event.seq, turnStartSeq };
        }
        return { kind: 'event', seq: event.seq, turnStartSeq };
      }
      case 'assistant/message': {
        const message = recordOf(data?.message);
        if ((stringOf(message?.id) ?? `seq-${event.seq}`) !== nodeId) break;
        return {
          kind: 'step',
          seq: event.seq,
          turnStartSeq,
          turn: data?.turn,
          step: data?.step,
        };
      }
      case 'tool/result': {
        // A result the projection could not hang on a step became a row of its own.
        const message = recordOf(data?.message);
        if ((stringOf(message?.id) ?? `seq-${event.seq}`) === nodeId) {
          return { kind: 'event', seq: event.seq, turnStartSeq };
        }
        break;
      }
      case 'turn/end':
        if (
          anchor !== undefined &&
          (nodeId === `${anchor}:end` || nodeId === `${anchor}:interrupted`)
        ) {
          return { kind: 'event', seq: event.seq, turnStartSeq };
        }
        turnStartSeq = undefined;
        anchor = undefined;
        break;
      default: {
        const name = aiclientEventName(event.type);
        if (name && (stringOf(data?.entryId) ?? `aiclient-${name}-${event.seq}`) === nodeId) {
          return { kind: 'event', seq: event.seq, turnStartSeq };
        }
      }
    }
  }
  return undefined;
}

/** Where a compaction checkpoint's operation ends: its `compaction/end`, then the command's `command/done`. */
function checkpointEnd(events: readonly DshLogEvent[], seq: number): number {
  let end = seq;
  let compactionId: string | undefined;
  let commandId: string | undefined;
  for (let index = seq - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'compaction/start') continue;
    const data = recordOf(event.data);
    compactionId = stringOf(data?.compactionId);
    commandId = stringOf(data?.sourceCommandId);
    break;
  }
  if (!compactionId) return end;
  for (let index = seq + 1; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.type === 'turn/start') break;
    const data = recordOf(event.data);
    if (event.type === 'compaction/end' && data?.compactionId === compactionId) end = event.seq;
    else if (
      event.type === 'command/done' &&
      commandId !== undefined &&
      data?.commandId === commandId &&
      end > seq
    ) {
      return event.seq;
    }
  }
  return end;
}

/** A step's last event: `step/end`, or the `turn/end` right after the turn's last step. */
function stepEnd(events: readonly DshLogEvent[], node: LocatedNode): number {
  let end = node.seq;
  for (let index = node.seq + 1; index < events.length; index += 1) {
    const event = events[index];
    if (!event) break;
    const data = recordOf(event.data);
    if (event.type === 'step/end' && data?.turn === node.turn && data?.step === node.step) {
      end = event.seq;
      continue;
    }
    // The turn's last step: its end carries how the turn ended.
    if (event.type === 'turn/end') return event.seq;
    if (event.type === 'step/start' || event.type === 'turn/start') return end;
  }
  return end;
}

/**
 * The seqs after which the durable inbox (`agent/inbox/spliced`) holds
 * nothing. A child inheriting a queued prompt would run it: the inbox is a
 * projection of the log, and the next turn claims what it holds.
 */
function inboxEmptyAfter(events: readonly DshLogEvent[], through: number): boolean[] {
  const empty: boolean[] = [];
  const pending: Record<string, number> = {};
  for (const event of events) {
    if (event.seq > through) break;
    if (event.type === 'agent/inbox/spliced') {
      const data = recordOf(event.data);
      const target = String(data?.target);
      const removed = typeof data?.removedCount === 'number' ? data.removedCount : 0;
      const inserted = Array.isArray(data?.inserted) ? data.inserted.length : 0;
      pending[target] = Math.max(0, (pending[target] ?? 0) - removed + inserted);
    }
    empty[event.seq] = Object.values(pending).every((count) => count === 0);
  }
  return empty;
}

/** Anything a child would keep from before `cut`: a closed turn, a message, a migrated row. */
function hasHistoryBefore(events: readonly DshLogEvent[], cut: number): boolean {
  return events.some(
    (event) =>
      event.seq < cut &&
      (event.type === 'turn/end' ||
        event.type === 'user/message' ||
        aiclientEventName(event.type) !== undefined)
  );
}

export interface DshCutPlan {
  /** Inclusive seq the child inherits through; `null` for an empty child. */
  boundary: number | null;
  /** A rewind to a typed prompt hands its text back to the composer. */
  editorText?: string;
}

/**
 * Where a rewind or a fork to `nodeId` cuts this log, or `undefined` when the
 * node is not in it (decision 027 rule 2):
 *
 *   rewind to a prompt   the last event before its turn — the turn it
 *                        answered stays out, the prompt goes back to the
 *                        composer; nothing before the first turn is an
 *                        empty child
 *   a model step         its `step/end`, or its turn's `turn/end` when it
 *                        was the turn's last step, so the turn keeps how it
 *                        ended (a Stop, an interjection)
 *   fork to a prompt     the prompt itself
 *   a checkpoint         through the compaction's end
 *   anything else        its own event (a turn end for the rows it made)
 *
 * The cut then steps back past anything still queued in the durable inbox.
 */
export function planDshCut(
  events: readonly DshLogEvent[],
  nodeId: string,
  operation: 'rewind' | 'fork'
): DshCutPlan | undefined {
  const node = locate(events, nodeId);
  if (!node) return undefined;
  let boundary: number;
  let editorText: string | undefined;
  switch (node.kind) {
    case 'prompt':
      if (operation === 'rewind') {
        const cut = node.turnStartSeq ?? node.seq;
        editorText = node.text ?? '';
        if (!hasHistoryBefore(events, cut)) return { boundary: null, editorText };
        boundary = cut - 1;
      } else {
        boundary = node.seq;
      }
      break;
    case 'step':
      boundary = stepEnd(events, node);
      break;
    case 'checkpoint':
      boundary = checkpointEnd(events, node.seq);
      break;
    default:
      boundary = node.seq;
  }
  const empty = inboxEmptyAfter(events, boundary);
  while (boundary >= 0 && empty[boundary] !== true) boundary -= 1;
  return {
    boundary: boundary >= 0 ? boundary : null,
    ...(editorText !== undefined ? { editorText } : {}),
  };
}
