import { describe, expect, it } from 'vitest';
import { deriveWeeklyQuotaView, formatQuotaUsd, parseWeeklyQuota } from '../weeklyQuota';

describe('F10 parseWeeklyQuota', () => {
  it('reads the documented shape', () => {
    expect(
      parseWeeklyQuota({ usedUsd: 12.4, limitUsd: 50, periodEnd: '2026-09-14T00:00:00Z' })
    ).toEqual({ usedUsd: 12.4, limitUsd: 50, periodEnd: '2026-09-14T00:00:00Z' });
  });

  it('answers null when there is no numerator to show', () => {
    // Inventing `0` here would report an unused allowance to somebody who may
    // have exhausted theirs.
    for (const payload of [null, undefined, 'nope', {}, { limitUsd: 50 }, { usedUsd: 'x' }]) {
      expect(parseWeeklyQuota(payload)).toBeNull();
    }
    expect(parseWeeklyQuota({ usedUsd: Number.NaN })).toBeNull();
    expect(parseWeeklyQuota({ usedUsd: -1 })).toBeNull();
  });

  it('keeps a missing limit missing rather than defaulting it', () => {
    // "No ceiling configured" is a real state and must survive the trip; a
    // default would make it indistinguishable from a ceiling of zero.
    expect(parseWeeklyQuota({ usedUsd: 3 })).toEqual({ usedUsd: 3, limitUsd: null });
    expect(parseWeeklyQuota({ usedUsd: 3, limitUsd: 'unlimited' })).toEqual({
      usedUsd: 3,
      limitUsd: null,
    });
  });

  it('omits periodEnd rather than inventing one', () => {
    expect(parseWeeklyQuota({ usedUsd: 1 })).not.toHaveProperty('periodEnd');
    expect(parseWeeklyQuota({ usedUsd: 1, periodEnd: '  ' })).not.toHaveProperty('periodEnd');
  });
});

describe('F10 deriveWeeklyQuotaView', () => {
  it('shows used over limit with a progress figure', () => {
    const view = deriveWeeklyQuotaView({ usedUsd: 12.4, limitUsd: 50 });
    expect(view.state).toBe('within');
    expect(view.amountText).toBe('$12.40 / $50.00');
    expect(view.percent).toBe(25);
    expect(view.remainingText).toBe('$37.60');
  });

  it('never produces NaN or a percentage when nothing arrived', () => {
    // The defect this whole state machine exists to prevent.
    const view = deriveWeeklyQuotaView(null);
    expect(view.state).toBe('unavailable');
    expect(view.percent).toBeNull();
    expect(view.amountText).toBe('');
    expect(view.remainingText).toBeNull();
  });

  it('shows spending with no bar when no ceiling is configured', () => {
    const view = deriveWeeklyQuotaView({ usedUsd: 12.4, limitUsd: null });
    expect(view.state).toBe('no-limit');
    expect(view.amountText).toBe('$12.40');
    // No denominator, so no percentage — the arm that makes `NaN%` unreachable.
    expect(view.percent).toBeNull();
  });

  it('flags an exceeded allowance and states the overage', () => {
    const view = deriveWeeklyQuotaView({ usedUsd: 62.5, limitUsd: 50 });
    expect(view.state).toBe('exceeded');
    expect(view.remainingText).toBe('$12.50');
    // Clamped: a bar past its own track says nothing `exceeded` does not.
    expect(view.percent).toBe(100);
  });

  it('treats a zero ceiling as a real limit, not as unlimited', () => {
    // An account capped at zero is a decision somebody made; reporting it as
    // unlimited would invert it.
    const spent = deriveWeeklyQuotaView({ usedUsd: 0.5, limitUsd: 0 });
    expect(spent.state).toBe('exceeded');
    expect(spent.percent).toBe(100);
    const untouched = deriveWeeklyQuotaView({ usedUsd: 0, limitUsd: 0 });
    expect(untouched.state).toBe('within');
  });

  it('passes the period end through when the service states one', () => {
    expect(
      deriveWeeklyQuotaView({ usedUsd: 1, limitUsd: 5, periodEnd: '2026-09-14T00:00:00Z' })
        .periodEnd
    ).toBe('2026-09-14T00:00:00Z');
    expect(deriveWeeklyQuotaView({ usedUsd: 1, limitUsd: 5 }).periodEnd).toBeNull();
  });

  it('formats money the way the rest of the account surfaces do', () => {
    expect(formatQuotaUsd(0.0123)).toBe('$0.0123');
    expect(formatQuotaUsd(12.4)).toBe('$12.40');
  });
});
