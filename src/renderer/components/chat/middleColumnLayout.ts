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

import { englishTranslate, type Translate } from '@shared/i18n';
import { DEFAULT_CHAT_BODY_FONT_SIZE } from '@shared/types/chatTypography';
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
 *
 * Decision 174 (issue #6, second wave): no conversation open is the HOME page,
 * and the home page docks the composer exactly where a conversation does —
 * the same card, the work bar under it — so sending the first message from it
 * moves nothing (user ruling 2026-10-10). It used to be `empty`, the start
 * screen's geometry, which put the work bar above a taller card and made the
 * card jump on the first send. `empty` is left for a blank conversation that
 * exists but has not started, which no "new chat" entry creates any more.
 */
export function deriveMiddleColumnMode(input: MiddleColumnModeInput): MiddleColumnMode {
  if (input.sessionId == null) {
    return 'session';
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
    // U28: the composer sits at the BOTTOM of the empty column, not floating in
    // the middle of it.
    //
    // A07's `flex-1 justify-center pb-[9%]` centred the composer in whatever
    // space the start screen left above it, which put the two of them in the
    // top half with a large dead area beneath — the arrangement the user
    // rejected on sight. pix pins its composer to the bottom and centres the
    // start screen in the room above; `startScreenHostClass` is that room, and
    // this is the pinned half. Slightly more bottom padding than session mode:
    // there is no timeline behind it for the card to read against.
    return 'shrink-0 px-6 pt-0 pb-6';
  }
  return 'shrink-0 px-6 pt-0 pb-3.5';
}

/**
 * U28: the region above the empty-mode composer, which the start screen is
 * centred in.
 *
 * A sibling of the composer's host rather than a wrapper around both: the two
 * have opposite jobs (one takes all the leftover height, one takes none), and
 * expressing that as one container would need a nested flex column anyway.
 */
export const START_SCREEN_HOST_CLASS = 'flex min-h-0 flex-1 items-center justify-center px-6';

/** Timeline scroll area's inner padding (A07 `.tl`: 20/24/8). Padding stays outside `ReadingColumn`. */
export const TIMELINE_PADDING_CLASS = 'px-6 pt-5 pb-2';

// ---- Composer control sizing ----

/**
 * The single height tier every Composer control derives from: the ⊕ attach
 * button, the action key, and the ghost triggers in the row under the box are
 * all 24px. Class helpers spell the Tailwind step (`size-6` / `h-6`); tests
 * cross-check `step × 4 === COMPOSER_CONTROL_SIZE`.
 */
export const COMPOSER_CONTROL_SIZE = 24;

/**
 * The composer box (2026-10-22, matched to the Claude Code desktop app): one
 * thin line when empty that grows with the draft. Inside the frame there is
 * only the input row (⊕, textarea, action key) and, when present, the draft
 * extras stacked above it; every other control lives in the plain row below
 * (`composerBarClass`).
 *
 * A 1px `border-soft` frame stepping to `border-strong` on hover and while the
 * textarea has focus, `rounded-lg` (12px), the nearest surface, no shadow.
 * `min-h-9.5` is the resting FLOOR (`composerFollowHeightBreakdown().total`);
 * the box grows past it with the draft and with a larger body font.
 *
 * U09-1: on the start screen of a blank conversation the target tab sits
 * flush on top, so the top corners drop to `rounded-t-xs` there.
 */
export function composerCardClass(
  mode: MiddleColumnMode,
  opts?: { hasProtrusion?: boolean }
): string {
  if (mode === 'empty' && opts?.hasProtrusion) {
    return `${COMPOSER_CARD_SURFACE} rounded-t-xs`;
  }
  return COMPOSER_CARD_SURFACE;
}

const COMPOSER_CARD_SURFACE =
  'relative flex min-h-9.5 flex-col gap-1.5 rounded-lg border border-border-soft bg-surface-3 p-1.5 transition-colors duration-150 ease-out hover:border-border-strong focus-within:border-border-strong';

/**
 * The textarea's line box as a multiple of `--text-chat-body`: the class
 * string spells `calc(var(--text-chat-body)*1.5)` for both its line-height and
 * its cap, and the height arithmetic multiplies the body default by this.
 */
export const COMPOSER_TEXTAREA_LINE_SCALE = 1.5;

/** How many body lines the textarea grows to before it scrolls (F7f's cap). */
export const COMPOSER_TEXTAREA_MAX_ROWS = 8;

/**
 * The resting height of the composer box, as data, so the contract is
 * assertable as arithmetic and cross-checked against the class strings.
 *
 * The input row is as tall as the taller of its children: the 24px control
 * tier, or the textarea's single line plus its centring padding. Below a 16px
 * body the textarea pads its one line out to the control tier
 * (`composerTextareaClass`'s `py`), so placeholder and caret sit on the
 * controls' centreline; at 16px and above the padding clamps to 0 and the line
 * itself sets the height.
 */
export function composerFollowHeightBreakdown(): {
  /** `border` — 1px top + 1px bottom. */
  border: number;
  /** `p-1.5` — 6px top + 6px bottom. */
  padding: number;
  /** One body line at the DEFAULT body size. */
  textareaLine: number;
  /** The textarea's own top + bottom padding that centres its one line. */
  textareaPadding: number;
  /** The textarea at rest: one line plus its padding. */
  textareaRow: number;
  /** The ⊕ button and the action key. */
  controlRow: number;
  /** The single input row: the taller of the two. */
  inputRow: number;
  total: number;
} {
  const border = 2;
  const padding = 12;
  // The body default lives in `@shared/types/chatTypography`.
  const textareaLine = DEFAULT_CHAT_BODY_FONT_SIZE * COMPOSER_TEXTAREA_LINE_SCALE;
  const controlRow = COMPOSER_CONTROL_SIZE;
  const textareaPadding = Math.max(0, controlRow - textareaLine);
  const textareaRow = textareaLine + textareaPadding;
  const inputRow = Math.max(textareaRow, controlRow);
  return {
    border,
    padding,
    textareaLine,
    textareaPadding,
    textareaRow,
    controlRow,
    inputRow,
    total: border + padding + inputRow,
  };
}

/**
 * The one row inside the box: ⊕, the textarea, the action key. `items-end`
 * keeps ⊕ and the key on the last line as the draft grows, the way the
 * reference does; on a single line every child is the same 24px, so it is
 * also centred.
 */
export function composerInputRowClass(): string {
  return 'flex min-w-0 items-end gap-1.5';
}

/**
 * The textarea's slot in the input row: takes the free width, and stacks the
 * history label (`History 2/3`) above the textarea when it shows.
 */
export function composerTextareaSlotClass(): string {
  return 'flex min-w-0 flex-1 flex-col';
}

/** The draft extras (notices, attachment and mention chips, status line) above the input row. */
export function composerExtrasClass(): string {
  return 'flex min-w-0 flex-col gap-1 px-1';
}

/**
 * The plain row under the box (no frame, no fill): the permission tier on the
 * left, model/effort and context use on the right. In a conversation and on
 * the home page the target row IS this row (`targetRowClass('session')`), so
 * repository, branch and run location join it rather than adding a second line.
 * `px-1` lines the first trigger's text up with the box's text inset.
 */
export function composerBarClass(): string {
  return 'mt-1.5 flex h-6 min-w-0 items-center gap-0.5 px-1';
}

/** The right-anchored group of the row under the box. */
export function composerBarTrailingClass(): string {
  return 'ms-auto flex shrink-0 items-center gap-0.5';
}

// ---- Slot order ----

/**
 * One control position. `modelEffort` is ONE slot: the model name and the
 * reasoning-effort suffix are a single trigger (`composerModelTriggerClass`).
 */
export type ComposerBarSlot = 'attach' | 'permission' | 'usage' | 'modelEffort' | 'actions';

/**
 * The order as DATA rather than JSX reading order (U09-2): the call site maps
 * these arrays, so the order a test reads here is the order that ships. A slot
 * with nothing real to say (no session for `usage`) renders nothing.
 *
 * Inside the box: ⊕ leads, the action key trails.
 */
export const COMPOSER_CARD_LEADING: readonly ComposerBarSlot[] = ['attach'];

/** @see COMPOSER_CARD_LEADING */
export const COMPOSER_CARD_TRAILING: readonly ComposerBarSlot[] = ['actions'];

/** The row under the box: what the message may do, on the left. */
export const COMPOSER_BAR_LEADING: readonly ComposerBarSlot[] = ['permission'];

/** How it will be answered, then how full the context is, on the right. */
export const COMPOSER_BAR_TRAILING: readonly ComposerBarSlot[] = ['modelEffort', 'usage'];

/**
 * The action key's group at the end of the input row. `ms-auto` keeps it at
 * the end whatever sits to its left, so Stop replaces Send in place.
 */
export function composerActionGroupClass(): string {
  return 'ms-auto flex shrink-0 items-center gap-1.5';
}

/**
 * Design system v2 §1 rule 1 / §7.9: every control inside the composer is a
 * ghost -- no frame, secondary ink at rest, foreground ink plus the one
 * ghost-hover fill on hover and keyboard focus (always as a pair), the
 * selected fill while its menu is open, and the shared focus ring.
 */
const COMPOSER_GHOST_STATES = [
  'transition-colors duration-150 ease-out',
  'hover:bg-fill-ghost-hover hover:text-foreground',
  'focus-visible:bg-fill-ghost-hover focus-visible:text-foreground focus-ring',
  'data-[popup-open]:bg-fill-ghost-selected data-[popup-open]:text-foreground',
  'disabled:pointer-events-none disabled:opacity-64',
] as const;

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
    ...COMPOSER_GHOST_STATES,
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
 *    on hover"). The shell is a FILL (`bg-fill-ghost-hover`), never a border: a hover
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
 * `focus-visible:bg-fill-ghost-hover` is not optional decoration: with the resting state
 * having no frame at all, a keyboard user tabbing onto this control would
 * otherwise see no shape appear. It must always ship paired with
 * `hover:bg-fill-ghost-hover` (asserted), and the outline sits ON TOP of the fill rather
 * than replacing it.
 *
 * Note for future edits: this repo's custom font-size tokens (`text-ui`,
 * `text-small`, `text-code`, …) ARE registered in tailwind-merge's `font-size`
 * class group in `lib/utils.ts`, so `cn('text-muted-foreground', 'text-ui')`
 * keeps both. It did not always: twMerge's stock config classifies an
 * unrecognised `text-<name>` as a COLOUR, and used to drop the real colour
 * silently — the registration is the fix for that, and this string predates
 * it. Plain concatenation is kept as belt-and-braces (a new token can land
 * before someone remembers to register it), not as a requirement.
 */
export function composerModelTriggerClass(): string {
  return [
    // U30: `max-w-56` caps how far a long model name can push this chip's left
    // edge. Its width is its content, and the bar pins its right edge, so every
    // model switch used to slide the whole chip sideways — visible as "the
    // controls move when I pick something". The cap plus the name's own
    // `truncate` bounds that travel; the effort suffix is never truncated,
    // being the short half that changes most often.
    'group/model inline-flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-sm px-2 text-small text-muted-foreground',
    ...COMPOSER_GHOST_STATES,
  ].join(' ');
}

/**
 * U12: permission tier chip — same ghost-chip language as the model trigger.
 */
export function composerPermissionTriggerClass(): string {
  return [
    'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-small text-muted-foreground',
    ...COMPOSER_GHOST_STATES,
  ].join(' ');
}

/**
 * The model name inside the merged trigger — the quieter half of the pair.
 * Cursor's follow-up bar reads `Sonnet 5` at L 0.398 with `High` at L 0.191:
 * the effort suffix is the value that changes, so it carries the emphasis.
 */
export function composerModelBaseClass(): string {
  // `min-w-0` is what makes `truncate` engage inside a flex row: a flex item
  // defaults to `min-width: auto` and refuses to shrink below its content.
  // Design system v2: brightens with the trigger's own hover/open state.
  return 'min-w-0 truncate text-muted-foreground group-hover/model:text-foreground group-data-[popup-open]/model:text-foreground';
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
 * one carries `text-ui`, i.e. the app-chrome font size, and using
 * it here would put 16px rows inside a card whose whole content is on D25's
 * `text-ui` domain scale. The shared item is right for app menus and wrong for
 * this card; the divergence is the point, not an oversight.
 *
 * Font-size tokens (`text-ui`, `text-small`) are written as plain concatenated
 * strings rather than composed through `cn()`. They ARE registered in
 * tailwind-merge's `font-size` class group in `lib/utils.ts` — but twMerge's
 * stock config classifies an unrecognised `text-<name>` as a COLOUR and drops
 * the real colour beside it, so plain strings stay as belt-and-braces for the
 * window between a new token landing and someone registering it.
 */
export function composerMenuItemClass(): string {
  // Design system v2 §7.10: the coss MenuItem's own look (xs highlight block,
  // the one ghost-hover fill). `sm:` restatements displace MenuSubTrigger's
  // responsive base so a sub-menu row matches its siblings.
  return 'flex min-h-7 cursor-default select-none items-center gap-2 rounded-xs px-2 py-1 text-ui outline-none data-disabled:pointer-events-none data-disabled:opacity-64 data-highlighted:bg-fill-ghost-hover data-highlighted:text-foreground data-popup-open:bg-fill-ghost-hover data-popup-open:text-foreground';
}

/** Section heading inside a Composer popup — same two-menu sharing rule as above. */
export function composerMenuGroupLabelClass(): string {
  // Design system v2 §7.10: the coss MenuGroupLabel's look.
  return 'px-2 pt-2 pb-1 text-small font-medium text-foreground-faint';
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
    'inline-flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-2 text-small',
    'transition-colors duration-150 ease-out',
    'hover:bg-fill-ghost-hover',
    'focus-visible:bg-fill-ghost-hover focus-ring',
    'data-[popup-open]:bg-fill-ghost-selected',
    'disabled:opacity-64',
  ].join(' ');
  return tone === 'muted' ? `${base} text-muted-foreground` : base;
}

/**
 * Queue strip wrapper (T-19), owner of the single 8px gap above the composer
 * card. Design system v2 §7.8: one strip frame (the `DockCard` strip look),
 * its 32px rows divided by hairlines rather than each row framing itself;
 * the cap holds three rows (3 × 32 + 2 dividers + 2 border = 100px).
 */
export function queueStripWrapperClass(): string {
  return 'mb-2 flex max-h-25 min-w-0 flex-col divide-y divide-border-soft overflow-y-auto rounded-md border border-border-soft bg-surface-2 text-ui';
}

/**
 * Textarea outer span's class, including the `[&_textarea]:` pierce-through
 * variants for the inner `<textarea>`. The `<Textarea>` is rendered with
 * `unstyled` (no border/bg/shadow/ring/dark:bg-input chrome on the outer
 * span at all), so the old `border-0 bg-transparent shadow-none
 * focus-visible:ring-0` counters against that default chrome are gone —
 * only size and pierce-through classes remain.
 */
export function composerTextareaClass(): string {
  // `<Textarea unstyled>` applies `className` to the outer span only, so every
  // sizing rule pierces through to the real `<textarea>` with `[&_textarea]:`.
  //
  // - Line box: `calc(var(--text-chat-body)*1.5)` for line-height, so the
  //   reader's prompt follows the body tier (T104).
  // - Rest: one line (`min-h-6`, the control tier). Below a 16px body the
  //   `py` pads that line out to 24px and centres it on the ⊕ / action key;
  //   at 16px and above it clamps to 0 and the line sets the height.
  // - Growth: `field-sizing-content` (textarea.tsx) up to
  //   `COMPOSER_TEXTAREA_MAX_ROWS` lines, then it scrolls.
  return 'w-full p-0 [&_textarea]:text-chat-body [&_textarea]:leading-[calc(var(--text-chat-body)*1.5)] [&_textarea]:min-h-6 [&_textarea]:max-h-[calc(var(--text-chat-body)*1.5*8)] [&_textarea]:py-[max(0px,calc((1.5rem_-_var(--text-chat-body)*1.5)/2))] [&_textarea]:resize-none [&_textarea]:px-0';
}

/**
 * The status line's wrapper inside the extras stack above the input row (both
 * modes). It is a draft-side fact (attachments being read off disk, or a
 * large-attachment hint), so it sits with the notices and chips on its own
 * full-width line; `min-w-0` lets the inner `<p>`'s `truncate` fire.
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

/**
 * Target row's outer class.
 *
 * U09-1 (2026-09-03) turns the EMPTY row into a protrusion tab joined to the
 * top of the card, replacing the free-floating row that used to sit 8px above
 * it. Three properties carry that, and each one is load-bearing:
 *
 *  - **No `mb-2`.** The 8px gap WAS the whole reason the row read as a separate
 *    element. Joined means zero gap; re-adding any bottom margin here un-joins
 *    the tab and there is no second owner of that gap to compensate with.
 *  - **`mx-3` (12px each side).** The tab is narrower than the card, which is
 *    what makes the card's top edge read as sitting ON the tab rather than
 *    beside it. pix uses 18px; 12px is this repo's own spacing step and the
 *    design system bans the arbitrary value that matching 18 exactly would need.
 *  - **`rounded-t-md` only.** Top corners round, bottom corners stay square so
 *    the tab meets the card's edge flush. Pairs with `composerCardClass`'s
 *    `rounded-t-xs` — the card keeps a small top radius so the join reads as two
 *    surfaces meeting, not one shape with a notch.
 *
 * `h-7` (28px) rather than the session row's `h-6`: this is now a filled
 * CONTAINER around the 24px control tier, not a bare row, so it needs the 2px
 * of breathing room above and below its chips. 28px is an established step here
 * (the sidebar row height D03 pinned), not a new one.
 *
 * `bg-muted` is the adjacent surface step to the card's `bg-card` in both
 * themes — deliberately a small delta. The tab is distinguished by SHAPE (top
 * radius, narrower, flush join); a loud fill would read as a separate panel,
 * which is the thing being retired. Do not reach for `bg-fill-ghost-hover` here: that
 * token means "pointer is over this" and using it as a resting fill would leave
 * the real hover state with nowhere to go.
 *
 * Session mode: the plain row under the box, shared with the composer's own
 * controls (`composerBarClass`).
 */
export function targetRowClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'mx-3 flex h-7 items-center gap-1 rounded-t-md bg-muted px-2';
  }
  // 2026-10-22: the row under the box (`composerBarClass`) — the permission
  // tier, model/effort and context use join repository, branch and run location
  // on one quiet line.
  return composerBarClass();
}

/**
 * Whether the empty card wears the joined protrusion tab (U09-1).
 *
 * Both the tab and the card's top radius read this, and two call sites
 * spelling the same condition inline is how they drift apart — the failure
 * mode being a card with a squared-off top edge and no tab above it.
 *
 * It narrows `shouldRenderTargetRow` rather than restating it: that function's
 * empty branch returns true for any targetable workspace, so a targetable
 * workspace is the entire condition. Calling through keeps one predicate.
 */
export function composerHasProtrusion(input: {
  mode: MiddleColumnMode;
  hasTargetableWorkspace: boolean;
}): boolean {
  if (input.mode !== 'empty') {
    return false;
  }
  return shouldRenderTargetRow({
    mode: 'empty',
    hasTargetableWorkspace: input.hasTargetableWorkspace,
  });
}

/**
 * Target row slots. A conversation's row drops the folder DROPDOWN (A07 §08②:
 * the repository is a locked label there). The home page keeps it — it is
 * where the next conversation's repository is picked — and so does the empty
 * (start-screen) row of a blank conversation.
 */
export function targetRowSlots(
  mode: MiddleColumnMode,
  opts?: { home?: boolean }
): {
  folder: boolean;
  branch: boolean;
  runLocation: boolean;
} {
  return { folder: mode === 'empty' || opts?.home === true, branch: true, runLocation: true };
}

/**
 * Whether the target row should render at all.
 *
 * Session mode — every conversation, and the home page — always renders it
 * (decision 174, issue #6): its first column is never empty (the home page's
 * repository dropdown, a conversation's locked repository, or 「临时对话」 for
 * one with no repository), and a row that came and went with the branch or
 * run-location slots moved the card 32px between conversations — and between
 * the home page and the conversation its first send opens.
 *
 * The empty (start-screen) row still needs a targetable workspace: there it is
 * a tab joined to the card (`composerHasProtrusion`), drawn only with a folder.
 */
export function shouldRenderTargetRow(input: {
  mode: MiddleColumnMode;
  hasTargetableWorkspace: boolean;
}): boolean {
  if (input.mode === 'session') {
    return true;
  }
  return input.hasTargetableWorkspace;
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
  // dsh-rebase decision 180: `/compact` no longer runs on this line (decision
  // 176 gave it one); it shows in the timeline, as a compaction does.
  return input.reading > 0 || input.hasStatusError || input.hasLargeHint;
}

// ---- Mention popup ----

/** Mention popup's placement class: the empty card has less headroom above it, so it opens downward. */
export function mentionPopupPlacementClass(side: PopupSide): string {
  return side === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1';
}

/** Which way a popup opens. `top` = above the anchor, `bottom` = below it. */
export type PopupSide = 'top' | 'bottom';

/**
 * F11: the `@` / `/` popup's default height, in px — the old hard-coded
 * `max-h-[240px]` promoted to a named value because it is now an INPUT to a
 * decision rather than a constant on a div.
 */
export const COMPOSER_POPUP_DESIRED_HEIGHT = 240;

/** Distance between anchor and popup (`mt-1` / `mb-1`), in px. */
export const COMPOSER_POPUP_GAP = 4;

/** Breathing room kept against the viewport edge, in px. */
export const COMPOSER_POPUP_VIEWPORT_MARGIN = 8;

/**
 * Below this a list is not worth flipping toward — F11 prefers the side the
 * mode asked for until it cannot even show a couple of rows there.
 */
export const COMPOSER_POPUP_MIN_HEIGHT = 96;

export interface ComposerPopupPlacementInput {
  /** Anchor's top edge in VIEWPORT coordinates (`getBoundingClientRect().top`). */
  anchorTop: number;
  /** Anchor's bottom edge in viewport coordinates. */
  anchorBottom: number;
  /** Usable viewport height — `visualViewport.height` when the IME is up. */
  viewportHeight: number;
  /** Which side the composer's mode would pick if space were unlimited. */
  preferred: PopupSide;
  desiredHeight?: number;
  gap?: number;
  margin?: number;
  minHeight?: number;
}

export interface ComposerPopupPlacement {
  side: PopupSide;
  /** Hard cap in px. Never exceeds the space actually available on `side`. */
  maxHeight: number;
}

/**
 * F11: where the mention / slash popup opens, and how tall it may be.
 *
 * ## What this replaces
 *
 * `mentionPopupPlacementClass` used to decide from the composer MODE alone —
 * docked card opens upward, centred card opens downward — and the popup carried
 * a fixed `max-h-[240px]`. Both halves of that are assumptions about space
 * nobody measured: a short window, a multi-line draft, or an on-screen keyboard
 * all shrink the chosen side without changing the mode, and a fixed 240px then
 * runs straight off the viewport. The mode preference is not WRONG — it is the
 * right tie-breaker — it just cannot be the whole rule.
 *
 * ## The rule
 *
 * Fit first, preference second, and the cap is never negotiable:
 *
 *  1. the preferred side fits the whole list ⇒ take it (the common case, so
 *     nothing moves in an ordinary window);
 *  2. otherwise the other side fits ⇒ flip;
 *  3. neither fits ⇒ stay on the preferred side while it can still show
 *     `minHeight`, else take whichever side is larger.
 *
 * `maxHeight` is then clamped to the space actually available on the chosen
 * side, ALWAYS — including in case 3, where the popup ends up shorter than
 * `minHeight`. "Scroll inside the popup" is a consequence of that clamp, not a
 * separate feature: the list gets a real ceiling, so its own `overflow-y-auto`
 * takes over instead of the popup growing past the edge.
 *
 * Pure and in this module rather than inline in `ChatComposer.tsx`, for the
 * reason this whole file exists: the repo's vitest is node-env and collects
 * only `*.test.ts`, so a placement rule living in the `.tsx` has no automated
 * coverage of any kind — which is how the fixed 240px survived this long.
 */
export function resolveComposerPopupPlacement(
  input: ComposerPopupPlacementInput
): ComposerPopupPlacement {
  const desired = Math.max(0, input.desiredHeight ?? COMPOSER_POPUP_DESIRED_HEIGHT);
  const gap = input.gap ?? COMPOSER_POPUP_GAP;
  const margin = input.margin ?? COMPOSER_POPUP_VIEWPORT_MARGIN;
  const minHeight = Math.min(input.minHeight ?? COMPOSER_POPUP_MIN_HEIGHT, desired);

  const spaceAbove = Math.max(0, input.anchorTop - gap - margin);
  const spaceBelow = Math.max(0, input.viewportHeight - input.anchorBottom - gap - margin);
  const spaceFor = (side: PopupSide) => (side === 'top' ? spaceAbove : spaceBelow);

  const preferred = input.preferred;
  const other: PopupSide = preferred === 'top' ? 'bottom' : 'top';

  let side = preferred;
  if (spaceFor(preferred) < desired) {
    if (spaceFor(other) >= desired) {
      side = other;
    } else if (spaceFor(preferred) < minHeight && spaceFor(other) > spaceFor(preferred)) {
      side = other;
    }
  }

  return { side, maxHeight: Math.min(desired, spaceFor(side)) };
}

/**
 * Which side a Composer popup opens toward, as a Base UI `side` value.
 *
 * The mode judgement itself: the docked card has no headroom below it, the
 * centred one has none above it. Base UI's own primitives take this directly,
 * because they measure and flip on their own; the mention / slash popups —
 * which position themselves with Tailwind and cannot flip — feed it to
 * `resolveComposerPopupPlacement` as the PREFERRED side instead (F11). Either
 * way there is one mode rule, stated here.
 */
export function composerPopupSide(mode: MiddleColumnMode): PopupSide {
  return mode === 'empty' ? 'bottom' : 'top';
}

// ---- Round action button ----

/**
 * 24px small-radius square (design system v2; was a true circle) for the
 * send/stop/retry/enqueue action button. Same for both modes — only the colour differs by kind
 * (`roundActionButtonKindClass`).
 *
 * T-30b2 §3.3-E2: was `size-7` (28px). A07 :1329 derived 28 from "Cursor's
 * send key looks about 36px", which measurement puts at 24 — so the input to
 * that derivation was 25% off. 24px is A07's own `--h-btn` and is what every
 * other Composer control already uses.
 *
 * `sm:size-6` is belt-and-braces: `Button`'s `icon-sm` used to be `size-8
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
  // Design system v2 §7.9: the reference's send key is a small-radius square,
  // not a circle; `Button` has no squircle left to override.
  return 'size-6 sm:size-6 rounded-sm';
}

export type RoundActionButtonKind =
  | 'send'
  | 'stop'
  | 'retry'
  | 'enqueue'
  | 'interject'
  | 'send-now';

/**
 * Per-kind fill for the round action button.
 *
 * `send` and `enqueue` are deliberately the SAME fill: enqueue is not a
 * demoted action, it is this turn's send with a delay, so giving it its own
 * colour would invent a distinction the behaviour does not have. Design system
 * v2 (§1 rule 7, open-claude-ui's composer) makes that fill the clay primary;
 * the near-black fill it replaces belonged to the retired Cursor reference.
 *
 * `stop` keeps the saturated red — a destructive-coloured Stop is an
 * established safety signal here and at most one is ever on screen. `retry`
 * and `send-now` are secondary: a neutral fill, no frame (§1 rule 1).
 *
 * These strings are applied ON TOP of the `Button` variant each kind already
 * uses, so they only need to restate what actually changes plus enough to be
 * self-describing as a contract.
 */
export function roundActionButtonKindClass(kind: RoundActionButtonKind): string {
  switch (kind) {
    case 'send':
    case 'enqueue':
    case 'interject':
      // Design system v2 §1 rule 7: the send key is the clay primary.
      return 'bg-primary text-primary-foreground hover:bg-primary/90';
    case 'stop':
      return 'bg-destructive text-destructive-foreground hover:bg-destructive/90';
    case 'retry':
    case 'send-now':
      // Frameless inside the composer (§1 rule 1): the neutral secondary fill.
      return 'bg-fill-neutral text-foreground hover:bg-fill-ghost-selected';
  }
}

// ---- Placeholder text ----

/** T-05: pending-question follow-up copy (A07 screen 6 group E — same lifecycle as the collapsed dock strip). */
export const PENDING_QUESTION_PLACEHOLDER = 'Add more optional details…';

/**
 * dsh-rebase P1-9e (decision 050): a chat from the previous version, which its
 * first send moves to the current engine before the message goes out — said
 * up front, because that first send takes a moment longer.
 */
export const MOVES_ON_SEND_PLACEHOLDER =
  'Send to continue — this chat moves to the current engine first';

/** dsh-rebase P1-9e: this window's resume is moving the chat right now. */
export const MIGRATING_SESSION_PLACEHOLDER = 'Moving this chat to the current engine…';

/**
 * A turn is running, so Enter joins this turn and Ctrl+Enter queues (decision
 * 203; it was the other way round until then). P1-7e e6
 * (problem 40, decision 145): it used to open with 「Agent Host 正在运行」,
 * the development name of the engine process, the same leftover as the
 * `Live Agent Host` decision 144 removed.
 */
export const TURN_RUNNING_PLACEHOLDER =
  'Turn in progress — Enter adds to this turn, Ctrl+Enter queues for after it…';

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
export function composerPlaceholder(
  input: {
    mode: MiddleColumnMode;
    canSend: boolean;
    busy: boolean;
    sending: boolean;
    hasSession: boolean;
    hasWorkspace: boolean;
    /**
     * T12-e: the resolved working directory. Separate from `hasWorkspace`
     * because a workspace can be present but not targetable (an empty path, so
     * a fake cwd can never reach spawn) — the state a fresh install is in.
     * Optional so callers that genuinely do not know keep their old behaviour
     * rather than silently claiming "no directory".
     */
    hasCwd?: boolean;
    /**
     * U05-b: this chat is unbound — it has no workspace and no cwd on purpose,
     * and gets an isolated directory on its first send. Suppresses the two
     * "finish setting up" rungs below, which would otherwise tell the user to
     * fix something that is not broken.
     */
    unbound?: boolean;
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
    /**
     * dsh-rebase P1-9e: a chat the previous engine wrote, which the next
     * resume moves to the current engine (`willMigrateOnResume`). A
     * prediction, so it only rewords the ordinary prompt; Main decides.
     */
    movesOnSend?: boolean;
    /**
     * dsh-rebase P1-9e: this window's resume is moving the chat to the
     * current engine right now (`selectIsMigrating`).
     */
    migrating?: boolean;
  },
  t: Translate = englishTranslate
): string {
  // Stop-hang fix (2026-08-10): computed up front so the `sending` branch can
  // stand DOWN for it. `sending` used to win outright, so a follow-up typed
  // during a turn was told "Sending to Agent Host…" when `decideSendAction`
  // had actually enqueued it (queueRelease.ts: any of busy/sending/inFlight
  // returns `'enqueue'`) — the placeholder claimed delivery for a message
  // that had not left the composer's own queue. Expressed as a stand-down
  // rather than a moved branch so the ONE case where `sending` still wins
  // stays visible: the m9 `hasWorkspace` gate below, where the queue cannot
  // release at all and promising "queued" would be the lie instead.
  // U05-b: an unbound chat has no workspace and can still release its queue —
  // its target is the isolated directory, so the "queue outlived its
  // workspace" case this guard exists for does not apply to it.
  const hasReleasableQueue =
    (input.queuedCount ?? 0) > 0 && (input.hasWorkspace || input.unbound === true);
  // P1-9e: first of all. A send waiting on the move would otherwise say
  // "Sending to Agent Host…" for as long as the move takes, and a move started
  // by the history card's Retry has no send to report at all.
  if (input.migrating) {
    return t(MIGRATING_SESSION_PLACEHOLDER);
  }
  if (input.sending && !hasReleasableQueue) {
    // Decision 156: the engine process's development name (`Agent Host`) no
    // longer reaches the screen, as problem 40 did for the running placeholder.
    if (input.isCreatingSession) {
      return t('Setting up the chat (first message only)…');
    }
    if (input.attachmentCount > 0) {
      return input.attachmentCount === 1
        ? t('Sending {{count}} attachment…', { count: input.attachmentCount })
        : t('Sending {{count}} attachments…', { count: input.attachmentCount });
    }
    return t('Sending…');
  }
  if (input.pendingQuestion) {
    return t(PENDING_QUESTION_PLACEHOLDER);
  }
  // m9 fix: `hasWorkspace` must gate this branch too — a queue can outlive
  // its workspace (a bucket is only pruned when its SESSION disappears, not
  // when the workspace backing it is removed), and without this guard the
  // placeholder keeps promising delivery ("type another follow-up…") for a
  // queue that can no longer release at all, masking the real blocker.
  // (`hasReleasableQueue` is that same condition, hoisted above for the
  // `sending` stand-down — same predicate, one definition.)
  if (hasReleasableQueue) {
    return t('Queued {{count}} — type another follow-up…', { count: input.queuedCount ?? 0 });
  }
  if (input.busy) {
    // The Ctrl+Enter affordance has no button of its own — it is a key on a
    // field the user is already typing in — so the busy copy is the only place
    // it can be discovered. Said here rather than globally: it names a key that
    // only does anything while a turn is running. P1-7e e6 (problem 40,
    // decision 145): it names the turn, not the process that runs it.
    return t(TURN_RUNNING_PLACEHOLDER);
  }
  // U28 removed a `!hasSession -> "Select a session in the left nav"` branch
  // here. It named a prerequisite that no longer exists: `runSend` creates the
  // conversation on the first send, so an empty composer with nothing selected
  // is ready to type into, and telling the user to go find something in the
  // sidebar first was the instruction that made a fresh install look broken.
  // `hasSession` stays in the input — the ladder below still distinguishes a
  // session that HAS a workspace problem from one that never existed.
  if (input.hasSession && !input.unbound && !input.hasWorkspace) {
    return t('Active session has no workspace…');
  }
  // T12-e: a workspace that is present but has no path fell through this
  // ladder to the terminal `Cannot send right now…`, i.e. the least
  // informative string in the function was what a FRESH INSTALL saw. Point at
  // the welcome card's button instead — the two now say the same thing.
  if (!input.unbound && input.hasCwd === false) {
    return t('Choose a working directory to start…');
  }
  if (input.canSend) {
    // P1-9e: only the ordinary prompt is reworded. Every rung above it names
    // something the user has to deal with first, which a legacy chat can meet
    // like any other (its workspace gone, a queue waiting).
    if (input.movesOnSend) return t(MOVES_ON_SEND_PLACEHOLDER);
    // Decision 144: no engine name (the 1.0.x prompt named Pi). Decision 174:
    // the home page docks in session mode but starts a conversation, so it
    // asks for the first message.
    return input.mode === 'session' && input.hasSession
      ? t('Send follow-up…')
      : t('Send a message…');
  }
  return t('Cannot send right now…');
}
