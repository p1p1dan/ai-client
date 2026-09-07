/**
 * F10 — the weekly spend allowance replaced "calls this month" on the account
 * card.
 *
 * ## Why money and not calls
 *
 * A call count answered a question nobody has: calls are not what runs out, and
 * two calls can differ in cost by three orders of magnitude. The allowance the
 * account actually has is denominated in money (confirmed product ruling), so
 * the card now states the thing that constrains the user.
 *
 * ## Why every field is nullable, and none is defaulted
 *
 * "The service did not say" is a real state, distinct from zero. A limit of `0`
 * means an account that may not spend; a MISSING limit means an account whose
 * allowance nobody configured, and rendering those the same way is how a card
 * ends up showing `$0.00 / $0.00` or `NaN%` to a user with no limit at all. The
 * renderer is required to show 暂不可用 in that case, which it can only do if
 * the absence survives the trip.
 */

/** The account's spend allowance for the current week, as the service reports it. */
export interface WeeklyQuota {
  /** Spent so far this period, in USD. */
  usedUsd: number;
  /** Ceiling for the period, in USD. `null` when the service states no limit. */
  limitUsd: number | null;
  /** ISO-8601 end of the current period, when the service states one. */
  periodEnd?: string;
}

export type UsageStatsResult =
  | {
      todayCount: number;
      todayCostUsd: number;
      monthCount: number;
      monthCostUsd: number;
      /**
       * `null` when the allowance endpoint did not answer, or answered without
       * a usable figure. Deliberately part of the SUCCESS arm: a failed quota
       * lookup must not take the rest of the account card down with it — the
       * field report is explicit that a network failure may not disturb the
       * user's own details or the logout button.
       */
      weeklyQuota: WeeklyQuota | null;
    }
  | { error: string };
