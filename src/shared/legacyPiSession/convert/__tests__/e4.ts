// New in dsh-rebase P1-9b

/**
 * E4 (plan P1-9 shard 05 §1): what a migrated session shows and sends,
 * compared with what 1.0.x showed and sent for the same file.
 *
 * - `compareHistories`: the pi projection (`projectPiSessionHistory`, the
 *   preview) against the DSH projection of the seed (`projectDshHistory`),
 *   message by message and block by block.
 * - `compareContexts`: the model context 1.0.x built (`buildSessionContext`
 *   over the successful messages, through `convertToLlm`) against the seed's
 *   surface, message by message.
 *
 * Every difference is given a category naming why it is expected (a
 * decision, or a projection rule P1-4 still has to add); one this file
 * cannot name is returned with `category: undefined`, and the corpus test
 * fails on it.
 */

import { INTERRUPTED_TURN_NOTICE_KEY } from '../../../dshHistory/projection.ts';
import type { HistoryBlock, HistoryMessage } from '../../../types/sessionHistory.ts';
import type { AgentMessage } from '../../types.ts';
import { seedSurface } from '../invariants.ts';
import { convertToLlm } from '../llmText.ts';
import { OUTCOME_UNKNOWN_TEXT } from '../seed.ts';
import { type DshSeedEvent, SEED_SOURCE_KIND } from '../types.ts';

export interface E4Diff {
  /** Why the difference is expected; undefined when nothing explains it. */
  category: string | undefined;
  id: string;
  field: string;
  pi?: unknown;
  dsh?: unknown;
}

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

const FAILURE_REASONS = new Set(['aborted', 'error', 'interrupted', 'length']);

/** Ignorable rows the DSH projection keys by seq; their data carries the pi entry id. */
function legacyRowAliases(seed: readonly DshSeedEvent[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const event of seed) {
    const entryId = recordOf(event.data)?.entryId;
    if (event.ignorable && typeof entryId === 'string')
      aliases.set(
        `h:aiclient-${event.type.slice('aiclient/'.length)}-${event.seq}`,
        `h:${entryId}`
      );
  }
  return aliases;
}

function realias(message: HistoryMessage, aliases: Map<string, string>): HistoryMessage {
  const alias = aliases.get(message.id);
  if (!alias) return message;
  const swap = (id: string) =>
    id.startsWith(message.id) ? alias + id.slice(message.id.length) : id;
  return {
    ...message,
    id: alias as HistoryMessage['id'],
    entryId: alias.slice(2),
    blocks: message.blocks.map((block) => ({ ...block, id: swap(block.id) })) as HistoryBlock[],
  };
}

function hasBody(message: HistoryMessage): boolean {
  return message.blocks.some(
    (block) => (block.type === 'text' || block.type === 'thinking') && Boolean(block.text.trim())
  );
}

function classifyOnlyPi(message: HistoryMessage, piKinds: Map<string, string>): string | undefined {
  const kind = piKinds.get(message.entryId ?? '');
  if (message.role === 'assistant' && message.stopReason === 'error') return 'failed-reply-body';
  if (message.role === 'assistant' && message.stopReason === 'aborted' && !hasBody(message))
    return 'stopped-reply-without-text';
  if (kind === 'branch_summary') return 'branch-summary-row';
  if (kind === 'message:toolResult') return 'orphan-result';
  return undefined;
}

function classifyOnlyDsh(message: HistoryMessage): string | undefined {
  const first = message.blocks[0];
  if (
    message.id.endsWith(':interrupted') &&
    first?.type === 'text' &&
    first.notice?.key === INTERRUPTED_TURN_NOTICE_KEY
  )
    return 'interrupted-turn-notice';
  if (message.id.endsWith(':end') && message.stopReason === 'error')
    return 'failed-reply-placeholder';
  if (message.id.endsWith(':end') && message.stopReason === 'aborted')
    return 'stopped-before-reply-placeholder';
  return undefined;
}

function blockKey(block: HistoryBlock): string {
  return block.type === 'tool_call' || block.type === 'tool_result'
    ? `${block.type}:${block.toolCallId}`
    : block.id;
}

function classifyBlock(
  field: string,
  pi: Row | undefined,
  dsh: Row | undefined,
  owner: HistoryMessage
): string | undefined {
  if (pi && !dsh && pi.type === 'tool_result' && pi.notStarted === true) return 'stripped-call';
  if (pi && !dsh && pi.type === 'tool_call' && owner.stopReason === 'aborted')
    return 'stripped-call';
  if (!pi && dsh?.type === 'tool_result' && dsh.outcomeUnknown === true) return 'outcome-unknown';
  if (!pi || !dsh) return undefined;
  if (['review', 'patch', 'refused', 'stopped'].includes(field) && dsh[field] === undefined)
    return 'tool-result-details';
  if (field === 'outcomeUnknown' && dsh.outcomeUnknown === true) return 'outcome-unknown';
  if (field === 'text' && typeof pi.text === 'string' && pi.text.trim() === String(dsh.text).trim())
    return 'summary-trim';
  if (field === 'text' && owner.role === 'system' && String(pi.text).startsWith('Context summary'))
    return 'summary-trim';
  if (field === 'input') {
    const piInput = recordOf(pi.input);
    const dshInput = recordOf(dsh.input);
    if (piInput && dshInput && dshInput.path === piInput.file_path) return 'tool-input-alias';
  }
  if (field === 'output' && dsh.output === '(image)') return 'image-only-output';
  return undefined;
}

function classifyField(
  field: string,
  dsh: HistoryMessage,
  turnEnds: Map<string, string>
): string | undefined {
  const end = turnEnds.get(dsh.id);
  if ((field === 'incomplete' || field === 'stopReason') && end === 'interrupted')
    return 'interrupted-turn';
  if (field === 'stopReason' && dsh.stopReason === 'length') return 'max-tokens-turn';
  if (field === 'settledAt' && end === 'interrupted') return 'interrupted-turn';
  return undefined;
}

/**
 * The reason each assistant row's turn ended, by row id (`h:<message id>`),
 * so a field changed by the turn's end can be told apart from one that is not.
 */
function turnEndsByMessage(seed: readonly DshSeedEvent[]): Map<string, string> {
  const ends = new Map<string, string>();
  let rows: string[] = [];
  for (const event of seed) {
    const data = recordOf(event.data);
    if (event.type === 'turn/start') rows = [];
    if (event.type === 'assistant/message') {
      const id = recordOf(data?.message)?.id;
      if (typeof id === 'string') rows.push(`h:${id}`);
    }
    if (event.type === 'turn/end') {
      const kind = String(recordOf(data?.reason)?.kind);
      for (const row of rows) ends.set(row, kind);
    }
  }
  return ends;
}

/** pi entry kind by entry id, for naming a row only the pi projection has. */
export type PiEntryKinds = Map<string, string>;

export function compareHistories(
  piRows: readonly HistoryMessage[],
  dshRows: readonly HistoryMessage[],
  seed: readonly DshSeedEvent[],
  piKinds: PiEntryKinds
): E4Diff[] {
  const aliases = legacyRowAliases(seed);
  const turnEnds = turnEndsByMessage(seed);
  const diffs: E4Diff[] = [];
  const dsh = dshRows.map((message) => realias(message, aliases));
  for (const message of dshRows)
    if (aliases.has(message.id))
      diffs.push({
        category: 'legacy-row-id',
        id: aliases.get(message.id) as string,
        field: 'id',
        dsh: message.id,
      });
  const dshById = new Map(dsh.map((message) => [message.id, message]));
  const piById = new Map(piRows.map((message) => [message.id, message]));
  // Order: the rows both sides have must come in the same order.
  const shared = piRows.filter((message) => dshById.has(message.id)).map((message) => message.id);
  const dshShared = dsh.filter((message) => piById.has(message.id)).map((message) => message.id);
  if (shared.join('\n') !== dshShared.join('\n'))
    diffs.push({ category: undefined, id: '*', field: 'order', pi: shared, dsh: dshShared });
  for (const message of piRows)
    if (!dshById.has(message.id))
      diffs.push({
        category: classifyOnlyPi(message, piKinds),
        id: message.id,
        field: 'message',
        pi: message.role,
      });
  for (const message of dsh)
    if (!piById.has(message.id))
      diffs.push({
        category: classifyOnlyDsh(message),
        id: message.id,
        field: 'message',
        dsh: message.role,
      });
  for (const pi of piRows) {
    const other = dshById.get(pi.id);
    if (!other) continue;
    const piFields = { ...pi } as Row;
    const dshFields = { ...other } as Row;
    // Replies that ended normally: DSH keeps no per-message stop reason.
    if (typeof piFields.stopReason === 'string' && !FAILURE_REASONS.has(piFields.stopReason))
      delete piFields.stopReason;
    for (const field of new Set([...Object.keys(piFields), ...Object.keys(dshFields)])) {
      if (field === 'blocks') continue;
      if (JSON.stringify(piFields[field]) === JSON.stringify(dshFields[field])) continue;
      diffs.push({
        category: classifyField(field, other, turnEnds),
        id: pi.id,
        field,
        pi: piFields[field],
        dsh: dshFields[field],
      });
    }
    const piBlocks = new Map(pi.blocks.map((block) => [blockKey(block), block as unknown as Row]));
    const dshBlocks = new Map(
      other.blocks.map((block) => [blockKey(block), block as unknown as Row])
    );
    const piKeys = pi.blocks.map(blockKey).filter((key) => dshBlocks.has(key));
    const dshKeys = other.blocks.map(blockKey).filter((key) => piBlocks.has(key));
    if (piKeys.join('\n') !== dshKeys.join('\n'))
      diffs.push({
        category: undefined,
        id: pi.id,
        field: 'block-order',
        pi: piKeys,
        dsh: dshKeys,
      });
    for (const key of new Set([...piBlocks.keys(), ...dshBlocks.keys()])) {
      const a = piBlocks.get(key);
      const b = dshBlocks.get(key);
      if (!a || !b) {
        diffs.push({
          category: classifyBlock('block', a, b, pi),
          id: pi.id,
          field: `block ${key}`,
          pi: a?.type,
          dsh: b?.type,
        });
        continue;
      }
      for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[field]) === JSON.stringify(b[field])) continue;
        diffs.push({
          category: classifyBlock(field, a, b, pi),
          id: pi.id,
          field: `block ${key}.${field}`,
          pi: a[field],
          dsh: b[field],
        });
      }
    }
  }
  return diffs;
}

// ---- model context ------------------------------------------------------------------

function contentParts(content: unknown): string[] {
  if (typeof content === 'string') return [`t:${content}`];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const block = recordOf(part);
    if (block?.type === 'text' && typeof block.text === 'string') return [`t:${block.text}`];
    if (block?.type === 'image') return ['[image]'];
    return [];
  });
}

/** One line per message the model receives, keyed so both sides spell it alike. */
export function piContextLines(messages: readonly AgentMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === 'compactionSummary') return [`summary:${message.summary}`];
    return convertToLlm([message]).map((llm) => {
      if (llm.role === 'user') return `user:${contentParts(llm.content).join('|')}`;
      if (llm.role === 'toolResult')
        return `tool:${llm.toolCallId}:${llm.isError === true}:${contentParts(llm.content).join('|')}`;
      return `assistant:${llm.content
        .map((block) =>
          block.type === 'text'
            ? `t:${block.text}`
            : block.type === 'thinking'
              ? `r:${block.thinking}`
              : `c:${block.id}:${block.name}`
        )
        .join('|')}`;
    });
  });
}

/** The context line of one surface event (see `piContextLines`). */
function eventLines(event: DshSeedEvent): string[] {
  const data = recordOf(event.data) ?? {};
  const message = event.type === 'user/message' ? data : (recordOf(data.message) ?? {});
  const content = Array.isArray(message.content) ? message.content : [];
  if (event.type === 'system/message') return content.length === 0 ? [] : ['system'];
  if (event.type === 'user/message') {
    if (recordOf(message.source)?.kind === SEED_SOURCE_KIND.checkpoint)
      return [`summary:${String(recordOf(content[1])?.text)}`];
    return [`user:${contentParts(content).join('|')}`];
  }
  if (event.type === 'tool/result')
    return [
      `tool:${String(message.toolCallId)}:${message.isError === true}:${contentParts(content).join('|')}`,
    ];
  return [
    `assistant:${content
      .map((part) => {
        const block = recordOf(part) ?? {};
        return block.type === 'text'
          ? `t:${String(block.text)}`
          : block.type === 'reasoning'
            ? `r:${String(block.text)}`
            : `c:${String(block.id)}:${String(block.name)}`;
      })
      .join('|')}`,
  ];
}

export function seedContextLines(seed: readonly DshSeedEvent[]): string[] {
  return seedSurface(seed).flatMap((seq) => eventLines(seed[seq] as DshSeedEvent));
}

export interface ContextDiff {
  category: string | undefined;
  side: 'pi' | 'dsh';
  line: string;
}

/** Lines only one side has (longest common subsequence), each with its reason. */
export function compareContexts(
  pi: readonly string[],
  dsh: readonly string[],
  seed: readonly DshSeedEvent[]
): ContextDiff[] {
  const lengths: number[][] = Array.from({ length: pi.length + 1 }, () =>
    new Array(dsh.length + 1).fill(0)
  );
  for (let i = pi.length - 1; i >= 0; i -= 1)
    for (let j = dsh.length - 1; j >= 0; j -= 1)
      lengths[i]![j] =
        pi[i] === dsh[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const interruptedLines = new Set(
    seed
      .filter(
        (event) => event.type === 'assistant/message' && recordOf(event.data)?.interrupted === true
      )
      .flatMap(eventLines)
  );
  const diffs: ContextDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < pi.length || j < dsh.length) {
    if (i < pi.length && j < dsh.length && pi[i] === dsh[j]) {
      i += 1;
      j += 1;
    } else if (j < dsh.length && (i >= pi.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) {
      const line = dsh[j] as string;
      diffs.push({
        side: 'dsh',
        line,
        category:
          line.startsWith('assistant:') && interruptedLines.has(line)
            ? 'interrupted-reply'
            : line.endsWith(`:true:t:${OUTCOME_UNKNOWN_TEXT}`)
              ? 'dangling-closure'
              : undefined,
      });
      j += 1;
    } else {
      diffs.push({
        side: 'pi',
        line: pi[i] as string,
        category: pi[i]?.startsWith('tool:') ? 'orphan-result' : undefined,
      });
      i += 1;
    }
  }
  return diffs;
}
