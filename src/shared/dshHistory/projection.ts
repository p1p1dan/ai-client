// New in dsh-rebase P1-4a

/**
 * DSH session log -> the `HistoryMessage` timeline the renderer replays
 * (dsh-rebase decisions 026 and 032; plan P1-4 shard 03 §1).
 *
 * One human message is one message; one step (a model call plus the results
 * of the tools it asked for) is one message. Ids are DSH `MessageId`s written
 * `h:<id>`: fork seeds copy events verbatim, so an id survives rewind and
 * fork, and the renderer's merge rules keep holding. Rows the projection has
 * to synthesize are keyed by the turn's first message id plus a suffix, which
 * is just as stable.
 *
 * Pure and incremental: `DshHistoryFold` takes events in log order, one at a
 * time, which is how the bridge keeps its cache current from `session/event`;
 * `projectDshHistory` is the same fold over a whole log. No IO, no DSH
 * package, no runtime — the static guard in `__tests__` holds it to that.
 */

import type { SessionFileChange } from '../sessionFileChange.ts';
import type {
  HistoryAttachment,
  HistoryBlock,
  HistoryMessage,
  TurnStopCause,
} from '../types/sessionHistory.ts';
import { parseToolArguments, toolRowInput } from './toolInput.ts';
import {
  AICLIENT_INTERJECT_REASON,
  DSH_FORM_NOTICE,
  DSH_SOURCE_AICLIENT_PI_BRANCH_SUMMARY,
  DSH_SOURCE_AICLIENT_RETRY,
  DSH_SOURCE_COMPACT_CHECKPOINT,
  DSH_SOURCE_USER,
  DSH_TOOL_ABORTED,
  DSH_TOOL_ABORTED_BEFORE_DISPATCH,
  DSH_TOOL_NOT_STARTED,
  DSH_TOOL_OUTCOME_UNKNOWN,
  type DshHistoryEntryType,
  type DshLogEvent,
  type DshToolResultBlock,
  PI_BRANCH_SUMMARY_PREFIX,
  PI_BRANCH_SUMMARY_SUFFIX,
  REVIEW_PATCH_MAX_LENGTH,
} from './types.ts';

/** Same bound as the pi projection (`legacyPiSession/timeline.ts`). */
const TOOL_OUTPUT_LIMIT = 4_000;
/** Mirrors the live projector's and the pi projection's wording for a call that never ran. */
const NOT_STARTED_ERROR = 'The run ended before this call started.';
/** What a result carrying only images reads as. */
const IMAGE_ONLY_OUTPUT = '(image)';

/**
 * The system note of a turn the engine never closed itself (decision 032):
 * DSH appends `turn/end {kind:'interrupted'}` when it resumes or cold-reads a
 * log whose last turn was open. English here, translated by the renderer
 * through `notice.key`.
 */
export const INTERRUPTED_TURN_NOTICE_KEY =
  'This turn was interrupted when the engine stopped unexpectedly.';

/**
 * The imported-history banner of a migrated session (P1-9 `aiclient/legacy-provenance`).
 * Must stay the key `legacyPiSession/timeline.ts` uses, so both render one
 * dictionary entry; `projection.test.ts` compares them.
 */
export const IMPORTED_HISTORY_NOTICE_KEY =
  'This history was imported from a {{sourceKind}} session ({{sourceSessionId}}). You can keep talking here; the original run state — tools, permissions — did not come across.';

const CONTEXT_SUMMARY_TITLE = 'Context summary';
const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/** Block-id kinds `dshHistoryEntryType` reads back; the projection mints them. */
const SUMMARY_PART = 'summary';

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timeOf(event: DshLogEvent): number | undefined {
  return typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined;
}

function blocksOf(content: unknown): Row[] {
  return Array.isArray(content)
    ? content.map(recordOf).filter((block): block is Row => block !== null)
    : [];
}

function textOf(content: unknown): string {
  return blocksOf(content)
    .flatMap((block) =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
    )
    .join('');
}

function partId(messageId: string, kind: string, suffix: string | number): string {
  return `${messageId}:${kind}:${suffix}`;
}

function historyId(id: string): HistoryMessage['id'] {
  return `h:${id}`;
}

/**
 * `aiclient/<name>` and `plugin:aiclient/<name>` alike (decision 053): the
 * ignorable events a migration seed carries, before and after DSH's format
 * migration renames an unknown ignorable type to `plugin:<type>`.
 */
export function aiclientEventName(type: string): string | undefined {
  if (type.startsWith('aiclient/')) return type.slice('aiclient/'.length) || undefined;
  if (type.startsWith('plugin:aiclient/'))
    return type.slice('plugin:aiclient/'.length) || undefined;
  return undefined;
}

/** A tree node's `entryType`, read back off the part ids this projection mints. */
export function dshHistoryEntryType(message: HistoryMessage): DshHistoryEntryType {
  if (message.role !== 'system') return 'message';
  const first = message.blocks[0];
  return first && first.id === partId(message.id, SUMMARY_PART, 0) ? 'compaction' : 'notice';
}

function attachmentsOf(content: unknown): HistoryAttachment[] {
  return blocksOf(content).flatMap((block): HistoryAttachment[] => {
    const attachment = recordOf(block.attachment);
    const name = stringOf(attachment?.name);
    if (block.type === 'image') {
      return [
        {
          kind: 'image',
          mediaType: stringOf(attachment?.mediaType) ?? 'image/*',
          ...(name ? { name } : {}),
        },
      ];
    }
    // DSH's verbatim file block. This app merges text attachments into the
    // prompt and writes none; a session from elsewhere may carry them.
    if (block.type === 'file') {
      return [{ kind: 'text', mediaType: 'text/plain', ...(name ? { name } : {}) }];
    }
    return [];
  });
}

function toolOutputOf(content: unknown): string {
  const text = textOf(content);
  if (text) {
    return text.length <= TOOL_OUTPUT_LIMIT
      ? text
      : `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n[truncated]`;
  }
  return blocksOf(content).some((block) => block.type === 'image') ? IMAGE_ONLY_OUTPUT : '';
}

/** The summary inside a `compact-checkpoint` node, without DSH's framing prose. */
function checkpointSummary(content: unknown): string {
  const text = textOf(content);
  const open = text.indexOf(SUMMARY_OPEN_TAG);
  const close = text.lastIndexOf(SUMMARY_CLOSE_TAG);
  return (
    open >= 0 && close > open ? text.slice(open + SUMMARY_OPEN_TAG.length, close) : text
  ).trim();
}

/**
 * The summary inside a migrated pi branch summary, without pi's framing: the
 * text 1.0.x showed under "Context summary".
 */
function piBranchSummary(content: unknown): string {
  const text = textOf(content);
  if (
    text.startsWith(PI_BRANCH_SUMMARY_PREFIX) &&
    text.endsWith(PI_BRANCH_SUMMARY_SUFFIX) &&
    text.length >= PI_BRANCH_SUMMARY_PREFIX.length + PI_BRANCH_SUMMARY_SUFFIX.length
  ) {
    return text.slice(PI_BRANCH_SUMMARY_PREFIX.length, -PI_BRANCH_SUMMARY_SUFFIX.length);
  }
  const open = text.indexOf('<summary>');
  const close = text.lastIndexOf(PI_BRANCH_SUMMARY_SUFFIX);
  return (open >= 0 && close > open ? text.slice(open + '<summary>'.length, close) : text).trim();
}

/**
 * `tool/result.meta.aiclient.piDetails`: the `details` of a migrated pi tool
 * result (P1-9, decision 076), the flags a 1.0.x row was read by.
 */
// Indexed by a constant: a `.aiclient` member access reads as the legacy
// app-state dir to the defaultPaths guard.
const AICLIENT_META_KEY = 'aiclient';

function piDetailsOf(meta: unknown): Row | null {
  return recordOf(recordOf(recordOf(meta)?.[AICLIENT_META_KEY])?.piDetails);
}

const REVIEW_STATUSES: ReadonlySet<unknown> = new Set(['added', 'modified', 'unknown']);
const REVIEW_UNAVAILABLE: ReadonlySet<unknown> = new Set(['too-large', 'binary', 'unreadable']);

/**
 * A recorded file change, validated as `parseSessionFileChange` does (without
 * zod, which this library may not load): anything off-shape is no review at
 * all, and unknown keys are dropped.
 */
function reviewOf(value: unknown): SessionFileChange | undefined {
  const review = recordOf(value);
  if (!review || review.version !== 1) return undefined;
  const { path, status, patch, unavailable } = review;
  if (typeof path !== 'string' || path.length === 0 || !REVIEW_STATUSES.has(status))
    return undefined;
  if (patch !== undefined && (typeof patch !== 'string' || patch.length > REVIEW_PATCH_MAX_LENGTH))
    return undefined;
  if (unavailable !== undefined && !REVIEW_UNAVAILABLE.has(unavailable)) return undefined;
  return {
    version: 1,
    path,
    status: status as SessionFileChange['status'],
    ...(patch !== undefined ? { patch } : {}),
    ...(unavailable !== undefined
      ? { unavailable: unavailable as NonNullable<SessionFileChange['unavailable']> }
      : {}),
  };
}

/** The user's own reasons for an `aborted` turn; every other cause carries none. */
function stopCauseOf(reason: Row | null): TurnStopCause | undefined {
  const cause = recordOf(reason?.reason);
  if (cause?.kind === 'user') return 'user_stop';
  if (cause?.kind === 'hook' && cause.reason === AICLIENT_INTERJECT_REASON) return 'interjected';
  return undefined;
}

function foldSettledAt(message: HistoryMessage, stamp: number | undefined): HistoryMessage {
  if (stamp === undefined) return message;
  const latest = message.settledAt ?? message.timestamp;
  if (latest !== undefined && stamp <= latest) return message;
  return { ...message, settledAt: stamp };
}

interface Entry {
  message: HistoryMessage;
  hidden: boolean;
}

interface TurnState {
  readonly turn: number;
  /** Id synthesized rows of this turn hang off: its first message, of any source. */
  anchor: string;
  anchored: boolean;
  /** A human prompt or a retry continuation already said what this turn is. */
  decided: boolean;
  /** Entry indexes of this turn's step messages, in order. */
  readonly steps: number[];
  /** Calls of this turn with no result yet. */
  readonly open: Set<string>;
}

/**
 * The incremental projection. Push every event of one DSH session in seq
 * order; `messages()` is the timeline so far. An event it does not know is
 * skipped, so a newer DSH vocabulary costs rows, never the read.
 */
export class DshHistoryFold {
  private readonly entries: Entry[] = [];
  /** Tool call id -> the entry of the step that asked for it. */
  private readonly callOwner = new Map<string, number>();
  private readonly callNames = new Map<string, string>();
  private turn: TurnState | null = null;
  /** Placeholder and note entries of the last closed turn; a retry hides them. */
  private retryHideable: number[] = [];
  private lastSeq = -1;
  private view: HistoryMessage[] | null = null;

  /** Seq of the last event pushed, -1 before any. */
  get cursor(): number {
    return this.lastSeq;
  }

  /** The visible timeline, oldest first. Do not mutate: the array is reused until the next push. */
  messages(): readonly HistoryMessage[] {
    this.view ??= this.entries.filter((entry) => !entry.hidden).map((entry) => entry.message);
    return this.view;
  }

  push(event: DshLogEvent): void {
    if (typeof event?.type !== 'string') return;
    if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq)) this.lastSeq = event.seq;
    this.view = null;
    switch (event.type) {
      case 'turn/start':
        this.openTurn(event);
        return;
      case 'user/message':
        this.onUserMessage(event);
        return;
      case 'assistant/message':
        this.onAssistantMessage(event);
        return;
      case 'tool/call':
        this.onToolCall(event);
        return;
      case 'tool/result':
        this.onToolResult(event);
        return;
      case 'turn/end':
        this.onTurnEnd(event);
        return;
      default: {
        const name = aiclientEventName(event.type);
        if (name) this.onAiclientEvent(name, event);
      }
    }
  }

  // ---- turns ------------------------------------------------------------------

  private openTurn(event: DshLogEvent): void {
    const turn = Number(recordOf(event.data)?.turn);
    this.turn = {
      turn,
      // Replaced by the turn's first message; kept only by a turn that never had one.
      anchor: `turn-${Number.isFinite(turn) ? turn : 'x'}-seq-${event.seq}`,
      anchored: false,
      decided: false,
      steps: [],
      open: new Set(),
    };
  }

  private currentTurn(event: DshLogEvent): TurnState {
    if (!this.turn) this.openTurn({ ...event, data: {} });
    return this.turn as TurnState;
  }

  /** The first human prompt or retry continuation of a turn settles the last turn's placeholders. */
  private decide(retry: boolean): void {
    if (this.turn?.decided) return;
    if (this.turn) this.turn.decided = true;
    if (retry) for (const index of this.retryHideable) this.hide(index);
    this.retryHideable = [];
  }

  private onTurnEnd(event: DshLogEvent): void {
    const turn = this.currentTurn(event);
    const time = timeOf(event);
    this.settleOpenCalls(turn);
    const reason = recordOf(recordOf(event.data)?.reason);
    const kind = reason?.kind;
    const last = turn.steps.at(-1);
    const hideable: number[] = [];
    if (kind === 'aborted') {
      const cause = stopCauseOf(reason);
      if (last !== undefined) {
        if (cause)
          this.update(last, (message) => foldSettledAt({ ...message, stopCause: cause }, time));
      } else if (turn.anchored) {
        hideable.push(
          this.append({
            id: historyId(`${turn.anchor}:end`),
            entryId: `${turn.anchor}:end`,
            role: 'assistant',
            ...(time !== undefined ? { timestamp: time } : {}),
            blocks: [],
            incomplete: true,
            stopReason: 'aborted',
            ...(cause ? { stopCause: cause } : {}),
          })
        );
      }
    } else if (kind === 'error') {
      // DSH records the failed call as `assistant/attempt`, outside model
      // history, so nothing stands for it yet.
      if (turn.anchored) {
        hideable.push(
          this.append({
            id: historyId(`${turn.anchor}:end`),
            entryId: `${turn.anchor}:end`,
            role: 'assistant',
            ...(time !== undefined ? { timestamp: time } : {}),
            blocks: [],
            incomplete: true,
            stopReason: 'error',
          })
        );
      }
    } else if (kind === 'interrupted') {
      if (last !== undefined) {
        this.update(last, (message) => ({
          ...message,
          incomplete: true,
          stopReason: message.stopReason ?? 'interrupted',
        }));
      }
      if (turn.anchored) {
        const id = historyId(`${turn.anchor}:interrupted`);
        hideable.push(
          this.append({
            id,
            entryId: `${turn.anchor}:interrupted`,
            role: 'system',
            ...(time !== undefined ? { timestamp: time } : {}),
            blocks: [
              {
                type: 'text',
                id: partId(id, 'interrupted', 0),
                text: INTERRUPTED_TURN_NOTICE_KEY,
                notice: { key: INTERRUPTED_TURN_NOTICE_KEY },
              },
            ],
          })
        );
      }
    } else if (kind === 'max-tokens' && last !== undefined) {
      this.update(last, (message) => ({ ...message, stopReason: 'length' }));
    }
    // `completed`, `blocked` and `forked` add nothing.
    this.retryHideable = hideable;
    this.turn = null;
  }

  /** Calls a closed step left without a result: they never ran (as the pi projection says). */
  private settleOpenCalls(turn: TurnState): void {
    for (const callId of turn.open) {
      const owner = this.callOwner.get(callId);
      if (owner === undefined) continue;
      this.update(owner, (message) => ({
        ...message,
        blocks: [
          ...message.blocks,
          {
            type: 'tool_result',
            id: partId(message.id, 'tool-result', callId),
            toolCallId: callId,
            ok: false,
            error: NOT_STARTED_ERROR,
            notStarted: true,
          },
        ],
      }));
    }
    turn.open.clear();
  }

  // ---- messages -----------------------------------------------------------------

  private onUserMessage(event: DshLogEvent): void {
    const message = recordOf(event.data);
    if (!message) return;
    const rawId = stringOf(message.id) ?? `seq-${event.seq}`;
    const id = historyId(rawId);
    const time = timeOf(event);
    const source = recordOf(message.source);
    const kind = stringOf(source?.kind);
    const turn = this.turn;
    if (turn && !turn.anchored) {
      turn.anchor = rawId;
      turn.anchored = true;
    }
    if (kind === DSH_SOURCE_AICLIENT_RETRY) {
      this.decide(true);
      return;
    }
    if (kind === DSH_SOURCE_USER) {
      this.decide(false);
      const text = textOf(message.content);
      const attachments = attachmentsOf(message.content);
      this.append({
        id,
        entryId: rawId,
        role: 'user',
        ...(time !== undefined ? { timestamp: time } : {}),
        blocks: text ? [{ type: 'text', id: partId(id, 'text', 0), text }] : [],
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      return;
    }
    if (kind === DSH_SOURCE_COMPACT_CHECKPOINT) {
      // The earlier messages it shadows stay on the timeline: the timeline is
      // what was said, not what the model still sees.
      const summary = checkpointSummary(message.content);
      this.append({
        id,
        entryId: rawId,
        role: 'system',
        ...(time !== undefined ? { timestamp: time } : {}),
        blocks: [
          {
            type: 'text',
            id: partId(id, SUMMARY_PART, 0),
            text: summary ? `${CONTEXT_SUMMARY_TITLE}\n\n${summary}` : CONTEXT_SUMMARY_TITLE,
          },
        ],
      });
      return;
    }
    if (kind === DSH_SOURCE_AICLIENT_PI_BRANCH_SUMMARY) {
      // 1.0.x showed a branch summary as a context summary, and skipped an empty one.
      const summary = piBranchSummary(message.content);
      if (!summary) return;
      this.append({
        id,
        entryId: rawId,
        role: 'system',
        ...(time !== undefined ? { timestamp: time } : {}),
        blocks: [
          {
            type: 'text',
            id: partId(id, SUMMARY_PART, 0),
            text: `${CONTEXT_SUMMARY_TITLE}\n\n${summary}`,
          },
        ],
      });
      return;
    }
    if (source?.form === DSH_FORM_NOTICE) {
      // A background job or goal account, one line (`source.summary`, at most 120 chars).
      const text = stringOf(source.summary) ?? textOf(message.content);
      if (!text) return;
      this.append({
        id,
        entryId: rawId,
        role: 'system',
        ...(time !== undefined ? { timestamp: time } : {}),
        blocks: [{ type: 'text', id: partId(id, 'notice', 0), text }],
      });
    }
    // Every other source is model context (runtime snapshots, instructions,
    // catalogs, goal rounds, reminders) and stays off the timeline.
  }

  private onAssistantMessage(event: DshLogEvent): void {
    const data = recordOf(event.data);
    const message = recordOf(data?.message);
    if (!data || !message) return;
    const rawId = stringOf(message.id) ?? `seq-${event.seq}`;
    const id = historyId(rawId);
    const time = timeOf(event);
    const index = this.entries.length;
    const turn = this.currentTurn(event);
    const blocks: HistoryBlock[] = [];
    blocksOf(message.content).forEach((block, position) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        blocks.push({ type: 'text', id: partId(id, 'text', position), text: block.text });
      } else if (block.type === 'reasoning' && typeof block.text === 'string') {
        blocks.push({ type: 'thinking', id: partId(id, 'thinking', position), text: block.text });
      } else if (block.type === 'tool-call') {
        const callId = stringOf(block.id) ?? `${rawId}-${position}`;
        const name = stringOf(block.name) ?? 'tool';
        blocks.push({
          type: 'tool_call',
          id: partId(id, 'tool-call', callId),
          toolCallId: callId,
          name,
          input: toolRowInput(parseToolArguments(block.arguments)),
        });
        this.callOwner.set(callId, index);
        this.callNames.set(callId, name);
        turn.open.add(callId);
      }
    });
    const source = recordOf(message.source);
    const provider = stringOf(source?.provider);
    const model = stringOf(source?.model);
    this.append({
      id,
      entryId: rawId,
      role: 'assistant',
      ...(time !== undefined ? { timestamp: time } : {}),
      ...(model ? { model: provider ? `${provider}/${model}` : model } : {}),
      blocks,
      // A turn cancelled mid-stream keeps what had streamed, marked so.
      ...(data.interrupted === true ? { incomplete: true, stopReason: 'aborted' } : {}),
    });
    turn.steps.push(index);
  }

  private onToolCall(event: DshLogEvent): void {
    const data = recordOf(event.data);
    const callId = stringOf(data?.callId);
    const name = stringOf(data?.name);
    if (callId && name && !this.callNames.has(callId)) this.callNames.set(callId, name);
  }

  private onToolResult(event: DshLogEvent): void {
    const data = recordOf(event.data);
    const message = recordOf(data?.message);
    if (!data || !message) return;
    const rawId = stringOf(message.id) ?? `seq-${event.seq}`;
    const id = historyId(rawId);
    const time = timeOf(event);
    const callId =
      stringOf(message.toolCallId) ?? stringOf(recordOf(message.source)?.callId) ?? `${rawId}-call`;
    const code = stringOf(recordOf(data.error)?.code);
    const failed = message.isError === true;
    const output = toolOutputOf(message.content);
    // A migrated pi result keeps the flags 1.0.x read off its `details`.
    const details = piDetailsOf(data.meta);
    const review = failed ? undefined : reviewOf(details?.review);
    const result: DshToolResultBlock = {
      type: 'tool_result',
      id: partId(id, 'tool-result', callId),
      toolCallId: callId,
      ok: !failed,
      ...(output ? { output } : {}),
      ...(review ? { review } : {}),
      ...(!failed && typeof details?.patch === 'string' ? { patch: details.patch } : {}),
      ...(failed ? { error: output || 'Tool call failed' } : {}),
      ...(details?.refused === true ? { refused: true as const } : {}),
      ...(code === DSH_TOOL_ABORTED_BEFORE_DISPATCH || code === DSH_TOOL_NOT_STARTED
        ? { notStarted: true as const }
        : {}),
      ...(code === DSH_TOOL_OUTCOME_UNKNOWN ? { outcomeUnknown: true as const } : {}),
      ...(code === DSH_TOOL_ABORTED ||
      recordOf(data.meta)?.aborted === true ||
      details?.stopped === true
        ? { stopped: true as const }
        : {}),
    };
    this.turn?.open.delete(callId);
    const owner = this.callOwner.get(callId);
    if (owner !== undefined) {
      // The result's date is when the call FINISHED; nothing later may record it.
      this.update(owner, (message) =>
        foldSettledAt({ ...message, blocks: [...message.blocks, result] }, time)
      );
      return;
    }
    this.append({
      id,
      entryId: rawId,
      role: 'assistant',
      ...(time !== undefined ? { timestamp: time } : {}),
      blocks: [
        {
          type: 'tool_call',
          id: partId(id, 'tool-call', callId),
          toolCallId: callId,
          name: this.callNames.get(callId) ?? 'tool',
        },
        result,
      ],
    });
  }

  // ---- migration seeds (decision 053) ---------------------------------------------

  private onAiclientEvent(name: string, event: DshLogEvent): void {
    const data = recordOf(event.data);
    // The pi entry id the seed carries (decision 076 rule 3), so the row keeps
    // the id the preview gave it; a row without one is keyed by its seq.
    const rawId = stringOf(data?.entryId) ?? `aiclient-${name}-${event.seq}`;
    const id = historyId(rawId);
    const time = timeOf(event);
    const stamp = time !== undefined ? { timestamp: time } : {};
    if (name === 'legacy-provenance') {
      // Same rendering as the pi projection's `aiclient.legacy-import.provenance`.
      const sourceSessionId = stringOf(data?.sourceSessionId) ?? 'unknown';
      const sourceKind = stringOf(data?.sourceKind) ?? 'legacy';
      this.append({
        id,
        entryId: rawId,
        role: 'system',
        ...stamp,
        blocks: [
          {
            type: 'text',
            id: partId(id, 'provenance', 0),
            text: IMPORTED_HISTORY_NOTICE_KEY.replace('{{sourceKind}}', sourceKind).replace(
              '{{sourceSessionId}}',
              sourceSessionId
            ),
            notice: { key: IMPORTED_HISTORY_NOTICE_KEY, params: { sourceKind, sourceSessionId } },
          },
        ],
      });
      return;
    }
    if (name === 'legacy-display') {
      // Same rendering as the pi projection's `aiclient.legacy-import.display`.
      const title = stringOf(data?.title) ?? 'Legacy history';
      if (data?.displayKind === 'tool') {
        const toolCallId = stringOf(data.toolCallId) ?? `${rawId}-display`;
        const output = typeof data.output === 'string' ? data.output : undefined;
        this.append({
          id,
          entryId: rawId,
          role: 'assistant',
          ...stamp,
          blocks: [
            {
              type: 'tool_call',
              id: partId(id, 'legacy-tool-call', 0),
              toolCallId,
              name: stringOf(data.toolName) ?? title,
              ...(data.input !== undefined ? { input: data.input } : {}),
            },
            {
              type: 'tool_result',
              id: partId(id, 'legacy-tool-result', 0),
              toolCallId,
              ok: data.isError !== true,
              ...(output ? (data.isError === true ? { error: output } : { output }) : {}),
            },
          ],
        });
        return;
      }
      const body = typeof data?.body === 'string' ? data.body : '';
      this.append({
        id,
        entryId: rawId,
        role: 'system',
        ...stamp,
        blocks: [
          {
            type: 'text',
            id: partId(id, 'legacy-display', 0),
            text: body ? `${title}\n\n${body}` : title,
          },
        ],
      });
    }
    // `pi-entry`, `pi-label`, `pi-subagent` and names this build does not
    // know are kept in the log for the record and never shown.
  }

  // ---- entries --------------------------------------------------------------------

  private append(message: HistoryMessage): number {
    this.entries.push({ message, hidden: false });
    return this.entries.length - 1;
  }

  /** Replaces, never mutates: a timeline already handed out stays as it was. */
  private update(index: number, change: (message: HistoryMessage) => HistoryMessage): void {
    const entry = this.entries[index];
    if (entry) entry.message = change(entry.message);
  }

  private hide(index: number): void {
    const entry = this.entries[index];
    if (entry) entry.hidden = true;
  }
}

/** The whole timeline of one DSH session log (events in seq order). */
export function projectDshHistory(events: Iterable<DshLogEvent>): HistoryMessage[] {
  const fold = new DshHistoryFold();
  for (const event of events) fold.push(event);
  return [...fold.messages()];
}
