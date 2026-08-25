/**
 * T-31 turn-level class assembly (reply-anatomy spec §4.8 / §5.4).
 *
 * Same discipline as `middleColumnLayout.ts`: every class string the turn
 * structure depends on lives in a `.ts` function so vitest's node environment
 * can assert it. Two of the rules below are structural, not cosmetic, and are
 * asserted as *prohibitions* (F-B8 / F-B10):
 *
 *  - the pinned bubble band and its containing block must never acquire
 *    `overflow-*`, `transform`, `filter` or `contain`. Each of those silently
 *    turns `position: sticky` off (or re-parents its containing block), and the
 *    failure is invisible in review — the element simply stops sticking.
 *  - the copy button must never be hover-only (`opacity-0` + `group-hover:`):
 *    a control only a mouse can discover is unreachable by touch and keyboard
 *    (§4.6).
 *
 * ## Spacing arithmetic (§5.4, asserted by F-B9)
 *
 * ```
 * ReadingColumn space-y-2.5  = 10   previous turn's end -> this turn's band
 * band py-2.5                = 10   top: completes the 20px turn-to-turn beat
 *                              10   bottom: the 10px "section gap" to the first
 *                                   content segment (FB6 moved the head down)
 * turn body gap-2.5          = 10   content segments / meta row (P-17)
 * ```
 *
 * Total between turns is still A07 `:846`'s 20px; only its composition changed
 * (one 20px gap -> 10 + 10). The band's own padding is doing double duty: it
 * carries half the beat *and* gives the pinned bubble an opaque 10px buffer
 * above and below, so content scrolling underneath is covered cleanly. That is
 * also why `chatTurnClass()` carries no gap of its own — the 10px below the
 * bubble is the band's bottom padding, and a section gap would stack a second
 * 10px on top of it, doubling §5.4's "bubble -> turn head = 10".
 */
import type { TurnStatusKind } from './turnStatus';

/**
 * `ReadingColumn`'s turn-to-turn spacing. Half of the 20px beat; the other half
 * is `turnBubbleBandClass()`'s top padding (see the arithmetic above).
 */
export function readingColumnSpacingClass(): string {
  return 'space-y-2.5';
}

/**
 * Per-turn `<section>`: the sticky containing block for this turn's bubble
 * band, which is what makes "the anchor is released when the turn ends" fall
 * out of DOM order instead of needing a scroll listener (§5.3).
 *
 * No gap (see the header note), no `overflow-*` / `transform` / `contain` — the
 * band's stickiness is scoped by this element, and any of those would break or
 * re-scope it.
 */
export function chatTurnClass(): string {
  return 'flex flex-col';
}

/**
 * The band that pins the user bubble to the top of the scroll viewport (§5.4).
 *
 * `bg-background` (the timeline surface, not `bg-card`) plus `py-2.5` is what
 * makes the pinned state opaque; `z-10` is enough because the timeline has no
 * other in-flow positioned element (popovers and menus render through portals).
 */
export function turnBubbleBandClass(): string {
  return 'sticky top-0 z-10 bg-background py-2.5';
}

/**
 * The prompt text inside the band — clamped UNCONDITIONALLY (§5.6-B, the
 * spec's own pre-authorised fallback; adopted as-built by F10, 2026-08-18).
 *
 * The pinned-only clamp it replaces (`@container scroll-state(stuck: top)`
 * → `-webkit-line-clamp: 3`, §5.6-A) created a scroll-position →
 * layout-height edge: collapsing the stuck band shrank `scrollHeight`, the
 * browser re-clamped `scrollTop` back below the sticky threshold, the band
 * un-stuck and re-expanded, and the stick-to-bottom follower pushed the
 * offset up again — a per-frame collapse/expand oscillation on any long
 * prompt whose turn sits at the bottom of the document. An unconditional
 * clamp makes band height a function of content alone: no scroll → height
 * edge exists anywhere in the timeline, so the loop is structurally
 * impossible (engine-independent, unlike a hysteresis tuning). The full
 * prompt stays reachable via the bubble's `title`; the user-owned expand
 * toggle that was booked as a follow-up ticket is FB3, landed 2026-08-23.
 *
 * ## FB3 and the loop, restated (the invariant this signature carries)
 *
 * `expanded` MUST be user intent and nothing else. The oscillation above came
 * from an edge that ran `scroll position -> clamp -> height -> scroll
 * position`; a click is an outside event that no layout change can feed back
 * into, so the cycle cannot re-form. Passing anything derived from scroll
 * offset, element geometry or an `IntersectionObserver` here rebuilds that
 * edge, whatever the parameter ends up being called -- which is why the
 * argument, not the behaviour, is what `[FB3-2]` pins.
 */
export function userBubbleTextClass(expanded: boolean): string {
  return expanded ? 'select-text space-y-2' : 'select-text space-y-2 line-clamp-6';
}

/**
 * Everything after the band: turn head, process shell, answer, footer.
 * `gap-2.5` is P-17's 10px "within a turn" tier and stays the single source of
 * it, inherited from the pre-T-31 `<article className="flex flex-col gap-2.5">`
 * that `AssistantMessage` used to own.
 */
export function turnBodyClass(): string {
  // `text-markdown leading-normal` comes from that same article and is not
  // decoration: `QuestionCard`'s header row sets no size of its own and reads
  // the body scale by inheritance. Dropping it here would silently resize a
  // component nothing in this module names. The head and footer slots override
  // it with `text-meta` (D25 S24) on their own elements.
  return 'flex flex-col gap-2.5 text-markdown leading-normal';
}

/**
 * The turn's process shell panel (`CollapsibleContent`).
 *
 * `ui/collapsible.tsx`'s panel animates height, which Base UI implements by
 * measuring `scrollHeight` into `--collapsible-panel-height` and pairing it
 * with `overflow-hidden`. That measurement only re-runs on an open/close
 * transition — never on content growth — which is fine for the leaf rows it was
 * written for and wrong for this panel, whose content grows in two ordinary
 * ways: tokens streaming into the process segment, and the user expanding a
 * tool row's IN/OUT body inside it (the state §10-C promises the turn-level
 * shell preserves). Either one would be silently clipped at the height the
 * panel happened to have when it opened.
 *
 * Setting `transition-none` is not just cosmetic: Base UI picks its animation
 * strategy by reading the panel's computed style once, and a panel with no
 * transition and no animation takes the `'none'` path, which skips the
 * measurement entirely and only toggles the `hidden` attribute. `duration-0`
 * has to ride along — the probe Base UI actually runs is on the computed
 * `transition-duration`, and `transition-none` alone leaves the base class's
 * `duration-150` standing (a different tailwind-merge group), which would put
 * the panel back on the measuring path. `h-auto` and the two `data-*-style`
 * overrides then make the leftover height utilities inert, and
 * `overflow-visible` restores normal flow. The cost is the 150ms height
 * animation; the alternative is content that disappears.
 */
export function turnProcessPanelClass(): string {
  return 'h-auto overflow-visible transition-none duration-0 data-starting-style:h-auto data-ending-style:h-auto';
}

/**
 * The turn's process shell root (`Collapsible.Root`).
 *
 * `Collapsible.Root` renders a plain `<div>`, so without this it was a block
 * box with no gap — the trigger row and the panel sat flush against each other
 * at 0px while every other pair inside the turn kept P-17's 10px beat (review
 * batch F11). Same tier as `turnBodyClass()`, so the shell's two children are
 * spaced exactly like the turn's own children; the 20px turn-to-turn
 * arithmetic in the header note is untouched, because this gap is *inside* a
 * turn body slot rather than between two of them.
 */
export function turnProcessShellClass(): string {
  return 'flex flex-col gap-2.5';
}

/**
 * The turn head slot: status line while in flight, `Worked for Ns …` once
 * complete (§4.7 — one slot, two states). Sized/coloured as a meta row (D25
 * S24); `tabular-nums` keeps the second counter from jittering the row width
 * as it ticks.
 */
export function turnHeadClass(): string {
  return 'flex min-w-0 items-center gap-1.5 text-meta tabular-nums text-muted-foreground';
}

/**
 * FB6 + D55 ①: the turn's single bottom meta row — status/`Worked for`, the
 * collapse trigger, the model · relative-time metadata, and the copy button,
 * all on ONE line at the END of the turn.
 *
 * Replaces a head row at the top plus a footer row at the bottom. It keeps
 * `turnHeadClass()`'s `min-w-0` (the status text truncates rather than wrapping
 * — see `MessageTimeline`'s note on why this row must stay one line) and
 * `turnFooterClass()`'s `justify-*` behaviour, but the status half is
 * `flex-1` so the metadata and the two 24px buttons sit at the trailing edge
 * while the ticking text gives way.
 *
 * `flex-wrap` is deliberately NOT here: the footer could wrap because its
 * content was static, but this row carries a counter that changes every second,
 * and a row that can wrap can change height every second under a
 * stick-to-bottom follower.
 */
export function turnMetaRowClass(): string {
  return 'flex min-w-0 items-center gap-2 text-meta tabular-nums text-muted-foreground';
}

/**
 * Copy button: 24px ghost icon button, same tier as every other control in
 * this design system. Always visible — no `opacity-0` / `group-hover:` pair
 * (F-B15).
 */
export function turnCopyButtonClass(): string {
  return 'inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-hover';
}

/**
 * The assistant's answer segment: one neutral container per turn (F5 D3-b,
 * user decision 2026-08-18).
 *
 * ## Edge only, never a face — and that is the whole design
 *
 * The comparison draft asked for `bg-muted + border-border` here. Measured, that
 * fill destroys more than it draws: inline code chips are `bg-muted` (1.000
 * against it — they vanish outright), fenced blocks are `bg-muted/50`, which
 * composites to exactly `muted` on a `muted` parent (1.000 again), and the
 * container itself only reaches 1.072 / 1.057 against `--background`, i.e.
 * below the discriminable threshold. `design-system.md:93-101` already forbids
 * the shape for that reason: two panel levels are expressed with `--border`,
 * never with `bg-secondary` vs `bg-muted`. So the container spends a border and
 * nothing else, and every inner surface keeps today's numbers unchanged.
 *
 * ## Division of labour with the user bubble (D3-c) — do not "unify" these
 *
 * The user side is told apart by SHAPE: right-aligned, capped at 85%, on a
 * coloured face (`bg-accent`). This side is told apart by BOUNDARY: full width,
 * no face, one ring of `--border`. The asymmetry is deliberate. Making the
 * assistant container coloured too, or giving the user bubble a full-width
 * outline "for consistency", collapses both into "everything is a card", where
 * the two roles read MORE alike than they do today — which is precisely the
 * objection D3-b was approved over. Changing either half means re-opening that
 * decision, not tidying up.
 *
 * The 14px inset is `chatMarkdownPolicy.ts`'s `BLOCK_GAP`, not a new number:
 * "container edge to first block" is the same distance as "block to block".
 * `first:mt-0` already keeps the first block from stacking its own margin on
 * top, so no negative offset is needed.
 *
 * Mounted on `answer` segments only, so it can never contain a tool group, a
 * permission card or a question card — those are `process`, which has its own
 * collapsible shell.
 *
 * FB4: ONE BOX PER ANSWER SEGMENT, not one per turn. An interleaved turn ("said
 * something, ran a tool, said something else") now keeps its prose outside the
 * shell in place, which means several boxes. That is the point of the change —
 * the old rule folded every earlier paragraph into the collapsed segment — but
 * it does make the box a repeating element rather than a singular one, and how
 * that reads is a GUI question, not a code one (spec §10 G-6, Q14). A turn with
 * no prose gets no box at all, which is honest: it is not an answer.
 */
export function turnAnswerContainerClass(): string {
  return 'rounded-sm border border-border p-3.5';
}

/**
 * Tone override for the turn-head status line, or `false` to keep the muted
 * colour `turnHeadClass()` already carries (F456 §7.5).
 *
 * Moved here from `MessageTimeline.tsx` by F456 slice ④. Two reasons: it is
 * turn-level class assembly, the same job as `turnHeadClass()` above it; and as
 * a module-private function inside a `.tsx` it was unreachable from any suite —
 * "which tier gets a colour" had no test at all.
 *
 * ## The two tiers, and why only one of them shouts
 *
 * `slow` used to be `text-warning`. F2 raised the silence ceiling to ~300s,
 * which turned "no first token by 45s" into the ordinary shape of a long prompt
 * or a long think — and a warning colour that stays on for minutes at a time
 * has stopped warning about anything. It now falls through to the head's own
 * `text-muted-foreground`, which this batch raised to a 7.20 / 6.70 contrast
 * pair: legible enough that the tier does not need a colour to be read, which
 * is the readability work paying for the alert work.
 *
 * ## Known deviation: `stalled` uses `text-warning`, which IS the brand orange
 *
 * `docs/design-system.md` says, in as many words, not to use `warning` in place
 * of amber: Flexoki's `status.warning` is bit-for-bit `primary.base` in both
 * themes (`globals.css` light `:176` / dark `:223` match `--primary` exactly).
 * This batch uses it anyway, knowingly, on three stated grounds:
 *
 *  1. a turn head contains no links, and `text-primary`'s only routine job in
 *     this app is links — so nothing in this element can be confused for one;
 *  2. this is the single moment on the whole timeline that has earned an
 *     eye-catching colour, and there is exactly one of it;
 *  3. a new semantic token would have to be double-written into `@theme` and
 *     both palettes, which is not worth opening for one tier.
 *
 * Recorded rather than done quietly: the deviation is also logged in the batch
 * ledger row and raised for review as Q8. If review rejects it, the fallback is
 * that `stalled` goes muted too and the wording tier carries the whole signal —
 * which is why §7.5-a's separate `stalled` copy is not optional.
 */
export function turnStatusToneClass(kind: TurnStatusKind): string | false {
  if (kind === 'stalled') return 'text-warning';
  if (kind === 'failed') return 'text-destructive';
  return false;
}
