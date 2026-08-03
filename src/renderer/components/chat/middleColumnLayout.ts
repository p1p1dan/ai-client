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
 * The session card's resting radius is a FIXED half-height (21px), not
 * `rounded-full`. Adversarial review of the pill decision (A07 v4 §8 `:1334`)
 * found `hasExtras` only covers one of the two ways this card grows: the other
 * is the textarea itself. It is `field-sizing-content` with
 * `[&_textarea]:min-h-6 max-h-14`, so ordinary typing soft-wraps and walks the
 * card 42 → 66 → 74px with no extras present at all. CSS clamps a 999px radius
 * to half the box height, so `rounded-full` would follow that growth into the
 * 33-37px arcs §5.3 names as the "runaway" shape — precisely what the extras
 * guard exists to prevent, reached by a path the guard cannot see.
 *
 * `hasExtras` still drops to `rounded-md`, unchanged: chips/notices are a
 * different, larger jump and the flatter radius reads better there.
 */
export function composerCardClass(mode: MiddleColumnMode, opts?: { hasExtras?: boolean }): string {
  if (mode === 'empty') {
    // T-30b2 §4.1: both modes now share one symmetric 8px inset (`p-2`). The
    // old 12/10 split traced back to A07's eyeballed three-value padding, not
    // to a measurement.
    return 'relative rounded-md border border-border bg-card focus-within:border-input p-2';
  }
  // Resting height contract, T-30b2 §3.3-E1: exactly 42px, not the 40px A07
  // :1844 wrote. That line computed "24px content + 8px top + 8px bottom" and
  // never added the two 1px borders; the Cursor reference measures 42px, which
  // is the same arithmetic done completely. T-28 saw the implementation render
  // 42 and "fixed" it back down to 40 by keeping a 28px round key and
  // squeezing the padding to 5px — the wrong direction. Content returns to
  // 24 (COMPOSER_CONTROL_SIZE), padding to 8, and the card rests at
  // `min-h-10.5` = 42px. `composerFollowHeightBreakdown()` below carries the
  // same arithmetic as data so a test can cross-check it against this string.
  // 21 === composerFollowHeightBreakdown().total / 2 — pixel-identical to a
  // pill at the 42px resting height, and it degrades to a rounded rectangle
  // instead of a growing arc once the content-sized textarea gets taller.
  // `rounded-full` would instead be clamped to h/2 at every height. The spec
  // forbids runtime measurement, so a static half-height constant is the only
  // available answer; the assertion cross-checks 21 × 2 against the breakdown
  // so the two cannot drift.
  const radius = opts?.hasExtras ? 'rounded-md' : 'rounded-[21px]';
  return `relative ${radius} border border-border bg-card focus-within:border-input flex min-h-10.5 items-center gap-2 p-2`;
}

/**
 * The 42px resting height of the docked follow-up card, as data.
 *
 * This exists purely so the height contract is assertable as ARITHMETIC rather
 * than as "the class string contains `min-h-10.5`". T-28's blocker was exactly
 * that gap: the test asserted a class was present and could not notice that
 * the composed height it produced was wrong.
 */
export function composerFollowHeightBreakdown(): {
  border: number;
  padding: number;
  content: number;
  total: number;
} {
  const border = 2; // 1px top + 1px bottom
  const padding = 16; // p-2 → 8px top + 8px bottom
  const content = COMPOSER_CONTROL_SIZE;
  return { border, padding, content, total: border + padding + content };
}

/**
 * The card's inner control row.
 *
 * `empty` mode: the bottom bar under the textarea (attach → model trigger →
 * status line → action buttons). `session` mode: the single docked row itself.
 * Both are 8px-gapped flex rows; only the empty bar needs the 6px offset from
 * the textarea above it.
 *
 * Round-5 fix (diag:placeholder-align): `session` mode uses `items-start`,
 * not `items-center`. Every other child in this row (attach button, model
 * trigger, action buttons) is an exact 24px box, so `items-start` vs.
 * `items-center` is a no-op for them either way. The textarea is the one
 * child whose rendered box height is NOT pinned to 24px — it relies on
 * `field-sizing-content` (textarea.tsx) to auto-size, and the browser's
 * intrinsic content-box height for one row is not guaranteed to equal
 * exactly `1 × line-height`; any UA slack makes the real height `H > 24`.
 * A `<textarea>`'s content is always top-anchored inside its own box
 * (browser default, not something this codebase controls), so
 * `items-center` on the row centers that taller `H`-height box against the
 * 24px reference — which visually pushes the (top-anchored) placeholder/
 * first line of text ABOVE the other controls' centerline whenever `H>24`.
 * `items-start` sidesteps the uncertain `H` entirely: every child's top
 * edge aligns, so the textarea's top-anchored first line always sits at
 * `row-top + 12px`, matching the 24px controls' centerline by construction —
 * robust to whatever `H` the browser actually renders, rest or grown.
 */
export function composerBarClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'mt-1.5 flex items-center gap-2';
  }
  return 'flex min-w-0 items-start gap-2';
}

/**
 * `empty` mode's right-hand action group (round buttons).
 *
 * `ms-auto` rather than a `justify-between` row: the status line to its left
 * is conditional now, and without an auto margin the send key would slide left
 * whenever the status text is absent. A round action key that changes position
 * depending on unrelated state breaks the "Stop replaces Send in place" rule
 * the whole button stack is built on. With the status line present its
 * `flex-1` already absorbs the free space, so the margin resolves to zero and
 * changes nothing.
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
    'inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-ui',
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
  // (needed for the 40px docked-card contract), and a `<textarea>` never
  // vertically centers its own content, so with zero padding the resting
  // line sat high in the 24px box. Matching line-height to the height token
  // fills the box instead of relying on padding.
  //
  // Round-4 point-check fix (defect B): `min-w-0` was a genuine flex-crush
  // hazard — the textarea's `flex: 1 1 0%` gives it a zero flex-basis, and
  // with no floor at all a same-row sibling with a large max-content basis
  // (e.g. a long error string) can claim the ENTIRE negative-shrink budget
  // (`shrink × basis`) and squeeze this down to a literal 0px. `min-w-32`
  // (128px, an ordinary Tailwind scale step) gives it a floor no sibling's
  // shrink math can cross, independent of how long any status text gets —
  // the same-row status slot itself also gets `basis-0` as the other half
  // of this fix (see `sessionStatusLineWrapperClass` below).
  //
  // Round-4 Codex NEEDS-FIX #4 (F5b): `flex-1` (grow:1) is now `flex-[2]`
  // (grow:2, same shrink:1/basis:0% — CSS's single-number `flex: N`
  // shorthand). `sessionStatusLineWrapperClass` below was ALSO switched to a
  // `flex-1`-based (grow:1) sibling instead of grow:0 — a real, live bug
  // Codex's review caught: `basis-0` with NO grow at all means that slot's
  // final width stays pinned at its zero basis in ANY positive-free-space
  // layout (the ordinary case — short "Sending…"/attachment-hint text, no
  // error present), since flex-grow:0 never claims a share of leftover
  // space; `min-w-0` on that slot removed even the browser's automatic
  // minimum-content floor. Ordinary status text was being crushed to 0px
  // EVERY time, not just under overflow — the fix this comment describes
  // regressed the case it wasn't targeting. Giving both siblings a
  // grow>0 flex basis restores real space-sharing; the 2:1 ratio keeps the
  // textarea's share dominant so the status slot (capped by its own
  // `max-w`, see below) never wins a fight for width, mirroring
  // `MergeEditor.tsx`'s existing `flex-[1.5]` split-pane precedent — no
  // non-arbitrary Tailwind step exists for a flex-grow RATIO (unlike a
  // spacing/size token, which `min-w-32`/the status line's `max-w` below
  // both are).
  return 'min-w-32 flex-[2] p-0 [&_textarea]:min-h-6 [&_textarea]:max-h-14 [&_textarea]:resize-none [&_textarea]:px-0 [&_textarea]:py-0 [&_textarea]:leading-6';
}

/**
 * Round-4 point-check fix (defect B, `shouldShowStatusLine`'s sibling in the
 * layout half of the fix): the session card's single docked row places the
 * textarea, the status line, Model/Effort and the action buttons all in one
 * flex row. ANY same-row auxiliary text slot in that row must carry
 * `basis-0` — without an explicit `flex-basis`, its own (potentially long)
 * content becomes its flex base size, and CSS's negative-space shrink
 * distribution (`shrink × basis`) hands nearly all of the deficit to
 * whichever sibling has the larger basis, starving the textarea's
 * `flex: 1 1 0%` toward 0px regardless of its own `min-w-32` floor's
 * PRESENCE — `basis-0` is what stops that sibling from ever outweighing the
 * textarea in the first place; `min-w-32` above is the second, independent
 * line of defense.
 *
 * Round-4 Codex NEEDS-FIX #4 (F5b): `basis-0` alone, with `flex-grow`
 * left at its browser default of 0, was itself a regression — a grow:0
 * item never claims any of a row's POSITIVE leftover space, so this slot
 * rendered at literally 0px (its own zero basis, un-grown) for the
 * ordinary, no-error case too (short "Sending…"/attachment-hint text),
 * not just the long-error-text case the original fix targeted. Now
 * carries `flex-1` (grow:1 — the textarea's own `flex-[2]` above keeps a
 * 2:1 dominance so this slot still loses any real space contest) PLUS an
 * explicit `max-w-48` (192px, an ordinary Tailwind scale step) so it can
 * never claim more than a bounded share even in a very wide row —
 * `max-width` clamps a flex item's HYPOTHETICAL size too (not just its
 * final rendered size), so this simultaneously re-caps this slot's
 * contribution to the negative-space shrink calculation, the exact
 * protection `basis-0` used to provide alone.
 *
 * Round-5 fix (diag:placeholder-align): now that the parent row
 * (`composerBarClass('session')`) switched from `items-center` to
 * `items-start`, this slot needs its OWN fixed-height box — its content
 * (a `size-3.5` Spinner + `text-meta`/13px text) is shorter than the 24px
 * the other row children stand at, and with the parent no longer centering
 * cross-axis, an un-pinned slot would render top-flush instead of matching
 * the textarea's 24px-tall first line. `h-6` (24px) restores that shared
 * reference height; the pre-existing `items-center` on THIS wrapper (not
 * the parent's) still centers the shorter spinner/text inside it.
 */
export function sessionStatusLineWrapperClass(): string {
  return 'flex h-6 min-w-0 flex-1 shrink basis-0 max-w-48 items-center gap-1.5';
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
 * a SECOND time crammed into this same single flex row as the textarea was
 * not just redundant, it was the actual defect-B trigger: the error string's
 * own max-content width could claim the row's entire shrink budget and crush
 * the textarea to 0px (see `composerTextareaClass`'s `min-w-32` / the
 * layout-half fix `sessionStatusLineWrapperClass`, both below). The banner
 * is now the SOLE owner of error text in session mode; any future inline
 * status for an error state must be a short, fixed-length label (e.g.
 * "Failed"), never the full message.
 */
export function shouldShowStatusLine(input: {
  mode: MiddleColumnMode;
  sending: boolean;
  reading: number;
  hasStatusError: boolean;
  hasLargeHint: boolean;
}): boolean {
  return input.sending || input.reading > 0 || input.hasStatusError || input.hasLargeHint;
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
  if (input.sending) {
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
  if ((input.queuedCount ?? 0) > 0 && input.hasWorkspace) {
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
