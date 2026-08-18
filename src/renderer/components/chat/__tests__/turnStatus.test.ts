import { describe, expect, it } from 'vitest';
import { composerSendingLine, SLOW_WAIT_HINT_SECONDS, STALLED_HINT_SECONDS } from '../attachments';
import {
  deriveTurnStatus,
  formatElapsedClock,
  formatTokenCount,
  isFailedCardBodyDuplicate,
  latestErrorNoticeText,
  TURN_FAILED_TEXT,
  type TurnStatusInput,
} from '../turnStatus';

const base: TurnStatusInput = {
  active: true,
  phase: 'awaiting',
  elapsedSeconds: 12,
  budgetMs: 45_000,
  attachmentCount: 0,
  attachmentBytes: 0,
};

describe('deriveTurnStatus (F-B5)', () => {
  it('F-B5: handshake', () => {
    const status = deriveTurnStatus({ ...base, phase: 'handshake', elapsedSeconds: 3 });
    expect(status?.kind).toBe('handshake');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'handshake',
        elapsedSeconds: 3,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    );
  });

  // The point of this pair is that neither side is a literal. `attachments.ts`
  // owns the copy and `attachments.test.ts` pins it word for word; this asserts
  // the turn head *delegates* rather than keeping a second copy of the string,
  // which is the drift the spec (§3.2) is guarding against.
  it('F-B5: awaiting is character-for-character the same-argument composerSendingLine output', () => {
    const status = deriveTurnStatus(base);
    expect(status?.kind).toBe('awaiting');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 12,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    );
  });

  it('F-B5: awaiting delegates the attachment branch too, without knowing its shape', () => {
    const input = { ...base, attachmentCount: 1, attachmentBytes: 155_648, elapsedSeconds: 31 };
    expect(deriveTurnStatus(input)?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 31,
        budgetMs: 45_000,
        attachmentCount: 1,
        attachmentBytes: 155_648,
      })
    );
  });

  it('D33: streaming — elapsed clock only, no verb, when no token estimate has arrived', () => {
    const status = deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: 7 });
    expect(status).toEqual({ kind: 'streaming', text: '7s' });
  });

  it('D33: streaming outranks the slow branch — "Still waiting" is false once tokens arrive', () => {
    const status = deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: 90 });
    expect(status).toEqual({ kind: 'streaming', text: '1m 30s' });
  });

  it('D33: streaming appends the ↓ token suffix once an estimate is present', () => {
    const status = deriveTurnStatus({
      ...base,
      hasBlocks: true,
      elapsedSeconds: 7,
      outputTokensDisplay: 850,
    });
    expect(status).toEqual({ kind: 'streaming', text: '7s · ↓ 850' });
  });

  it('D33: streaming formats a large token estimate in k-notation', () => {
    const status = deriveTurnStatus({
      ...base,
      hasBlocks: true,
      elapsedSeconds: 7,
      outputTokensDisplay: 38512,
    });
    expect(status).toEqual({ kind: 'streaming', text: '7s · ↓ 38.5k' });
  });

  it('D33: streaming omits the ↓ suffix for null/undefined outputTokensDisplay', () => {
    expect(
      deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: 7, outputTokensDisplay: null })
        ?.text
    ).toBe('7s');
    expect(deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: 7 })?.text).toBe('7s');
  });

  it('F-B5: slow at the threshold, still delegating the copy', () => {
    const status = deriveTurnStatus({ ...base, elapsedSeconds: SLOW_WAIT_HINT_SECONDS });
    expect(status?.kind).toBe('slow');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: SLOW_WAIT_HINT_SECONDS,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    );
    // One second earlier is still the ordinary waiting state: the kind flips on
    // the same constant the copy does, never a second threshold of its own.
    expect(deriveTurnStatus({ ...base, elapsedSeconds: SLOW_WAIT_HINT_SECONDS - 1 })?.kind).toBe(
      'awaiting'
    );
  });

  it('F-B5: retrying carries the retry counter through, base copy intact', () => {
    const retry = { attempt: 3, maxRetries: 10 };
    const status = deriveTurnStatus({ ...base, retry });
    expect(status?.kind).toBe('retrying');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: 12,
        budgetMs: 45_000,
        attachmentCount: 0,
        attachmentBytes: 0,
        retry,
      })
    );
  });

  it('F-B5: complete returns null — the "Worked for Ns" row takes the same slot', () => {
    expect(deriveTurnStatus({ ...base, active: false })).toBeNull();
  });

  it('F-B5: failed wins over every in-flight branch and stays a short fixed label', () => {
    expect(deriveTurnStatus({ ...base, failed: true })).toEqual({
      kind: 'failed',
      text: TURN_FAILED_TEXT,
    });
    expect(deriveTurnStatus({ ...base, active: false, failed: true })?.kind).toBe('failed');
    expect(TURN_FAILED_TEXT.length).toBeLessThanOrEqual(16);
  });

  it('F-B5: a negative/fractional elapsed counts the same second as the composer copy does', () => {
    expect(deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: -2 })?.text).toBe('0s');
    expect(deriveTurnStatus({ ...base, hasBlocks: true, elapsedSeconds: 7.9 })?.text).toBe('7s');
  });
});

describe('formatElapsedClock (D33)', () => {
  it('renders under a minute as bare seconds', () => {
    expect(formatElapsedClock(0)).toBe('0s');
    expect(formatElapsedClock(42)).toBe('42s');
    expect(formatElapsedClock(59)).toBe('59s');
  });

  it('renders a minute and over as "Nm Ns"', () => {
    expect(formatElapsedClock(60)).toBe('1m 0s');
    expect(formatElapsedClock(61)).toBe('1m 1s');
    expect(formatElapsedClock(1195)).toBe('19m 55s');
  });

  it('floors fractional input and clamps negative input to zero', () => {
    expect(formatElapsedClock(7.9)).toBe('7s');
    expect(formatElapsedClock(-5)).toBe('0s');
  });
});

describe('formatTokenCount (D33)', () => {
  it('renders under 1000 as-is', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(850)).toBe('850');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('renders 1000 and over as one-decimal k-notation', () => {
    expect(formatTokenCount(1000)).toBe('1.0k');
    expect(formatTokenCount(38512)).toBe('38.5k');
  });
});

describe('round-10 ③ — failed-card body dedupe vs the error notice', () => {
  it('containment in either direction is a duplicate (String(err) wears an Error: prefix)', () => {
    expect(isFailedCardBodyDuplicate('upstream 503', 'Error: upstream 503')).toBe(true);
    expect(isFailedCardBodyDuplicate('Error: upstream 503', 'upstream 503')).toBe(true);
    expect(isFailedCardBodyDuplicate('upstream 503', 'upstream 503')).toBe(true);
  });

  it('a different failure text keeps the card body', () => {
    expect(isFailedCardBodyDuplicate('watchdog fired', 'Error: upstream 503')).toBe(false);
  });

  it('absence on either side keeps the card body (replayed failure with no notice)', () => {
    expect(isFailedCardBodyDuplicate(null, 'Error: x')).toBe(false);
    expect(isFailedCardBodyDuplicate('x', null)).toBe(false);
    expect(isFailedCardBodyDuplicate('', '')).toBe(false);
  });

  it('latestErrorNoticeText picks the newest error notice, skipping other roles and empty bodies', () => {
    const messages = [
      { role: 'error', blocks: [{ type: 'text', text: 'old failure' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'prose' }] },
      { role: 'error', blocks: [{ type: 'text', text: 'Error: new failure' }] },
      { role: 'user', blocks: [{ type: 'text', text: 'hey' }] },
    ];
    expect(latestErrorNoticeText(messages)).toBe('Error: new failure');
    expect(latestErrorNoticeText([])).toBeNull();
    expect(latestErrorNoticeText([{ role: 'error', blocks: [] }])).toBeNull();
  });
});

/**
 * F2 S3 §8.3 / §12.1 — `[TS-1]`: `kind` and copy are SAME-SOURCED.
 *
 * `turnStatus.ts` and `composerSendingLine` both key their wording switch off
 * the one imported `SLOW_WAIT_HINT_SECONDS`, which is what makes it impossible
 * for the head to say "Still waiting" while calling itself `awaiting` (or the
 * reverse). F2 makes this window reachable for text-only sends for the first
 * time — the budget went from 45s to a 300s silence ceiling, so `45s -> 300s`
 * is now a VISIBLE waiting state rather than the instant before an abandon.
 *
 * The proposition is deliberately "kind and copy flip together", NOT ">=45 is
 * always slow": F456's fourth slice splits `>=180` off into its own `'stalled'`
 * kind, and a test written the second way would go red by construction on a
 * proposition F2 never owned. The sample point is therefore anchored INSIDE
 * `[45, 180)` — 62s, the same second `attachments.test.ts:357`/`:436` pin word
 * for word, so the two suites stay same-sourced too.
 */
describe('[TS-1] slow kind and slow copy are same-sourced (F2 §8.3)', () => {
  const SAMPLE_SECONDS = 62;

  it('[TS-1] 62s with no blocks is `slow`, and its text delegates to composerSendingLine', () => {
    expect(SAMPLE_SECONDS).toBeGreaterThanOrEqual(SLOW_WAIT_HINT_SECONDS);
    const input: TurnStatusInput = {
      ...base,
      elapsedSeconds: SAMPLE_SECONDS,
      budgetMs: 300_000,
      hasBlocks: false,
    };
    const status = deriveTurnStatus(input);
    expect(status?.kind).toBe('slow');
    // Delegation, not a literal — the same posture as the `awaiting` pair
    // above. `attachments.test.ts` owns the word-for-word pin.
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: SAMPLE_SECONDS,
        budgetMs: 300_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      })
    );
    // The one word-level fact this batch DID audit before making the copy
    // reachable on the text-only path (§8.4): the instruction it gives is
    // executable. Stop really is on screen in this state — `'pending'` keeps
    // the turn head alive and never unbinds the Host, so the button reaches it.
    expect(status?.text).toContain('Stop to abort.');
  });

  it('[TS-1] the retry suffix survives the slow branch, still from the same source', () => {
    const retry = { attempt: 1, maxRetries: 10 };
    const status = deriveTurnStatus({
      ...base,
      elapsedSeconds: SAMPLE_SECONDS,
      budgetMs: 300_000,
      hasBlocks: false,
      retry,
    });
    expect(status?.kind).toBe('slow');
    expect(status?.text).toBe(
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds: SAMPLE_SECONDS,
        budgetMs: 300_000,
        attachmentCount: 0,
        attachmentBytes: 0,
        retry,
      })
    );
  });

  it('[TS-1] the budget re-source does not print a deadline in the slow branch', () => {
    // §9.3 change 4: `(up to Ns)` is a prediction, and past the threshold
    // there is nothing to predict — reaching the ceiling is not an event.
    const status = deriveTurnStatus({
      ...base,
      elapsedSeconds: SAMPLE_SECONDS,
      budgetMs: 300_000,
      hasBlocks: false,
    });
    expect(status?.text).not.toContain('up to');
  });
});

/**
 * F456 slice ④ §7.5-b — `[TS-1]` continued, in its SEGMENTED form.
 *
 * F2 wrote `[TS-1]` as "kind and copy flip together" and anchored its sample
 * inside `[45, 180)` precisely so this batch could split `>=180` off without
 * retiring it. What follows is the other segment plus the boundary sweep F2's
 * §8.3 asked the later batch to add: the two thresholds now key TWO wording
 * switches, and the same-source invariant is stated over both.
 *
 * The load-bearing half — every waiting tier names the control that is
 * actually on screen — is asserted on BOTH tiers, not just the one F2 owned.
 */
describe('[TS-1] the slow/stalled split keeps kind and copy same-sourced (F456 §7.5-b)', () => {
  it('[TS-1] `[SLOW, STALLED)` is slow and `>= STALLED` is stalled, both delegating their copy', () => {
    const at = (elapsedSeconds: number) =>
      deriveTurnStatus({ ...base, elapsedSeconds, budgetMs: 300_000, hasBlocks: false });
    const sameArgumentCopy = (elapsedSeconds: number) =>
      composerSendingLine({
        phase: 'awaiting',
        elapsedSeconds,
        budgetMs: 300_000,
        attachmentCount: 0,
        attachmentBytes: 0,
      });

    for (const second of [SLOW_WAIT_HINT_SECONDS, 62, STALLED_HINT_SECONDS - 1]) {
      expect(at(second)?.kind, `at ${second}s`).toBe('slow');
      expect(at(second)?.text, `at ${second}s`).toBe(sameArgumentCopy(second));
    }
    for (const second of [STALLED_HINT_SECONDS, 299]) {
      expect(at(second)?.kind, `at ${second}s`).toBe('stalled');
      expect(at(second)?.text, `at ${second}s`).toBe(sameArgumentCopy(second));
    }
  });

  it('[TS-1] both waiting tiers still tell the user about a control that exists', () => {
    // F2 §9's stated purpose for this half was to stop a later batch deleting
    // it. A later batch then added a tier — so the half moves with it rather
    // than staying pinned to the one tier that happened to exist first.
    for (const second of [SLOW_WAIT_HINT_SECONDS, STALLED_HINT_SECONDS, 299]) {
      const status = deriveTurnStatus({
        ...base,
        elapsedSeconds: second,
        budgetMs: 300_000,
        hasBlocks: false,
      });
      expect(status?.text, `at ${second}s`).toContain('Stop to abort.');
    }
  });

  /**
   * `[TS-1b]` The boundary sweep. At each of the four seconds either BOTH the
   * kind and the wording change, or NEITHER does — a kind that moved a second
   * before (or after) its copy is exactly the drift the shared constants exist
   * to prevent, and it is invisible to a test that samples one second per tier.
   */
  it('[TS-1b] kind and copy flip on the same second at 44/45 and 179/180', () => {
    const sample = (elapsedSeconds: number) => {
      const status = deriveTurnStatus({
        ...base,
        elapsedSeconds,
        budgetMs: 300_000,
        hasBlocks: false,
      });
      return { kind: status?.kind, text: status?.text };
    };
    const before = [SLOW_WAIT_HINT_SECONDS - 1, STALLED_HINT_SECONDS - 1];
    for (const boundary of before) {
      const low = sample(boundary);
      const high = sample(boundary + 1);
      expect(low.kind, `kind must change at ${boundary + 1}s`).not.toBe(high.kind);
      expect(low.text, `copy must change at ${boundary + 1}s`).not.toBe(high.text);
    }
    // And the seconds that are NOT boundaries move neither: one step inside
    // each tier leaves both the kind and the sentence alone.
    for (const boundary of before) {
      const a = sample(boundary - 1);
      const b = sample(boundary);
      expect(a.kind, `kind must not change at ${boundary}s`).toBe(b.kind);
      expect(a.text?.replace(`${boundary - 1}s`, `${boundary}s`)).toBe(b.text);
    }
  });
});

/**
 * F456 slice ④ §7.4 / §8.4 `[F4-3]` — the two counters, asserted at the layer
 * that WIRES them rather than the one that formats them.
 *
 * `attachments.test.ts` owns the formatting contract. What only this file can
 * see is whether `deriveTurnStatus` actually hands its own inputs down: the
 * `↓` estimate used to be read exclusively by the streaming branch, and a
 * version that keeps it there passes every assertion in the other suite while
 * showing the user nothing.
 */
describe('[F4-3] deriveTurnStatus feeds both counters into the waiting copy', () => {
  it('[F4-3] the awaiting tier carries the ↓ token estimate, not just the streaming tier', () => {
    const status = deriveTurnStatus({
      ...base,
      hasBlocks: false,
      outputTokensDisplay: 1800,
    });
    expect(status?.kind).toBe('awaiting');
    expect(status?.text).toContain('↓ 1.8k');
  });

  it('[F4-3] the awaiting tier carries the ↑ prompt size from the send snapshot', () => {
    const status = deriveTurnStatus({ ...base, hasBlocks: false, promptChars: 428 });
    expect(status?.text).toContain('↑ 428 chars');
  });

  it('[F4-3] a turn with no snapshot and no estimate shows neither arrow', () => {
    // The `?? 0` fallback in `MessageTimeline.tsx` exists for a session that was
    // already running when this window opened. It must read as "unknown", never
    // as a user who sent nothing.
    const status = deriveTurnStatus({
      ...base,
      hasBlocks: false,
      promptChars: 0,
      outputTokensDisplay: null,
    });
    expect(status?.text).not.toContain('↑');
    expect(status?.text).not.toContain('↓');
  });
});
