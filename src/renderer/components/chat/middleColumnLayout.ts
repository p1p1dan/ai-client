/**
 * T-28: pure decision/derivation functions for the middle column's two-state
 * layout (D23) — empty (centered, no history) vs session (docked composer +
 * timeline) — plus the class strings and small view-model helpers that both
 * states share.
 *
 * Only type imports plus the pure `isSessionBusy` helper are allowed here —
 * no components, hooks, or `window`. Store writes and subscriptions live in
 * `ChatWorkspace.tsx`; this module only decides what should render and
 * assembles read-only view data (mirrors `composerTarget.ts`'s role for the
 * target bar).
 */

import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { isSessionBusy } from './sessionIndex/resumeIntent';

// ---- Two-state mode derivation ----

export type MiddleColumnMode = 'empty' | 'session';

export interface MiddleColumnModeInput {
  sessionId: string | null;
  /** messages[sessionId]?.length ?? 0 — must come from a scalar selector, never subscribe to the whole array. */
  messageCount: number;
  /** Whether this app run already started a send for this session (sticky — see `rememberSendAttempt`). */
  sendAttempted: boolean;
  /** activeSessionId ∈ hostBoundSessionIds */
  hostBound: boolean;
  /** session.runtimeIdentity != null — resume-flicker guard (mirrors `computeEverHostBound`). */
  hasRuntimeIdentity: boolean;
  /** Whether historyErrors[sessionId] is set (pass a boolean, not the raw error). */
  hasHistoryError: boolean;
  status: SessionRuntimeStatus;
}

/**
 * Decide whether the middle column shows the centered empty state or the
 * docked session state. Rules are evaluated in order and short-circuit —
 * order matters (see T-28 design doc §1 decision table).
 */
export function deriveMiddleColumnMode(input: MiddleColumnModeInput): MiddleColumnMode {
  if (input.sessionId == null) {
    return 'empty';
  }
  if (input.messageCount > 0) {
    return 'session';
  }
  if (input.sendAttempted) {
    return 'session';
  }
  if (input.hostBound || input.hasRuntimeIdentity) {
    return 'session';
  }
  if (input.hasHistoryError) {
    return 'session';
  }
  if (isSessionBusy(input.status) || input.status === 'failed') {
    return 'session';
  }
  return 'empty';
}

/**
 * Sticky latch recording which sessions have started a send this app run.
 * Returns the same array reference when the id is already tracked (or when
 * `sessionId` is null) so callers can use it directly as `setState` input
 * without triggering an extra re-render.
 */
export function rememberSendAttempt(
  sessionIds: readonly string[],
  sessionId: string | null
): readonly string[] {
  if (sessionId == null) {
    return sessionIds;
  }
  if (sessionIds.includes(sessionId)) {
    return sessionIds;
  }
  return [...sessionIds, sessionId];
}

// ---- Composer host / card / textarea class assembly ----

/**
 * Composer host div's class: empty centers-and-grows, session docks at a fixed
 * height. Both share `px-6`.
 *
 * T-30b2 (§4.7 / F-A10): the docked branch dropped its `pt-1.5`. The 8px gap
 * above the composer card is owned by exactly ONE upstream at a time — the
 * timeline's `pb-2`, the question dock's `pb-2`, or the queue strip's `mb-2` —
 * and this host used to add 6px on top of whichever one was present, so the
 * real gap rendered at 14px instead of the 8px A07 :2709 specifies. Adding any
 * `pt-*` back here re-splits that contract across two owners again.
 */
export function middleColumnHostClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'flex min-h-0 flex-1 flex-col justify-center px-6 pb-[9%]';
  }
  return 'shrink-0 px-6 pt-0 pb-3.5';
}

/** Timeline scroll area's inner padding (A07 `.tl`: 20/24/8). Padding stays outside `ReadingColumn`. */
export const TIMELINE_PADDING_CLASS = 'px-6 pt-5 pb-2';

// ---- Composer control sizing ----

/**
 * T-30b2 §3.3-E2: the single height tier every Composer control derives from
 * — the attach button, the merged model/effort trigger, the round action
 * button and the target-row triggers are all 24px (A07's own `--h-btn`).
 * "One height tier across the whole Composer" is the structural half of the
 * coherence this batch is chasing; A07 :1329's `--h-row` (28px) tier stays for
 * dropdown rows and sidebar session rows, but no longer appears inside the
 * Composer.
 *
 * Every class helper below spells its own Tailwind step (`size-6` / `h-6`)
 * because Tailwind cannot read a TS constant — the assertions cross-check the
 * spelled step against this number (`step × 4 === COMPOSER_CONTROL_SIZE`) so
 * the two can never drift apart silently.
 */
export const COMPOSER_CONTROL_SIZE = 24;

/**
 * Composer card's outer frame class — shared border/fill/radius tokens,
 * mode-specific padding and layout.
 *
 * T-30b2 §4.1: the resting border is `--border`, and focus steps it to
 * `--input` (ΔL 0.0347, zero chroma). It used to rest on `--input` and step to
 * `--ring`, i.e. the brand orange (C = 0.1523) — measured against the Cursor
 * reference that is a 2.5× heavier resting edge plus a fully chromatic focus
 * state, and it was the second-largest contributor to the "too round / too AI"
 * reading. A07 :1336 justified `--input` as a substitute for "the drop shadow
 * Cursor floats its card with"; pixel measurement showed Cursor's card has NO
 * shadow at all (8 rows outside the border are a flat background value), so
 * the premise for that tier is gone.
 *
 * F6 (2026-08-18) RETIRES the pill radius and the `hasExtras` opt-in that
 * switched it. Both cards now rest on `rounded-md`.
 *
 * The pill was never a free constant: `21` was defined as
 * `composerFollowHeightBreakdown().total / 2`, cross-asserted against the 42px
 * resting height, and spelled as a fixed value rather than `rounded-full`
 * precisely so the corners could not ride the textarea's `field-sizing-content`
 * growth into the 33-37px arcs §5.3 names as the "runaway" shape. That
 * derivation is what broke, not its value: the session card is two rows now and
 * rests at 74px, so the same chain yields `rounded-[37px]` — a hand-written
 * arbitrary value the design system bans, and half-height corners on a two-row
 * card read as a stretched capsule, not a pill. There is no pill mental model
 * left to preserve, so the chain retires whole and the radius joins the empty
 * card's.
 *
 * With the radius constant in both branches, `opts.hasExtras` had no remaining
 * consumer and is gone from the signature; the extras stack still uses
 * `hasComposerExtras` at the call site to decide whether to RENDER, which was
 * always a separate question.
 */
export function composerCardClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    // T-30b2 §4.1: both modes now share one symmetric 8px inset (`p-2`). The
    // old 12/10 split traced back to A07's eyeballed three-value padding, not
    // to a measurement.
    return 'relative rounded-md border border-border bg-card focus-within:border-input p-2';
  }
  // Resting height contract, T-30b2 §3.3-E1 as re-derived by F6: exactly 74px.
  // The arithmetic is unchanged in KIND — borders + padding + content, done
  // completely (the 40px A07 :1844 wrote left the two 1px borders out of the
  // sum, and T-28 "fixed" the correct 42 back down to it by squeezing the
  // padding to 5px, the wrong direction). What changed is the content term:
  // the card stacks two 24px rows with an 8px gap between them instead of one
  // row, so 2 + 16 + 24 + 8 + 24 = 74 and the card rests at `min-h-18.5`.
  // `composerFollowHeightBreakdown()` below carries the same arithmetic as
  // data, including the gap, so a test can cross-check every term of it
  // against this string and against `composerRowsClass()`.
  //
  // No `items-center`: the card's only in-flow child is now one full-width
  // column (`composerRowsClass()`), so there is nothing to centre cross-axis,
  // and the moment the extras stack appears inside that column, centring it
  // would align the card's contents against an ambiguous reference.
  return 'relative rounded-md border border-border bg-card focus-within:border-input flex min-h-18.5 gap-2 p-2';
}

/**
 * The 74px resting height of the docked follow-up card, as data.
 *
 * This exists purely so the height contract is assertable as ARITHMETIC rather
 * than as "the class string contains `min-h-18.5`". T-28's blocker was exactly
 * that gap: the test asserted a class was present and could not notice that
 * the composed height it produced was wrong.
 *
 * F6 (2026-08-18) added `rows` and `rowGap` rather than editing `total` to a
 * new literal, for the same reason the breakdown exists at all — the height
 * has to stay something you can re-derive. `content` remains the height of ONE
 * row (the shared 24px control tier); the card stacks `rows` of them with
 * `rowGap` between each pair.
 */
export function composerFollowHeightBreakdown(): {
  border: number;
  padding: number;
  content: number;
  rows: number;
  rowGap: number;
  total: number;
} {
  const border = 2; // 1px top + 1px bottom
  const padding = 16; // p-2 → 8px top + 8px bottom
  const content = COMPOSER_CONTROL_SIZE;
  const rows = 2; // row 1: the textarea; row 2: the control strip
  const rowGap = 8; // composerRowsClass()'s `gap-2`
  return {
    border,
    padding,
    content,
    rows,
    rowGap,
    total: border + padding + content * rows + rowGap * (rows - 1),
  };
}

/**
 * The session card's body: the column that holds the two rows.
 *
 * This is not a new wrapper — the docked branch always had a
 * `flex min-w-0 flex-1 flex-col` div written inline at the call site, whose one
 * job was to stack the conditional extras above the single control row. F6
 * promotes that literal into the class-assembly layer (and gives it a real
 * `gap-2`, replacing the extras stack's own `mb-1`) so the two-row structure is
 * assertable from a pure module instead of only from JSX text.
 *
 * `flex-1` lets it claim the card's full width; `min-w-0` is what lets both
 * rows shrink below their content's intrinsic width, which every `truncate`
 * inside them depends on.
 */
export function composerRowsClass(): string {
  return 'flex min-w-0 flex-1 flex-col gap-2';
}

/**
 * The card's inner control row.
 *
 * `empty` mode: the bottom bar under the textarea (attach → agent → model →
 * permission → status line → action buttons). `session` mode: row 2 of the
 * card, the same strip minus the status line. Both are 8px-gapped flex rows;
 * only the empty bar needs the 6px offset from the textarea above it (the
 * session column spaces its own rows through `composerRowsClass()`'s gap).
 *
 * F6 (2026-08-18) REVERSES the round-5 fix (diag:placeholder-align), which had
 * put `session` on `items-start`. That fix existed for exactly one child: the
 * textarea's rendered height is NOT pinned to 24px (it relies on
 * `field-sizing-content`, and the UA's intrinsic one-row height is not
 * guaranteed to equal `1 × line-height`), and a `<textarea>`'s content is
 * always top-anchored inside its own box, so `items-center` centred that
 * taller box and pushed the placeholder above the other controls' centreline.
 * `items-start` sidestepped the uncertain height by aligning top edges.
 *
 * The textarea now has row 1 to itself. Every remaining child of this row —
 * attach button, agent picker, model/effort trigger, permission trigger,
 * action buttons — is an exact 24px box, which makes `items-start` and
 * `items-center` identical in output. `items-center` is the one that states
 * what the row means, and it no longer needs the status slot's `h-6`
 * compensation (see `sessionStatusLineWrapperClass`).
 */
export function composerBarClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'mt-1.5 flex items-center gap-2';
  }
  return 'flex min-w-0 items-center gap-2';
}

/**
 * The right-hand action group (round buttons), shared by both modes.
 *
 * `ms-auto` rather than a `justify-between` row: what sits to its left is
 * conditional in both cards — the empty bar's status line, and (before F6) the
 * session row's status slot — and without an auto margin the send key would
 * slide left whenever those are absent. A round action key that changes
 * position depending on unrelated state breaks the "Stop replaces Send in
 * place" rule the whole button stack is built on.
 *
 * F6 (2026-08-18): the session card's row 2 uses this too. It used to render
 * `actionButtons` bare, relying on the textarea's `flex-[2]` to eat the free
 * space and push them right; row 2 has no elastic child at all now, so without
 * the auto margin the whole strip would bunch at the left edge.
 */
export function composerActionGroupClass(): string {
  return 'ms-auto flex shrink-0 items-center gap-1.5';
}

/**
 * The ⊕ button at the far left of the card (T-30b2 §4.6).
 *
 * Same ghost language as the model/target triggers: no border, no shadow, a
 * filled `--hover` shell that only appears on hover or keyboard focus. It is
 * `size-6` (both axes) rather than `h-6` because it is a square icon target.
 *
 * D4 (round-5): it is now a MENU trigger, so it needs the third state the
 * other menu triggers already have — `data-[popup-open]:bg-selection`. Without
 * it the button loses its shell the moment the pointer moves off it into the
 * open popup, which reads as "the menu belongs to nothing". The size step is
 * untouched: 24px is the one control tier (F-A4 asserts it).
 */
export function composerAttachButtonClass(): string {
  return [
    'grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground',
    'transition-colors duration-150',
    'hover:bg-hover',
    'focus-visible:bg-hover',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary',
    'data-[popup-open]:bg-selection',
    'disabled:pointer-events-none disabled:opacity-64',
  ].join(' ');
}

/**
 * The merged model + reasoning-effort trigger (T-30b2 addendum §3.1.2).
 *
 * Four things are deliberately absent, and each one is a regression this repo
 * has already shipped once through `SelectTrigger`'s base class:
 *
 *  - **no `border*`** — a permanently visible outline is exactly what the
 *    round-4 point-check asked to remove ("no always-on outer frame; show it
 *    on hover"). The shell is a FILL (`bg-hover`), never a border: a hover
 *    border would add 2px to the box on hover and make the whole row jump.
 *  - **no `shadow*`** — including `SelectTrigger`'s `before:shadow` inner
 *    highlight. A07 :1337 (zero shadows on buttons and cards) and the Cursor
 *    measurement agree.
 *  - **no `min-w-*`** — this is the transcribed lesson from the deleted
 *    `ModelSelect`/`EffortSelect`: they carried `min-w-22` (88px) and
 *    `min-w-26` (104px) floors sized to their own longest labels. Combined
 *    with `SelectTrigger`'s `justify-between`, a short label ("Sonnet") sat in
 *    the left part of an over-wide pill with dead space before the chevron,
 *    which round-3 point-check #7 reported as "the text is not centred". The
 *    real defect was never alignment — it was a width floor wider than the
 *    content. Width here is content-fit; do not add a floor back.
 *  - **no `rounded-md`/`rounded-lg` or larger** — a radius at or above half
 *    the box height is clamped by CSS to exactly half, so `rounded-lg` (16px)
 *    on a 24px-tall control renders as a full pill. `rounded-sm` (8px) is
 *    A07 :810-819's own value for this control.
 *
 * `focus-visible:bg-hover` is not optional decoration: with the resting state
 * having no frame at all, a keyboard user tabbing onto this control would
 * otherwise see no shape appear. It must always ship paired with
 * `hover:bg-hover` (asserted), and the outline sits ON TOP of the fill rather
 * than replacing it.
 *
 * Note for future edits: this repo's custom font-size tokens (`text-ui`,
 * `text-meta`, `text-code`, …) ARE registered in tailwind-merge's `font-size`
 * class group in `lib/utils.ts`, so `cn('text-muted-foreground', 'text-ui')`
 * keeps both. It did not always: twMerge's stock config classifies an
 * unrecognised `text-<name>` as a COLOUR, and used to drop the real colour
 * silently — the registration is the fix for that, and this string predates
 * it. Plain concatenation is kept as belt-and-braces (a new token can land
 * before someone remembers to register it), not as a requirement.
 */
export function composerModelTriggerClass(): string {
  return [
    'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-ui',
    'transition-colors duration-150',
    'hover:bg-hover',
    'focus-visible:bg-hover',
    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary',
    'data-[popup-open]:bg-selection',
    'disabled:pointer-events-none disabled:opacity-64',
  ].join(' ');
}

/**
 * The model name inside the merged trigger — the quieter half of the pair.
 * Cursor's follow-up bar reads `Sonnet 5` at L 0.398 with `High` at L 0.191:
 * the effort suffix is the value that changes, so it carries the emphasis.
 */
export function composerModelBaseClass(): string {
  return 'text-muted-foreground';
}

/**
 * The effort suffix inside the merged trigger — darker AND heavier than the
 * model name.
 *
 * The weight half of this only exists once the UI runs on a proportional
 * font stack: under an all-monospace stack `font-medium` (500) is a no-op,
 * because most system monospace faces ship 400 and 700 only. D25's font-domain
 * split is therefore a hard prerequisite for this class doing what it says.
 */
export function composerModelSuffixClass(): string {
  return 'text-foreground font-medium';
}

/**
 * One row inside a Composer popup (model/effort menu, ⊕ attach menu).
 *
 * D4 lifted this out of `ComposerModelTrigger`, where it was a private const,
 * because a second Composer menu now exists and two menus in one card that
 * disagree about row height or type size read as two components borrowed from
 * different apps.
 *
 * It is deliberately NOT `components/ui/menu.tsx`'s shared `MenuItem`: that
 * one carries `text-base sm:text-sm`, i.e. the app-chrome font size, and using
 * it here would put 16px rows inside a card whose whole content is on D25's
 * `text-ui` domain scale. The shared item is right for app menus and wrong for
 * this card; the divergence is the point, not an oversight.
 *
 * Font-size tokens (`text-ui`, `text-meta`) are written as plain concatenated
 * strings rather than composed through `cn()`. They ARE registered in
 * tailwind-merge's `font-size` class group in `lib/utils.ts` — but twMerge's
 * stock config classifies an unrecognised `text-<name>` as a COLOUR and drops
 * the real colour beside it, so plain strings stay as belt-and-braces for the
 * window between a new token landing and someone registering it.
 */
export function composerMenuItemClass(): string {
  return 'flex min-h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 text-ui outline-none data-disabled:pointer-events-none data-disabled:opacity-64 data-highlighted:bg-accent data-highlighted:text-accent-foreground';
}

/** Section heading inside a Composer popup — same two-menu sharing rule as above. */
export function composerMenuGroupLabelClass(): string {
  return 'px-2 py-1.5 text-meta font-medium tracking-[0.04em] text-muted-foreground';
}

/**
 * Target-row trigger (folder / branch) — the same ghost chip as the model
 * trigger above, so the Composer has exactly ONE dropdown form across the card
 * and the row below it.
 *
 * It used to spell `rounded-md` (12px) on an `h-6` (24px) box, which CSS
 * clamps to 12 = half the height: the hover fill rendered as a full pill.
 * A07 :736-753 always specified `--r-sm`.
 *
 * `tone: 'muted'` is the branch/secondary variant, so the returned string
 * pairs a font-size token with a colour token — see
 * `composerModelTriggerClass`'s note on why that combination is safe through
 * `cn()` now and why it is still written out plainly here.
 */
export function targetTriggerClass(tone: 'default' | 'muted' = 'default'): string {
  const base = [
    // `min-w-0` is what makes the inner `truncate` actually engage: a flex item
    // defaults to `min-width: auto`, i.e. it refuses to shrink below its
    // content, so under pressure the row overflowed and pushed its siblings
    // around instead of the label ellipsing (T-32 m8).
    'inline-flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-2 text-ui',
    'transition-colors duration-150',
    'hover:bg-hover',
    'focus-visible:bg-hover',
    'data-[popup-open]:bg-selection',
    'disabled:opacity-64',
  ].join(' ');
  return tone === 'muted' ? `${base} text-muted-foreground` : base;
}

/** Queue strip wrapper (T-19), owner of the single 8px gap above the composer card. */
export function queueStripWrapperClass(): string {
  return 'mb-2 flex max-h-24 flex-col gap-1 overflow-y-auto';
}

/**
 * Textarea outer span's class, including the `[&_textarea]:` pierce-through
 * variants for the inner `<textarea>`. The `<Textarea>` is rendered with
 * `unstyled` (no border/bg/shadow/ring/dark:bg-input chrome on the outer
 * span at all), so the old `border-0 bg-transparent shadow-none
 * focus-visible:ring-0` counters against that default chrome are gone —
 * only size and pierce-through classes remain.
 */
export function composerTextareaClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    // Round-2 visual fix: `<Textarea unstyled>` only applies `className` to
    // the outer span (textarea.tsx), never to the real inner `<textarea>` —
    // a bare `resize-none` here was inert (outer span isn't a scroll
    // container) and left the UA default `resize: both` grip on the real
    // element. `[&_textarea]:` pierces through like every sizing class next
    // to it.
    return 'min-h-14 p-0 [&_textarea]:min-h-14 [&_textarea]:resize-none [&_textarea]:px-0';
  }
  // Round-2 visual fix: same resize pierce-through as the empty branch, plus
  // `[&_textarea]:leading-6` — the session textarea pins `min-h-6`/`py-0`
  // (the 24px row the card's height arithmetic counts twice, see
  // `composerFollowHeightBreakdown`), and a `<textarea>` never
  // vertically centers its own content, so with zero padding the resting
  // line sat high in the 24px box. Matching line-height to the height token
  // fills the box instead of relying on padding.
  //
  // F6 (2026-08-18) RETIRES `min-w-32` (round-4 defect B) and `flex-[2]`
  // (round-4 F5b) together. Both were arbitration between two elastic text
  // competitors in one row: a same-row sibling with a large max-content basis
  // (a long error string) could claim the entire negative-shrink budget and
  // crush this to 0px, so it got a 128px floor; then the status slot needed a
  // non-zero grow weight of its own to stop rendering at 0px, so this one was
  // raised to grow:2 to keep the dominant share. The textarea now owns row 1
  // outright and the status line moved into the extras stack, which deletes
  // the contest instead of arbitrating it — a width floor and a grow weight
  // both describe a negotiation that no longer happens.
  //
  // `w-full` in their place: this is a column child, so it stretches by
  // default, and saying so keeps the intent legible next to the empty
  // branch. The four `[&_textarea]:` pierce-through variants are untouched —
  // `<Textarea unstyled>` only applies `className` to the outer span
  // (textarea.tsx), so sizing that must reach the real inner element still
  // has to be written this way.
  return 'w-full p-0 [&_textarea]:min-h-6 [&_textarea]:max-h-14 [&_textarea]:resize-none [&_textarea]:px-0 [&_textarea]:py-0 [&_textarea]:leading-6';
}

/**
 * The session card's status line wrapper — now a full-width line in the extras
 * stack, no longer a slot competing inside the control row.
 *
 * F6 (2026-08-18) RETIRES the whole patch network this class used to carry
 * (`basis-0`, `flex-1`, `max-w-48`, `h-6`), and MOVES the line itself out of
 * `composerBarClass('session')` into the extras stack above the textarea. Both
 * halves of that need justifying, because the patches were each fixing a real,
 * observed defect:
 *
 *  - `basis-0` (round-4 defect B): without an explicit flex-basis this slot's
 *    own potentially-long content became its base size, and CSS's negative
 *    shrink distribution (`shrink × basis`) handed the deficit to the larger
 *    basis, starving the textarea toward 0px.
 *  - `flex-1` + `max-w-48` (round-4 F5b): `basis-0` with grow:0 then rendered
 *    this slot at literally 0px in the ORDINARY positive-free-space case, so
 *    it needed a grow weight back, bounded so it could not win a width contest.
 *  - `h-6` (round-5 diag:placeholder-align): compensation for the parent row's
 *    `items-start`, so this slot's shorter content still stood at the shared
 *    24px reference.
 *
 * Every one of those answers the same question — how should this slot and the
 * textarea divide one row — and F6 stops asking it. The line is a DRAFT-side
 * fact (attachments being read off disk, or a large-attachment hint; see
 * `shouldShowStatusLine` and `resolveIdleStatusText` for why nothing else can
 * reach it in this mode), which puts it in the same family as the notice, the
 * queue notice and the chips. It renders with them, on its own line, with the
 * card's full width. `min-w-0` is all that survives, and only because the
 * inner `<p>`'s `truncate` needs a zero min-width above it to fire at all;
 * `h-6` goes because the parent it compensated for is `items-center` again.
 *
 * The two modes deliberately place this line DIFFERENTLY and must not be
 * "unified": `empty` keeps its status line inside the bottom bar, where it is
 * the only elastic text and has room to be (`ChatComposer.tsx`'s empty branch
 * passes its own wrapper class). The empty card is a wide centred card; the
 * session card is a narrow docked one whose row 2 already carries five
 * controls. Same component, two different width budgets, two right answers.
 */
export function sessionStatusLineWrapperClass(): string {
  return 'flex min-w-0 items-center gap-1.5';
}

/**
 * F5(a) (round-4 Codex NEEDS-FIX #4): the composer's inline status-line TEXT
 * for the non-sending, non-reading case. Session mode must NEVER select the
 * full `statusHint` (error / no-session / no-workspace / no-cwd) text —
 * even in combination with `hasLargeHint` being true (`shouldShowStatusLine`
 * can still show the row for `hasLargeHint` alone, independent of
 * `hasStatusError`) — because the destructive banner above the composer
 * card already owns that text exclusively (`shouldShowStatusLine`'s own
 * fix). Without this, the OLD `(!hasStatusError && largeHint) || statusHint`
 * selection still fell through to the full error text the instant
 * `hasStatusError` was true, regardless of why the row was showing at all —
 * a residual defect-B crack in exactly the combined state the original fix
 * did not consider. Empty mode is unaffected: unchanged fallback order.
 */
export function resolveIdleStatusText(input: {
  mode: MiddleColumnMode;
  hasStatusError: boolean;
  largeHint: string | null;
  statusHint: string;
}): string | null {
  if (input.mode === 'session' && input.hasStatusError) {
    return input.largeHint;
  }
  return (!input.hasStatusError && input.largeHint) || input.statusHint;
}

// ---- Target row ----

/** Target row's outer class: empty sits 8px above the card, session sits 8px below it; row height/gap match. */
export function targetRowClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'mb-2 flex h-6 items-center gap-1';
  }
  return 'mt-2 flex h-6 items-center gap-1';
}

/** Target row slots: session mode drops the folder slot (A07 §08②). */
export function targetRowSlots(mode: MiddleColumnMode): {
  folder: boolean;
  branch: boolean;
  runLocation: boolean;
} {
  return { folder: mode === 'empty', branch: true, runLocation: true };
}

/**
 * Whether the target row should render at all. A non-targetable workspace
 * always hides it. In session mode, a row with neither a branch dropdown nor
 * a run-location label would just be 24px of dead space, so it collapses.
 */
export function shouldRenderTargetRow(input: {
  mode: MiddleColumnMode;
  hasTargetableWorkspace: boolean;
  showBranchSelect: boolean;
  hasRunLocation: boolean;
}): boolean {
  if (!input.hasTargetableWorkspace) {
    return false;
  }
  if (input.mode === 'empty') {
    return true;
  }
  return input.showBranchSelect || input.hasRunLocation;
}

// ---- Status line ----

/**
 * Whether the composer's status line (`Ready · cwd: …` / sending / error /
 * large-attachment hint) should be shown. Both cards now hide their resting
 * state: the line appears only while something is actually in flight or
 * flagged.
 *
 * T-30b2 §4.8: the empty card used to return `true` unconditionally, so a
 * static `Ready · cwd: /home/…` line was permanently parked inside it. The
 * reference has no such element, and A07 :1612 ("nothing permanently docked
 * under the empty card") points the same way. The cwd path it used to be the
 * only carrier of is now reachable from the target row's folder trigger
 * `title` — removing a display without first restoring a path to the
 * information is the failure mode that compensation exists to prevent. The
 * destructive banner above the card is unaffected; it still prints the full
 * hint whenever there is no cwd or a last error.
 *
 * Round-4 point-check fix (defect B): session mode no longer shows it for
 * `hasStatusError` at all. The full error text (`Error: ${lastError}` —
 * potentially a multi-hundred-character `rawEvents=[...]`/`hostAfter=...`
 * dump) already renders once, in full, in the destructive banner above the
 * composer card (`ChatComposer.tsx`'s `mb-2 max-h-28 …` block) — showing it
 * a SECOND time crammed into what was then the same flex row as the textarea
 * was not just redundant, it was the actual defect-B trigger: the error
 * string's own max-content width could claim the row's entire shrink budget
 * and crush the textarea to 0px. (F6 has since taken the status line out of
 * that row entirely — see `sessionStatusLineWrapperClass` below — which
 * removes the mechanism, not the reason: the banner is still the SOLE owner
 * of error text in session mode, and any future inline status for an error
 * state must be a short, fixed-length label (e.g. "Failed"), never the full
 * message.)
 *
 * T-31 §3.2 (F-B11): `sending` no longer shows this line at all. The waiting
 * copy it used to gate ("Pondering… · ↑ 428 chars · 12s" — F456 §7.1 replaced
 * the older "Waiting for Agent Host reply · 12s (up to 45s)" wording, budget
 * clause and all) describes the turn in flight, not the draft in hand, so it
 * moved to the turn head, where it gets the full reading-column width instead
 * of the middle of the docked card. Leaving the condition here would print the same fact twice, in two
 * places, from one source. What stays in the composer is the round action
 * button's Stop state — the "something is running" signal is still
 * double-channelled, it just no longer duplicates the text.
 *
 * `sending` remains in the input type on purpose, now optional: the composer
 * stopped supplying it once the turn head took the copy over (R4), but keeping
 * the field is what lets F-B11 keep asserting that passing it changes nothing.
 * Delete it and the regression that assertion guards becomes unexpressible.
 */
export function shouldShowStatusLine(input: {
  mode: MiddleColumnMode;
  /** Accepted and ignored — see the note above. */
  sending?: boolean;
  reading: number;
  hasStatusError: boolean;
  hasLargeHint: boolean;
}): boolean {
  return input.reading > 0 || input.hasStatusError || input.hasLargeHint;
}

// ---- Mention popup ----

/** Mention popup's placement class: the empty card has less headroom above it, so it opens downward. */
export function mentionPopupPlacementClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'top-full mt-1';
  }
  return 'bottom-full mb-1';
}

/**
 * Which side a Composer popup opens toward, as a Base UI `side` value.
 *
 * This is the SAME judgement `mentionPopupPlacementClass` above encodes as
 * Tailwind classes (the docked card has no headroom below it, the centred one
 * has none above it), restated for primitives that position themselves rather
 * than accepting a class. It is deliberately not a second rule — if the mode
 * criterion ever changes, both of these move together.
 */
export function composerPopupSide(mode: MiddleColumnMode): 'top' | 'bottom' {
  return mode === 'empty' ? 'bottom' : 'top';
}

// ---- Round action button ----

/**
 * 24px true-circle class for the send/stop/retry/enqueue action button,
 * overriding `Button`'s forced squircle four-piece (`rounded-[10px]
 * [corner-shape:squircle] supports-…:rounded-[50px] before:rounded-[9px]…`).
 * Same for both modes — only the colour differs by kind
 * (`roundActionButtonKindClass`).
 *
 * T-30b2 §3.3-E2: was `size-7` (28px). A07 :1329 derived 28 from "Cursor's
 * send key looks about 36px", which measurement puts at 24 — so the input to
 * that derivation was 25% off. 24px is A07's own `--h-btn` and is what every
 * other Composer control already uses.
 *
 * `sm:size-6` is NOT redundant. `Button`'s `icon-sm` size is `size-8
 * sm:size-7`, and a bare `size-6` only displaces the unprefixed half —
 * tailwind-merge keeps `sm:size-7` because a breakpoint-prefixed class is a
 * different conflict group. At `sm` and wider (i.e. every real window) the
 * leftover would win and the button would quietly render 28px while every
 * class assertion still passed. This is the same leak the deleted
 * `ModelSelect`/`EffortSelect` each carried a patch for (`min-h-6 sm:min-h-6`
 * against `size="sm"`'s `min-h-8 sm:min-h-7`); it is a property of layering a
 * flat override onto a responsive variant, not a one-off.
 */
export function roundActionButtonClass(): string {
  return 'size-6 sm:size-6 rounded-full [corner-shape:round] supports-[corner-shape:squircle]:rounded-full before:rounded-full supports-[corner-shape:squircle]:before:rounded-full';
}

export type RoundActionButtonKind = 'send' | 'stop' | 'retry' | 'enqueue';

/**
 * Per-kind fill for the round action button.
 *
 * `send` and `enqueue` are deliberately the SAME near-neutral black: enqueue
 * is not a demoted action, it is this turn's send with a delay, so giving it
 * its own colour would invent a distinction the behaviour does not have. They
 * used to be `--primary` (the brand orange, C = 0.1523); the reference uses a
 * near-zero-chroma dark fill, and orange-plus-red round keys sitting side by
 * side (Retry + Send, or Stop + …) was the last of the four "too AI" sources.
 *
 * `stop` keeps the saturated red — a destructive-coloured Stop is an
 * established safety signal here and at most one is ever on screen. `retry`
 * keeps the outline treatment.
 *
 * These strings are applied ON TOP of the `Button` variant each kind already
 * uses, so they only need to restate what actually changes plus enough to be
 * self-describing as a contract.
 */
export function roundActionButtonKindClass(kind: RoundActionButtonKind): string {
  switch (kind) {
    case 'send':
    case 'enqueue':
      return 'border-foreground bg-foreground text-background shadow-none not-disabled:inset-shadow-none hover:border-foreground hover:bg-foreground/90';
    case 'stop':
      return 'border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90';
    case 'retry':
      return 'border-border bg-background text-foreground hover:bg-accent/50';
  }
}

// ---- Placeholder text ----

/** T-05: pending-question follow-up copy (A07 screen 6 group E — same lifecycle as the collapsed dock strip). */
export const PENDING_QUESTION_PLACEHOLDER = 'Add more optional details…';

/**
 * Composer placeholder text. Sending/busy/no-session/no-workspace states are
 * identical in both modes; only the default "ready to type" copy differs —
 * the docked composer asks for a follow-up instead of the initial prompt.
 *
 * `pendingQuestion` must be checked before `busy`: `waiting_question` makes
 * `isStoppable` (`ChatComposer.tsx:64-71`) true, which makes `busy` true —
 * if this branch sat after the `busy` check it would never be reached.
 *
 * T-19: `queuedCount` must also be checked before `busy` for the same reason
 * `pendingQuestion` is — a non-empty queue only exists while `busy` is true,
 * so a branch after `busy` would never fire. Once composer input unlocks
 * while a turn runs (T-19 decision 2), the old "use Stop, then send again"
 * copy is simply wrong — it tells the user to do something they no longer
 * need to.
 */
export function composerPlaceholder(input: {
  mode: MiddleColumnMode;
  canSend: boolean;
  busy: boolean;
  sending: boolean;
  hasSession: boolean;
  hasWorkspace: boolean;
  attachmentCount: number;
  /** T-05: this session has a pending question dock showing. */
  pendingQuestion?: boolean;
  /** T-19: messages already queued for this session while a turn runs. */
  queuedCount?: number;
  /**
   * Round-2 P0: this send is a brand-new session's first message, going
   * through the create-session handshake (close → createSession → wait for
   * session.created, up to ~5s) rather than the instant 'direct' path an
   * already-bound session takes. Gets its own copy so a slow first message
   * doesn't read like an ordinary follow-up sitting in flight.
   */
  isCreatingSession?: boolean;
}): string {
  // Stop-hang fix (2026-08-10): computed up front so the `sending` branch can
  // stand DOWN for it. `sending` used to win outright, so a follow-up typed
  // during a turn was told "Sending to Agent Host…" when `decideSendAction`
  // had actually enqueued it (queueRelease.ts: any of busy/sending/inFlight
  // returns `'enqueue'`) — the placeholder claimed delivery for a message
  // that had not left the composer's own queue. Expressed as a stand-down
  // rather than a moved branch so the ONE case where `sending` still wins
  // stays visible: the m9 `hasWorkspace` gate below, where the queue cannot
  // release at all and promising "queued" would be the lie instead.
  const hasReleasableQueue = (input.queuedCount ?? 0) > 0 && input.hasWorkspace;
  if (input.sending && !hasReleasableQueue) {
    if (input.isCreatingSession) {
      return 'Creating session with Agent Host (first message only)…';
    }
    return input.attachmentCount > 0
      ? `Sending ${input.attachmentCount} attachment${input.attachmentCount > 1 ? 's' : ''} to Agent Host…`
      : 'Sending to Agent Host…';
  }
  if (input.pendingQuestion) {
    return PENDING_QUESTION_PLACEHOLDER;
  }
  // m9 fix: `hasWorkspace` must gate this branch too — a queue can outlive
  // its workspace (a bucket is only pruned when its SESSION disappears, not
  // when the workspace backing it is removed), and without this guard the
  // placeholder keeps promising delivery ("type another follow-up…") for a
  // queue that can no longer release at all, masking the real blocker.
  // (`hasReleasableQueue` is that same condition, hoisted above for the
  // `sending` stand-down — same predicate, one definition.)
  if (hasReleasableQueue) {
    return `Queued ${input.queuedCount} — type another follow-up…`;
  }
  if (input.busy) {
    return 'Agent Host is running — your message will be queued…';
  }
  if (!input.hasSession) {
    return 'Select a session in the left nav before sending…';
  }
  if (!input.hasWorkspace) {
    return 'Active session has no workspace…';
  }
  if (input.canSend) {
    return input.mode === 'session' ? 'Send follow-up…' : 'Message Claude via Agent Host…';
  }
  return 'Cannot send right now…';
}
