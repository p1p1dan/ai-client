/**
 * The DSH sessions one chat has been (dsh-rebase P1-4b, decisions 026 and
 * 027): the stub's `lineage`, the ids a rewind mints, and the timelines of
 * the retired sessions the session tree merges with the current one.
 *
 * A rewind leaves what it cut off in the session it retires; nothing ever
 * appends to a retired session again, so its projection is read once (a cold
 * `observeSession`, no lock, no write) and kept. Only what the tree shows is
 * kept: role, ids, time and a text prefix, not tool output.
 */

import { DshHistoryFold } from '../../shared/dshHistory/projection.ts';
import type { DshLogEvent } from '../../shared/dshHistory/types.ts';
import type { HistoryMessage } from '../../shared/types/sessionHistory.ts';
import type { DshSessionQuery } from './historyCache.ts';
import type { SessionLineageEntry } from './stub.ts';

/** First suffix a rewind mints: `aiclient-<logical id>_r2` (plan P1-4 shard 03 §3). */
const FIRST_REWIND = 2;
/** Text a retired node keeps; the tree previews 96 characters. */
const RETIRED_TEXT_MAX = 400;

/**
 * The separators of a minted suffix, newest first: `_` since P1-9c (decision
 * 121), because DSH's projection cache keys a session by its id and refuses
 * one with a dot (`dsh-storage-json`: `[a-zA-Z0-9_-]`), leaving it stale;
 * `.` in the lineages written before, which are still read.
 */
const SUFFIX_SEPARATORS = ['_', '.'] as const;

/** One past the highest `<base><sep><letter><n>` in `ids`, and never below `first`. */
export function nextSuffixNumber(
  base: string,
  letter: string,
  ids: Iterable<string>,
  first: number
): number {
  let highest = first - 1;
  for (const id of ids) {
    for (const separator of SUFFIX_SEPARATORS) {
      const prefix = `${base}${separator}${letter}`;
      if (!id.startsWith(prefix)) continue;
      const tail = id.slice(prefix.length);
      const n = /^[1-9][0-9]*$/.test(tail) ? Number(tail) : Number.NaN;
      if (Number.isSafeInteger(n) && n > highest) highest = n;
    }
  }
  return highest + 1;
}

/**
 * The id of the `attempt`-th candidate for a rewind of `base`
 * (`aiclient-<logical id>`): one past the highest `_r<n>` (or legacy `.r<n>`)
 * of the lineage. A failed rewind can leave its child on disk under the next
 * id, so the caller moves on to the following one when DSH says it already
 * exists.
 */
export function rewindSessionId(
  base: string,
  lineage: readonly SessionLineageEntry[],
  attempt = 0
): string {
  const next = nextSuffixNumber(
    base,
    'r',
    lineage.map((entry) => entry.dshSessionId),
    FIRST_REWIND
  );
  return `${base}_r${next + attempt}`;
}

/** The retired sessions of a lineage, oldest first, each once, never the current one. */
export function retiredSessionIds(
  lineage: readonly SessionLineageEntry[],
  current: string
): string[] {
  const ids: string[] = [];
  for (const entry of lineage) {
    if (entry.dshSessionId !== current && !ids.includes(entry.dshSessionId)) {
      ids.push(entry.dshSessionId);
    }
  }
  return ids;
}

/** What the tree reads of a message: ids, role, time, and the start of its text. */
export function treeOnlyMessage(message: HistoryMessage): HistoryMessage {
  return {
    id: message.id,
    ...(message.entryId !== undefined ? { entryId: message.entryId } : {}),
    role: message.role,
    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
    blocks: message.blocks.flatMap((block) =>
      block.type === 'text' ? [{ ...block, text: block.text.slice(0, RETIRED_TEXT_MAX) }] : []
    ),
  };
}

/** A timeline, the way the retired cache keeps it. */
export function treeOnlyTimeline(messages: readonly HistoryMessage[]): HistoryMessage[] {
  return messages.map(treeOnlyMessage);
}

/** Every event of one DSH session, copied out of the observation. */
export async function readSessionEvents(
  query: DshSessionQuery,
  dshSessionId: string
): Promise<DshLogEvent[]> {
  const observation = await query.observeSession(dshSessionId, { projectionMode: 'none' });
  try {
    return [...observation.events];
  } finally {
    observation[Symbol.dispose]?.();
  }
}

export interface RetiredChain {
  readonly dshSessionId: string;
  readonly messages: readonly HistoryMessage[];
}

/** The projected timelines of retired sessions, by DSH session id. */
export class DshRetiredHistory {
  private readonly query: DshSessionQuery;
  private readonly log: (...args: unknown[]) => void;
  private readonly timelines = new Map<string, readonly HistoryMessage[]>();

  constructor(query: DshSessionQuery, log: (...args: unknown[]) => void = () => undefined) {
    this.query = query;
    this.log = log;
  }

  /** A session a rewind just retired: its timeline is already folded. */
  remember(dshSessionId: string, messages: readonly HistoryMessage[]): void {
    this.timelines.set(dshSessionId, treeOnlyTimeline(messages));
  }

  /**
   * The timelines of `ids`, in that order. A session that cannot be read is
   * left out, and tried again next time: a missing branch beats a failed tree.
   */
  async chains(ids: readonly string[]): Promise<RetiredChain[]> {
    const chains: RetiredChain[] = [];
    for (const dshSessionId of ids) {
      let messages = this.timelines.get(dshSessionId);
      if (!messages) {
        try {
          const fold = new DshHistoryFold();
          for (const event of await readSessionEvents(this.query, dshSessionId)) fold.push(event);
          messages = treeOnlyTimeline(fold.messages());
          this.timelines.set(dshSessionId, messages);
        } catch (error) {
          this.log('[dsh-bridge] retired session unreadable', dshSessionId, error);
          continue;
        }
      }
      chains.push({ dshSessionId, messages });
    }
    return chains;
  }
}
