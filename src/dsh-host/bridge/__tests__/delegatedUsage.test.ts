import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { foldSessionSpend } from '../../../shared/dshDelegatedUsage.ts';
import type { DshLogEvent } from '../../../shared/dshHistory/types.ts';
import {
  DELEGATED_PENDING_MAX,
  DELEGATED_READ_FAILURES_MAX,
  DELEGATED_SESSIONS_MAX,
  DshDelegatedUsage,
} from '../delegatedUsage.ts';
import type { DshSessionObservation } from '../historyCache.ts';

/**
 * Decision 198 — the bridge follows a session's subagents through their own
 * logs: one read of each (one at a time), then `session/event` one event at
 * a time; what arrives during a read is folded after it, a gap reads again,
 * and a fork's inherited prefix is never counted.
 */

const ROOT = 'aiclient-chat-1';
const T0 = 1_790_000_000_000;

function message(seq: number, step: number, input: number, output: number): DshLogEvent {
  return {
    type: 'assistant/message',
    seq,
    time: T0 + seq,
    data: {
      turn: 1,
      step,
      message: { id: `a${seq}`, role: 'assistant', content: [] },
      usage: { inputTokens: input, outputTokens: output },
    },
  };
}

function catalog(seq: number, childId: string): DshLogEvent {
  return {
    type: 'subagent/catalog',
    seq,
    time: T0 + seq,
    data: { version: 0, childId, mode: 'one-shot' },
  };
}

/**
 * An observeSession over `logs` by session id, each read held until
 * `release`; a log may be swapped (`logs.set`) or made to fail (`failing`).
 */
function fakeQuery(logs: Map<string, { events: DshLogEvent[]; inherited?: number }>, hold = true) {
  const failing = new Set<string>();
  const pending: Array<() => void> = [];
  const disposed: string[] = [];
  const observeSession = vi.fn(async (sessionId: string) => {
    if (hold) await new Promise<void>((resolve) => pending.push(resolve));
    if (failing.has(sessionId)) throw new Error(`no log for ${sessionId}`);
    const log = logs.get(sessionId) ?? { events: [] };
    const events = [...log.events];
    const observation: DshSessionObservation = {
      events,
      cursor: events.at(-1)?.seq ?? -1,
      ...(log.inherited !== undefined ? { inheritedEventCount: log.inherited } : {}),
      [Symbol.dispose]: () => disposed.push(sessionId),
    };
    return observation;
  });
  /** Lets every held read through, including the ones those reads queue. */
  const release = async (usage: DshDelegatedUsage) => {
    // Reads go one at a time: each round lets the one in flight through.
    for (let round = 0; round < 1_000; round += 1) {
      while (pending.length > 0) pending.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (pending.length === 0) break;
    }
    await usage.settled();
  };
  return { query: { observeSession }, observeSession, failing, disposed, release };
}

function tracker(logs: Map<string, { events: DshLogEvent[]; inherited?: number }>, hold = true) {
  const fake = fakeQuery(logs, hold);
  const lines: unknown[][] = [];
  const usage = new DshDelegatedUsage(fake.query, (...args) => lines.push(args));
  usage.reset(ROOT);
  return { ...fake, usage, lines, release: () => fake.release(usage) };
}

describe('DshDelegatedUsage — what the subagents spent, from their logs (decision 198)', () => {
  it('[D198-TRACK-1] reads each adopted child once and sums what it reported', async () => {
    const h = tracker(
      new Map([
        ['child-a', { events: [message(0, 1, 100, 10), message(1, 2, 20, 2)] }],
        ['child-b', { events: [message(0, 1, 5, 1)] }],
      ])
    );
    expect(h.usage.view()).toBeUndefined();
    h.usage.adopt(['child-a', 'child-b']);
    h.usage.adopt(['child-a']);
    // The root is never its own delegate.
    h.usage.adopt([ROOT]);
    await h.release();
    expect(h.observeSession).toHaveBeenCalledTimes(2);
    expect(h.observeSession).toHaveBeenCalledWith('child-a', { projectionMode: 'none' });
    expect(h.disposed).toEqual(['child-a', 'child-b']);
    expect(h.usage.view()).toEqual({
      delegates: 2,
      input: 125,
      output: 13,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 138,
    });
  });

  it('[D198-TRACK-2] folds live events after the read, holds the ones that arrive during it', async () => {
    const logs = new Map([['child-a', { events: [message(0, 1, 100, 10)] }]]);
    const h = tracker(logs);
    h.usage.adopt(['child-a']);
    // Arrives while the read is in flight: the read already holds seq 0, not seq 1.
    h.usage.onSessionEvent('child-a', message(0, 1, 100, 10));
    h.usage.onSessionEvent('child-a', message(1, 2, 7, 3));
    await h.release();
    expect(h.usage.view()).toMatchObject({ delegates: 1, input: 107, output: 13 });
    h.usage.onSessionEvent('child-a', message(2, 3, 1, 1));
    h.usage.onSessionEvent('child-a', message(2, 3, 1, 1));
    // Another session's event is not this one's.
    h.usage.onSessionEvent('aiclient-other', message(3, 1, 999, 999));
    expect(h.usage.view()).toMatchObject({ delegates: 1, input: 108, output: 14 });
    expect(h.observeSession).toHaveBeenCalledTimes(1);
  });

  it('[D198-TRACK-3] reads again after a gap, keeping what it had meanwhile', async () => {
    const logs = new Map([['child-a', { events: [message(0, 1, 100, 10)] }]]);
    const h = tracker(logs);
    h.usage.adopt(['child-a']);
    await h.release();
    logs.set('child-a', {
      events: [message(0, 1, 100, 10), message(1, 2, 20, 2), message(2, 3, 3, 3)],
    });
    h.usage.onSessionEvent('child-a', message(2, 3, 3, 3));
    expect(h.usage.view()).toMatchObject({ input: 100, output: 10 });
    await h.release();
    expect(h.observeSession).toHaveBeenCalledTimes(2);
    expect(h.usage.view()).toMatchObject({ input: 123, output: 15 });
    expect(h.lines.some((line) => String(line[0]).includes('gap'))).toBe(true);
  });

  it('[D198-TRACK-4] skips a fork’s inherited prefix and follows the children of children', async () => {
    const h = tracker(
      new Map([
        [
          'fork-a',
          {
            // The parent's finished turn, then the fork's own step and its child.
            events: [
              message(0, 1, 5000, 500),
              catalog(1, 'sibling-of-the-parent'),
              { type: 'session/end-seed', seq: 2, time: T0 + 2, data: {} },
              message(3, 1, 40, 4),
              catalog(4, 'grandchild'),
            ],
            inherited: 3,
          },
        ],
        ['grandchild', { events: [message(0, 1, 2, 1)] }],
        ['sibling-of-the-parent', { events: [message(0, 1, 777, 7)] }],
      ])
    );
    h.usage.adopt(['fork-a']);
    await h.release();
    expect(h.observeSession.mock.calls.map((call) => call[0])).toEqual(['fork-a', 'grandchild']);
    expect(h.usage.view()).toEqual({
      delegates: 2,
      input: 42,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 47,
    });
    // A child the fork names live is followed from its catalog entry.
    h.usage.onSessionEvent('fork-a', catalog(5, 'late'));
    await h.release();
    expect(h.observeSession.mock.calls.map((call) => call[0])).toEqual([
      'fork-a',
      'grandchild',
      'late',
    ]);
  });

  it('[D198-TRACK-5] a reset drops the old session’s delegates and the reads still in flight', async () => {
    const h = tracker(
      new Map([
        ['child-a', { events: [message(0, 1, 100, 10), catalog(1, 'grandchild-a')] }],
        ['grandchild-a', { events: [message(0, 1, 5, 5)] }],
      ])
    );
    h.usage.adopt(['child-a']);
    // The read is in flight when the session changes (a rewind).
    await vi.waitFor(() => expect(h.observeSession).toHaveBeenCalledTimes(1));
    h.usage.reset('aiclient-chat-2');
    await h.release();
    // Neither the old child nor the children its log names belong to the new session.
    expect(h.usage.view()).toBeUndefined();
    expect(h.disposed).toEqual(['child-a']);
    // Disposed: no session, nothing adopted.
    h.usage.reset('');
    h.usage.adopt(['child-a']);
    await h.release();
    expect(h.observeSession).toHaveBeenCalledTimes(1);
    expect(h.usage.view()).toBeUndefined();
  });

  it('[D198-TRACK-6] counts nothing for a log it cannot read, tries again on its next event, then gives up', async () => {
    const logs = new Map([['child-a', { events: [message(0, 1, 100, 10)] }]]);
    const h = tracker(logs);
    h.failing.add('child-a');
    h.usage.adopt(['child-a']);
    await h.release();
    expect(h.usage.view()).toBeUndefined();
    for (let attempt = 1; attempt < DELEGATED_READ_FAILURES_MAX + 2; attempt += 1) {
      h.usage.onSessionEvent('child-a', message(attempt, 2, 1, 1));
      await h.release();
    }
    expect(h.observeSession).toHaveBeenCalledTimes(DELEGATED_READ_FAILURES_MAX);
    // A read that works again only needs a live event while the budget lasts.
    const again = tracker(logs);
    again.failing.add('child-a');
    again.usage.adopt(['child-a']);
    await again.release();
    again.failing.delete('child-a');
    again.usage.onSessionEvent('child-a', message(1, 2, 1, 1));
    await again.release();
    expect(again.usage.view()).toMatchObject({ input: 100, output: 10 });
  });

  it('[D198-TRACK-7] reads again when the held events overflow, and bounds the sessions it follows', async () => {
    const logs = new Map([['child-a', { events: [message(0, 1, 100, 10)] }]]);
    const h = tracker(logs);
    h.usage.adopt(['child-a']);
    for (let seq = 1; seq <= DELEGATED_PENDING_MAX + 1; seq += 1) {
      h.usage.onSessionEvent('child-a', message(seq, seq + 1, 1, 0));
    }
    logs.set('child-a', { events: [message(0, 1, 100, 10), message(1, 2, 50, 5)] });
    await h.release();
    expect(h.observeSession).toHaveBeenCalledTimes(2);
    expect(h.usage.view()).toMatchObject({ input: 150, output: 15 });

    // Reads that land at once: the bound, not the hold, is under test.
    const many = tracker(new Map(), false);
    many.usage.adopt(Array.from({ length: DELEGATED_SESSIONS_MAX + 5 }, (_, i) => `c${i}`));
    await many.release();
    expect(many.observeSession).toHaveBeenCalledTimes(DELEGATED_SESSIONS_MAX);
    expect(many.lines.filter((line) => String(line[0]).includes('too many'))).toHaveLength(1);
  });
});

/**
 * The fold must not drift from dsh-token-meter's `tokenUsage` unit (the
 * bundled bridge cannot import it). Only where src/dsh-host is installed: the
 * unit is taken from the meter's own registration.
 */
const DSH_MODULES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/@deepseek-ai'
);
const TOKEN_METER = join(DSH_MODULES, 'dsh-token-meter/lib/index.js');
const CORDIS = join(DSH_MODULES, 'cordis/lib/index.js');

describe.skipIf(!existsSync(TOKEN_METER) || !existsSync(CORDIS))(
  'foldSessionSpend against dsh-token-meter',
  () => {
    interface Unit {
      key: string;
      init(): unknown;
      apply(state: unknown, event: unknown): unknown;
      wire: { view(state: unknown): Record<string, number> };
    }
    async function tokenUsageUnit(): Promise<Unit> {
      const { Context } = (await import(pathToFileURL(CORDIS).href)) as {
        Context: new () => { provide(name: string): void; set(name: string, value: unknown): void };
      };
      const { TokenMeter } = (await import(pathToFileURL(TOKEN_METER).href)) as {
        TokenMeter: new (ctx: unknown) => unknown;
      };
      const units: Unit[] = [];
      const ctx = new Context();
      ctx.provide('sessionProjections');
      ctx.set('sessionProjections', { register: (unit: Unit) => units.push(unit) });
      new TokenMeter(ctx);
      const unit = units.find((candidate) => candidate.key === 'tokenUsage');
      if (!unit) throw new Error('dsh-token-meter registered no tokenUsage unit');
      return unit;
    }
    const usage = (input: number, output: number, cacheRead?: number, cacheWrite?: number) => ({
      inputTokens: input,
      outputTokens: output,
      ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    });
    const sample = (value: Record<string, number>) => ({
      type: 'chunk',
      chunk: { type: 'usage', usage: value },
    });
    const settle = (
      type: 'assistant/message' | 'assistant/attempt',
      seq: number,
      turn: number,
      step: number,
      own: Record<string, number> | undefined,
      stream: unknown[] = []
    ): DshLogEvent => ({
      type,
      seq,
      time: T0 + seq,
      data: { turn, step, stream, ...(own ? { usage: own } : {}) },
    });
    const retry = (seq: number, turn: number, step: number): DshLogEvent => ({
      type: 'llm/retry-started',
      seq,
      time: T0 + seq,
      data: { turn, step },
    });

    // Loading the meter and cordis cold takes seconds on a busy machine.
    it('[D198-PARITY] sums every log the way the meter sums it', async () => {
      const unit = await tokenUsageUnit();
      const logs: DshLogEvent[][] = [
        [settle('assistant/message', 0, 1, 1, usage(100, 10, 400, 3))],
        [
          settle('assistant/attempt', 0, 1, 1, undefined, [
            sample(usage(9, 1)),
            sample(usage(50, 2)),
          ]),
          retry(1, 1, 1),
          settle('assistant/message', 2, 1, 1, usage(50, 10)),
          settle('assistant/message', 3, 1, 1, usage(50, 12, 7)),
          settle('assistant/message', 4, 1, 1, usage(50, 12, 7)),
          retry(5, 1, 9),
          settle('assistant/message', 6, 1, 1, usage(51, 13, 7)),
          settle('assistant/message', 7, 1, 2, undefined, [sample(usage(7, 3, 0, 5))]),
          settle('assistant/message', 8, 2, 1, usage(1, 1)),
          settle('assistant/message', 9, 1, 2, usage(2, 2)),
        ],
        [
          settle('assistant/attempt', 0, 1, 1, undefined, []),
          settle('assistant/attempt', 1, 1, 1, undefined, [sample(usage(30, 0, 0, 900))]),
          settle('assistant/attempt', 2, 1, 1, undefined, [sample(usage(31, 0, 0, 900))]),
          retry(3, 1, 1),
          settle('assistant/attempt', 4, 1, 1, undefined, [sample(usage(31, 0, 0, 900))]),
          retry(6, 1, 1),
          retry(7, 1, 1),
          settle('assistant/message', 8, 1, 1, usage(32, 4, 900)),
        ],
      ];
      for (const [index, events] of logs.entries()) {
        let state = unit.init();
        for (const event of events) state = unit.apply(state, event);
        const meter = unit.wire.view(state);
        const loop = foldSessionSpend(events).loop;
        expect(loop, `log ${index}`).toEqual({
          input: meter.uncachedInputTokens,
          output: meter.outputTokens,
          cacheRead: meter.cacheReadTokens,
          cacheWrite: meter.cacheWriteTokens,
        });
      }
    }, 30_000);
  }
);
