import { describe, expect, it } from 'vitest';
import { formatRelativeAge } from '@/lib/relativeTime';
import {
  defaultFormatTime,
  formatAbsoluteTime,
  formatRelativeTimestamp,
  initialMetadataRegistry,
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
    expect(next.byMessage.a1).toEqual({ startedAt: 1000, model: 'sonnet', reportedModel: null });
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
    expect(next.byMessage.a1).toEqual({
      startedAt: 1000,
      model: 'claude-opus-4-8[1m]',
      reportedModel: 'claude-opus-4-8[1m]',
    });
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
    expect(next.byMessage.a1).toEqual({ startedAt: 1000, model: 'sonnet', reportedModel: null });
  });

  // A06 (config-model-impersonates-actual): `reportedModel` must carry NO
  // fallback at all, even though `model` (above) falls back to the session
  // selection. A consumer that read `model` as "the actual model" would show
  // a fabricated "actual" — this pins the additive field that lets Context
  // surface tell the two apart.
  it('reportedModel stays null when the Host echoes no model, regardless of a session selection or catalog default being available', () => {
    const withSessionModel = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'a1', role: 'assistant' },
      }),
      'sonnet'
    );
    expect(withSessionModel.byMessage.a1.reportedModel).toBeNull();

    const withoutSessionModel = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'a1', role: 'assistant' },
      })
      // no sessionModel argument at all
    );
    expect(withoutSessionModel.byMessage.a1.reportedModel).toBeNull();
    expect(withoutSessionModel.byMessage.a1.model).toBeNull();
  });

  it('reportedModel equals the event model exactly, independent of the session selection', () => {
    const next = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'a1', role: 'assistant', model: 'claude-opus-4-8[1m]' },
      }),
      'a-completely-different-session-model'
    );
    expect(next.byMessage.a1.reportedModel).toBe('claude-opus-4-8[1m]');
    expect(next.byMessage.a1.model).toBe('claude-opus-4-8[1m]');
  });

  it('reportedModel survives a subsequent message.completed fold unchanged', () => {
    let reg = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'a1', role: 'assistant', model: 'claude-opus-4-8[1m]' },
      }),
      'sonnet'
    );
    reg = reduceMessageMetadata(
      reg,
      event('message.completed', { timestamp: 2200, payload: { messageId: 'a1' } })
    );
    expect(reg.byMessage.a1.reportedModel).toBe('claude-opus-4-8[1m]');
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

  // D33: interim ticks (`payload.interim === true`, the Host's live
  // token-estimate channel) must never reach this registry — the merge below
  // is additive and never clears keys, so an interim payload's `interim`/
  // `turn_output_tokens_display` keys would otherwise survive in `usage`
  // forever, even after the settled result lands.
  it('D33: an interim usage.updated tick is dropped; the settled result that follows lands clean', () => {
    let reg = reduceMessageMetadata(
      initialMetadataRegistry,
      event('message.started', {
        sessionId: 's1',
        timestamp: 1000,
        payload: { messageId: 'a1', role: 'assistant' },
      }),
      'sonnet'
    );
    // Step 1: an interim tick — must be a no-op.
    reg = reduceMessageMetadata(
      reg,
      event('usage.updated', {
        sessionId: 's1',
        payload: { interim: true, turn_output_tokens_display: 850 },
      })
    );
    expect(reg.byMessage.a1.usage).toBeUndefined();

    // Step 2: the settled result — lands deep-equal to ITS OWN payload, no
    // trace of the interim tick's keys.
    const resultPayload = { input_tokens: 10, output_tokens: 900 };
    reg = reduceMessageMetadata(
      reg,
      event('usage.updated', { sessionId: 's1', payload: resultPayload })
    );
    expect(reg.byMessage.a1.usage).toEqual(resultPayload);
    expect(reg.byMessage.a1.usage).not.toHaveProperty('interim');
    expect(reg.byMessage.a1.usage).not.toHaveProperty('turn_output_tokens_display');
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

  /*
   * The four `formatMessageMetadata` cases here retired with that function
   * (T12-b): it composed the turn meta row's `model · latency · time` line, and
   * the row is gone. `reduceMessageMetadata` above still fills the registry —
   * `MessageMetadata` is read by the timeline for `completedAt` (the hover
   * strip's `HH:MM`) and by the context surface for usage.
   */
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

  /*
   * `F-B13: formatMessageMetadata defaults to the relative timestamp` and
   * `F9: … renders the injected clock` both retired with that function (T12-b).
   * The property F9 existed to protect — a timestamp read against a later clock
   * must age — is still asserted directly above on `formatRelativeTimestamp`,
   * which the sidebar continues to use.
   */
});
