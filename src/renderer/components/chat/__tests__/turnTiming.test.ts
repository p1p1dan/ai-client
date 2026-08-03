import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  deriveTurnStats,
  formatThoughtRow,
  formatWorkedForRow,
  initialTurnTimingRegistry,
  reduceTurnTiming,
} from '../turnTiming';

function event(
  type: string,
  opts: { blockId?: string; timestamp?: number; messageId?: string } = {}
): { type: string; timestamp?: number; payload?: Record<string, unknown> } {
  return {
    type,
    timestamp: opts.timestamp,
    payload: { messageId: opts.messageId ?? 'm1', blockId: opts.blockId },
  };
}

describe('reduceTurnTiming', () => {
  it('records thinking.started as startedAt', () => {
    const next = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.started', { blockId: 'th1', timestamp: 1000 })
    );
    expect(next.byBlock.th1).toEqual({ startedAt: 1000 });
  });

  it('fills in completedAt and durationMs on thinking.completed', () => {
    let reg = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.started', { blockId: 'th1', timestamp: 1000 })
    );
    reg = reduceTurnTiming(reg, event('thinking.completed', { blockId: 'th1', timestamp: 4000 }));
    expect(reg.byBlock.th1).toEqual({ startedAt: 1000, completedAt: 4000, durationMs: 3000 });
  });

  it('leaves durationMs null when completed arrives without a prior started', () => {
    const reg = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.completed', { blockId: 'th1', timestamp: 4000 })
    );
    expect(reg.byBlock.th1.durationMs).toBeNull();
  });

  it('ignores unrelated events, returning the same registry reference', () => {
    const reg = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.started', { blockId: 'th1', timestamp: 1000 })
    );
    expect(reduceTurnTiming(reg, event('tool.started', { blockId: 'x' }))).toBe(reg);
    expect(reduceTurnTiming(reg, event('message.completed'))).toBe(reg);
  });

  it('keeps multiple blockIds independent', () => {
    let reg = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.started', { blockId: 'a', timestamp: 0 })
    );
    reg = reduceTurnTiming(reg, event('thinking.started', { blockId: 'b', timestamp: 10 }));
    reg = reduceTurnTiming(reg, event('thinking.completed', { blockId: 'a', timestamp: 5 }));
    expect(reg.byBlock.a).toEqual({ startedAt: 0, completedAt: 5, durationMs: 5 });
    expect(reg.byBlock.b).toEqual({ startedAt: 10 });
  });
});

describe('formatThoughtRow', () => {
  it('shows "briefly" under the 5s threshold', () => {
    expect(formatThoughtRow({ durationMs: 3000 })).toEqual({
      verb: 'Thought',
      arg: 'briefly',
      argKind: 'prose',
    });
  });

  it('shows "for Ns" at/above the threshold', () => {
    expect(formatThoughtRow({ durationMs: 12_000 })).toEqual({
      verb: 'Thought',
      arg: 'for 12s',
      argKind: 'prose',
    });
  });

  it('shows a bare "Thought" with no arg when duration is null (never fabricates seconds)', () => {
    expect(formatThoughtRow({ durationMs: null })).toEqual({ verb: 'Thought' });
  });

  it('shows "Thinking" with no arg while streaming', () => {
    expect(formatThoughtRow({ streaming: true, durationMs: 9000 })).toEqual({ verb: 'Thinking' });
  });

  it('D25 §2.4: "briefly" and "for Ns" args are prose, not an identifier (sans, not mono)', () => {
    expect(formatThoughtRow({ durationMs: 3000 }).argKind).toBe('prose');
    expect(formatThoughtRow({ durationMs: 12_000 }).argKind).toBe('prose');
  });
});

describe('formatWorkedForRow', () => {
  it('rounds 31000ms to "Worked for 31s"', () => {
    expect(formatWorkedForRow(31_000)).toEqual({
      verb: 'Worked for',
      arg: '31s',
      argKind: 'prose',
    });
  });

  it('never shows 0s -- 400ms rounds up to "Worked for 1s"', () => {
    expect(formatWorkedForRow(400)).toEqual({ verb: 'Worked for', arg: '1s', argKind: 'prose' });
  });

  // F-B12 (T-31, A07 :2399): the never-fabricate-seconds guard. A history
  // message hydrated without T-06 metadata has no measured duration, and the
  // row must be omitted rather than shown as "0s"/"1s". The stats argument
  // added by T-31 must not create a second path that renders a row anyway.
  it('F-B12: returns null (row does not render) when latencyMs is null, stats or not', () => {
    expect(formatWorkedForRow(null)).toBeNull();
    expect(formatWorkedForRow(undefined)).toBeNull();
    expect(formatWorkedForRow(null, '3 tools, 11 searches')).toBeNull();
  });

  it('F-B12: 66000ms reads as "1m 6s", not "66s"', () => {
    expect(formatWorkedForRow(66_000)?.arg).toContain('1m 6s');
    expect(formatWorkedForRow(66_000)?.arg).toBe('1m 6s');
  });

  it('F-B12: appends the turn stats to the same arg (§4.2 — counts move up into the collapsed row)', () => {
    expect(formatWorkedForRow(66_000, '3 tools, 11 searches')).toEqual({
      verb: 'Worked for',
      arg: '1m 6s · 3 tools, 11 searches',
      argKind: 'prose',
    });
  });

  it('F-B12: an absent or empty stats value leaves the duration arg untouched', () => {
    expect(formatWorkedForRow(31_000, null)?.arg).toBe('31s');
    expect(formatWorkedForRow(31_000, '')?.arg).toBe('31s');
  });

  it('F-B12: drops the seconds segment on a whole minute', () => {
    expect(formatWorkedForRow(120_000)?.arg).toBe('2m');
  });

  it('D25 §2.4: the "Ns" arg is prose, not an identifier (sans, not mono)', () => {
    expect(formatWorkedForRow(31_000)?.argKind).toBe('prose');
  });
});

function call(id: string, toolName: string, input: unknown = {}): ChatBlock {
  return { id, type: 'tool_call', toolCallId: id, toolName, toolInput: input };
}

function result(callId: string, overrides: Partial<ChatBlock> = {}): ChatBlock {
  return {
    id: `${callId}-result`,
    type: 'tool_result',
    toolCallId: callId,
    toolOk: true,
    ...overrides,
  };
}

function message(blocks: ChatBlock[]): ChatMessage {
  return { id: 'm1', sessionId: 's1', role: 'assistant', blocks };
}

describe('deriveTurnStats', () => {
  it('3 other tool calls + 11 searches + 1 edit -> "3 tool calls · 11 searches · 1 edit"', () => {
    const blocks: ChatBlock[] = [];
    for (let i = 0; i < 3; i += 1) {
      blocks.push(call(`t${i}`, 'Bash', { command: 'ls' }), result(`t${i}`));
    }
    for (let i = 0; i < 11; i += 1) {
      blocks.push(call(`s${i}`, 'Grep', { pattern: 'x' }), result(`s${i}`));
    }
    blocks.push(call('e0', 'Edit', { file_path: 'a.ts' }), result('e0'));
    expect(deriveTurnStats(message(blocks))).toBe('3 tool calls · 11 searches · 1 edit');
  });

  it('omits a zero-count segment', () => {
    const blocks: ChatBlock[] = [call('a', 'Bash', { command: 'ls' }), result('a')];
    expect(deriveTurnStats(message(blocks))).toBe('1 tool call');
  });

  it('returns null when every count is zero', () => {
    expect(deriveTurnStats(message([]))).toBeNull();
    expect(deriveTurnStats(message([]), { style: 'compact' })).toBeNull();
  });

  // Same counting pass, two renderings: ` · ` is already the separator between
  // the duration and the counts inside the "Worked for …" arg, so the compact
  // form falls back to commas instead of nesting one separator inside itself.
  it('F-B12: compact style renders the reference wording "3 tools, 11 searches"', () => {
    const blocks: ChatBlock[] = [];
    for (let i = 0; i < 3; i += 1) {
      blocks.push(call(`t${i}`, 'Bash', { command: 'ls' }), result(`t${i}`));
    }
    for (let i = 0; i < 11; i += 1) {
      blocks.push(call(`s${i}`, 'Grep', { pattern: 'x' }), result(`s${i}`));
    }
    expect(deriveTurnStats(message(blocks), { style: 'compact' })).toBe('3 tools, 11 searches');
  });

  it('F-B12: compact style keeps the singular/plural rule', () => {
    const blocks: ChatBlock[] = [call('a', 'Bash', { command: 'ls' }), result('a')];
    expect(deriveTurnStats(message(blocks), { style: 'compact' })).toBe('1 tool');
  });
});
