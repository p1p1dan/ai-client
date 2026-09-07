import { describe, expect, it } from 'vitest';
import { deriveWeeklyQuotaView, formatQuotaUsd, parseWeeklyQuota } from '../weeklyQuota';

/**
 * Captured from cch's live `my-usage/getMyQuota` on 2026-09-07 with a real key.
 *
 * Account-identifying values are replaced (`userName`, the provider groups, the
 * key name); every FIELD NAME and every quota number is exactly what the
 * gateway returned. The unrelated fields are kept on purpose — they are what
 * proves the parser ignores the other four windows and the account metadata
 * instead of tripping over them.
 */
const CAPTURED_GET_MY_QUOTA = {
  keyLimit5hUsd: null,
  keyLimitDailyUsd: null,
  keyLimitWeeklyUsd: null,
  keyLimitMonthlyUsd: null,
  keyLimitTotalUsd: null,
  keyLimitConcurrentSessions: 0,
  keyCurrent5hUsd: 0,
  keyCurrentDailyUsd: 0,
  keyCurrentWeeklyUsd: 0,
  keyCurrentMonthlyUsd: 0,
  keyCurrentTotalUsd: 2.0878065,
  keyCurrentConcurrentSessions: 0,
  userLimit5hUsd: null,
  userLimitWeeklyUsd: 1000,
  userLimitMonthlyUsd: null,
  userLimitTotalUsd: null,
  userLimitConcurrentSessions: null,
  userRpmLimit: null,
  userCurrent5hUsd: 0,
  userCurrentDailyUsd: 0.13937024,
  userCurrentWeeklyUsd: 0.13937024,
  userCurrentMonthlyUsd: 0.13937024,
  userCurrentTotalUsd: 2490.41637794,
  userCurrentConcurrentSessions: 0,
  userLimitDailyUsd: null,
  userExpiresAt: null,
  userProviderGroup: 'group-a,group-b',
  userName: 'user@example.test',
  userIsEnabled: true,
  keyProviderGroup: 'group-a',
  keyName: 'key-1',
  keyIsEnabled: true,
  userAllowedModels: [],
  userAllowedClients: [],
  expiresAt: null,
  dailyResetMode: 'fixed',
  dailyResetTime: '00:00',
};

describe('F10 parseWeeklyQuota — real cch payload', () => {
  it('reads the binding weekly allowance out of the captured response', () => {
    // The key has no weekly ceiling; the user does. Reading only the key scope
    // would have told this account it has no allowance at all.
    expect(parseWeeklyQuota(CAPTURED_GET_MY_QUOTA)).toEqual({
      usedUsd: 0.13937024,
      limitUsd: 1000,
    });
  });

  it('states no period end, because the payload contains none', () => {
    // `dailyResetTime` is the DAILY window's and `expiresAt` is account expiry;
    // reading either as the week's end would put a confident wrong date on the
    // card.
    expect(parseWeeklyQuota(CAPTURED_GET_MY_QUOTA)).not.toHaveProperty('periodEnd');
  });

  it('ignores the other four windows and the account metadata', () => {
    // `keyCurrentTotalUsd: 2.09` and `userCurrentTotalUsd: 2490.42` are both in
    // the same payload and neither may leak into a WEEKLY figure.
    const parsed = parseWeeklyQuota(CAPTURED_GET_MY_QUOTA);
    expect(parsed?.usedUsd).not.toBe(2.0878065);
    expect(parsed?.usedUsd).not.toBe(2490.41637794);
  });
});

describe('F10 parseWeeklyQuota — scope selection', () => {
  it('takes the key scope when it is the tighter of the two', () => {
    expect(
      parseWeeklyQuota({
        keyCurrentWeeklyUsd: 9,
        keyLimitWeeklyUsd: 10,
        userCurrentWeeklyUsd: 50,
        userLimitWeeklyUsd: 1000,
      })
    ).toEqual({ usedUsd: 9, limitUsd: 10 });
  });

  it('takes the user scope when the key has more headroom', () => {
    expect(
      parseWeeklyQuota({
        keyCurrentWeeklyUsd: 0,
        keyLimitWeeklyUsd: 10_000,
        userCurrentWeeklyUsd: 990,
        userLimitWeeklyUsd: 1000,
      })
    ).toEqual({ usedUsd: 990, limitUsd: 1000 });
  });

  it('never pairs one scope limit with the other scope usage', () => {
    // The percentage would be of nothing: the key's weekly spend counts one
    // key, the user's counts every key they hold.
    const parsed = parseWeeklyQuota({
      keyCurrentWeeklyUsd: 1,
      keyLimitWeeklyUsd: 5,
      userCurrentWeeklyUsd: 800,
      userLimitWeeklyUsd: 1000,
    });
    expect(parsed).toEqual({ usedUsd: 1, limitUsd: 5 });
  });

  it('breaks a headroom tie on the lower ceiling, so the answer is stable', () => {
    expect(
      parseWeeklyQuota({
        keyCurrentWeeklyUsd: 5,
        keyLimitWeeklyUsd: 10,
        userCurrentWeeklyUsd: 95,
        userLimitWeeklyUsd: 100,
      })
    ).toEqual({ usedUsd: 5, limitUsd: 10 });
  });

  it("reports the user's spend when neither scope sets a ceiling", () => {
    // The figure that describes the person, not this one installation.
    expect(
      parseWeeklyQuota({
        keyCurrentWeeklyUsd: 2,
        keyLimitWeeklyUsd: null,
        userCurrentWeeklyUsd: 40,
        userLimitWeeklyUsd: null,
      })
    ).toEqual({ usedUsd: 40, limitUsd: null });
  });
});

describe('F10 parseWeeklyQuota', () => {
  it('accepts one unscoped weekly pair, for a gateway that reports it that way', () => {
    expect(
      parseWeeklyQuota({ costWeekly: 12.4, limitWeeklyUsd: 50, periodEnd: '2026-09-14T00:00:00Z' })
    ).toEqual({ usedUsd: 12.4, limitUsd: 50, periodEnd: '2026-09-14T00:00:00Z' });
    expect(parseWeeklyQuota({ weeklyCostUsd: 1, weeklyLimitUsd: 2 })).toEqual({
      usedUsd: 1,
      limitUsd: 2,
    });
  });

  it('takes a reset time as an epoch number as well as a string', () => {
    expect(parseWeeklyQuota({ costWeekly: 1, weeklyResetAt: 1_789_000_000_000 })?.periodEnd).toBe(
      new Date(1_789_000_000_000).toISOString()
    );
    // Not a usable instant: say nothing rather than render 1970.
    expect(parseWeeklyQuota({ costWeekly: 1, weeklyResetAt: 0 })).not.toHaveProperty('periodEnd');
  });

  it('answers null when there is no numerator anywhere', () => {
    // Inventing `0` would report an unused allowance to somebody who may have
    // exhausted theirs.
    for (const payload of [null, undefined, 'nope', {}, { userLimitWeeklyUsd: 50 }]) {
      expect(parseWeeklyQuota(payload)).toBeNull();
    }
    expect(parseWeeklyQuota({ userCurrentWeeklyUsd: Number.NaN })).toBeNull();
    expect(parseWeeklyQuota({ userCurrentWeeklyUsd: -1 })).toBeNull();
  });

  it('reads a blank weekly limit as unlimited, which is what cch means by it', () => {
    // cch's admin field says 留空表示无限制 — an absent ceiling is a real
    // configuration, not a broken response.
    expect(parseWeeklyQuota({ userCurrentWeeklyUsd: 12.4, userLimitWeeklyUsd: null })).toEqual({
      usedUsd: 12.4,
      limitUsd: null,
    });
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
