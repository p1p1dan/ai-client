/**
 * Turn-level class assembly for the chat timeline.
 *
 * Same discipline as `middleColumnLayout.ts`: every class string the turn
 * structure depends on lives in a `.ts` function so vitest's node environment
 * can assert it. One rule below is structural rather than cosmetic and is
 * asserted as a *prohibition*: the copy button must never be hover-only
 * (`opacity-0` + `group-hover:`), because a control only a mouse can discover
 * is unreachable by touch and by keyboard (§4.6).
 *
 * ## T12 (2026-08-29): the pinned bubble band and its whole dependency chain
 *
 * The timeline now follows pi-app's turn chrome (D9 rev.2 authorises taking its
 * structure and interaction wholesale, then dressing it in this repo's tokens).
 * Three things retired together, and the ORDER of causes matters because each
 * later one existed only to pay for the one before it:
 *
 *  1. `turnBubbleBandClass()` — the `position: sticky` band that pinned the
 *     user's prompt to the top of the scroll viewport. pi-app's timeline has no
 *     such band; the prompt is an ordinary row in the flow.
 *  2. the unconditional six-line clamp on the prompt (F10). Its own header
 *     stated its premise: the pinned-only clamp coupled *scroll position* to
 *     *layout height* and oscillated, and an unconditional clamp was the
 *     structural fix. With no sticky element left, that edge cannot form at
 *     all, so the clamp has nothing to prevent.
 *  3. the always-visible `Show more` toggle (FB3), which existed only to give
 *     back the prose the clamp took. Q15 (2026-08-23) accepted it staying
 *     visible under short prompts as the lesser evil; removing the clamp
 *     removes the choice.
 *
 * ⚠️ Known trade recorded rather than hidden: an extremely long pasted prompt
 * now renders at full height. pi-app accepts the same. If that turns out to be
 * a problem the fix is a clamp again — but it must NOT come back together with
 * a sticky band, or F10's oscillation comes back with it.
 *
 * ## Spacing arithmetic (asserted by F-B9)
 *
 * ```
 * ReadingColumn space-y-5  = 20   previous turn's end -> this turn's prompt
 * turn gap-2.5             = 10   prompt -> turn body
 * turn body gap-2.5        = 10   content segments / meta row (P-17)
 * ```
 *
 * The 20px turn-to-turn beat (A07 `:846`) is unchanged in total; only its
 * composition moved back to a single gap now that there is no band padding to
 * carry half of it. `chatTurnClass()` picks up the 10px that used to be the
 * band's bottom padding.
 */
import type { TurnStatusKind } from './turnStatus';

/**
 * `ReadingColumn`'s turn-to-turn spacing — the whole 20px beat, in one place.
 *
 * It was `space-y-2.5` while `turnBubbleBandClass()`'s `py-2.5` carried the
 * other half. The band is gone (see the header note), so leaving this at 2.5
 * would have silently halved the rhythm between turns.
 */
export function readingColumnSpacingClass(): string {
  return 'space-y-5';
}

/**
 * Per-turn `<section>`: the user's prompt row, then the turn body.
 *
 * `gap-2.5` is the 10px that used to be the bubble band's bottom padding — the
 * "prompt -> first content segment" beat, inherited unchanged.
 *
 * `group/turn` is the hover scope for `turnActionsSlotClass()` (T12-b). It is
 * NAMED rather than a bare `group` on purpose: tool rows and the thinking chain
 * inside this subtree run their own hover groups, and an anonymous one here
 * would be the nearest ancestor for some of them and change what they react to.
 */
export function chatTurnClass(): string {
  return 'group/turn flex flex-col gap-2.5';
}

/**
 * The row the user's prompt sits at the end of (pi-app `.timeline-user-row`,
 * whose only job is the right alignment).
 *
 * Lives here rather than inline in the `.tsx` for the reason stated in the head
 * note: node-environment suites can read a `.ts` return value, and they can
 * only read JSX through an AST walk that breaks whenever the element moves.
 */
export function userBubbleRowClass(): string {
  return 'flex justify-end';
}

/**
 * The prompt bubble itself (T12 — pi-app `.timeline-user-bubble`, retokenised).
 *
 * ## What changed and what deliberately did not
 *
 * pi-app draws this as `border-radius: 10px 2px 10px 10px` on a flat face, no
 * edge, capped at 80%. Adopted, with two adjustments:
 *
 *  - the radii are token steps, not raw pixels: `rounded-md` (12px, the
 *    design-system tier for containers ≥32px) plus `rounded-tr-xs` (4px) for
 *    the sharp corner. The corner MOVED — it used to be bottom-right; pi-app
 *    points it at the top-right, toward the composer edge the message came
 *    from, which is the messenger convention.
 *  - the `border-input` edge STAYS, against pi-app. F5 D3-c measured the face
 *    alone at 1.161 (light) / 1.292 (dark) against the timeline surface and the
 *    edge at 1.350 / 1.322; dropping the edge walks back toward the "the bubble
 *    is, in effect, not drawn" state that decision was taken to fix.
 *
 * `min-w-0` is not decoration and not interchangeable with the cap: this box is
 * a flex item, so its `min-width` resolves to `auto` (= min-content), and
 * `min-width` outranks `max-width`. One unbreakable run — a long URL, one long
 * word — pushes min-content past the cap, the cap is silently ignored, and the
 * bubble goes full width again for *some* content only, which is why review
 * never catches it. `break-words` on the paragraph is the other half.
 */
export function userBubbleClass(): string {
  return 'min-w-0 max-w-[80%] space-y-2 rounded-md rounded-tr-xs border border-input bg-accent px-3.5 py-2';
}

/**
 * The prompt text inside the bubble.
 *
 * `select-text` because `globals.css` sets `user-select: none` on `*`; without
 * it the operator's own prompt can only be copied through a button. `space-y-2`
 * is the paragraph rhythm for a multi-block prompt.
 *
 * The `expanded` parameter retired with the clamp it switched (see the head
 * note). Nothing geometric may be reintroduced here: this function must stay a
 * constant, because the moment its output depends on element geometry or scroll
 * offset, the `scroll position -> height -> scroll position` cycle F10 removed
 * has a place to re-form.
 */
export function userBubbleTextClass(): string {
  return 'select-text space-y-2';
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
 * The turn's process panel.
 *
 * FB4/FB6 retired `turnProcessPanelClass()` along with the Base UI
 * `Collapsible` it existed to neutralise: every class in it (`h-auto`,
 * `overflow-visible`, `transition-none duration-0`, the two `data-*-style`
 * overrides) was there to opt that component OUT of measuring and clipping the
 * panel's height. A plain `hidden` panel measures nothing, so there is nothing
 * left to undo — see `MessageTimeline`'s note on why Base UI could not drive
 * several panels from one外部 trigger.
 */
export function turnProcessShellClass(): string {
  return 'flex flex-col gap-2.5';
}

/**
 * The turn's status row: `Awaiting first token 8s`, `Stalled`, `Failed`, the
 * retry counter — i.e. the things that are only true WHILE the turn is running.
 *
 * §4.7 used to describe this as "one slot, two states" (status in flight,
 * `Worked for Ns · 2 tools` once complete). T12-b removed the second state:
 * a finished turn now says nothing about itself (see `turnMetaRowClass()`'s
 * retirement note below), so this row exists only while something is happening.
 * `PendingTurnHead` renders the identical shape for the window before the user
 * echo lands, which is why both paths now spell it the same way.
 *
 * `tabular-nums` keeps the second counter from jittering the row width as it
 * ticks; `min-w-0` lets the status text truncate rather than wrap, because a
 * row that can wrap can change HEIGHT every second underneath a
 * stick-to-bottom follower.
 */
export function turnHeadClass(): string {
  return 'flex min-w-0 items-center gap-1.5 text-meta tabular-nums text-muted-foreground';
}

/**
 * `turnMetaRowClass()` retired with the row it named (T12-b, user decision
 * 2026-08-29: "跟随 pi-app 删掉 meta").
 *
 * It carried four things at the end of every completed turn:
 * `Worked for 12s · 2 tools`, the model name, the relative time, and the copy
 * button. pi-app's timeline carries none of them — its `turn-chrome.tsx` and
 * `turn-footer.tsx` are empty modules with a note saying the strip was removed
 * on purpose — and it re-homes only what is an ACTION rather than a statistic:
 *
 *  - copy       -> `turnActionsSlotClass()` below, revealed on hover;
 *  - timestamp  -> the same strip, as bare `HH:MM`;
 *  - duration / tool count -> dropped outright (pi-app still COMPUTES a turn
 *    duration in `timeline-turn-timing.ts` and has no caller for it anywhere —
 *    checked, not assumed);
 *  - model name -> dropped from the timeline; the composer's model chip already
 *    answers "which model is this session on", which is the question a user
 *    actually asks.
 */

/**
 * The hover-revealed action strip at the end of a turn (T12-b — pi-app's
 * `.message-actions-slot`).
 *
 * ## This is a deliberate reversal of F-B15, not an oversight
 *
 * `turnCopyButtonClass()` used to carry a standing prohibition: the copy button
 * may never be hover-only, because a control only a mouse can discover is
 * unreachable by touch and by keyboard. **The user overruled that on 2026-08-29
 * in favour of matching pi-app exactly**, having been shown the cost. So the
 * rule is retired rather than quietly bent, and the cost is recorded here:
 * keyboard-only and touch-only users cannot reach Copy from the timeline.
 *
 * ## Mechanism
 *
 * `grid-rows-[0fr] -> [1fr]` is the animate-height-to-auto trick, taken from
 * pi-app verbatim. It matters that the collapsed state is a real ZERO-height
 * row rather than `opacity-0`: an always-present 28px strip under every turn
 * would spend the same vertical budget the meta row just gave back, which would
 * make this change cosmetic instead of actual. `motion-reduce:transition-none`
 * is ours, not pi-app's — the repo honours the OS setting everywhere else.
 */
export function turnActionsSlotClass(): string {
  return 'grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-150 ease-out group-hover/turn:grid-rows-[1fr] group-hover/turn:opacity-100 motion-reduce:transition-none';
}

/**
 * The strip's inner row — the grid item the `0fr` track has to be able to
 * squash.
 *
 * `overflow-hidden` + `min-h-0` are the two halves of that: the first clips the
 * content that no longer fits, the second removes the automatic minimum size a
 * grid item otherwise contributes to its track.
 *
 * ⚠️ **This row must never carry a fixed height.** A definite `height` on a grid
 * item is not squashable, so the `auto` half of the track's implied
 * `minmax(auto, 0fr)` resolves to that height and the collapsed strip stands at
 * full size with `opacity: 0` — present, invisible, and still spending its
 * vertical budget. It shipped that way for one build here (`h-7`, copied
 * straight from pi-app's `.message-actions-slot-inner`) and every class
 * assertion stayed green, because each individual class was exactly what the
 * spec called for. Measured in the browser: `grid-template-rows` resolved to
 * `28px`; dropping the fixed height took it to `0px`.
 *
 * The row's height therefore comes from its content — the 24px copy button —
 * which is also why the button's own `size-6` is load-bearing here.
 */
export function turnActionsInnerClass(): string {
  return 'flex min-h-0 items-center gap-1.5 overflow-hidden text-meta tabular-nums text-muted-foreground';
}

/**
 * Copy button: 24px ghost icon button, same tier as every other control in this
 * design system.
 *
 * The button itself is NOT hover-styled — it is fully opaque and clickable
 * whenever it exists. What hides it is its container
 * (`turnActionsSlotClass()`), which is a different claim and the reason this
 * string stays free of `opacity-0` / `group-hover:`: putting the reveal on the
 * control as well would mean two independent things had to agree before a
 * click could land.
 */
export function turnCopyButtonClass(): string {
  return 'inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-hover';
}

/**
 * The assistant's answer segment (T12 — pi-app renders reply prose bare).
 *
 * ## Why the box retired
 *
 * `turnAnswerContainerClass()` used to put one `rounded-sm border border-border
 * p-3.5` ring around each answer segment (F5 D3-b, user decision 2026-08-18).
 * It is gone. pi-app's timeline draws assistant prose with nothing around it at
 * all — the reading column and the vertical rhythm carry the structure — and
 * D9 rev.2 authorises taking that form.
 *
 * What makes it a considered change rather than a coin flip is FB4. Before FB4
 * the ring was ONE box per turn. After FB4 ("prose renders where it happened")
 * an interleaved turn — said something, ran a tool, said something else — grew
 * one ring per prose run, so a single reply could be three stacked boxes with
 * tool rows between them. Q14 recorded exactly that as a look question the
 * screenshots would have to settle; this is the settlement.
 *
 * ## The role split that replaces it — do not "unify" these
 *
 * Both roles still have to be told apart at a glance, and now they are told
 * apart by ASYMMETRY rather than by two kinds of box:
 *
 *  - user  -> a shaped object: right-aligned, capped at 80%, coloured face,
 *             one sharp corner (`userBubbleClass()`);
 *  - agent -> not an object at all: full reading width, no face, no edge.
 *
 * Giving the assistant side a face or a ring "for consistency" collapses both
 * into "everything is a card", which is the exact failure D3-b argued against —
 * it just arrives from the other direction. That is why there is no
 * `turnAnswerContainerClass()` left to edit: the answer segment mounts
 * `turnBodyClass()` and nothing else.
 */

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
