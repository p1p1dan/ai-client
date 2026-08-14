import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COALESCE_WINDOW_MS, CoalescingEmitter } from '../coalescingEmitter.ts';

/**
 * Unit coverage for the Host-side delta coalescer (partial-messages 片 1e).
 *
 * Kept separate from the normalizer tests on purpose: this class is the one
 * piece of the batch that reorders nothing but delays something, and it is
 * cheaper to prove the ordering/merging contract here than through a whole
 * SDK transcript.
 */

function delta(text: string, blockId = 'blk-1', type = 'message.delta'): Record<string, unknown> {
  return {
    type,
    sessionId: 'sess-1',
    requestId: 'req-1',
    payload: { messageId: 'asst-1', blockId, text },
  };
}

function makeSink(): {
  sink: (e: Record<string, unknown>) => void;
  out: Record<string, unknown>[];
} {
  const out: Record<string, unknown>[] = [];
  return { sink: (e) => out.push(e), out };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CoalescingEmitter', () => {
  it('is a total bypass while disabled — same object, no timers', () => {
    const { sink, out } = makeSink();
    const c = new CoalescingEmitter(sink);
    const event = delta('a');
    c.emit(event);
    c.emit(delta('b'));

    expect(out).toHaveLength(2);
    expect(out[0]).toBe(event);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('merges consecutive same-block deltas within the window into one event', () => {
    const { sink, out } = makeSink();
    const c = new CoalescingEmitter(sink);
    c.setEnabled(true);
    c.emit(delta('Hel'));
    c.emit(delta('lo, '));
    c.emit(delta('world'));
    expect(out).toHaveLength(0);

    vi.advanceTimersByTime(COALESCE_WINDOW_MS);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: 'message.delta',
      sessionId: 'sess-1',
      requestId: 'req-1',
      payload: { messageId: 'asst-1', blockId: 'blk-1', text: 'Hello, world' },
    });
  });

  it('preserves strict order: delta → tool.started → delta', () => {
    const { sink, out } = makeSink();
    const c = new CoalescingEmitter(sink);
    c.setEnabled(true);
    c.emit(delta('one'));
    c.emit(delta(' two'));
    const foreign = { type: 'tool.started', sessionId: 'sess-1', payload: { toolCallId: 't1' } };
    c.emit(foreign);
    c.emit(delta('three'));
    c.flushAll();

    expect(out.map((e) => e.type)).toEqual(['message.delta', 'tool.started', 'message.delta']);
    expect((out[0].payload as { text: string }).text).toBe('one two');
    expect(out[1]).toBe(foreign);
    expect((out[2].payload as { text: string }).text).toBe('three');
  });

  it('never merges across blocks, messages, or event types', () => {
    const { sink, out } = makeSink();
    const c = new CoalescingEmitter(sink);
    c.setEnabled(true);
    c.emit(delta('a', 'blk-1'));
    c.emit(delta('b', 'blk-2'));
    c.emit(delta('c', 'blk-2', 'thinking.delta'));
    c.flushAll();

    expect(out).toHaveLength(3);
    expect(out.map((e) => (e.payload as { text: string }).text)).toEqual(['a', 'b', 'c']);
  });

  it('does not merge events that arrive after the window has elapsed', () => {
    const { sink, out } = makeSink();
    const c = new CoalescingEmitter(sink);
    c.setEnabled(true);
    c.emit(delta('early'));
    vi.advanceTimersByTime(COALESCE_WINDOW_MS);
    c.emit(delta('late'));
    c.flushAll();

    expect(out.map((e) => (e.payload as { text: string }).text)).toEqual(['early', 'late']);
  });

  it('the backstop timer delivers a run that never sees a follow-up event', () => {
    const { sink, out } = makeSink();
    const c = new CoalescingEmitter(sink);
    c.setEnabled(true);
    c.emit(delta('stranded'));
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(COALESCE_WINDOW_MS - 1);
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(out).toHaveLength(1);
    // Backstop disarmed after firing — no phantom second delivery.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(out).toHaveLength(1);
  });

  it('passes through delta-shaped events that lack a mergeable identity', () => {
    const { sink, out } = makeSink();
    const c = new CoalescingEmitter(sink);
    c.setEnabled(true);
    const noBlock = {
      type: 'message.delta',
      sessionId: 's',
      payload: { messageId: 'm', text: 'x' },
    };
    const noText = {
      type: 'message.delta',
      sessionId: 's',
      payload: { messageId: 'm', blockId: 'b' },
    };
    c.emit(noBlock);
    c.emit(noText);

    expect(out).toEqual([noBlock, noText]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('setEnabled(false) flushes what is buffered instead of dropping it', () => {
    const { sink, out } = makeSink();
    const c = new CoalescingEmitter(sink);
    c.setEnabled(true);
    c.emit(delta('pending'));
    expect(out).toHaveLength(0);

    c.setEnabled(false);
    expect(out).toHaveLength(1);
    expect((out[0].payload as { text: string }).text).toBe('pending');
    expect(vi.getTimerCount()).toBe(0);
    expect(c.isEnabled()).toBe(false);
  });

  it('does not mutate the event it was handed', () => {
    const { sink, out } = makeSink();
    const c = new CoalescingEmitter(sink);
    c.setEnabled(true);
    const head = delta('a');
    c.emit(head);
    c.emit(delta('b'));
    c.flushAll();

    expect((head.payload as { text: string }).text).toBe('a');
    expect((out[0].payload as { text: string }).text).toBe('ab');
  });
});
