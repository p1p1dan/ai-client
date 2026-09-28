/**
 * The bridge's copy of its session's timeline (dsh-rebase P1-4a, decision 026).
 *
 * Main reads the history when it opens a session and the tree after every
 * turn (to persist the leaf), so the projection is kept rather than rebuilt:
 * one full fold of the log through `ctx.sessionQuery.observeSession` (the live
 * session's snapshot; it never takes a lock or writes), then one event at a
 * time from `session/event`. `initialHistory`, `worker.history`, `worker.tree`
 * and the leaf all read this cache.
 *
 * Only events that arrive while the log is being read are buffered: anything
 * earlier is in the observation, and after a gap the next read starts over
 * from a fresh observation instead of trusting a fold that missed an event.
 */

import { paginateHistory } from '../../shared/dshHistory/page.ts';
import { DshHistoryFold } from '../../shared/dshHistory/projection.ts';
import { buildDshSessionTree, dshLeafCheckpoint } from '../../shared/dshHistory/tree.ts';
import type { DshLogEvent } from '../../shared/dshHistory/types.ts';
import type {
  HistoryMessage,
  PiLeafCheckpoint,
  SessionHistoryPage,
  SessionTreeSnapshot,
} from '../../shared/types/sessionHistory.ts';

/** `SessionObservation` (dsh-session-query), narrowed to what is read here. */
export interface DshSessionObservation {
  readonly events: readonly DshLogEvent[];
  /** Last observed seq, -1 for an empty log. */
  readonly cursor: number;
  [Symbol.dispose]?(): void;
}

/** `ctx.sessionQuery`, narrowed to the one exact read the cache needs. */
export interface DshSessionQuery {
  observeSession(
    sessionId: string,
    options?: { projectionMode?: 'all' | 'none' }
  ): Promise<DshSessionObservation>;
}

type CacheState = 'empty' | 'loading' | 'ready' | 'stale';

export class DshHistoryCache {
  private readonly query: DshSessionQuery;
  private readonly log: (...args: unknown[]) => void;
  private sessionId = '';
  private fold = new DshHistoryFold();
  private state: CacheState = 'empty';
  /** Events delivered while an observation is in flight. */
  private pending: DshLogEvent[] = [];
  private loading: Promise<void> | null = null;
  private generation = 0;

  constructor(query: DshSessionQuery, log: (...args: unknown[]) => void = () => undefined) {
    this.query = query;
    this.log = log;
  }

  /** Starts over for `sessionId`; call `load` once the session is open. */
  reset(sessionId: string): void {
    this.generation += 1;
    this.sessionId = sessionId;
    this.fold = new DshHistoryFold();
    this.state = 'empty';
    this.pending = [];
    this.loading = null;
  }

  /** One `session/event` of this session, in the order DSH appended it. */
  push(event: DshLogEvent): void {
    if (this.state === 'loading') this.pending.push(event);
    else if (this.state === 'ready') this.append(event);
    // 'empty' / 'stale': the next observation already holds it.
  }

  /** Reads and folds the whole log. Never throws: a failed read leaves the cache stale, and the next read tries again. */
  load(): Promise<void> {
    if (!this.loading) {
      const loading: Promise<void> = this.loadOnce().finally(() => {
        if (this.loading === loading) this.loading = null;
      });
      this.loading = loading;
    }
    return this.loading;
  }

  /** Whether the cache is current; tries a fresh read first when it is not. */
  async ready(): Promise<boolean> {
    if (this.state !== 'ready') await this.load();
    return this.state === 'ready';
  }

  /** Whether the fold holds the whole log, with no read pending and no gap. */
  isCurrent(): boolean {
    return this.state === 'ready';
  }

  messages(): readonly HistoryMessage[] {
    return this.fold.messages();
  }

  page(offset?: number, limit?: number): SessionHistoryPage {
    return paginateHistory(this.fold.messages(), offset, limit);
  }

  leaf(): PiLeafCheckpoint {
    return dshLeafCheckpoint(this.fold.messages(), this.sessionId, this.fold.cursor);
  }

  /**
   * The tree of this session merged with `retired`, the timelines of the
   * sessions earlier rewinds left behind (P1-4b, decision 026), oldest first:
   * an inherited prefix shares its ids, the rest becomes sibling branches.
   */
  tree(
    meta: {
      logicalSessionId: string;
      sessionFile: string;
      workspacePath: string;
    },
    retired: ReadonlyArray<readonly HistoryMessage[]> = []
  ): SessionTreeSnapshot {
    return buildDshSessionTree({
      ...meta,
      chains: [
        ...retired.map((messages) => ({ messages, current: false })),
        { messages: this.fold.messages(), current: true },
      ],
      leaf: this.leaf(),
    });
  }

  private async loadOnce(): Promise<void> {
    const generation = this.generation;
    const sessionId = this.sessionId;
    this.state = 'loading';
    this.pending = [];
    let observation: DshSessionObservation | undefined;
    try {
      observation = await this.query.observeSession(sessionId, { projectionMode: 'none' });
      if (generation !== this.generation) return;
      const fold = new DshHistoryFold();
      for (const event of observation.events) fold.push(event);
      this.fold = fold;
      this.state = 'ready';
      const pending = this.pending;
      this.pending = [];
      for (const event of pending) {
        if (!this.append(event)) break;
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.state = 'stale';
      this.pending = [];
      this.log('[dsh-bridge] history read failed', sessionId, error);
    } finally {
      observation?.[Symbol.dispose]?.();
    }
  }

  /** Folds one event after the log; false when one went missing and the fold is stale. */
  private append(event: DshLogEvent): boolean {
    const cursor = this.fold.cursor;
    if (event.seq <= cursor) return true;
    if (event.seq !== cursor + 1) {
      this.state = 'stale';
      this.log('[dsh-bridge] history gap', this.sessionId, `after ${cursor}`, `got ${event.seq}`);
      return false;
    }
    this.fold.push(event);
    return true;
  }
}
