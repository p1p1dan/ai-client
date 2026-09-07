import type { UsageStatsResult } from '@shared/types';
import { useQuery } from '@tanstack/react-query';

/**
 * How often the account card re-reads usage from cch.
 *
 * F10-b raised this from 5 minutes. What it buys, per signed-in client:
 *
 *  - the figures it shows are a daily total, a month-to-date total and a weekly
 *    allowance. None of them is a number anyone watches tick; the fastest-moving
 *    one changes when a turn finishes, and a turn's own status line already
 *    reports that.
 *  - each refresh costs three requests against the gateway (today, summary,
 *    quota) — four surfaces' worth of data, but still three round trips that a
 *    room full of clients multiplies.
 *
 * Combined with the session cache in `UsageService` (which removed the bearer
 * probe and the login that used to run on EVERY refresh), the poll went from
 * 5 requests every 5 minutes to 3 every 15 — 60/hour down to 12.
 *
 * The manual refresh button on the profile card is what covers "I want to see
 * it now", which is the only case a short interval was serving.
 */
const USAGE_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export function useUsageStats(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: ['usageStats'],
    queryFn: async (): Promise<UsageStatsResult> => {
      return await window.electronAPI.usage.getStats();
    },
    enabled,
    staleTime: USAGE_REFRESH_INTERVAL_MS,
    gcTime: USAGE_REFRESH_INTERVAL_MS,
    refetchInterval: USAGE_REFRESH_INTERVAL_MS,
    // Keep usage polling predictable; avoid extra refetch triggers when the
    // window gains focus. With a 15-minute interval this matters more, not
    // less: focus-refetch would quietly reintroduce the old request rate for
    // anyone who alt-tabs a lot.
    refetchOnWindowFocus: false,
  });
}
