import type { WeeklyQuota } from './types/usage';

/**
 * F10 — reading the weekly allowance off the wire, and deciding what the card
 * says about it.
 *
 * Pure, and in `shared` rather than in the renderer, for the usual reason here:
 * the repo's vitest is node-env and collects only `*.test.ts`, so a percentage
 * computed inline in a `.tsx` has no automated coverage — and "shows NaN when
 * the limit is missing" is precisely the class of defect that lives in an
 * untested inline computation.
 */

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Read the weekly allowance out of a cch `my-usage/getMyQuota` payload.
 *
 * ## Two scopes, and why the tighter one wins
 *
 * cch tracks every spend window TWICE — once for the API key and once for the
 * user who owns it — and this app holds one key out of however many that user
 * has. Observed against the live gateway (2026-09-07): a key with no weekly
 * ceiling of its own, under a user with `userLimitWeeklyUsd: 1000` and
 * `userCurrentWeeklyUsd: 0.139`. Reading only the key scope would have reported
 * "no allowance configured" to someone who very much has one.
 *
 * So both scopes are candidates and the BINDING one is chosen: whichever will
 * stop the user first, i.e. has the least headroom. Each candidate carries its
 * own spend figure, because the two are not interchangeable — the key's weekly
 * spend counts only this key, the user's counts every key they hold — and
 * pairing one scope's limit with the other's usage would produce a percentage
 * of nothing.
 *
 * When neither scope sets a ceiling, the USER's spend is what gets reported
 * alongside "no limit": it is the figure that describes the person rather than
 * this one installation.
 *
 * ## No period end
 *
 * The payload has no weekly reset instant. `dailyResetTime` belongs to the
 * DAILY window, and `expiresAt` / `userExpiresAt` are account expiry — reading
 * either as the week's end would put a confident wrong date on the card. So
 * `periodEnd` is normally absent; the aliases below exist only so a future
 * gateway that does state one is picked up without another round trip.
 */
export function parseWeeklyQuota(payload: unknown): WeeklyQuota | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;

  const keyUsed = finiteNonNegative(raw.keyCurrentWeeklyUsd);
  const keyLimit = finiteNonNegative(raw.keyLimitWeeklyUsd);
  const userUsed = finiteNonNegative(raw.userCurrentWeeklyUsd);
  const userLimit = finiteNonNegative(raw.userLimitWeeklyUsd);

  // Generic fallbacks, for a caller (or a future gateway) that reports one
  // unscoped weekly pair instead of cch's two.
  const flatUsed = finiteNonNegative(raw.costWeekly ?? raw.weeklyCostUsd ?? raw.usedUsd);
  const flatLimit = finiteNonNegative(raw.limitWeeklyUsd ?? raw.weeklyLimitUsd ?? raw.limitUsd);

  const scoped: Array<{ usedUsd: number; limitUsd: number }> = [];
  if (keyUsed !== null && keyLimit !== null) scoped.push({ usedUsd: keyUsed, limitUsd: keyLimit });
  if (userUsed !== null && userLimit !== null) {
    scoped.push({ usedUsd: userUsed, limitUsd: userLimit });
  }
  if (flatUsed !== null && flatLimit !== null) {
    scoped.push({ usedUsd: flatUsed, limitUsd: flatLimit });
  }

  const periodEnd = readIsoLike(raw.weeklyResetAt ?? raw.weeklyResetTime ?? raw.periodEnd);

  if (scoped.length > 0) {
    // Least headroom first; on a tie the lower ceiling, so the answer is stable
    // rather than dependent on which scope happened to be pushed first.
    const binding = scoped.reduce((tightest, candidate) => {
      const a = candidate.limitUsd - candidate.usedUsd;
      const b = tightest.limitUsd - tightest.usedUsd;
      if (a !== b) return a < b ? candidate : tightest;
      return candidate.limitUsd < tightest.limitUsd ? candidate : tightest;
    });
    return { ...binding, ...(periodEnd ? { periodEnd } : {}) };
  }

  // No ceiling anywhere. Report spending if we know any, so the card can say
  // "$12.40 spent, no limit set" rather than nothing at all.
  const usedUsd = userUsed ?? keyUsed ?? flatUsed;
  if (usedUsd === null) return null;
  return { usedUsd, limitUsd: null, ...(periodEnd ? { periodEnd } : {}) };
}

/**
 * The reset instant as a string, from either an ISO string or an epoch number.
 *
 * Accepting a number costs one branch and saves the card from showing nothing
 * on a perfectly good answer. Anything else — including a blank string — is
 * "not stated", which the view layer renders by omitting the line rather than
 * by guessing a date.
 */
function readIsoLike(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return '';
}

/**
 * Money, formatted the way the rest of the account card already formats it.
 *
 * Four decimals below a dollar and two above: sub-dollar spend is where the
 * interesting resolution is, and `$0.00` for a real charge reads as free. This
 * matches `UserFooterPill`'s own `formatCostUsd` verbatim so the two surfaces
 * cannot print the same number differently.
 */
export function formatQuotaUsd(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export type WeeklyQuotaState =
  /** No allowance figure at all — the card says 暂不可用. */
  | 'unavailable'
  /** Spending is being tracked, but no ceiling is configured. */
  | 'no-limit'
  | 'within'
  | 'exceeded';

export interface WeeklyQuotaView {
  state: WeeklyQuotaState;
  /** `$12.40 / $50.00`, `$12.40`, or the unavailable copy. */
  amountText: string;
  /** `0`–`100`, already clamped. `null` whenever there is no ceiling to divide by. */
  percent: number | null;
  /** Remaining allowance, or the amount by which it was exceeded. */
  remainingText: string | null;
  /** ISO period end, passed through for the caller to render. */
  periodEnd: string | null;
}

/**
 * What the card shows.
 *
 * Four states, and the two degenerate ones are the point:
 *
 *  - **`unavailable`** — nothing usable arrived. The caller prints its own
 *    "暂不可用" copy; this function does not carry UI strings for it, because
 *    that one sentence is translated and the rest of this module is not.
 *  - **`no-limit`** — spending is known, the ceiling is not. A percentage needs
 *    a denominator, so `percent` is `null` and the caller renders no bar. This
 *    is the arm that stops `NaN%`: it is unreachable to divide by a missing
 *    limit, rather than merely discouraged.
 *
 * A limit of exactly `0` is treated as a real ceiling that any spending
 * exceeds, not as "no limit" — an account capped at zero is a decision
 * somebody made, and reporting it as unlimited would invert it.
 */
export function deriveWeeklyQuotaView(quota: WeeklyQuota | null): WeeklyQuotaView {
  if (!quota) {
    return {
      state: 'unavailable',
      amountText: '',
      percent: null,
      remainingText: null,
      periodEnd: null,
    };
  }
  const periodEnd = quota.periodEnd ?? null;
  const usedText = formatQuotaUsd(quota.usedUsd);
  if (quota.limitUsd === null) {
    return {
      state: 'no-limit',
      amountText: usedText,
      percent: null,
      remainingText: null,
      periodEnd,
    };
  }
  const limitText = formatQuotaUsd(quota.limitUsd);
  const amountText = `${usedText} / ${limitText}`;
  const exceeded = quota.usedUsd > quota.limitUsd;
  // Clamped rather than allowed past 100: a bar that overflows its track says
  // nothing the `exceeded` state does not already say, and it breaks the
  // layout while saying it. A zero ceiling divides to `100` by fiat for the
  // same reason the state above calls it a real limit.
  const percent =
    quota.limitUsd === 0 ? 100 : Math.min(100, Math.round((quota.usedUsd / quota.limitUsd) * 100));
  const delta = Math.abs(quota.limitUsd - quota.usedUsd);
  return {
    state: exceeded ? 'exceeded' : 'within',
    amountText,
    percent,
    remainingText: formatQuotaUsd(delta),
    periodEnd,
  };
}
