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
 *
 * Decision 173 (issue #9): beside the timeline it folds the session's prompt
 * cache chain (`shared/cacheChain.ts`), from the same events in the same
 * order, when given the routes' options. Kept here because this cache lives as
 * long as the session does — across turns, which the live translation's state
 * does not — and every read of a reopened session starts from its fold of the
 * whole log. The chain is the plain JSON state `restoreCacheChain` reads; it
 * is rebuilt from the log at every read, never restored, and leaves the
 * timeline untouched.
 *
 * Decision 193 §10: the same way, the usage of the session's compaction
 * summaries (`dshAuxiliaryUsage.ts`), which the token meter's total leaves out.
 * Decision 198: and the subagents its catalog names (`childSessions`), whose
 * own logs `delegatedUsage.ts` folds.
 */

import {
  applyCacheChain,
  type CacheChainOptions,
  type CacheChainState,
  type CacheChainTotals,
  type CacheChainView,
  type CacheStepVerdict,
  foldCacheChain,
  initCacheChain,
  viewCacheChain,
} from '../../shared/cacheChain.ts';
import {
  type AuxiliaryUsage,
  applyAuxiliaryUsage,
  emptyAuxiliaryUsage,
  foldAuxiliaryUsage,
} from '../../shared/dshAuxiliaryUsage.ts';
import { catalogChildOf } from '../../shared/dshDelegatedUsage.ts';
import { paginateHistory } from '../../shared/dshHistory/page.ts';
import { DshHistoryFold } from '../../shared/dshHistory/projection.ts';
import { buildDshSessionTree, dshLeafCheckpoint } from '../../shared/dshHistory/tree.ts';
import type { DshLogEvent } from '../../shared/dshHistory/types.ts';
import type { DshToolPresenter } from '../../shared/dshToolPresentation.ts';
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
  /** How many of `events` were copied from the session this one was forked from. */
  readonly inheritedEventCount?: number;
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

/** A step's cache verdict, with the session's totals as of it. */
export interface DshCacheStep {
  readonly verdict: CacheStepVerdict;
  readonly totals: Readonly<CacheChainTotals>;
}

export class DshHistoryCache {
  private readonly query: DshSessionQuery;
  private readonly log: (...args: unknown[]) => void;
  /** Decision 131: the live rows' own presenter, so a plugin call replays with its title. */
  private readonly presentCall: DshToolPresenter | undefined;
  /** Decision 173: what the plan says of each route's cache; absent, no chain is kept. */
  private readonly chainOptions: CacheChainOptions | undefined;
  /** Decision 179: the instructions each `/compact` summarized with, by compaction. */
  private readonly compactInstructions: ((compactionId: string) => string | undefined) | undefined;
  /** Decision 180: what was typed after each `/compact`, for its command line. */
  private readonly compactCommandInstructions:
    | ((compactionId: string) => string | undefined)
    | undefined;
  private sessionId = '';
  private fold = new DshHistoryFold();
  /** Decision 173: the session's cache chain, at the fold's cursor; undefined when not kept. */
  private chain: CacheChainState | undefined;
  /** The step the last appended event recorded, by that event's seq. */
  private lastStep: { seq: number; verdict: CacheStepVerdict } | undefined;
  /** Decision 193 §10: the logged usage of requests outside the agent loop, at the fold's cursor. */
  private auxiliary: AuxiliaryUsage = emptyAuxiliaryUsage();
  /**
   * Decision 198: the subagents the log's catalog names, in order, inherited
   * entries included — the token meter's total counts an inherited step too,
   * so a rewind keeps what was delegated before its cut.
   */
  private children: string[] = [];
  private state: CacheState = 'empty';
  /** Events delivered while an observation is in flight. */
  private pending: DshLogEvent[] = [];
  private loading: Promise<void> | null = null;
  private generation = 0;

  constructor(
    query: DshSessionQuery,
    log: (...args: unknown[]) => void = () => undefined,
    presentCall?: DshToolPresenter,
    chainOptions?: CacheChainOptions,
    compactInstructions?: (compactionId: string) => string | undefined,
    compactCommandInstructions?: (compactionId: string) => string | undefined
  ) {
    this.query = query;
    this.log = log;
    this.presentCall = presentCall;
    this.chainOptions = chainOptions;
    this.compactInstructions = compactInstructions;
    this.compactCommandInstructions = compactCommandInstructions;
  }

  /** Starts over for `sessionId`; call `load` once the session is open. */
  reset(sessionId: string): void {
    this.generation += 1;
    this.sessionId = sessionId;
    this.fold = this.newFold();
    this.chain = this.chainOptions ? initCacheChain() : undefined;
    this.lastStep = undefined;
    this.auxiliary = emptyAuxiliaryUsage();
    this.children = [];
    this.state = 'empty';
    this.pending = [];
    this.loading = null;
  }

  /**
   * Rows name the ids this session's live events gave them (P1-4d1), a
   * plugin call the title its live row carried (decision 131), a `/compact`
   * summary the instructions it was written with (decision 179), and its
   * command line what was typed (decision 180).
   */
  private newFold(): DshHistoryFold {
    return new DshHistoryFold({
      liveSessionId: this.sessionId,
      ...(this.presentCall ? { presentCall: this.presentCall } : {}),
      ...(this.compactInstructions ? { compactInstructions: this.compactInstructions } : {}),
      ...(this.compactCommandInstructions
        ? { compactCommandInstructions: this.compactCommandInstructions }
        : {}),
    });
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

  /** Model steps with provider-reported usage so far (P1-4d1: the session total's turn count). */
  usageSteps(): number {
    return this.fold.usageSteps;
  }

  /**
   * Decision 193 §10: what the log records of the session's requests outside
   * the agent loop (its compaction summaries), as a copy.
   */
  auxiliaryUsage(): AuxiliaryUsage {
    return { ...this.auxiliary };
  }

  /** Decision 198: the session's subagents its log names, as a copy. */
  childSessions(): readonly string[] {
    return [...this.children];
  }

  /** The current goal's round budget, when the log recorded one (P1-4d1: a goal head's origin). */
  goalMaxRounds(): number | undefined {
    return this.fold.goalMaxRounds;
  }

  /** How the session's last turn ended (`turn/end.reason.kind`); undefined before any did (P1-4c1). */
  lastTurnEnd(): string | undefined {
    return this.fold.lastTurnEnd;
  }

  /**
   * Decision 173: the cache verdict of the step the event at `seq` recorded,
   * when that event is the last one folded — the live translation asks right
   * after `push`. Undefined when no chain is kept, the event recorded no step,
   * or it was not folded one at a time (a read in flight buffered it, a gap
   * dropped it).
   */
  cacheStep(seq: number): DshCacheStep | undefined {
    const chain = this.chain;
    const last = this.lastStep;
    if (!chain || last?.seq !== seq) return undefined;
    return { verdict: last.verdict, totals: viewCacheChain(chain).totals };
  }

  /** Decision 173: the session's cache chain as of the fold's cursor; undefined when none is kept. */
  cacheChainView(): CacheChainView | undefined {
    return this.chain ? viewCacheChain(this.chain) : undefined;
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
      const fold = this.newFold();
      for (const event of observation.events) fold.push(event);
      this.fold = fold;
      this.chain = this.foldChain(observation.events);
      this.lastStep = undefined;
      this.auxiliary = foldAuxiliaryUsage(observation.events);
      this.children = [];
      for (const event of observation.events) this.noteChild(event);
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
    this.applyChain(event);
    applyAuxiliaryUsage(this.auxiliary, event);
    this.noteChild(event);
    return true;
  }

  private noteChild(event: DshLogEvent): void {
    const childId = catalogChildOf(event);
    if (childId && !this.children.includes(childId)) this.children.push(childId);
  }

  /** Decision 173: the chain of a whole log, or undefined when none is kept or it cannot be folded. */
  private foldChain(events: readonly DshLogEvent[]): CacheChainState | undefined {
    if (!this.chainOptions) return undefined;
    try {
      return foldCacheChain(events, this.chainOptions);
    } catch (error) {
      this.log('[dsh-bridge] cache chain not folded', this.sessionId, error);
      return undefined;
    }
  }

  /** One more event of the chain. A failure costs the chain until the next read, never the timeline. */
  private applyChain(event: DshLogEvent): void {
    const chain = this.chain;
    if (!chain || !this.chainOptions) return;
    try {
      const verdict = applyCacheChain(chain, event, this.chainOptions);
      if (verdict) this.lastStep = { seq: event.seq, verdict };
    } catch (error) {
      this.chain = undefined;
      this.lastStep = undefined;
      this.log('[dsh-bridge] cache chain dropped', this.sessionId, error);
    }
  }
}
