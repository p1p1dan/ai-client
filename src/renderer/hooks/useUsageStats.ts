import { useQuery } from '@tanstack/react-query';
import type { UsageStatsResult } from '@shared/types';

export function useUsageStats(options?: { enabled?: boolean }) {
  const refetchIntervalMs = 1000 * 60 * 5;
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: ['usageStats'],
    queryFn: async (): Promise<UsageStatsResult> => {
      return await window.electronAPI.usage.getStats();
    },
    enabled,
    staleTime: refetchIntervalMs,
    gcTime: refetchIntervalMs,
    refetchInterval: refetchIntervalMs,
    // Keep usage polling predictable; avoid extra refetch triggers when the window gains focus.
    refetchOnWindowFocus: false,
  });
}
