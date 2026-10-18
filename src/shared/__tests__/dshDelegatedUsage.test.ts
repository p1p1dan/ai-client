import { describe, expect, it } from 'vitest';
import {
  applySessionSpend,
  catalogChildOf,
  foldSessionSpend,
  initSessionSpend,
  sessionSpendTokens,
  sumDelegatedSpend,
} from '../dshDelegatedUsage';

/**
 * Decision 198 — one subagent session's spend, folded from its own log the
 * way dsh-token-meter's `tokenUsage` sums the agent loop, plus its
 * compaction summaries; a fork's inherited prefix is the parent's and is
 * never counted.
 */

type Event = { type: string; seq: number; data?: Record<string, unknown> };

function message(seq: number, step: number, usage?: Record<string, number>, turn = 1): Event {
  return {
    type: 'assistant/message',
    seq,
    data: {
      turn,
      step,
      message: { id: `a${seq}`, role: 'assistant', content: [] },
      ...(usage ? { usage } : {}),
    },
  };
}

/** A settlement whose usage is only in its stream (a failed attempt's is). */
function streamed(
  type: 'assistant/attempt' | 'assistant/message',
  seq: number,
  step: number,
  usage: Record<string, number>
): Event {
  return {
    type,
    seq,
    data: {
      turn: 1,
      step,
      stream: [
        { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
        { type: 'text-chunks', texts: ['partial'] },
        { type: 'chunk', chunk: { type: 'usage', usage } },
        { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } },
      ],
    },
  };
}

function catalog(seq: number, childId: string): Event {
  return { type: 'subagent/catalog', seq, data: { version: 0, childId, mode: 'one-shot' } };
}

describe('foldSessionSpend — a subagent log as the token meter sums it (decision 198)', () => {
  it('[D198-FOLD-1] adds each reported step, its cache traffic and its compaction summaries', () => {
    const spend = foldSessionSpend([
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      message(1, 1, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 400 }),
      message(2, 2, { inputTokens: 30, outputTokens: 5, cacheWriteTokens: 60, totalTokens: 95 }),
      // A step Stop cut short reported nothing: nothing to add.
      message(3, 3),
      {
        type: 'compaction/summary',
        seq: 4,
        data: { usage: { inputTokens: 900, outputTokens: 80, cacheReadTokens: 10 } },
      },
      // A summary that logged no usage was not billed as far as DSH knows.
      { type: 'compaction/summary', seq: 5, data: {} },
    ]);
    expect(spend.loop).toEqual({ input: 130, output: 25, cacheRead: 400, cacheWrite: 60 });
    expect(spend.auxiliary).toEqual({
      requests: 1,
      input: 900,
      output: 80,
      cacheRead: 10,
      cacheWrite: 0,
    });
    expect(sessionSpendTokens(spend)).toEqual({
      input: 1030,
      output: 105,
      cacheRead: 410,
      cacheWrite: 60,
    });
  });

  it('[D198-FOLD-2] replaces a sample of the same step, adds a retried one, counts a failed attempt', () => {
    const spend = foldSessionSpend([
      // The failed first attempt's stream reported a sample: billed.
      streamed('assistant/attempt', 0, 1, { inputTokens: 50, outputTokens: 2 }),
      // DSH retries the step: the retry is another billed request.
      { type: 'llm/retry-started', seq: 1, data: { turn: 1, step: 1 } },
      message(2, 1, { inputTokens: 50, outputTokens: 10 }),
      // A later sample of the same step replaces the earlier one, never adds.
      message(3, 1, { inputTokens: 50, outputTokens: 12 }),
      // The same sample again changes nothing.
      message(4, 1, { inputTokens: 50, outputTokens: 12 }),
      // A retry of another step leaves this step's slot alone.
      { type: 'llm/retry-started', seq: 5, data: { turn: 1, step: 9 } },
      message(6, 1, { inputTokens: 50, outputTokens: 13 }),
      // A settled message without its own usage reads its stream's last sample.
      streamed('assistant/message', 7, 2, { inputTokens: 7, outputTokens: 3 }),
    ]);
    expect(spend.loop).toEqual({ input: 107, output: 18, cacheRead: 0, cacheWrite: 0 });
  });

  it('[D198-FOLD-3] skips what a fork inherited: its steps, summaries and catalog are the parent’s', () => {
    const events: Event[] = [
      message(0, 1, { inputTokens: 1000, outputTokens: 100 }),
      catalog(1, 'sibling'),
      { type: 'compaction/summary', seq: 2, data: { usage: { inputTokens: 5, outputTokens: 5 } } },
      { type: 'session/end-seed', seq: 3, data: {} },
      message(4, 1, { inputTokens: 40, outputTokens: 4, cacheReadTokens: 1000 }, 2),
      catalog(5, 'grandchild'),
    ];
    const fork = foldSessionSpend(events, 4);
    expect(fork.loop).toEqual({ input: 40, output: 4, cacheRead: 1000, cacheWrite: 0 });
    expect(fork.auxiliary.requests).toBe(0);
    expect(fork.children).toEqual(['grandchild']);
    // Read as a session of its own, the same log counts everything.
    expect(foldSessionSpend(events).loop.input).toBe(1040);
    expect(catalogChildOf(catalog(1, 'sibling'), 4)).toBeUndefined();
    expect(catalogChildOf(catalog(5, 'grandchild'), 4)).toBe('grandchild');
  });

  it('[D198-FOLD-4] names its own children once, in order, and ignores what it cannot read', () => {
    const spend = initSessionSpend();
    for (const event of [
      catalog(0, 'b'),
      catalog(1, 'a'),
      catalog(2, 'b'),
      { type: 'subagent/catalog', seq: 3, data: { childId: '' } },
      { type: 'subagent/catalog', seq: 4 },
      { type: 'assistant/message', seq: 5, data: { turn: 1, step: 1, usage: 'lots' } },
      { type: 'assistant/message', seq: 6, data: { turn: 1, step: 2, usage: { inputTokens: -5 } } },
      { type: 'assistant/attempt', seq: 7, data: { turn: 1, step: 3, stream: 'nope' } },
      { type: 7, seq: 8 } as unknown as Event,
      null as unknown as Event,
    ]) {
      applySessionSpend(spend, event);
    }
    expect(spend.children).toEqual(['b', 'a']);
    expect(spend.loop).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(initSessionSpend(-3).inheritedEventCount).toBe(0);
    expect(initSessionSpend(Number.NaN).inheritedEventCount).toBe(0);
  });
});

describe('sumDelegatedSpend — the delegated share (decision 198)', () => {
  it('[D198-SUM] sums the delegates that reported anything, and counts them', () => {
    const a = foldSessionSpend([message(0, 1, { inputTokens: 10, outputTokens: 5 })]);
    const b = foldSessionSpend([
      message(0, 1, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }),
      {
        type: 'compaction/summary',
        seq: 1,
        data: { usage: { inputTokens: 100, outputTokens: 0 } },
      },
    ]);
    const silent = foldSessionSpend([message(0, 1)]);
    expect(sumDelegatedSpend([a, silent, b])).toEqual({
      delegates: 2,
      input: 111,
      output: 7,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 125,
    });
    // None measured is "no figures", not a measured zero.
    expect(sumDelegatedSpend([silent])).toBeUndefined();
    expect(sumDelegatedSpend([])).toBeUndefined();
  });
});
