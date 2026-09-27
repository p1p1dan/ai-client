import { describe, expect, it, vi } from 'vitest';
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
