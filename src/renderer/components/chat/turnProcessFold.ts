/**
 * What a folded process segment says about itself.
 *
 * Pure, and in its own `.ts`: the vitest suite runs `environment: node` and
 * only collects `*.test.ts`, so anything living inside `MessageTimeline.tsx`
 * can only be asserted by scanning source. These two answer questions worth a
 * real test — how many steps happened, and how the clock reads — so they live
 * where a test can import them.
 */

import type { TurnItem } from './chatTurn';

/**
 * How many steps a folded process segment says it took.
 *
 * A tool group is not one step: it is the run(s) and thinking blocks inside it,
 * which is what the user watched happen. Counting groups instead would report
 * "1 步骤" for a turn that ran four tools.
 */
export function countProcessSteps(items: readonly TurnItem[]): number {
  return items.reduce((total, item) => {
    if (item.kind === 'toolGroup') return total + item.entries.length;
    if (item.kind === 'permissionActivity') return total + item.blocks.length;
    return total + 1;
  }, 0);
}

/** `19s` / `1m 05s` — the same clock vocabulary the running status row uses. */
export function formatProcessDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
