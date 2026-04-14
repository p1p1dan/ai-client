export type UsageStatsResult =
  | {
      todayCount: number;
      todayCostUsd: number;
      monthCount: number;
      monthCostUsd: number;
    }
  | { error: string };
