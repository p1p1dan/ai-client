/**
 * Display formatting for the two live counters the turn head shows while a
 * reply is in flight (F456 §7.4).
 *
 * ## Why this module exists at all
 *
 * `formatTokenCount` used to live in `turnStatus.ts`, which already imports
 * from `attachments.ts`. F456 needs the SAME formatter inside
 * `composerSendingLine`, and having `attachments.ts` import it back would be a
 * straight import cycle. Both sides import it from here instead; `turnStatus.ts`
 * re-exports it so no existing consumer moves.
 *
 * ## Why one shape serves both counters
 *
 * `428` / `1.8k` reads the same whichever quantity it is measuring, and a
 * status line that switched notation between two adjacent numbers would make
 * the reader work out which rule applies where. The DIFFERENCE between the two
 * counters is carried by their unit words, not their notation — see
 * `composerSendingLine` for why `↑` is labelled and `↓` deliberately is not.
 *
 * Pure and clock-free by contract: `[F4-5]` scans this file along with the rest
 * of `attachments.ts`'s local import closure, because a random or time-based
 * source moved one module sideways would otherwise escape the scan entirely.
 */

/** `850` as-is, `1000` and over as one-decimal k-notation. */
function formatCount(count: number): string {
  if (count < 1000) return `${count}`;
  return `${(count / 1000).toFixed(1)}k`;
}

/**
 * D33: `850` / `38.5k` — display formatting for the Host's live output-token
 * estimate. This number is NOT a billing figure: it is a monotonic peak the
 * Host derives mid-turn from streamed deltas (`eventNormalizer.ts`'s
 * `emitInterimUsage`), never the settled `usage.updated` result payload, so
 * it must only ever be shown as a rough, in-flight indicator — never
 * presented as (or reconciled against) an authoritative token count.
 */
export function formatTokenCount(count: number): string {
  return formatCount(count);
}

/**
 * F456 §7.4: `428` / `1.2k` — the size of the prompt the user just sent,
 * counted in CODE POINTS at the commit point (see `ChatComposer.tsx`).
 *
 * Unlike the token estimate this is an exact figure the renderer computed from
 * text it holds, which is why the status line is allowed to label it (`↑ 428
 * chars`) while the estimate stays bare.
 */
export function formatCharCount(count: number): string {
  return formatCount(count);
}
