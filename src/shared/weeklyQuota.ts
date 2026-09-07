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
 * `null` when the payload carries no usable allowance.
 *
 * `usedUsd` is required and `limitUsd` is not: an account can genuinely have
 * spending with no ceiling configured, and that is a state the card must be
 * able to describe ("$12.40 spent, no limit set") rather than a malformed
 * response. What is NOT tolerated is a missing or nonsensical `usedUsd` — with
 * no numerator there is nothing to show, and inventing `0` would report an
 * unused allowance to someone who may have exhausted theirs.
 */
export function parseWeeklyQuota(payload: unknown): WeeklyQuota | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  const usedUsd = finiteNonNegative(raw.usedUsd ?? raw.usedCostUsd ?? raw.used);
  if (usedUsd === null) return null;
  const limitUsd = finiteNonNegative(raw.limitUsd ?? raw.limit ?? raw.weeklyLimitUsd);
  const periodEnd = typeof raw.periodEnd === 'string' ? raw.periodEnd.trim() : '';
  return {
    usedUsd,
    limitUsd,
    ...(periodEnd ? { periodEnd } : {}),
  };
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
