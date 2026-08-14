import { describe, expect, it, vi } from 'vitest';

import { COALESCE_WINDOW_MS } from '../coalescingEmitter.ts';
import { EventNormalizer } from '../eventNormalizer.ts';

/** Fresh normalizer + its captured event log, per the harness pattern used across this suite. */
function makeNormalizer(sessionId = 'sess-1'): {
  events: Record<string, unknown>[];
  n: EventNormalizer;
} {
  const events: Record<string, unknown>[] = [];
  const n = new EventNormalizer(sessionId, (e) => events.push(e));
  return { events, n };
}

function types(events: Record<string, unknown>[]): unknown[] {
  return events.map((e) => e.type);
}

describe('EventNormalizer', () => {
  it('beginTurn emits started/delta/completed with a consistent messageId, blockId and requestId', () => {
    const { events, n } = makeNormalizer();
    n.beginTurn('Hello there', undefined, 'req-1');

    expect(types(events)).toEqual(['message.started', 'message.delta', 'message.completed']);
    const messageId = (events[0].payload as { messageId: string }).messageId;
    expect(messageId).toBeTruthy();
    expect(events[0]).toMatchObject({ requestId: 'req-1', payload: { messageId, role: 'user' } });
    expect(events[1]).toMatchObject({
      requestId: 'req-1',
      payload: { messageId, blockId: `${messageId}-text`, text: 'Hello there' },
    });
    expect(events[2]).toMatchObject({ requestId: 'req-1', payload: { messageId } });
  });

  // Round-2 P0 (Chat attachments): beginTurn forwards lightweight attachment
  // metadata onto the echoed user message.started — never the raw bytes.
  it('beginTurn with attachments includes their kind/mediaType/name on message.started, with no data field', () => {
    const { events, n } = makeNormalizer();
    n.beginTurn('see attached', [
      { kind: 'image', mediaType: 'image/png', name: 'screenshot.png' },
      { kind: 'text', mediaType: 'text/plain' },
    ]);

    const payload = events[0].payload as { attachments?: unknown };
    expect(payload.attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', name: 'screenshot.png' },
      { kind: 'text', mediaType: 'text/plain' },
    ]);
    expect(JSON.stringify(payload)).not.toContain('data');
  });

  it('beginTurn without attachments (or an empty array) omits the attachments key entirely', () => {
    const { events, n } = makeNormalizer();
    n.beginTurn('no attachments');
    expect(events[0].payload).not.toHaveProperty('attachments');

    events.length = 0;
    n.beginTurn('empty array', []);
    expect(events[0].payload).not.toHaveProperty('attachments');
  });

  it('first assistant text emits message.started once, then a second text ingest emits only message.delta', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    });

    expect(types(events)).toEqual(['message.started', 'message.delta']);
    expect(events[0]).toMatchObject({ payload: { role: 'assistant' } });
    expect(events[1]).toMatchObject({ payload: { text: 'Hi' } });

    events.length = 0;
    n.ingest({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: ' there' }] },
    });
    expect(types(events)).toEqual(['message.delta']);
    expect(events[0]).toMatchObject({ payload: { text: ' there' } });
  });

  // Round-2 P0 (event source real model): the assistant-side message.started
  // carries the raw SDK message's actual model id, not the UI's local
  // selection — the renderer has no other way to learn what really answered.
  it('assistant message.started carries the real model id read off the raw SDK message', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8[1m]',
        content: [{ type: 'text', text: 'Hi' }],
      },
    });

    expect(events[0]).toMatchObject({
      payload: { role: 'assistant', model: 'claude-opus-4-8[1m]' },
    });
  });

  it('assistant message.started omits the model key when the raw SDK message carries none', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    });

    expect(events[0].payload).not.toHaveProperty('model');
  });

  it('the first assistant message in a turn wins the model even if a later one in the same turn differs', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
      },
    });
    n.ingest({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }],
      },
    });
    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'done' }],
      },
    });

    expect(events[0]).toMatchObject({ payload: { role: 'assistant', model: 'claude-sonnet-5' } });
  });

  it('thinking + text in one assistant message: thinking handled before text, thinking.started only once', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think' },
          { type: 'text', text: 'Answer' },
        ],
      },
    });

    expect(types(events)).toEqual([
      'message.started',
      'thinking.started',
      'thinking.delta',
      'message.delta',
    ]);
    expect(events[2]).toMatchObject({ payload: { text: 'Let me think' } });
    expect(events[3]).toMatchObject({ payload: { text: 'Answer' } });

    events.length = 0;
    n.ingest({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'more thinking' }] },
    });
    // thinking.started is not re-emitted for later thinking deltas.
    expect(types(events)).toEqual(['thinking.delta']);
  });

  it('assistant tool_use emits tool.started once; the same tool id ingested again is deduped', () => {
    const { events, n } = makeNormalizer();
    const toolBlock = {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Read',
      input: { file_path: 'a.ts' },
    };

    n.ingest({ type: 'assistant', message: { role: 'assistant', content: [toolBlock] } });
    expect(types(events)).toEqual(['message.started', 'tool.started']);
    expect(events[1]).toMatchObject({
      type: 'tool.started',
      payload: { toolCallId: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
    });

    events.length = 0;
    n.ingest({ type: 'assistant', message: { role: 'assistant', content: [toolBlock] } });
    expect(events).toHaveLength(0);
  });

  it('user tool_result maps to tool.completed, with ok/error mapped from is_error', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
      },
    });

    events.length = 0;
    n.ingest({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body', is_error: false },
        ],
      },
    });
    expect(types(events)).toEqual(['tool.completed']);
    expect(events[0]).toMatchObject({
      payload: { toolCallId: 'toolu_1', ok: true, output: 'file body' },
    });
    expect((events[0].payload as { error?: unknown }).error).toBeUndefined();

    events.length = 0;
    n.ingest({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true }],
      },
    });
    expect(events[0]).toMatchObject({
      payload: { toolCallId: 'toolu_2', ok: false, output: 'boom', error: 'boom' },
    });
  });

  it('user tool_result with is_error:true and non-string content coerces error via String()', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
      },
    });

    events.length = 0;
    n.ingest({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: { oops: 1 }, is_error: true },
        ],
      },
    });
    expect(types(events)).toEqual(['tool.completed']);
    expect(events[0]).toMatchObject({
      payload: { toolCallId: 'toolu_1', ok: false, error: '[object Object]' },
    });
  });

  it('hasOpenTools() toggles true after tool.started and false again after its tool.completed', () => {
    const { n } = makeNormalizer();
    expect(n.hasOpenTools()).toBe(false);

    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
      },
    });
    expect(n.hasOpenTools()).toBe(true);

    n.ingest({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }],
      },
    });
    expect(n.hasOpenTools()).toBe(false);
  });

  // Partial-messages batch (片 1e): a content delta opens the partial gate, so
  // from here on text/thinking deltas leave through the CoalescingEmitter and
  // reach the sink when the 45ms window expires (or a foreign event arrives).
  // The dispatch this test pins — which delta type feeds which emitter — is
  // unchanged; only the moment of delivery moved.
  it('stream_event content_block_delta: text_delta -> message.delta, first thinking_delta -> thinking.started + thinking.delta', () => {
    vi.useFakeTimers();
    try {
      const { events, n } = makeNormalizer();
      n.ingest({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      });
      expect(types(events)).toEqual(['message.started']);
      vi.advanceTimersByTime(COALESCE_WINDOW_MS);
      expect(types(events)).toEqual(['message.started', 'message.delta']);
      expect(events[1]).toMatchObject({ payload: { text: 'partial' } });

      events.length = 0;
      n.ingest({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'pondering' },
        },
      });
      vi.advanceTimersByTime(COALESCE_WINDOW_MS);
      expect(types(events)).toEqual(['thinking.started', 'thinking.delta']);
      expect(events[1]).toMatchObject({ payload: { text: 'pondering' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('system subtype init emits session.status running; unknown subtypes emit nothing', () => {
    const { events, n } = makeNormalizer();
    n.ingest({ type: 'system', subtype: 'init' });
    expect(types(events)).toEqual(['session.status']);
    expect(events[0]).toMatchObject({ payload: { status: 'running' } });

    events.length = 0;
    n.ingest({ type: 'system', subtype: 'totally-unknown-subtype' });
    expect(events).toHaveLength(0);
  });

  // a1 (2026-07-30 net-visibility batch): previously api_retry was silently
  // dropped here — the ONE data point that explained a "hung" turn as a CLI
  // transport-retry loop instead of a genuine stall. It must now surface on
  // session.status (still 'running') with the retry fields passed through.
  it('system subtype api_retry emits session.status running with the retry payload', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'system',
      subtype: 'api_retry',
      attempt: 3,
      max_retries: 10,
      retry_delay_ms: 4200.5,
      error_status: null,
      error: 'unknown',
      session_id: 'rt-retry-1',
    });

    expect(types(events)).toEqual(['session.status']);
    expect(events[0]).toMatchObject({
      payload: {
        status: 'running',
        retry: {
          attempt: 3,
          maxRetries: 10,
          delayMs: 4200.5,
          errorStatus: null,
          error: 'unknown',
        },
      },
    });
  });

  it('system subtype api_retry with missing/non-numeric fields falls back to safe defaults instead of throwing', () => {
    const { events, n } = makeNormalizer();
    n.ingest({ type: 'system', subtype: 'api_retry' });

    expect(types(events)).toEqual(['session.status']);
    expect(events[0]).toMatchObject({
      payload: {
        status: 'running',
        retry: { attempt: 0, maxRetries: 0, delayMs: 0, errorStatus: null, error: 'unknown' },
      },
    });
  });

  it('system subtype api_retry with a numeric error_status stringifies it (HTTP status code case)', () => {
    const { events, n } = makeNormalizer();
    n.ingest({ type: 'system', subtype: 'api_retry', attempt: 1, error_status: 529 });

    expect((events[0].payload as { retry: { errorStatus: unknown } }).retry.errorStatus).toBe(
      '529'
    );
  });

  it('result after thinking+text closes the turn in order: thinking.completed, message.completed, usage.updated, session.completed, session.status idle', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'final answer' },
        ],
      },
    });

    events.length = 0;
    n.ingest({ type: 'result', usage: { input_tokens: 10, output_tokens: 20 } });
    expect(types(events)).toEqual([
      'thinking.completed',
      'message.completed',
      'usage.updated',
      'session.completed',
      'session.status',
    ]);
    expect(events[2].payload).toEqual({ input_tokens: 10, output_tokens: 20 });
    expect(events[4]).toMatchObject({ payload: { status: 'idle' } });
  });

  it('result with is_error:true emits session.failed with the error payload, then session.status failed', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    });

    events.length = 0;
    n.ingest({ type: 'result', is_error: true, error: 'boom' });
    expect(types(events)).toEqual(['message.completed', 'session.failed', 'session.status']);
    expect(events[1]).toMatchObject({ type: 'session.failed', payload: { error: 'boom' } });
    expect(events[2]).toMatchObject({ payload: { status: 'failed' } });
  });

  it('result with subtype "error" (no is_error flag) also triggers session.failed', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    });

    events.length = 0;
    n.ingest({ type: 'result', subtype: 'error', error: 'stream broke' });
    expect(types(events)).toEqual(['message.completed', 'session.failed', 'session.status']);
    expect(events[1]).toMatchObject({ payload: { error: 'stream broke' } });
  });

  it('result-only text fallback (no streamed assistant text) synthesizes message.started/delta/completed before terminals', () => {
    const { events, n } = makeNormalizer();
    n.ingest({ type: 'result', result: 'Final answer text' });

    expect(types(events)).toEqual([
      'message.started',
      'message.delta',
      'message.completed',
      'session.completed',
      'session.status',
    ]);
    expect(events[0]).toMatchObject({ payload: { role: 'assistant' } });
    expect(events[1]).toMatchObject({ payload: { text: 'Final answer text' } });
    expect(events[4]).toMatchObject({ payload: { status: 'idle' } });
  });

  describe('finishTurn', () => {
    it('returns "already" and emits nothing new once a result already closed the turn', () => {
      const { events, n } = makeNormalizer();
      n.ingest({ type: 'result', result: 'done' });

      events.length = 0;
      const outcome = n.finishTurn();
      expect(outcome).toBe('already');
      expect(events).toHaveLength(0);
    });

    it('returns "completed" with synthetic terminals when assistant output arrived but no result did', () => {
      const { events, n } = makeNormalizer();
      n.ingest({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      });

      events.length = 0;
      const outcome = n.finishTurn();
      expect(outcome).toBe('completed');
      expect(types(events)).toEqual(['message.completed', 'session.completed', 'session.status']);
      expect(events[2]).toMatchObject({ payload: { status: 'idle' } });
    });

    it('returns "failed" with a stream-ended error when no assistant output arrived at all', () => {
      const { events, n } = makeNormalizer();
      const outcome = n.finishTurn();
      expect(outcome).toBe('failed');
      expect(types(events)).toEqual(['session.failed', 'session.status']);
      expect((events[0].payload as { error: string }).error).toMatch(/stream ended/i);
      expect(events[1]).toMatchObject({ payload: { status: 'failed' } });
    });
  });

  it('emitStopped closes an open thinking block and message before session.stopped + status idle', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'partial' },
        ],
      },
    });

    events.length = 0;
    n.emitStopped();
    expect(types(events)).toEqual([
      'thinking.completed',
      'message.completed',
      'session.stopped',
      'session.status',
    ]);
    expect(events[3]).toMatchObject({ payload: { status: 'idle' } });
  });

  it('emitFailed closes an open thinking block and message before session.failed + status failed', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'partial' },
        ],
      },
    });

    events.length = 0;
    n.emitFailed('watchdog stall');
    expect(types(events)).toEqual([
      'thinking.completed',
      'message.completed',
      'session.failed',
      'session.status',
    ]);
    expect(events[2]).toMatchObject({ payload: { error: 'watchdog stall' } });
    expect(events[3]).toMatchObject({ payload: { status: 'failed' } });
  });

  it('malformed or unknown input never throws and never emits; unknown type only logs', () => {
    const events: Record<string, unknown>[] = [];
    const logs: unknown[][] = [];
    const n = new EventNormalizer(
      'sess-1',
      (e) => events.push(e),
      (...args) => logs.push(args)
    );

    expect(() => n.ingest(null)).not.toThrow();
    expect(() => n.ingest('a string')).not.toThrow();
    expect(() => n.ingest(42)).not.toThrow();
    expect(() => n.ingest({ type: 'totally-unknown' })).not.toThrow();

    expect(events).toHaveLength(0);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('ingest returns the SDK session_id string when present, undefined when absent', () => {
    const { n } = makeNormalizer();
    const withId = n.ingest({ type: 'system', subtype: 'init', session_id: 'sdk-session-abc' });
    expect(withId).toBe('sdk-session-abc');

    const withoutId = n.ingest({ type: 'system', subtype: 'init' });
    expect(withoutId).toBeUndefined();
  });

  it('beginTurn resets turn state: after a result-closed turn, a new assistant ingest emits a fresh envelope', () => {
    const { events, n } = makeNormalizer();
    n.ingest({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first turn answer' }] },
    });
    n.ingest({ type: 'result' });

    events.length = 0;
    n.beginTurn('next question', undefined, 'req-2');

    events.length = 0;
    n.ingest({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'second turn answer' }] },
    });
    expect(types(events)).toEqual(['message.started', 'message.delta']);
    expect(events[0]).toMatchObject({ payload: { role: 'assistant' } });
    expect(events[1]).toMatchObject({ payload: { text: 'second turn answer' } });
  });
});
