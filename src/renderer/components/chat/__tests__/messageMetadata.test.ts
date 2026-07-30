import { describe, expect, it } from 'vitest';
import {
  formatMessageMetadata,
  initialMetadataRegistry,
  type MessageMetadata,
  reduceMessageMetadata,
} from '../messageMetadata';

function event(
  type: string,
  opts: { sessionId?: string; timestamp?: number; payload?: Record<string, unknown> } = {}
): { type: string; sessionId?: string; timestamp?: number; payload?: Record<string, unknown> } {
  return { type, sessionId: opts.sessionId, timestamp: opts.timestamp, payload: opts.payload };
}

describe('reduceMessageMetadata (T-06)', () => {
  it('records assistant message.started with session model stamp and indexes session last assistant', () => {
    const next = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'a1', role: 'assistant' },
      }),
      'sonnet'
    );
    expect(next.byMessage.a1).toEqual({ startedAt: 1000, model: 'sonnet' });
    expect(next.bySessionLastAssistant.s1).toBe('a1');
  });

  it('ignores user message.started (no assistant index, no entry)', () => {
    const next = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'u1', role: 'user' },
      })
    );
    expect(next.byMessage.u1).toBeUndefined();
    expect(next.bySessionLastAssistant.s1).toBeUndefined();
  });

  it('computes latencyMs on message.completed from the recorded startedAt', () => {
    let reg = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'a1', role: 'assistant' },
      }),
      'sonnet'
    );
    reg = reduceMessageMetadata(
      reg,
      event('message.completed', { timestamp: 2200, payload: { messageId: 'a1' } })
    );
    expect(reg.byMessage.a1.latencyMs).toBe(1200);
    expect(reg.byMessage.a1.completedAt).toBe(2200);
  });

  it('attributes usage.updated to the session last assistant messageId', () => {
    let reg = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'a1', role: 'assistant' },
      }),
      'sonnet'
    );
    reg = reduceMessageMetadata(
      reg,
      event('usage.updated', { sessionId: 's1', payload: { input_tokens: 10, output_tokens: 5 } })
    );
    expect(reg.byMessage.a1.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('ignores usage.updated with no prior assistant index for the session', () => {
    const next = reduceMessageMetadata(
      initialMetadataRegistry,
      event('usage.updated', { sessionId: 's1', payload: { input_tokens: 1 } })
    );
    expect(next).toBe(initialMetadataRegistry);
  });

  it('ignores unrelated event types', () => {
    const base = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1,
        payload: { messageId: 'a1', role: 'assistant' },
      })
    );
    expect(reduceMessageMetadata(base, event('permission.requested', { sessionId: 's1' }))).toBe(
      base
    );
    expect(reduceMessageMetadata(base, event('host.ready', {}))).toBe(base);
  });

  it('formatMessageMetadata renders model · latency · time', () => {
    const meta: MessageMetadata = {
      startedAt: 1000,
      completedAt: 2200,
      latencyMs: 1200,
      model: 'sonnet',
    };
    const line = formatMessageMetadata(meta, { formatTime: () => '10:30' });
    expect(line).toBe('sonnet · 1.2s · 10:30');
  });

  it('formatMessageMetadata omits missing fields', () => {
    expect(formatMessageMetadata(undefined)).toBeNull();
    expect(formatMessageMetadata({ model: null })).toBeNull();
    expect(formatMessageMetadata({ completedAt: 2200 }, { formatTime: () => '10:30' })).toBe(
      '10:30'
    );
    expect(formatMessageMetadata({ latencyMs: -1 })).toBeNull();
  });

  it('formatMessageMetadata with omitLatency: true drops the latency segment (T-05 "model · time")', () => {
    const meta: MessageMetadata = {
      startedAt: 1000,
      completedAt: 2200,
      latencyMs: 1200,
      model: 'claude-opus-5',
    };
    const line = formatMessageMetadata(meta, { formatTime: () => '07:41', omitLatency: true });
    expect(line).toBe('claude-opus-5 · 07:41');
  });

  it('formatMessageMetadata default behavior (no options) is unchanged by the omitLatency addition', () => {
    const meta: MessageMetadata = {
      startedAt: 1000,
      completedAt: 2200,
      latencyMs: 1200,
      model: 'sonnet',
    };
    const line = formatMessageMetadata(meta, { formatTime: () => '10:30' });
    expect(line).toBe('sonnet · 1.2s · 10:30');
  });
});
