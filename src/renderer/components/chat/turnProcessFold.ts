/**
 * What a folded process segment says about itself.
 *
 * Pure, and in its own `.ts`: the vitest suite runs `environment: node` and
 * only collects `*.test.ts`, so anything living inside `MessageTimeline.tsx`
 * can only be asserted by scanning source. How many steps happened is a
 * question worth a real test, so it lives where a test can import it.
 *
 * The label carries no duration (user decision 2026-09-10): the latency on
 * hand was the last assistant message's, which every fold of a multi-message
 * turn repeated, and a restored history turn has none at all.
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
