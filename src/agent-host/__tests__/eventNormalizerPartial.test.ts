import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COALESCE_WINDOW_MS } from '../coalescingEmitter.ts';
import { EventNormalizer } from '../eventNormalizer.ts';
import {
  buildTreatmentMessages,
  chunkInto,
  MESSAGE_ID_1,
  TEXT_WHOLE_1,
  TEXT_WHOLE_2,
  THINKING_SIGNATURE,
  THINKING_WHOLE,
  TOOL_CALL_ID,
  TOOL_INPUT,
  TREATMENT_MODEL,
  TREATMENT_REQUEST_ID,
  TREATMENT_USER_TEXT,
} from './fixtures/partial-messages/treatmentFixture.ts';

/**
 * ON-position behavior for the partial-messages batch (片 1b/1c/1d/1e).
 *
 * The OFF position is arbitrated separately and absolutely by
 * `eventNormalizerGolden.test.ts`; nothing here may be read as covering it.
 *
 * Fake timers everywhere: the coalescer (1e) is time-driven, and the interim
 * token throttle (1d) reads `Date.now()`. `stepMs` in `replay` chooses between
 * two deliberately different regimes:
 *  - `0` (burst)  — every event in one window, which is the regime the event
 *                   budget assertion needs (a coalescer that got bypassed
 *                   cannot pass it);
 *  - `>0` (paced) — windows expire between events, which is the regime the
 *                   "≥3 deltas actually stream" assertion needs (a coalescer
 *                   that merged everything into one event would fail it).
 */

interface Harness {
  events: Record<string, unknown>[];
  logs: string[];
  n: EventNormalizer;
}

function makeHarness(sessionId = 'sess-partial'): Harness {
  const events: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const n = new EventNormalizer(
    sessionId,
    (e) => events.push(e),
    (...args) => logs.push(args.map((a) => String(a)).join(' '))
  );
  return { events, logs, n };
}

function payloadOf(event: Record<string, unknown>): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>;
}

function types(events: Record<string, unknown>[]): unknown[] {
  return events.map((e) => e.type);
}

/** Assistant-side text only — `beginTurn` echoes the user prompt as a delta too. */
function assistantText(events: Record<string, unknown>[]): string {
  return events
    .filter(
      (e) => e.type === 'message.delta' && String(payloadOf(e).messageId ?? '').startsWith('asst-')
    )
    .map((e) => String(payloadOf(e).text ?? ''))
    .join('');
}

function assistantDeltas(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.filter(
    (e) => e.type === 'message.delta' && String(payloadOf(e).messageId ?? '').startsWith('asst-')
  );
}

function thinkingText(events: Record<string, unknown>[]): string {
  return events
    .filter((e) => e.type === 'thinking.delta')
    .map((e) => String(payloadOf(e).text ?? ''))
    .join('');
}

function interims(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.filter((e) => e.type === 'usage.updated' && payloadOf(e).interim === true);
}

/** Feed messages through a fresh normalizer, optionally letting the clock run between them. */
function replay(
  messages: unknown[],
  options: { stepMs?: number; sessionId?: string } = {}
): Harness {
  const h = makeHarness(options.sessionId);
  h.n.beginTurn(TREATMENT_USER_TEXT, undefined, TREATMENT_REQUEST_ID);
  for (const message of messages) {
    h.n.ingest(message, TREATMENT_REQUEST_ID);
    if (options.stepMs) vi.advanceTimersByTime(options.stepMs);
  }
  // Terminal flush — a no-op when a `result` already flushed, and the only
  // thing that empties the buffer on the streams that end without one.
  h.n.finishTurn(TREATMENT_REQUEST_ID);
  return h;
}

/** Minimal main-agent stream_event wrapper. */
function se(event: Record<string, unknown>): Record<string, unknown> {
  return { type: 'stream_event', parent_tool_use_id: null, event };
}

function wholeText(text: string, messageId = MESSAGE_ID_1): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: messageId,
      role: 'assistant',
      model: TREATMENT_MODEL,
      content: [{ type: 'text', text }],
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 2 / 3 — Happy Path (摘录 A) and the thinking counterpart (摘录 B)
// ---------------------------------------------------------------------------

describe('partial Happy Path (spike 摘录 A + B replay)', () => {
  it('streams the body once, keeps ≥3 deltas, fires one real-input tool.started, and reports the model', () => {
    const { events } = replay(buildTreatmentMessages(), { stepMs: 25 });

    // Exactly one copy of everything — this is the 雷 A assertion.
    expect(assistantText(events)).toBe(TEXT_WHOLE_1 + TEXT_WHOLE_2);
    expect(thinkingText(events)).toBe(THINKING_WHOLE);

    // ... and it really did arrive as a stream, not as two whole messages.
    expect(assistantDeltas(events).length).toBeGreaterThanOrEqual(3);
    expect(events.filter((e) => e.type === 'thinking.delta').length).toBeGreaterThanOrEqual(3);
    expect(events.filter((e) => e.type === 'thinking.started')).toHaveLength(1);

    // 雷 B: one card, carrying the input that only the whole message has.
    const toolStarted = events.filter((e) => e.type === 'tool.started');
    expect(toolStarted).toHaveLength(1);
    expect(payloadOf(toolStarted[0]).toolCallId).toBe(TOOL_CALL_ID);
    expect(payloadOf(toolStarted[0]).name).toBe('Bash');
    expect(payloadOf(toolStarted[0]).input).toEqual(TOOL_INPUT);
    expect(events.filter((e) => e.type === 'tool.completed')).toHaveLength(1);

    // Review blocker #2: on the ON path the deltas mint the envelope long
    // before any whole `assistant` message lands, so `message_start` is the
    // only place the model can come from.
    const assistantStarted = events.filter(
      (e) => e.type === 'message.started' && payloadOf(e).role === 'assistant'
    );
    expect(assistantStarted).toHaveLength(1);
    expect(payloadOf(assistantStarted[0]).model).toBe(TREATMENT_MODEL);
  });

  it('keeps strict ordering: msg1 text, then the tool round trip, then msg2 text', () => {
    const { events } = replay(buildTreatmentMessages(), { stepMs: 25 });
    const order = types(events);
    const toolStartedAt = order.indexOf('tool.started');
    const toolCompletedAt = order.indexOf('tool.completed');
    const deltaIndexes = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => assistantDeltas([e]).length === 1)
      .map(({ i }) => i);

    expect(toolStartedAt).toBeGreaterThan(deltaIndexes[0]);
    expect(toolCompletedAt).toBeGreaterThan(toolStartedAt);
    // The second message's body must come after the tool result, not merged
    // into the first message's run.
    expect(deltaIndexes[deltaIndexes.length - 1]).toBeGreaterThan(toolCompletedAt);
  });

  it('never lets signature_delta or input_json_delta reach the text/thinking emitters', () => {
    const h = makeHarness();
    h.n.beginTurn('x', undefined, 'r');
    h.n.ingest(
      se({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
      'r'
    );
    // Both carry decoy `text`/`thinking` fields: the dispatch must key off the
    // delta TYPE, so a future SDK that starts attaching them cannot leak.
    h.n.ingest(
      se({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'signature_delta',
          signature: THINKING_SIGNATURE,
          text: 'LEAKED',
          thinking: 'LEAKED',
        },
      }),
      'r'
    );
    h.n.ingest(
      se({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"a":1}',
          text: 'LEAKED',
          thinking: 'LEAKED',
        },
      }),
      'r'
    );
    h.n.finishTurn('r');

    expect(assistantDeltas(h.events)).toHaveLength(0);
    expect(h.events.filter((e) => e.type === 'thinking.delta')).toHaveLength(0);
    expect(JSON.stringify(h.events)).not.toContain('LEAKED');
  });
});

// ---------------------------------------------------------------------------
// 4 — tail-truncation fallback and its mid-stream-loss negative control
// ---------------------------------------------------------------------------

describe('partial dedup — reconciliation outcomes', () => {
  it('tail truncation: emits only the missing suffix, once', () => {
    const { events, logs } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello, ' },
        }),
        wholeText('Hello, world!'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );

    const deltas = assistantDeltas(events);
    expect(deltas).toHaveLength(2);
    expect(payloadOf(deltas[1]).text).toBe('world!');
    expect(assistantText(events)).toBe('Hello, world!');
    expect(logs.some((l) => l.includes('tail-truncation fallback'))).toBe(true);
  });

  it('mid-stream loss (negative control): the whole message is DROPPED and logged, never re-emitted', () => {
    const { events, logs } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'abc' } }),
        // 'def' never arrives — an append-only stream cannot repair this.
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ghi' } }),
        wholeText('abcdefghi'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );

    expect(assistantText(events)).toBe('abcghi');
    expect(assistantText(events)).not.toContain('abcdefghi');
    const mismatch = logs.find((l) => l.includes('accumulator mismatch'));
    expect(mismatch).toBeDefined();
    // The log must carry both lengths — that is what makes a real occurrence
    // diagnosable from a Host log alone.
    expect(mismatch).toContain('acc=6 chars');
    expect(mismatch).toContain('whole=9 chars');
  });

  it('exact match: the whole message is dropped silently (the measured常态 path)', () => {
    const { events, logs } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }),
        wholeText('done'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );
    expect(assistantText(events)).toBe('done');
    expect(logs.filter((l) => l.includes('partial dedup'))).toHaveLength(0);
  });

  it('whole message arriving AFTER content_block_stop still reconciles (closedBlocks)', () => {
    const { events } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }),
        se({ type: 'content_block_stop', index: 0 }),
        wholeText('done'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );
    expect(assistantText(events)).toBe('done');
  });

  it('zero candidates: the whole message is EMITTED (never silently dropped) and logged', () => {
    // The gateway honoured partials for the first message, then stopped. The
    // final answer must survive — a duplicate is recoverable, a disappearance
    // is not.
    const { events, logs } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } }),
        se({ type: 'content_block_stop', index: 0 }),
        wholeText('first'),
        se({ type: 'message_start', message: { id: 'msg_second', model: TREATMENT_MODEL } }),
        wholeText('the whole second answer', 'msg_second'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );

    expect(assistantText(events)).toBe('firstthe whole second answer');
    const noCandidate = logs.find((l) => l.includes('no text accumulator candidate'));
    expect(noCandidate).toBeDefined();
    expect(noCandidate).toContain('acc=none');
    expect(noCandidate).toContain('whole=23 chars');
  });

  it('two open same-typed blocks (invariant violation): emits as-is and logs, never drops', () => {
    const { events, logs } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'aa' } }),
        se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'bb' } }),
        wholeText('aa'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );
    expect(assistantText(events)).toBe('aabbaa');
    expect(logs.some((l) => l.includes('open text blocks when a whole message arrived'))).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// 5 — cross-message state (message_start clears the block ledger)
// ---------------------------------------------------------------------------

describe('partial dedup — cross-message state', () => {
  it('two API messages: the second body arrives complete', () => {
    const { events } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one' } }),
        wholeText('one'),
        se({ type: 'content_block_stop', index: 0 }),
        se({ type: 'message_start', message: { id: 'msg_second', model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'two' } }),
        wholeText('two', 'msg_second'),
        se({ type: 'content_block_stop', index: 0 }),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );
    expect(assistantText(events)).toBe('onetwo');
  });

  it('message_start clears a STALE OPEN block, so the next message is not swallowed by it', () => {
    // Message 1 streams 'aaa' and then simply stops (no content_block_stop, no
    // whole message). Message 2's whole answer happens to be the same string.
    // Without the clear, message 2 would reconcile against message 1's stale
    // accumulator and be dropped — the user's answer would vanish.
    const { events } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'aaa' } }),
        se({ type: 'message_start', message: { id: 'msg_second', model: TREATMENT_MODEL } }),
        wholeText('aaa', 'msg_second'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );
    expect(assistantText(events)).toBe('aaaaaa');
  });

  it('message_start clears a STALE CLOSED block too', () => {
    const { events } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bbb' } }),
        se({ type: 'content_block_stop', index: 0 }),
        se({ type: 'message_start', message: { id: 'msg_second', model: TREATMENT_MODEL } }),
        wholeText('bbb', 'msg_second'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );
    expect(assistantText(events)).toBe('bbbbbb');
  });

  it('index reuse after a missing content_block_stop does not truncate the next message', () => {
    const { events } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part' } }),
        // no content_block_stop at all
        se({ type: 'message_start', message: { id: 'msg_second', model: TREATMENT_MODEL } }),
        se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        se({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'part two' },
        }),
        wholeText('part two', 'msg_second'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );
    expect(assistantText(events)).toBe('partpart two');
  });
});

// ---------------------------------------------------------------------------
// 6 — gate narrowing
// ---------------------------------------------------------------------------

describe('partial gate (partialContentSeen) is opened only by real content', () => {
  it('message_start alone does not open it — the whole message takes the untouched path', () => {
    const { events } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        wholeText('the entire answer'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );
    expect(assistantText(events)).toBe('the entire answer');
    // The model still rides along, because capture happens regardless.
    const started = events.find(
      (e) => e.type === 'message.started' && payloadOf(e).role === 'assistant'
    );
    expect(payloadOf(started ?? {}).model).toBe(TREATMENT_MODEL);
  });

  it('a SUBAGENT stream_event does not open it (the parent-id drop comes first)', () => {
    const h = makeHarness();
    h.n.beginTurn(TREATMENT_USER_TEXT, undefined, TREATMENT_REQUEST_ID);
    // T-34 red line: parent-set stream_events are dropped whole. If the gate
    // were set before that drop, the main agent's whole message below would be
    // routed into the dedup path and could be swallowed.
    h.n.ingest(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_delegation',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      TREATMENT_REQUEST_ID
    );
    h.n.ingest(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_delegation',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'main answer' },
        },
      },
      TREATMENT_REQUEST_ID
    );
    h.n.ingest(wholeText('main answer'), TREATMENT_REQUEST_ID);
    h.n.finishTurn(TREATMENT_REQUEST_ID);

    expect(assistantText(h.events)).toBe('main answer');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a text delta with no content_block_start still opens it (accumulator established late)', () => {
    const { events } = replay(
      [
        se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
        se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'late' } }),
        wholeText('late'),
      ],
      { stepMs: COALESCE_WINDOW_MS + 5 }
    );
    expect(assistantText(events)).toBe('late');
  });
});

// ---------------------------------------------------------------------------
// 7 — tool ledger
// ---------------------------------------------------------------------------

describe('partial tool ledger (雷 B)', () => {
  it('the empty stub emits no tool.started at all', () => {
    const messages = buildTreatmentMessages();
    const h = makeHarness();
    h.n.beginTurn(TREATMENT_USER_TEXT, undefined, TREATMENT_REQUEST_ID);
    for (const message of messages) {
      const isWholeToolMessage =
        (message as { type?: string }).type === 'assistant' &&
        JSON.stringify(message).includes('"tool_use"');
      if (isWholeToolMessage) break;
      h.n.ingest(message, TREATMENT_REQUEST_ID);
    }
    // Everything up to (but excluding) the whole tool message has been fed:
    // the stub and all 22 partial_json fragments are in.
    expect(h.events.filter((e) => e.type === 'tool.started')).toHaveLength(0);
    expect(h.n.hasOpenTools()).toBe(false);
  });

  it('orphan fallback: no whole tool message → tool.started is back-filled from partial_json', () => {
    const { events, logs } = replay(buildTreatmentMessages({ omitWholeToolMessage: true }), {
      stepMs: 25,
    });

    const started = events.filter((e) => e.type === 'tool.started');
    expect(started).toHaveLength(1);
    expect(payloadOf(started[0]).toolCallId).toBe(TOOL_CALL_ID);
    expect(payloadOf(started[0]).name).toBe('Bash');
    // The real arguments, reassembled from the 22 fragments — NOT the stub's
    // empty object.
    expect(payloadOf(started[0]).input).toEqual(TOOL_INPUT);

    // It must precede its completion so the timeline card can settle.
    const order = types(events);
    expect(order.indexOf('tool.started')).toBeLessThan(order.indexOf('tool.completed'));
    expect(events.filter((e) => e.type === 'tool.completed')).toHaveLength(1);
    expect(logs.some((l) => l.includes('back-filling tool.started'))).toBe(true);
  });

  it('orphan fallback with unparsable fragments falls back to an empty input, not a lost card', () => {
    const h = makeHarness();
    h.n.beginTurn(TREATMENT_USER_TEXT, undefined, TREATMENT_REQUEST_ID);
    h.n.ingest(
      se({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_trunc', name: 'Bash', input: {} },
      }),
      TREATMENT_REQUEST_ID
    );
    h.n.ingest(
      se({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"comm' },
      }),
      TREATMENT_REQUEST_ID
    );
    h.n.ingest(
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_trunc', content: 'out' }],
        },
      },
      TREATMENT_REQUEST_ID
    );

    const started = h.events.filter((e) => e.type === 'tool.started');
    expect(started).toHaveLength(1);
    expect(payloadOf(started[0]).input).toEqual({});
  });

  it('does not double-fire when the whole message DID arrive', () => {
    const { events } = replay(buildTreatmentMessages(), { stepMs: 25 });
    expect(events.filter((e) => e.type === 'tool.started')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8 — interim token channel
// ---------------------------------------------------------------------------

function openGate(h: Harness): void {
  h.n.beginTurn(TREATMENT_USER_TEXT, undefined, TREATMENT_REQUEST_ID);
  h.n.ingest(
    se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
    TREATMENT_REQUEST_ID
  );
  h.n.ingest(
    se({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    TREATMENT_REQUEST_ID
  );
}

function thinkingTokens(delta: number): Record<string, unknown> {
  return { type: 'system', subtype: 'thinking_tokens', estimated_tokens_delta: delta };
}

describe('interim token channel (1d)', () => {
  it('emits the very first tick unconditionally (null sentinel, not a 0 timestamp)', () => {
    const h = makeHarness();
    openGate(h);
    h.n.ingest(thinkingTokens(7), TREATMENT_REQUEST_ID);
    expect(interims(h.events)).toHaveLength(1);
    expect(payloadOf(interims(h.events)[0]).turn_output_tokens_display).toBe(7);
  });

  it('throttles the thinking_tokens path: 10ms×3 → 1 event, 300ms×3 → 3 events', () => {
    const fast = makeHarness();
    openGate(fast);
    for (let i = 0; i < 3; i += 1) {
      fast.n.ingest(thinkingTokens(2), TREATMENT_REQUEST_ID);
      vi.advanceTimersByTime(10);
    }
    expect(interims(fast.events)).toHaveLength(1);

    const slow = makeHarness();
    openGate(slow);
    for (let i = 0; i < 3; i += 1) {
      slow.n.ingest(thinkingTokens(2), TREATMENT_REQUEST_ID);
      vi.advanceTimersByTime(300);
    }
    expect(interims(slow.events)).toHaveLength(3);
  });

  it('is inert on the control path — thinking_tokens without the gate emits nothing', () => {
    const h = makeHarness();
    h.n.beginTurn(TREATMENT_USER_TEXT, undefined, TREATMENT_REQUEST_ID);
    for (let i = 0; i < 5; i += 1) {
      h.n.ingest(thinkingTokens(4), TREATMENT_REQUEST_ID);
      vi.advanceTimersByTime(400);
    }
    expect(interims(h.events)).toHaveLength(0);
  });

  it('message_delta steps unthrottled, and a thinking content_block_stop tail-emits', () => {
    const h = makeHarness();
    openGate(h);
    h.n.ingest(thinkingTokens(5), TREATMENT_REQUEST_ID); // first, unconditional
    expect(interims(h.events)).toHaveLength(1);

    h.n.ingest(thinkingTokens(5), TREATMENT_REQUEST_ID); // inside the throttle
    expect(interims(h.events)).toHaveLength(1);

    // Tail emit at the thinking→text transition: the last ticks must not be lost.
    h.n.ingest(se({ type: 'content_block_stop', index: 0 }), TREATMENT_REQUEST_ID);
    expect(interims(h.events)).toHaveLength(2);
    expect(payloadOf(interims(h.events)[1]).turn_output_tokens_display).toBe(10);

    // And a settled step is never throttled either.
    h.n.ingest(se({ type: 'message_delta', usage: { output_tokens: 51 } }), TREATMENT_REQUEST_ID);
    expect(interims(h.events)).toHaveLength(3);
  });

  it('never counts backwards when a subagent estimate is zeroed by the main message_delta', () => {
    const h = makeHarness();
    openGate(h);
    // `system/thinking_tokens` carries no parent marker, so a delegation's
    // thinking mixes into the same estimate.
    h.n.ingest(thinkingTokens(40), TREATMENT_REQUEST_ID);
    vi.advanceTimersByTime(300);
    h.n.ingest(thinkingTokens(60), TREATMENT_REQUEST_ID);
    vi.advanceTimersByTime(300);
    h.n.ingest(se({ type: 'message_delta', usage: { output_tokens: 10 } }), TREATMENT_REQUEST_ID);
    vi.advanceTimersByTime(300);
    h.n.ingest(thinkingTokens(1), TREATMENT_REQUEST_ID);

    const displays = interims(h.events).map(
      (e) => payloadOf(e).turn_output_tokens_display as number
    );
    expect(displays.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < displays.length; i += 1) {
      expect(displays[i]).toBeGreaterThanOrEqual(displays[i - 1]);
    }
    expect(Math.max(...displays)).toBe(100);
  });

  it('accumulates per-message output_tokens across the turn (51 + 30 = 81)', () => {
    const h = makeHarness();
    h.n.beginTurn(TREATMENT_USER_TEXT, undefined, TREATMENT_REQUEST_ID);
    h.n.ingest(
      se({ type: 'message_start', message: { id: MESSAGE_ID_1, model: TREATMENT_MODEL } }),
      TREATMENT_REQUEST_ID
    );
    h.n.ingest(
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      TREATMENT_REQUEST_ID
    );
    h.n.ingest(
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }),
      TREATMENT_REQUEST_ID
    );
    h.n.ingest(se({ type: 'message_delta', usage: { output_tokens: 51 } }), TREATMENT_REQUEST_ID);
    h.n.ingest(
      se({ type: 'message_start', message: { id: 'msg_second', model: TREATMENT_MODEL } }),
      TREATMENT_REQUEST_ID
    );
    h.n.ingest(se({ type: 'message_delta', usage: { output_tokens: 30 } }), TREATMENT_REQUEST_ID);

    const displays = interims(h.events).map((e) => payloadOf(e).turn_output_tokens_display);
    expect(displays).toEqual([51, 81]);
  });

  it('every interim carries sessionId and requestId', () => {
    const { events } = replay(buildTreatmentMessages(), { stepMs: 25 });
    const list = interims(events);
    expect(list.length).toBeGreaterThan(0);
    for (const event of list) {
      // Without sessionId the renderer's reduceSessionRuntimeFacts drops it.
      expect(event.sessionId).toBe('sess-partial');
      expect(event.requestId).toBe(TREATMENT_REQUEST_ID);
      expect(payloadOf(event).interim).toBe(true);
    }
  });

  it('leaves the result terminal untouched: exact payload and exact ordering', () => {
    const { events } = replay(buildTreatmentMessages(), { stepMs: 25 });
    expect(types(events).slice(-5)).toEqual([
      'thinking.completed',
      'message.completed',
      'usage.updated',
      'session.completed',
      'session.status',
    ]);
    const final = events[events.length - 3];
    expect(final.payload).toEqual({
      input_tokens: 2971,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 81,
      output_tokens_details: { thinking_tokens: 0 },
    });
    // The settled terminal is NOT an interim — the renderer distinguishes them.
    expect(payloadOf(final)).not.toHaveProperty('interim');
    expect(payloadOf(final)).not.toHaveProperty('turn_output_tokens_display');
  });
});

// ---------------------------------------------------------------------------
// 9 — coalescer, at the normalizer level
// ---------------------------------------------------------------------------

describe('delta coalescing (1e) inside the normalizer', () => {
  it('keeps the downstream event count under a third of the raw stream_event count', () => {
    const messages = buildTreatmentMessages();
    const streamEvents = messages.filter((m) => m.type === 'stream_event').length;
    // Non-vacuity: a toy fixture would let per-turn overhead dominate and any
    // implementation, coalescer or not, would pass.
    expect(streamEvents).toBeGreaterThan(100);

    const { events } = replay(messages);
    expect(events.length).toBeLessThanOrEqual(Math.floor(streamEvents / 3));
    // Still complete: merging must not lose a single character.
    expect(assistantText(events)).toBe(TEXT_WHOLE_1 + TEXT_WHOLE_2);
    expect(thinkingText(events)).toBe(THINKING_WHOLE);
  });

  it('the fixture really is the spike shape it claims to be', () => {
    const messages = buildTreatmentMessages();
    const streamEvents = messages.filter((m) => m.type === 'stream_event');
    const deltaTypes = streamEvents
      .map((m) => (m.event as { delta?: { type?: string } })?.delta?.type)
      .filter(Boolean);
    expect(deltaTypes.filter((t) => t === 'thinking_delta')).toHaveLength(53);
    expect(deltaTypes.filter((t) => t === 'text_delta')).toHaveLength(46 + 7);
    expect(deltaTypes.filter((t) => t === 'input_json_delta')).toHaveLength(22);
    expect(deltaTypes.filter((t) => t === 'signature_delta')).toHaveLength(1);
    // One message_delta per API message (spike §1 Q4).
    expect(
      streamEvents.filter((m) => (m.event as { type?: string })?.type === 'message_delta')
    ).toHaveLength(2);
    // The fragments really do reassemble into the whole strings.
    expect(chunkInto(TEXT_WHOLE_1, 46).join('')).toBe(TEXT_WHOLE_1);
    expect(JSON.parse(chunkInto(JSON.stringify(TOOL_INPUT), 22).join(''))).toEqual(TOOL_INPUT);
  });
});
