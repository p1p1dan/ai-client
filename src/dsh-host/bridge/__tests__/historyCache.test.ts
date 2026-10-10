import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  applyCacheChain,
  CACHE_CHAIN_STATE_VERSION,
  type CacheChainOptions,
  foldCacheChain,
  restoreCacheChain,
  viewCacheChain,
} from '../../../shared/cacheChain.ts';
import type { DshLogEvent } from '../../../shared/dshHistory/types.ts';
import { DshHistoryCache, type DshSessionObservation } from '../historyCache.ts';

/**
 * dsh-rebase P1-4a — the bridge's history cache: one full fold through
 * `sessionQuery.observeSession`, then `session/event` one at a time; a gap or
 * a failed read makes the next read start over from a fresh observation.
 */

const SESSION = 'aiclient-chat-1';

function user(seq: number, id: string, text = id): DshLogEvent {
  return {
    type: 'user/message',
    seq,
    time: 1_790_000_000_000 + seq,
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  };
}

function marker(seq: number): DshLogEvent {
  return { type: 'session/end-seed', seq, time: 1_790_000_000_000 + seq, data: {} };
}

/** An observeSession that answers from `logs` in turn, each resolvable by hand. */
function fakeQuery(...logs: DshLogEvent[][]) {
  const disposed: number[] = [];
  const pending: Array<() => void> = [];
  let calls = 0;
  const observeSession = vi.fn(async (sessionId: string) => {
    expect(sessionId).toBe(SESSION);
    const index = calls++;
    const events = logs[Math.min(index, logs.length - 1)] ?? [];
    await new Promise<void>((resolve) => pending.push(resolve));
    const observation: DshSessionObservation = {
      events,
      cursor: events.at(-1)?.seq ?? -1,
      [Symbol.dispose]: () => disposed.push(index),
    };
    return observation;
  });
  const release = async () => {
    while (pending.length > 0) pending.shift()?.();
    await Promise.resolve();
  };
  return { query: { observeSession }, disposed, release };
}

async function loaded(cache: DshHistoryCache, release: () => Promise<void>): Promise<void> {
  const loading = cache.load();
  await release();
  await loading;
}

function ids(cache: DshHistoryCache): string[] {
  return cache.messages().map((message) => message.id);
}

describe('DshHistoryCache', () => {
  it('folds the observed log once, disposes the observation and answers page, leaf and tree', async () => {
    const { query, disposed, release } = fakeQuery([user(0, 'u1'), user(1, 'u2')]);
    const cache = new DshHistoryCache(query);
    cache.reset(SESSION);
    await loaded(cache, release);
    expect(query.observeSession).toHaveBeenCalledWith(SESSION, { projectionMode: 'none' });
    expect(disposed).toEqual([0]);
    expect(cache.page(0, 1)).toMatchObject({ totalCount: 2, hasMore: true, offset: 0, limit: 1 });
    expect(cache.page().messages.map((message) => message.id)).toEqual(['h:u1', 'h:u2']);
    expect(cache.leaf()).toEqual({ activeEntryId: 'u2', fileTailEntryId: `${SESSION}#1` });
    expect(
      cache.tree({ logicalSessionId: 'chat-1', sessionFile: '/stub', workspacePath: '/w' })
    ).toMatchObject({ totalNodes: 2, leaf: { activeEntryId: 'u2' } });
  });

  it('keeps what arrives during the read and skips what the observation already holds', async () => {
    const { query, release } = fakeQuery([user(0, 'u1'), user(1, 'u2')]);
    const cache = new DshHistoryCache(query);
    cache.reset(SESSION);
    const loading = cache.load();
    cache.push(user(1, 'u2'));
    cache.push(user(2, 'u3'));
    await release();
    await loading;
    expect(ids(cache)).toEqual(['h:u1', 'h:u2', 'h:u3']);
    expect(cache.leaf().fileTailEntryId).toBe(`${SESSION}#2`);
  });

  it('folds live events one at a time once ready, ignoring repeats', async () => {
    const { query, release } = fakeQuery([user(0, 'u1')]);
    const cache = new DshHistoryCache(query);
    cache.reset(SESSION);
    await loaded(cache, release);
    cache.push(user(1, 'u2'));
    cache.push(user(1, 'u2'));
    cache.push(marker(2));
    expect(ids(cache)).toEqual(['h:u1', 'h:u2']);
    expect(cache.leaf()).toEqual({ activeEntryId: 'u2', fileTailEntryId: `${SESSION}#2` });
    expect(await cache.ready()).toBe(true);
    expect(query.observeSession).toHaveBeenCalledTimes(1);
  });

  it('drops events before the first read: the observation holds them', async () => {
    const { query, release } = fakeQuery([user(0, 'u1'), marker(1)]);
    const cache = new DshHistoryCache(query);
    cache.reset(SESSION);
    cache.push(user(0, 'u1'));
    cache.push(marker(1));
    await loaded(cache, release);
    expect(ids(cache)).toEqual(['h:u1']);
  });

  it('starts over from a fresh observation after a gap', async () => {
    const log = vi.fn();
    const { query, release } = fakeQuery(
      [user(0, 'u1')],
      [user(0, 'u1'), user(1, 'u2'), user(2, 'u3')]
    );
    const cache = new DshHistoryCache(query, log);
    cache.reset(SESSION);
    await loaded(cache, release);
    cache.push(user(2, 'u3'));
    expect(ids(cache)).toEqual(['h:u1']);
    expect(log).toHaveBeenCalledWith('[dsh-bridge] history gap', SESSION, 'after 0', 'got 2');
    const ready = cache.ready();
    await release();
    expect(await ready).toBe(true);
    expect(ids(cache)).toEqual(['h:u1', 'h:u2', 'h:u3']);
  });

  it('survives a failed read with a legal page, and reads again next time', async () => {
    const log = vi.fn();
    let fail = true;
    const observeSession = vi.fn(async () => {
      if (fail) throw new Error('corrupt');
      return { events: [user(0, 'u1')], cursor: 0 };
    });
    const cache = new DshHistoryCache({ observeSession }, log);
    cache.reset(SESSION);
    await cache.load();
    expect(cache.page()).toEqual({
      messages: [],
      offset: 0,
      limit: 80,
      totalCount: 0,
      hasMore: false,
    });
    expect(cache.leaf()).toEqual({ activeEntryId: null, fileTailEntryId: null });
    expect(log).toHaveBeenCalledWith(
      '[dsh-bridge] history read failed',
      SESSION,
      expect.any(Error)
    );
    fail = false;
    expect(await cache.ready()).toBe(true);
    expect(ids(cache)).toEqual(['h:u1']);
  });

  it('ignores a read that finishes after the cache moved to another session', async () => {
    const { query, release } = fakeQuery([user(0, 'old')]);
    const cache = new DshHistoryCache(query);
    cache.reset(SESSION);
    const stale = cache.load();
    cache.reset('aiclient-chat-2');
    await release();
    await stale;
    expect(ids(cache)).toEqual([]);
    expect(cache.leaf()).toEqual({ activeEntryId: null, fileTailEntryId: null });
  });
});

describe('DshHistoryCache — a plugin call names itself (decision 131)', () => {
  const call = (seq: number, name: string): DshLogEvent => ({
    type: 'assistant/message',
    seq,
    time: 1_790_000_000_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `a${seq}`,
        role: 'assistant',
        content: [{ type: 'tool-call', id: `c${seq}`, name, arguments: '{"path":"report.docx"}' }],
      },
    },
  });

  it('[D131-CACHE] folds with the presenter the live rows use, on the full read and one event at a time', async () => {
    const presentCall = vi.fn((name: string) =>
      name === 'word_read' ? { card: 'generic' as const, title: 'Read report.docx' } : undefined
    );
    const { query, release } = fakeQuery([call(0, 'word_read')]);
    const cache = new DshHistoryCache(query, () => undefined, presentCall);
    cache.reset(SESSION);
    await loaded(cache, release);
    cache.push(call(1, 'word_read'));
    cache.push(call(2, 'bash'));
    const presented = cache
      .messages()
      .map((message) => (message.blocks[0] as { presentation?: { title: string } }).presentation);
    expect(presented).toEqual([
      { card: 'generic', title: 'Read report.docx' },
      { card: 'generic', title: 'Read report.docx' },
      undefined,
    ]);
    expect(presentCall).toHaveBeenCalledWith('word_read', { path: 'report.docx' });
  });
});

describe('DshHistoryCache — the session’s cache chain (decision 173)', () => {
  const T0 = 1_790_000_000_000;
  /** Claude is followed (anthropic-messages), with the fold's default TTL. */
  const OPTIONS: CacheChainOptions = {
    cacheAware: (provider) => provider === 'claude',
    ttlMsFor: () => undefined,
  };

  const at = (seq: number, type: string, data: Record<string, unknown> = {}): DshLogEvent => ({
    type,
    seq,
    time: T0 + seq * 1_000,
    data,
  });

  /** One model step at `seq`..`seq + 2`: its start, its answer with usage, its end. */
  function step(
    seq: number,
    turn: number,
    index: number,
    usage: { read?: number; write?: number }
  ): DshLogEvent[] {
    return [
      at(seq, 'step/start', { turn, step: index }),
      at(seq + 1, 'assistant/message', {
        turn,
        step: index,
        message: {
          id: `a${seq + 1}`,
          role: 'assistant',
          source: { kind: 'model', provider: 'claude', model: 'claude-opus-5-5' },
          content: [{ type: 'text', text: `answer ${turn}.${index}` }],
        },
        usage: {
          inputTokens: 2,
          outputTokens: 5,
          ...(usage.read ? { cacheReadTokens: usage.read } : {}),
          ...(usage.write ? { cacheWriteTokens: usage.write } : {}),
        },
      }),
      at(seq + 2, 'step/end', { turn, step: index }),
    ];
  }

  /** Turn 1: two steps, the second reading what the first cached. */
  const TURN_1: DshLogEvent[] = [
    at(0, 'turn/start', { turn: 1 }),
    user(1, 'u1'),
    ...step(2, 1, 1, { write: 10_000 }),
    ...step(5, 1, 2, { read: 10_000, write: 2_000 }),
    at(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  /** Turn 2: its first step reads nothing back, and nothing local says why. */
  const TURN_2: DshLogEvent[] = [
    at(9, 'turn/start', { turn: 2 }),
    user(10, 'u2'),
    ...step(11, 2, 1, { write: 13_000 }),
    at(14, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ];
  const LOG = [...TURN_1, ...TURN_2];

  async function opened(events: DshLogEvent[], options?: CacheChainOptions, log = vi.fn()) {
    const { query, release } = fakeQuery(events);
    const cache = new DshHistoryCache(query, log, undefined, options);
    cache.reset(SESSION);
    await loaded(cache, release);
    return cache;
  }

  it('keeps the chain across turns and answers the verdict of the event just folded', async () => {
    const cache = await opened(TURN_1, OPTIONS);
    expect(cache.cacheChainView()?.verdicts.map((verdict) => verdict.kind)).toEqual([
      'cold',
      'warm',
    ]);
    // Read from the log, never handed to the live path.
    expect(cache.cacheStep(6)).toBeUndefined();
    for (const event of TURN_2) cache.push(event);
    // Turn 2's first step is judged against turn 1's last.
    expect(cache.cacheStep(12)).toEqual({
      verdict: expect.objectContaining({
        turn: 2,
        step: 1,
        kind: 'rebuild',
        prevPrompt: 12_002,
        lost: 12_002,
        explained: false,
      }),
      totals: expect.objectContaining({ steps: 3, rebuilds: 1, unexplained: 1 }),
    });
    // Only the event that recorded the step answers.
    expect(cache.cacheStep(13)).toBeUndefined();
    expect(cache.cacheStep(6)).toBeUndefined();
  });

  it('leaves the timeline as it is', async () => {
    const followed = await opened(TURN_1, OPTIONS);
    const plain = await opened(TURN_1);
    for (const event of TURN_2) {
      followed.push(event);
      plain.push(event);
    }
    expect(followed.messages()).toEqual(plain.messages());
    expect(followed.page()).toEqual(plain.page());
    expect(followed.leaf()).toEqual(plain.leaf());
    expect(followed.usageSteps()).toBe(3);
  });

  it('gives a reopened session the chain the live path built, from its log', async () => {
    const live = await opened(TURN_1, OPTIONS);
    for (const event of TURN_2) live.push(event);
    const reopened = await opened(LOG, OPTIONS);
    expect(reopened.cacheChainView()).toEqual(live.cacheChainView());
    expect(reopened.cacheChainView()).toEqual(viewCacheChain(foldCacheChain(LOG, OPTIONS)));
  });

  it('keeps what a saved copy restores to; a copy of another version is refused', async () => {
    // The cache never stores the chain; a caller that did would hold this JSON.
    const saved: unknown = JSON.parse(JSON.stringify(foldCacheChain(TURN_1, OPTIONS)));
    const restored = restoreCacheChain(saved);
    if (!restored) throw new Error('the saved chain was refused');
    for (const event of TURN_2) applyCacheChain(restored, event, OPTIONS);
    const live = await opened(TURN_1, OPTIONS);
    for (const event of TURN_2) live.push(event);
    expect(live.cacheChainView()).toEqual(viewCacheChain(restored));
    // Another version is dropped: its holder folds the log afresh, as every read here does.
    expect(
      restoreCacheChain({ ...(saved as object), version: CACHE_CHAIN_STATE_VERSION + 1 })
    ).toBeUndefined();
  });

  it('folds the chain afresh after a gap, and what came in during the read', async () => {
    const log = vi.fn();
    const { query, release } = fakeQuery(TURN_1, LOG.slice(0, 13));
    const cache = new DshHistoryCache(query, log, undefined, OPTIONS);
    cache.reset(SESSION);
    await loaded(cache, release);
    cache.push(LOG[10] as DshLogEvent);
    expect(log).toHaveBeenCalledWith('[dsh-bridge] history gap', SESSION, 'after 8', 'got 10');
    const ready = cache.ready();
    cache.push(LOG[13] as DshLogEvent);
    await release();
    expect(await ready).toBe(true);
    expect(cache.cacheChainView()).toEqual(viewCacheChain(foldCacheChain(LOG, OPTIONS)));
  });

  it('keeps no chain without the routes’ options (the check switched off)', async () => {
    const cache = await opened(TURN_1);
    cache.push(TURN_2[0] as DshLogEvent);
    expect(cache.cacheChainView()).toBeUndefined();
    expect(cache.cacheStep(6)).toBeUndefined();
  });

  it('loses the chain, never the timeline, when the options fail', async () => {
    const log = vi.fn();
    let calls = 0;
    const failing: CacheChainOptions = {
      cacheAware: () => {
        calls += 1;
        if (calls > 2) throw new Error('no plan');
        return true;
      },
      ttlMsFor: () => undefined,
    };
    const live = await opened(TURN_1, failing, log);
    for (const event of TURN_2) live.push(event);
    expect(log).toHaveBeenCalledWith(
      '[dsh-bridge] cache chain dropped',
      SESSION,
      expect.any(Error)
    );
    expect(live.cacheChainView()).toBeUndefined();
    expect(live.cacheStep(12)).toBeUndefined();
    expect(ids(live)).toEqual(['h:u1', 'h:a3', 'h:a6', 'h:u2', 'h:a12']);

    const read = await opened(LOG, failing, log);
    expect(log).toHaveBeenCalledWith(
      '[dsh-bridge] cache chain not folded',
      SESSION,
      expect.any(Error)
    );
    expect(read.cacheChainView()).toBeUndefined();
    expect(ids(read)).toEqual(ids(live));
  });
});

describe('DshHistoryCache — the cache chain over the recorded logs (decision 173)', () => {
  const FIXTURES = new URL('../../../shared/__tests__/fixtures/dsh/', import.meta.url);
  const FOLLOW_ALL: CacheChainOptions = { cacheAware: () => true, ttlMsFor: () => undefined };

  async function read(events: DshLogEvent[], options?: CacheChainOptions) {
    const cursor = events.at(-1)?.seq ?? -1;
    const cache = new DshHistoryCache(
      { observeSession: async () => ({ events, cursor }) },
      () => undefined,
      undefined,
      options
    );
    cache.reset(SESSION);
    await cache.load();
    return cache;
  }

  it('answers each with the timeline it answered without the chain', async () => {
    const names = readdirSync(FIXTURES).filter((name) => name.startsWith('log.'));
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const { events } = JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as {
        events: DshLogEvent[];
      };
      const followed = await read(events, FOLLOW_ALL);
      const plain = await read(events);
      expect(followed.messages(), name).toEqual(plain.messages());
      expect(followed.leaf(), name).toEqual(plain.leaf());
      // One verdict per step the provider reported usage for.
      expect(followed.cacheChainView()?.totals.steps, name).toBe(plain.usageSteps());
    }
  });
});
