/**
 * Display formatting for counted quantities the chat surfaces show (F456 §7.4).
 *
 * ## Why this module exists at all
 *
 * These formatters are needed by both `turnStatus.ts` and `attachments.ts`, and
 * `turnStatus.ts` already imports from `attachments.ts` — putting them in either
 * file would make the other's import a cycle. Both import from here instead.
 *
 * Pure and clock-free by contract: `[F4-5]` scans this file along with the rest
 * of `attachments.ts`'s local import closure, because a random or time-based
 * source moved one module sideways would otherwise escape the scan entirely.
 */

/**
 * U06-b: `480` / `21.4k` / `1.05M` — settled token totals off `usage.updated`
 * (`shared/piUsage.ts`), for the Run surface's occupancy ring and usage rows.
 *
 * Separate from `formatCharCount` below despite the shared k-notation, because
 * the two describe different KINDS of number and the difference matters at the
 * top of the range: this one is a real total that reaches context-window scale,
 * so it needs an `M` step a prompt's character count never hits. Same
 * thresholds as pi-app's `formatTokens`, so a user reading both apps sees one
 * notation.
 */
export function formatTokenTotal(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count)}`;
}

/**
 * F456 §7.4: `428` / `1.2k` — the size of the prompt the user just sent,
 * counted in CODE POINTS at the commit point (see `ChatComposer.tsx`).
 *
 * An exact figure the renderer computed from text it holds, which is why the
 * status line is allowed to label it (`↑ 428 chars`) rather than leaving the
 * unit to the reader.
 */
export function formatCharCount(count: number): string {
  if (count < 1000) return `${count}`;
  return `${(count / 1000).toFixed(1)}k`;
}
