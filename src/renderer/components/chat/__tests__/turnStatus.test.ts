import { describe, expect, it } from 'vitest';
import { composerSendingLine, SLOW_WAIT_HINT_SECONDS } from '../attachments';
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
