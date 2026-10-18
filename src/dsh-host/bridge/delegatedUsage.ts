/**
 * What the session's subagents spent, kept current for its settled usage
 * (dsh-rebase decision 198; runtime-hardening decision 005).
 *
 * Every delegate is a DSH session of its own, so its spend is in its own log
 * (`shared/dshDelegatedUsage.ts` folds one). This module follows the
 * session's delegates — the children its log's catalog names (`adopt`, the
 * history cache's `childSessions`), and theirs, down the catalogs of their
 * logs — and keeps each one's fold:
 *
 *   - once, from the whole log: `ctx.sessionQuery.observeSession`, one read
 *     at a time (a reopened session reads its children cold, from disk);
 *   - then one event at a time, from `session/event` (`onSessionEvent`);
 *     events that arrive while the log is read are held and folded after
 *     it; a gap starts a fresh read.
 *
 * Nothing is kept anywhere else: a reopened session, or a host restart,
 * computes the same figure from the same logs. A child whose log cannot be
 * read counts nothing until a read succeeds.
 *
 * `view` is synchronous (the settled usage is built inside `session/event`)
 * and is what was folded so far: a child still being read is not in it yet,
 * a child mid-run is in it up to its last settled request.
 */

import {
  applySessionSpend,
  type DshDelegatedSpend,
  type DshSessionSpend,
  foldSessionSpend,
  sumDelegatedSpend,
} from '../../shared/dshDelegatedUsage.ts';
import type { DshLogEvent } from '../../shared/dshHistory/types.ts';
import type { DshSessionQuery } from './historyCache.ts';

/** Delegated sessions followed per session; past it a new one is left out (and logged once). */
export const DELEGATED_SESSIONS_MAX = 256;
/** Events held for one delegate while its log is read; past it the read is redone. */
export const DELEGATED_PENDING_MAX = 2_000;
/** Failed reads in a row after which a delegate's log is given up on. */
export const DELEGATED_READ_FAILURES_MAX = 3;

interface Delegate {
  readonly id: string;
  /** The fold as of `cursor`; undefined until the first read lands. */
  spend: DshSessionSpend | undefined;
  /** Last event seq folded, -1 before any. */
  cursor: number;
  /** A read is queued or in flight; live events wait in `pending`. */
  reading: boolean;
  pending: DshLogEvent[];
  /** The held events overflowed: read again once this read lands. */
  reread: boolean;
  /** Failed reads in a row. */
  failures: number;
}

export class DshDelegatedUsage {
  private readonly query: DshSessionQuery;
  private readonly log: (...args: unknown[]) => void;
  private root = '';
  private generation = 0;
  private readonly delegates = new Map<string, Delegate>();
  private full = false;
  /** One read at a time: a reopened session with many children must not read them all at once. */
  private queue: Promise<void> = Promise.resolve();

  constructor(query: DshSessionQuery, log: (...args: unknown[]) => void = () => undefined) {
    this.query = query;
    this.log = log;
  }

  /** A new session to follow (bootstrap, rewind), or none (dispose): its delegates start over. */
  reset(rootSessionId: string): void {
    this.generation += 1;
    this.root = rootSessionId;
    this.delegates.clear();
    this.full = false;
  }

  /** Children the session's own log names; known ones are kept as they are. */
  adopt(childIds: Iterable<string>): void {
    if (!this.root) return;
    for (const id of childIds) this.follow(id);
  }

  /** A durable event of some other session: a delegate's is folded, any other is ignored. */
  onSessionEvent(sessionId: string, event: DshLogEvent): void {
    const delegate = this.delegates.get(sessionId);
    if (!delegate) return;
    if (delegate.reading) {
      if (delegate.pending.length >= DELEGATED_PENDING_MAX) {
        delegate.pending = [];
        delegate.reread = true;
      } else if (!delegate.reread) {
        delegate.pending.push(event);
      }
      return;
    }
    this.append(delegate, event);
  }

  /** What the delegates folded so far spent; undefined when none reported anything. */
  view(): DshDelegatedSpend | undefined {
    const folds: DshSessionSpend[] = [];
    for (const delegate of this.delegates.values()) if (delegate.spend) folds.push(delegate.spend);
    return sumDelegatedSpend(folds);
  }

  /** Resolves once every read queued so far has landed (tests, probes). */
  settled(): Promise<void> {
    return this.queue;
  }

  private follow(id: string): void {
    if (!id || id === this.root || this.delegates.has(id)) return;
    if (this.delegates.size >= DELEGATED_SESSIONS_MAX) {
      if (!this.full) this.log('[dsh-bridge] delegated usage: too many subagents, not all counted');
      this.full = true;
      return;
    }
    const delegate: Delegate = {
      id,
      spend: undefined,
      cursor: -1,
      reading: false,
      pending: [],
      reread: false,
      failures: 0,
    };
    this.delegates.set(id, delegate);
    this.read(delegate);
  }

  private read(delegate: Delegate): void {
    delegate.reading = true;
    const generation = this.generation;
    this.queue = this.queue.then(() => this.readOnce(delegate, generation));
  }

  private async readOnce(delegate: Delegate, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    let observation: Awaited<ReturnType<DshSessionQuery['observeSession']>> | undefined;
    try {
      observation = await this.query.observeSession(delegate.id, { projectionMode: 'none' });
      if (generation !== this.generation) return;
      const spend = foldSessionSpend(observation.events, observation.inheritedEventCount ?? 0);
      delegate.spend = spend;
      delegate.cursor = observation.cursor;
      delegate.reading = false;
      delegate.failures = 0;
      const pending = delegate.pending;
      delegate.pending = [];
      if (delegate.reread) {
        delegate.reread = false;
        this.read(delegate);
      } else {
        for (const event of pending) {
          if (!this.append(delegate, event)) break;
        }
      }
      for (const child of spend.children) this.follow(child);
    } catch (error) {
      if (generation !== this.generation) return;
      delegate.reading = false;
      delegate.pending = [];
      delegate.reread = false;
      delegate.failures += 1;
      this.log('[dsh-bridge] delegated usage: subagent log unreadable', delegate.id, error);
    } finally {
      observation?.[Symbol.dispose]?.();
    }
  }

  /**
   * Folds one event after the log; false when it cannot be (a gap, or no
   * fold yet) and a fresh read was started instead, unless the log has
   * failed too often to try again. What was folded stays counted meanwhile.
   */
  private append(delegate: Delegate, event: DshLogEvent): boolean {
    const spend = delegate.spend;
    if (spend && event.seq <= delegate.cursor) return true;
    if (!spend || event.seq !== delegate.cursor + 1) {
      if (spend) {
        this.log(
          '[dsh-bridge] delegated usage: gap',
          delegate.id,
          `after ${delegate.cursor}`,
          `got ${event.seq}`
        );
      }
      if (delegate.failures < DELEGATED_READ_FAILURES_MAX) this.read(delegate);
      return false;
    }
    const known = spend.children.length;
    applySessionSpend(spend, event);
    delegate.cursor = event.seq;
    for (const child of spend.children.slice(known)) this.follow(child);
    return true;
  }
}
