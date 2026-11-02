/**
 * Chat search (docs/plantree/plans/chat-search README §3): find a
 * conversation by what was said in it.
 *
 * Owns the freshness of the message cache (`ChatSearchStore`) and answers
 * `chatSearch.query`. The session index (`SessionIndexService`) stays the
 * authority on which chats exist, what they are called and when they last
 * changed; this only remembers, per session, the `updatedAt` its rows were
 * read under.
 *
 * - **Backfill** starts with the first query: every listed, unarchived session
 *   whose stored `updatedAt` differs from the index is read again, newest
 *   first, one at a time with a pause between, and a session that fails is
 *   logged and skipped until it changes. Queries never wait for it; they
 *   answer from what is indexed so far and report `indexing` progress.
 * - **Incremental**: once active, a turn that ends (`session.completed`,
 *   `failed`, `stopped`) re-reads that session a moment later.
 * - Archived, deleted and hidden sessions are dropped from the cache and
 *   never searched.
 */

import { resolveAgentWireName } from '@shared/types/agentWire';
import type {
  ChatSearchProgress,
  ChatSearchQuery,
  ChatSearchResult,
  ChatSearchSessionResult,
} from '@shared/types/chatSearch';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { canonicalPathKey } from '@shared/utils/path';
import type { ChatSearchStore, MessageHit } from './ChatSearchStore';
import type { IndexedMessage } from './extract';
import { type ChatSearchEngine, engineOf } from './sessionReader';
import { buildSnippet, containsText, findMatch } from './snippet';

export const CHAT_SEARCH_DEFAULT_LIMIT = 50;
export const CHAT_SEARCH_MAX_LIMIT = 200;
/** Pause between two sessions of a backfill. */
const DEFAULT_BACKFILL_DELAY_MS = 150;
/** Wait after a turn ends before re-reading the session, so its last lines are on disk. */
const DEFAULT_SETTLE_DELAY_MS = 2_000;
/** How long a DSH read waits for a busy host before it goes ahead anyway. */
const HOST_BUSY_POLL_MS = 1_000;
const HOST_BUSY_MAX_WAIT_MS = 30_000;

export interface ChatSearchIndexDeps {
  store: ChatSearchStore;
  /** The rows the sidebar lists (`sessionIndexService.listForDisplay`). */
  listSessions(): Promise<SessionIndexEntry[]>;
  /** One row by id (`sessionIndexService.get`). */
  getSession(sessionId: string): Promise<SessionIndexEntry | undefined>;
  /** One session's searchable messages; throws when it cannot be read. */
  readMessages(row: SessionIndexEntry): Promise<IndexedMessage[]>;
  /** True while the DSH host is starting or running a turn: DSH reads wait (bounded). */
  hostBusy?(): boolean;
  backfillDelayMs?: number;
  settleDelayMs?: number;
  sleep?(ms: number): Promise<void>;
  log?(line: string, error?: unknown): void;
}

interface PendingItem {
  sessionId: string;
  /** Counted in `indexing` progress (backfill); an incremental re-read is not. */
  counted: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** A row this build lists and may search: a known engine binding, not archived. */
function searchable(row: SessionIndexEntry): boolean {
  return !row.archived && engineOf(row) !== null;
}

/** A row a query may show (title matches need no stored messages). */
function listable(row: SessionIndexEntry): boolean {
  return !row.archived && resolveAgentWireName(row.agent) !== null;
}

function inScope(row: SessionIndexEntry, query: ChatSearchQuery): boolean {
  if (query.scope.kind === 'all') return true;
  return canonicalPathKey(row.workspacePath) === canonicalPathKey(query.scope.workspacePath);
}

export function normalizeLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return CHAT_SEARCH_DEFAULT_LIMIT;
  return Math.min(CHAT_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export class ChatSearchIndex {
  private readonly deps: ChatSearchIndexDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string, error?: unknown) => void;
  private active = false;
  /** sessionId → `updatedAt` its stored rows were read under; null until loaded. */
  private stored: Map<string, number> | null = null;
  private loadingStored: Promise<Map<string, number>> | null = null;
  /** sessionId → `updatedAt` whose read failed; retried once the session changes. */
  private readonly failed = new Map<string, number>();
  private readonly pending = new Map<string, PendingItem>();
  private worker: Promise<void> | null = null;
  private inFlight: PendingItem | null = null;
  private progress = { done: 0, total: 0 };
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(deps: ChatSearchIndexDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log ?? ((line, error) => console.warn(`[chat-search] ${line}`, error ?? ''));
    deps.store.onReset = () => {
      // The rows are gone: forget what was stored, re-read on the next query.
      this.stored = new Map();
      this.failed.clear();
    };
  }

  // ---- query -------------------------------------------------------------------

  async query(query: ChatSearchQuery): Promise<ChatSearchResult> {
    this.active = true;
    const rows = await this.deps.listSessions();
    await this.sync(rows).catch((error) =>
      this.log('cannot compare the cache with the index', error)
    );

    const text = typeof query.text === 'string' ? query.text.trim() : '';
    if (!text) return { sessions: [], truncated: false, indexing: this.indexing() };

    const shown = new Map<string, SessionIndexEntry>();
    for (const row of rows) if (listable(row) && inScope(row, query)) shown.set(row.sessionId, row);

    let hits: MessageHit[] = [];
    try {
      hits = await this.deps.store.findMessages(text);
    } catch (error) {
      this.log('message search failed', error);
    }
    const bySession = new Map<string, MessageHit[]>();
    for (const hit of hits) {
      if (!shown.has(hit.sessionId)) continue;
      const list = bySession.get(hit.sessionId) ?? [];
      list.push(hit);
      bySession.set(hit.sessionId, list);
    }

    const matched: Array<{ row: SessionIndexEntry; titleMatch: boolean; hits: MessageHit[] }> = [];
    for (const row of shown.values()) {
      const sessionHits = bySession.get(row.sessionId) ?? [];
      const titleMatch = containsText(row.title ?? '', text);
      if (!titleMatch && sessionHits.length === 0) continue;
      sessionHits.sort((a, b) => a.ord - b.ord);
      matched.push({ row, titleMatch, hits: sessionHits });
    }
    matched.sort(
      (a, b) => Number(b.titleMatch) - Number(a.titleMatch) || b.row.updatedAt - a.row.updatedAt
    );
    const limit = normalizeLimit(query.limit);
    const page = matched.slice(0, limit);

    let bodies = new Map<number, string>();
    try {
      bodies = await this.deps.store.bodies(
        page.flatMap((entry) => (entry.hits[0] ? [entry.hits[0].id] : []))
      );
    } catch (error) {
      this.log('cannot read snippets', error);
    }

    const sessions: ChatSearchSessionResult[] = page.map(({ row, titleMatch, hits: list }) => {
      const first = list[0];
      const body = first ? bodies.get(first.id) : undefined;
      return {
        sessionId: row.sessionId,
        title: row.title,
        workspacePath: row.unbound ? null : row.workspacePath || null,
        updatedAt: row.updatedAt,
        titleMatch,
        snippet:
          first && body !== undefined
            ? buildSnippet(body, first.role, findMatch(body, text))
            : null,
        hitCount: list.length,
        messageKeys: list.map((hit) => hit.messageKey),
      };
    });
    return { sessions, truncated: matched.length > limit, indexing: this.indexing() };
  }

  /** Non-null while sessions counted in the current backfill are still waiting. */
  indexing(): ChatSearchProgress | null {
    if (this.progress.total === 0) return null;
    return { done: this.progress.done, total: this.progress.total };
  }

  // ---- incremental -------------------------------------------------------------

  /** Fed every runtime event (the path `SessionIndexService.handleRuntimeEvent` rides). */
  handleRuntimeEvent(event: RuntimeEvent): void {
    if (!this.active || this.disposed || !event.sessionId) return;
    if (
      event.type !== 'session.completed' &&
      event.type !== 'session.failed' &&
      event.type !== 'session.stopped'
    ) {
      return;
    }
    const sessionId = event.sessionId;
    const previous = this.settleTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.settleTimers.delete(sessionId);
      this.enqueue(sessionId, false, true);
    }, this.deps.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS);
    timer.unref?.();
    this.settleTimers.set(sessionId, timer);
  }

  /** Waits for the worker to drain (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.worker) await this.worker;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
    this.pending.clear();
  }

  // ---- freshness ---------------------------------------------------------------

  private async storedStates(): Promise<Map<string, number>> {
    if (this.stored) return this.stored;
    if (!this.loadingStored) {
      this.loadingStored = this.deps.store
        .sessionStates()
        .then((states) => {
          this.stored = new Map(states.map((state) => [state.sessionId, state.updatedAt]));
          return this.stored;
        })
        .finally(() => {
          this.loadingStored = null;
        });
    }
    return this.loadingStored;
  }

  /** Drop what left the list, queue what is missing or out of date. */
  private async sync(rows: readonly SessionIndexEntry[]): Promise<void> {
    const stored = await this.storedStates();
    const keep = new Map<string, SessionIndexEntry>();
    for (const row of rows) if (searchable(row)) keep.set(row.sessionId, row);
    const gone = [...stored.keys()].filter((id) => !keep.has(id));
    if (gone.length > 0) {
      for (const id of gone) stored.delete(id);
      await this.deps.store.removeSessions(gone);
    }
    const stale = [...keep.values()]
      .filter(
        (row) =>
          stored.get(row.sessionId) !== row.updatedAt &&
          this.failed.get(row.sessionId) !== row.updatedAt
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const row of stale) this.enqueue(row.sessionId, true, false);
  }

  private enqueue(sessionId: string, counted: boolean, front: boolean): void {
    if (this.disposed) return;
    if (this.inFlight?.sessionId === sessionId && !front) return;
    const existing = this.pending.get(sessionId);
    if (existing) {
      if (!front) return;
      // Move it to the front, keeping whether it counts.
      this.pending.delete(sessionId);
      const entries = [...this.pending.entries()];
      this.pending.clear();
      this.pending.set(sessionId, existing);
      for (const [id, item] of entries) this.pending.set(id, item);
      return;
    }
    const item: PendingItem = { sessionId, counted };
    if (counted) this.progress.total += 1;
    if (front) {
      const entries = [...this.pending.entries()];
      this.pending.clear();
      this.pending.set(sessionId, item);
      for (const [id, other] of entries) this.pending.set(id, other);
    } else {
      this.pending.set(sessionId, item);
    }
    this.startWorker();
  }

  private startWorker(): void {
    if (this.worker) return;
    this.worker = this.drain().finally(() => {
      this.worker = null;
      const counted = [...this.pending.values()].filter((item) => item.counted).length;
      this.progress = { done: 0, total: counted };
      if (this.pending.size > 0 && !this.disposed) this.startWorker();
    });
  }

  private async drain(): Promise<void> {
    let first = true;
    while (!this.disposed) {
      const next = this.pending.values().next();
      if (next.done) return;
      const item = next.value;
      this.pending.delete(item.sessionId);
      if (!first) await this.sleep(this.deps.backfillDelayMs ?? DEFAULT_BACKFILL_DELAY_MS);
      first = false;
      this.inFlight = item;
      try {
        await this.indexOne(item.sessionId);
      } finally {
        this.inFlight = null;
        if (item.counted) this.progress.done += 1;
      }
    }
  }

  private async indexOne(sessionId: string): Promise<void> {
    const stored = await this.storedStates();
    const row = await this.deps.getSession(sessionId);
    if (!row || !searchable(row)) {
      if (stored.has(sessionId)) {
        stored.delete(sessionId);
        await this.deps.store.removeSessions([sessionId]).catch((error) => {
          this.log(`cannot drop session ${sessionId}`, error);
        });
      }
      return;
    }
    // Captured before the read: a turn that ends meanwhile leaves the row stale, not lost.
    const updatedAt = row.updatedAt;
    if (stored.get(sessionId) === updatedAt) return;
    const engine = engineOf(row) as ChatSearchEngine;
    if (engine === 'dsh') await this.waitForHost();
    let messages: IndexedMessage[];
    try {
      messages = await this.deps.readMessages(row);
    } catch (error) {
      this.failed.set(sessionId, updatedAt);
      this.log(`skipped session ${sessionId} (${engine}): its history could not be read`, error);
      return;
    }
    try {
      await this.deps.store.replaceSession(sessionId, updatedAt, messages);
      this.stored?.set(sessionId, updatedAt);
      this.failed.delete(sessionId);
    } catch (error) {
      this.log(`cannot store session ${sessionId}`, error);
    }
  }

  private async waitForHost(): Promise<void> {
    const busy = this.deps.hostBusy;
    if (!busy) return;
    let waited = 0;
    while (busy() && waited < HOST_BUSY_MAX_WAIT_MS && !this.disposed) {
      await this.sleep(HOST_BUSY_POLL_MS);
      waited += HOST_BUSY_POLL_MS;
    }
  }
}
