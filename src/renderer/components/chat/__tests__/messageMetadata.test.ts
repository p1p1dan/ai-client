import { describe, expect, it } from 'vitest';
import { formatRelativeAge } from '@/lib/relativeTime';
import {
  defaultFormatTime,
  formatAbsoluteTime,
  formatMessageMetadata,
  formatRelativeTimestamp,
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

  // Round-2 P0 (event source real model): the event's own model wins over
  // the locally-selected sessionModel — fixes "displayed selection masks
  // the actual model" (P-14).
  it('prefers the event-sourced actual model over the local session selection', () => {
    const next = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'a1', role: 'assistant', model: 'claude-opus-4-8[1m]' },
      }),
      'sonnet'
    );
    expect(next.byMessage.a1).toEqual({ startedAt: 1000, model: 'claude-opus-4-8[1m]' });
  });

  it('falls back to the local session selection when the event carries no model (unchanged fallback chain)', () => {
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

// F-B13 (T-31 §4.6 / polish-audit P-18): the footer timestamp is relative now.
// The sidebar already showed relative ages, so the interesting property is not
// the wording but that both surfaces answer from ONE bucket table — a second
// implementation would drift the two into disagreeing about when "an hour ago"
// starts.
describe('relative timestamps (F-B13)', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);

  it('F-B13: under a minute reads "just now"', () => {
    expect(formatRelativeTimestamp(NOW - 5_000, NOW)).toBe('just now');
    expect(formatRelativeTimestamp(NOW - 59_000, NOW)).toBe('just now');
    // Clock skew (a future timestamp) must not fall through to a negative age.
    expect(formatRelativeTimestamp(NOW + 5_000, NOW)).toBe('just now');
  });

  it('F-B13: 90 minutes reads "1h ago"', () => {
    expect(formatRelativeTimestamp(NOW - 90 * MINUTE, NOW)).toBe('1h ago');
  });

  it('F-B13: across a day boundary reads "Nd ago"', () => {
    expect(formatRelativeTimestamp(NOW - DAY, NOW)).toBe('1d ago');
    expect(formatRelativeTimestamp(NOW - 3 * DAY, NOW)).toBe('3d ago');
  });

  it('F-B13: same source as the sidebar — the suffix is the ONLY difference', () => {
    const samples = [30_000, 5 * MINUTE, 90 * MINUTE, 3 * DAY, 10 * DAY, 60 * DAY, 400 * DAY];
    for (const age of samples) {
      const sidebar = formatRelativeAge(NOW - age, NOW);
      const footer = formatRelativeTimestamp(NOW - age, NOW);
      expect(footer).toBe(sidebar === 'now' ? 'just now' : `${sidebar} ago`);
    }
  });

  it('F-B13: defaultFormatTime is the relative form, read against the wall clock', () => {
    const now = Date.now();
    expect(defaultFormatTime(now - 5_000)).toBe('just now');
    expect(defaultFormatTime(now - 90 * MINUTE)).toBe('1h ago');
    expect(defaultFormatTime(now - 3 * DAY)).toBe('3d ago');
  });

  it('F-B13: formatMessageMetadata now defaults to the relative timestamp', () => {
    const meta: MessageMetadata = {
      model: 'claude-opus-5',
      completedAt: Date.now() - 3 * 3600_000,
    };
    expect(formatMessageMetadata(meta, { omitLatency: true })).toBe('claude-opus-5 · 3h ago');
  });

  // The precision the relative form trades away is restored on hover (§10-D),
  // so the absolute formatter stays exported rather than being deleted.
  it('F-B13: the absolute clock time stays available for the title attribute', () => {
    const at = new Date(2026, 6, 31, 7, 41).getTime();
    expect(formatAbsoluteTime(at)).toBe('07:41');
  });

  // Review batch F9. The footer used to render through `defaultFormatTime`,
  // which reads `Date.now()` itself — so the age only ever advanced when
  // something ELSE re-rendered that turn, and in an idle session nothing does.
  // "just now" stayed "just now" for hours. The fix is that `MessageTimeline`
  // owns one clock and passes it in; these assertions pin the property that
  // makes that possible — the same message, read against a later clock, ages.
  it('F9: the same timestamp read against a later clock advances', () => {
    const completedAt = NOW;
    expect(formatRelativeTimestamp(completedAt, NOW + 5_000)).toBe('just now');
    expect(formatRelativeTimestamp(completedAt, NOW + MINUTE)).toBe('1m ago');
    expect(formatRelativeTimestamp(completedAt, NOW + 2 * MINUTE)).toBe('2m ago');
    expect(formatRelativeTimestamp(completedAt, NOW + HOUR)).toBe('1h ago');
  });

  // The wiring F9 actually depends on: the injected `formatTime` must be what
  // renders the footer's timestamp segment, not the wall-clock default.
  it('F9: formatMessageMetadata renders the injected clock, not Date.now()', () => {
    const meta: MessageMetadata = { model: 'claude-opus-5', completedAt: NOW };
    const at = (now: number) =>
      formatMessageMetadata(meta, {
        omitLatency: true,
        formatTime: (ms) => formatRelativeTimestamp(ms, now),
      });
    expect(at(NOW + 5_000)).toBe('claude-opus-5 · just now');
    expect(at(NOW + MINUTE)).toBe('claude-opus-5 · 1m ago');
    // A clock far from the wall clock proves the default was not consulted.
    expect(at(NOW + 400 * DAY)).toBe('claude-opus-5 · 1y ago');
  });
});
