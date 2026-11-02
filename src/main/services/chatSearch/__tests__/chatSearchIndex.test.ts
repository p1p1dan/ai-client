import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatSearchQuery } from '@shared/types/chatSearch';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSearchIndex, type ChatSearchIndexDeps } from '../ChatSearchIndex';
import { ChatSearchStore } from '../ChatSearchStore';
import type { IndexedMessage } from '../extract';

/**
 * The index on a real sqlite file: Chinese substrings through FTS5 trigram,
 * short queries through LIKE, case, scope, archived and deleted sessions,
 * freshness by the session index's `updatedAt`, and a cache file that has to
 * be rebuilt.
 */

let dir: string;
let dbPath: string;
let rows: SessionIndexEntry[];
let bodies: Map<string, IndexedMessage[]>;
let reads: string[];
let failing: Set<string>;
let stores: ChatSearchStore[];

function row(sessionId: string, fields: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    sessionId,
    agent: 'dsh',
    runtimeIdentity: `/dsh/aiclient-sessions/${sessionId}.dsh.json`,
    workspacePath: '/repo/a',
    title: `Chat ${sessionId}`,
    updatedAt: 100,
    archived: false,
    ...fields,
  };
}

function say(key: string, role: 'user' | 'assistant', text: string): IndexedMessage {
  return { key, role, text };
}

function makeIndex(overrides: Partial<ChatSearchIndexDeps> = {}): ChatSearchIndex {
  const store = new ChatSearchStore({ dbPath, log: () => {} });
  stores.push(store);
  return new ChatSearchIndex({
    store,
    listSessions: async () => rows.map((r) => ({ ...r })),
    getSession: async (id) => rows.find((r) => r.sessionId === id),
    readMessages: async (r) => {
      reads.push(r.sessionId);
      if (failing.has(r.sessionId)) throw new Error('read failed');
      return bodies.get(r.sessionId) ?? [];
    },
    backfillDelayMs: 0,
    settleDelayMs: 0,
    log: () => {},
    ...overrides,
  });
}

const all = (text: string, limit?: number): ChatSearchQuery => ({
  text,
  scope: { kind: 'all' },
  ...(limit !== undefined ? { limit } : {}),
});

/** First query starts the backfill; the second sees it finished. */
async function built(index: ChatSearchIndex): Promise<void> {
  await index.query(all(''));
  await index.idle();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-search-index-'));
  dbPath = join(dir, 'chat-search.db');
  stores = [];
  reads = [];
  failing = new Set();
  rows = [
    row('s1', { updatedAt: 300, title: '良率周报' }),
    row('s2', { updatedAt: 200, workspacePath: '/repo/B/' }),
    row('s3', { updatedAt: 100 }),
  ];
  bodies = new Map([
    [
      's1',
      [
        say('h:1a', 'user', '帮我看下'),
        say('h:1b', 'assistant', '这是批次良率分析的结果，良率 97%。'),
      ],
    ],
    [
      's2',
      [
        say('h:2a', 'user', 'Where is lot 8GE21E15?'),
        say('h:2b', 'assistant', 'Lot 8ge21e15 shipped.'),
        say('h:2c', 'user', '再查一下良率'),
      ],
    ],
    ['s3', [say('h:3a', 'user', 'nothing to see')]],
  ]);
});

afterEach(async () => {
  for (const store of stores) await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('ChatSearchIndex query', () => {
  it('finds a Chinese substring and groups hits by session, title matches first', async () => {
    const index = makeIndex();
    await built(index);
    const result = await index.query(all('批次良率'));
    expect(result.indexing).toBeNull();
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(result.sessions[0]).toMatchObject({
      titleMatch: false,
      hitCount: 1,
      messageKeys: ['h:1b'],
      snippet: {
        role: 'assistant',
        text: '这是批次良率分析的结果，良率 97%。',
        matchStart: 2,
        matchLength: 4,
      },
    });

    // 「良率」 is two characters: LIKE, and the title of s1 matches too.
    const short = await index.query(all('良率'));
    expect(short.sessions.map((s) => [s.sessionId, s.titleMatch, s.messageKeys])).toEqual([
      ['s1', true, ['h:1b']],
      ['s2', false, ['h:2c']],
    ]);
  });

  it('is case-insensitive, keeps every hit oldest first and returns workspace paths', async () => {
    const index = makeIndex();
    await built(index);
    const result = await index.query(all('  8GE21e15 '));
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: 's2',
      workspacePath: '/repo/B/',
      updatedAt: 200,
      hitCount: 2,
      messageKeys: ['h:2a', 'h:2b'],
      snippet: { role: 'user', text: 'Where is lot 8GE21E15?', matchStart: 13, matchLength: 8 },
    });
    // Short queries fold ASCII case too.
    expect((await index.query(all('LO'))).sessions.map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('answers an empty query with nothing', async () => {
    const index = makeIndex();
    await built(index);
    expect(await index.query(all('   '))).toEqual({
      sessions: [],
      truncated: false,
      indexing: null,
    });
  });

  it('limits the scope to one workspace, compared as the session index compares paths', async () => {
    const index = makeIndex();
    await built(index);
    const scoped = await index.query({
      text: '良率',
      scope: { kind: 'workspace', workspacePath: '/repo/b' },
    });
    expect(scoped.sessions.map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('cuts long messages around the first hit', async () => {
    bodies.set('s3', [say('h:3a', 'user', `${'前'.repeat(100)}NEEDLE\n${'后'.repeat(100)}`)]);
    const index = makeIndex();
    await built(index);
    const [hit] = (await index.query(all('needle'))).sessions;
    expect(hit?.snippet?.text).toBe(`…${'前'.repeat(40)}NEEDLE ${'后'.repeat(79)}…`);
    expect(hit?.snippet?.matchStart).toBe(41);
    expect(hit?.snippet?.matchLength).toBe(6);
  });

  it('sorts by recency and reports truncation past the limit', async () => {
    bodies.set('s3', [say('h:3a', 'user', 'lot again')]);
    const index = makeIndex();
    await built(index);
    const result = await index.query(all('lot', 1));
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s2']);
    expect(result.truncated).toBe(true);
    expect((await index.query(all('lot', 0))).sessions).toHaveLength(1);
    expect((await index.query(all('lot', 999))).truncated).toBe(false);
  });
});

describe('ChatSearchIndex freshness', () => {
  it('never searches archived or deleted sessions, and drops their rows', async () => {
    const index = makeIndex();
    await built(index);
    rows = rows.filter((r) => r.sessionId !== 's2');
    rows[0] = { ...(rows[0] as SessionIndexEntry), archived: true, updatedAt: 301 };
    const result = await index.query(all('良率'));
    expect(result.sessions).toEqual([]);
    await index.idle();
    // Nothing was read again: they are gone, not stale.
    expect(reads).toEqual(['s1', 's2', 's3']);
    expect(await stores[0]?.sessionStates()).toEqual([{ sessionId: 's3', updatedAt: 100 }]);
  });

  it('re-reads only sessions whose updatedAt moved, across restarts', async () => {
    const first = makeIndex();
    await built(first);
    expect(reads).toEqual(['s1', 's2', 's3']);
    await stores[0]?.close();

    reads = [];
    rows[2] = { ...(rows[2] as SessionIndexEntry), updatedAt: 150 };
    bodies.set('s3', [say('h:3b', 'assistant', 'fresh words')]);
    const second = makeIndex();
    const during = await second.query(all('fresh'));
    expect(during.indexing).toMatchObject({ total: 1 });
    await second.idle();
    expect(reads).toEqual(['s3']);
    const after = await second.query(all('fresh'));
    expect(after.indexing).toBeNull();
    expect(after.sessions[0]?.messageKeys).toEqual(['h:3b']);
    expect((await second.query(all('nothing to see'))).sessions).toEqual([]);
  });

  it('skips a session whose read fails until it changes', async () => {
    failing.add('s2');
    const index = makeIndex();
    await built(index);
    expect(reads).toEqual(['s1', 's2', 's3']);
    await index.query(all('x'));
    await index.idle();
    expect(reads).toEqual(['s1', 's2', 's3']);

    failing.clear();
    rows[1] = { ...(rows[1] as SessionIndexEntry), updatedAt: 201 };
    await index.query(all('x'));
    await index.idle();
    expect(reads).toEqual(['s1', 's2', 's3', 's2']);
    expect((await index.query(all('8GE21E15'))).sessions.map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('re-reads a session after its turn ends, once search is in use', async () => {
    const index = makeIndex();
    const event = { type: 'session.completed', sessionId: 's3' } as RuntimeEvent;
    index.handleRuntimeEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reads).toEqual([]);

    await built(index);
    bodies.set('s3', [say('h:3c', 'assistant', 'after the turn')]);
    rows[2] = { ...(rows[2] as SessionIndexEntry), updatedAt: 101 };
    index.handleRuntimeEvent(event);
    await vi.waitFor(() => expect(reads).toEqual(['s1', 's2', 's3', 's3']));
    await index.idle();
    const result = await index.query(all('after the turn'));
    expect(result.sessions[0]?.messageKeys).toEqual(['h:3c']);
    expect(result.indexing).toBeNull();
  });

  it('lets a busy DSH host finish before reading', async () => {
    let busy = true;
    const sleep = vi.fn(async () => {
      busy = false;
    });
    const index = makeIndex({ hostBusy: () => busy, sleep });
    await built(index);
    expect(sleep).toHaveBeenCalled();
    expect(reads).toEqual(['s1', 's2', 's3']);
  });
});

describe('ChatSearchStore recovery', () => {
  it('rebuilds a cache file that is not a database', async () => {
    await writeFile(dbPath, 'this is not sqlite at all, just text '.repeat(200));
    const index = makeIndex();
    await built(index);
    expect(stores[0]?.describe().location).toBe('rebuilt');
    expect((await index.query(all('8GE21E15'))).sessions).toHaveLength(1);
  });

  it('rebuilds a cache file that reads back TSD-encrypted', async () => {
    await writeFile(dbPath, Buffer.concat([Buffer.from('%TSD-Header-###%'), Buffer.alloc(4096)]));
    const index = makeIndex();
    await built(index);
    expect(stores[0]?.describe().location).toBe('rebuilt');
    expect((await readFile(dbPath)).subarray(0, 15).toString()).toBe('SQLite format 3');
    expect((await index.query(all('良率'))).sessions).toHaveLength(2);
  });

  it('keeps the index in memory when the file cannot be created', async () => {
    dbPath = join(dir, 'missing-dir', 'nested', 'chat-search.db');
    const index = makeIndex();
    await built(index);
    expect(stores[0]?.describe()).toEqual({ location: 'memory', fts: true });
    expect((await index.query(all('批次良率'))).sessions).toHaveLength(1);
  });
});
