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
 * a problem the fix is a clamp again — but a *pinned-only* clamp must never
 * come back, for the reason spelled out in the next section.
 *
 * ## T096 (2026-09-19): sticky is allowed again, under one stated condition
 *
 * ⚠️ **PARTLY REVERSED by decision 033 (2026-09-22).** The grant below was made
 * for exactly one element — the THINKING block's fold header — and that element
 * no longer pins: the user reasoned that a pinned thought header and a pinned
 * process-group head would fight over the same `top-0` inside one stacking
 * context, and chose to keep the consideration header pinned instead (`D4`) and
 * give the thought row a prominent BACKGROUND LINE (`D3`). So the permission is
 * read back to one element again, and it is now the process-group head
 * (`turnWorkGroupSummaryClass()`).
 *
 * What does NOT change, and is why this section is kept rather than deleted:
 * **the condition.** F10's oscillation needs a cycle, and the cycle needs a
 * height change that is a FUNCTION OF SCROLL POSITION. All four links have to be
 * present:
 *
 * ```
 * scroll position -> "is it stuck?" -> layout height -> scrollHeight
 *      ^                                                     |
 *      +----- browser clamps scrollTop to the new maximum ---+
 * ```
 *
 * The retired user bubble band closed that loop with `@container scroll-state(stuck: top)`
 * + `line-clamp-3`: getting stuck removed three lines of height, the document
 * got shorter, the engine clamped `scrollTop` back below the sticky threshold,
 * the band un-stuck and grew again, and the bottom-follower pushed the offset
 * back — once per frame.
 *
 * A header whose height is the same number stuck and un-stuck cannot close it,
 * which is all either element ever needed to satisfy. Nothing it carries is
 * derived from scroll position — no `scroll-state()` query, no clamp, no
 * max-height, and the one decoration that DOES vary (the hairline) keys off
 * `data-panel-open`, i.e. a click, not an offset. A height change a user asked
 * for is not a cycle; it settles in one frame.
 *
 * So the rule stands, unchanged, and applies to whichever element holds the
 * pin: **a sticky element in this timeline may not change its own height as a
 * function of scroll state.** That is what `chatTimelineLayout.test.ts`'s
 * (rewritten) T096 group asserts, and it is the only thing that has to stay
 * true for F10 to stay dead.
 *
 * The retired machinery — `thoughtFoldHeaderClass()` and the collapse-time
 * scroll re-anchor it needed (`scrollPinnedFoldHeaderIntoView` /
 * `stickyFoldScrollTarget`) — went with the pin. Decision 028's problem (the
 * fold control scrolling out of reach while reading a long thought) is now
 * solved by bounding the thought BODY instead (`thoughtBodyMaxHeightClass()`),
 * which needs no scroll-position dependency at all.
 *
 * ## Spacing arithmetic (asserted by F-B9)
 *
 * ```
 * ReadingColumn space-y-5  = 20   previous turn's end -> this turn's prompt
 * turn gap-3               = 12   prompt -> the turn's own line (status / head)
 * turn body gap-2          = 8    that line -> the content it describes (P-17)
 * ```
 *
 * The 20px turn-to-turn beat (A07 `:846`) is unchanged in total, and it still
 * lives entirely in `ReadingColumn` — the band that used to carry half of it is
 * gone (see above), and nothing has been added back above the prompt.
 *
 * ## Why the two inner tiers are different numbers (user decision 2026-09-19)
 *
 * They were one number (10px) for as long as the turn had nothing between the
 * prompt and the reply. The work group put a LINE there — 「工作中 47 秒 …」
 * while the turn runs, the status row when something is wrong — and at equal
 * gaps above and below, that line is read as the tail of the prompt rather than
 * as the header of the output: 「状态行贴着用户气泡、离后续输出远」.
 *
 * So the two beats separate, both onto design-system tiers (12px loose / 8px
 * standard, `docs/design-system.md` 「间距规范」), and the asymmetry is the whole
 * point — the line is now nearer to what it is about than to what came before
 * it. Re-unifying them "for consistency" restores the defect.
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
 * `gap-3` is the 12px loose tier — the beat between the prompt and the first
 * thing the turn says about itself (the work-group head, or the status row).
 * It is deliberately WIDER than the within-turn tier below it; see the head
 * note's spacing arithmetic for what an equal pair did to that line.
 *
 * `group/turn` is the hover scope for `turnActionsSlotClass()` (T12-b). It is
 * NAMED rather than a bare `group` on purpose: tool rows and the thinking chain
 * inside this subtree run their own hover groups, and an anonymous one here
 * would be the nearest ancestor for some of them and change what they react to.
 */
export function chatTurnClass(): string {
  return 'group/turn flex flex-col gap-3';
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
 * Everything after the prompt: turn head, process shell, answer, footer.
 * `gap-2` is the 8px "within a turn" tier (P-17's slot; the number moved to the
 * standard tier on 2026-09-19, see the head note) and this function stays the
 * single source of it, inherited from the pre-T-31 `<article>` that
 * `AssistantMessage` used to own.
 */
export function turnBodyClass(): string {
  // `text-chat-body leading-normal` comes from that same article and is not
  // decoration: `QuestionCard`'s header row sets no size of its own and reads
  // the body scale by inheritance. Dropping it here would silently resize a
  // component nothing in this module names. The head and footer slots override
  // it on their own elements — the head with `text-ui`, the hover strip with
  // `text-meta` (D25 S24); see those two functions for why they differ.
  //
  // T104: this is a runtime-configurable token, so the process shell that
  // shares this class also inherits whatever the reader picked. That is
  // intended and harmless — `ToolRows`' two sites (`:124` / `:682`) declare
  // `text-chat-process` explicitly and therefore override the inherited value
  // on the rows that actually carry process text.
  return 'flex flex-col gap-2 text-chat-body leading-normal';
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
 *
 * ⚠️ The Base UI `Collapsible` is still the wrong component here, and for a
 * SECOND reason the 2026-09-18 work group had to re-check: its panel class
 * (`COLLAPSIBLE_PANEL_BASE_CLASS` in `ui/collapsible.tsx`) carries
 * `overflow-hidden`, and `overflow` on an ancestor creates a containing block.
 * That is the standing prohibition this file has carried since T-31 and it is
 * why the group is a native `<details>`.
 */
export function turnProcessShellClass(): string {
  // Pinned to `turnBodyClass()`'s gap rather than spelled independently: the
  // shell stacks process rows INSIDE one turn-body slot, so a second number
  // here would read as a third tier nobody chose.
  return 'flex flex-col gap-2';
}

/**
 * ## The three-tier reading ladder (user decision 2026-09-18)
 *
 * The user's complaint was not that the transcript showed too little — it was
 * that everything on it shouted equally: 「用户真实关注的其实只是模型输出，而不是
 * 那些什么思考和终端」. So brightness now encodes importance, in three steps, and
 * the three functions below are the only places those steps are named.
 *
 * Measured contrast against each theme's `--background` (oklch → linear sRGB →
 * WCAG relative luminance; the middle rung reproduces the 7.20 / 6.70 pair this
 * file already recorded for `turnStatusToneClass`, which is what says the
 * arithmetic is right):
 *
 * ```
 *                      light   dark    role
 * text-foreground      18.78   11.38   answer text
 * text-muted-foreground 7.20    6.70   the work-group head, and mid-turn prose
 * text-tool-arg         5.09    5.02   thinking / terminal rows inside it
 * ```
 *
 * Every rung clears WCAG AA for body text (4.5) on its own; the point of the
 * table is the RATIOS between them — 1.70× then 1.33× in dark, which is the
 * narrower of the two themes. No new colour token was minted for this: all
 * three already existed, `--tool-arg` being the derived third grey T-05
 * introduced for tool-row arguments.
 */

/** Tier 1 — ordinary answer text. */
export function turnAnswerToneClass(): string {
  return 'text-foreground';
}

/**
 * Tier 2 — intermediate prose inside the process group. No italics — Chinese
 * readability.
 */
export function turnIntermediateToneClass(): string {
  return 'text-muted-foreground';
}

/**
 * Decision 033 D1: the hairline + label that separates the turn's process group
 * from its FINAL reply.
 *
 * It exists because the extraction has to be VISIBLE. The user's own words for
 * the shape were 「确定流式完毕后，输出分割线，把最终输出提出折叠头」 — the divider
 * is named there as part of the mechanism, not as decoration. Without it, a
 * reply that pops out of an already-open group reads as content moving for no
 * reason; with it, the single structural change a turn makes announces itself.
 *
 * Rendered only when a `finalAnswer` section actually exists, which is exactly
 * when `splitTurnWorkGroup` was given `settled: true` AND found an answer with no
 * process after it. So it cannot appear mid-stream, and a settled turn that ends
 * on a tool call or an error notice has none — correctly, since nothing was
 * extracted for it to announce.
 *
 * No `bg-*` and no `sticky`: it is a separator in the flow. Keeping it
 * non-sticky is what leaves `turnWorkGroupSummaryClass()` the timeline's single
 * pinned element, which is the property the rewritten T096 group asserts.
 */
export function turnFinalAnswerDividerClass(): string {
  return 'flex min-w-0 items-center gap-2 pt-1 text-meta text-muted-foreground';
}

/**
 * Tier 3 — thinking and terminal rows. Dimmer than the head that summarises them. */
export function turnProcessToneClass(): string {
  return 'text-tool-arg';
}

/**
 * How tall a thinking block's BODY may get before it scrolls internally
 * (decision 033 D3's replacement for a pinned fold header).
 *
 * ## Why `46vh` and not a pixel tier
 *
 * The value is the Bash-family output window (`toolCard.outputMaxHeightClass()`),
 * reused rather than invented: the two are the same kind of surface — a long,
 * read-only transcript the reader scrolls inside the timeline — and a second
 * height for the same job would be two answers to one question.
 *
 * Viewport-relative rather than the fixed 240px `INPUT_MAX_HEIGHT_CLASS` or the
 * 288px `max-h-72` diff window, and that is the load-bearing part: a thought can
 * be arbitrarily long, so what the bound really decides is "how much of the
 * reading column may this one block occupy". In pixels that share grows as the
 * viewport shrinks — on a short window a fixed 288px block can push its own
 * header (and the next rows) off screen entirely, which is the defect this
 * function exists to prevent. A `vh` bound keeps the share constant, and it
 * also stays off the `max-h-72` value the subagent panel and diff preview
 * already occupy, so the three windows remain distinguishable by role.
 *
 * ⚠️ `overflow-y-auto` is part of the contract, not decoration: a `max-height`
 * without it CLIPS the tail of a long thought, which is worse than the unbounded
 * body it replaced. The pair is applied to the thought body alone — tool output,
 * diffs and the subagent panel keep their own windows (`ToolRowOutputSegment`).
 */
export function thoughtBodyMaxHeightClass(): string {
  return 'max-h-[46vh] overflow-y-auto';
}

/**
 * Tier 2 — a process group's head: 「已处理 10 个步骤」 plus the chevron, and
 * since T113 (2026-09-21) that is ALL it ever says.
 *
 * It used to carry the turn's own clock and totals too — 「工作中 47 秒 · ↑ 12.0k
 * tokens · ↓ 1.3k tokens · 思考 20 秒」 running, 「已工作 57 秒」 settled — but
 * only on whichever group happened to be last, so two scopes wore the same
 * line. Those figures moved to `turnWorkZoneClass()` below. The SIZE ruling
 * recorded here did not move with them; see that function for why it applies
 * to both.
 *
 * `list-none` + `marker:content-none` strips the `<summary>` disclosure
 * triangle, which points the wrong way in half the browsers that draw it and
 * cannot be styled; the chevron beside the text is the affordance instead.
 * `cursor-pointer` because a `<summary>` does not get one by default.
 *
 * `text-ui` (14px) — raised from `text-meta` (13px) by user decision
 * 2026-09-19, together with `turnHeadClass()` below, which is the same line in
 * its other shape. The two must move together or the turn appears to change
 * type size when a work group forms mid-turn.
 *
 * ⚠️ Registered deviation from `docs/design-system.md`'s Typography table,
 * which files a status line under `meta`. The tier that table describes is
 * passive chrome — timestamps, footers, the app's own status bar — read once or
 * not at all. THIS line is what the reader watches for the whole length of a
 * wait (it is often the only thing on screen for 20s), and at 13px it was
 * reported as too small to be that. It stays a token, not an arbitrary value,
 * so the domain scale still owns the number.
 *
 * `tabular-nums` joined it on 2026-09-18, when the head started carrying a
 * ticking clock: the same reason `turnHeadClass()` below has always had it, and
 * the same defect it prevents — a proportional `1` makes the row re-measure
 * every second underneath a stick-to-bottom follower.
 *
 * ## 2026-09-22 (decision 033 D4, revised same day): pinned, not painted
 *
 * The user's report was 「有时候内容多了根本找不到折叠头」, and the pin is the
 * whole of the answer. The accent face D4 also asked for was BUILT and then
 * withdrawn by the same user on sight: 「还是和工具调用一样吧，工具头也是，这个
 * 背景块太丑了」. So the row keeps `sticky top-0 z-10` and gives up
 * `bg-accent` + `border` + `rounded-sm` + horizontal padding.
 *
 * **`sticky top-0 z-10`** is the direct fix for "cannot find it". This is now
 * the timeline's ONE pinned element (D3 took the pin off the thought header,
 * whose `sticky top-0 z-10` was competing for the same slot), so the stacking
 * argument in the head note is unchanged — the competition is still scoped to
 * the scrollport's own stacking context, and the docks, the jump-to-bottom
 * button and `ChatWorkspace`'s overlay all live outside it.
 *
 * ⚠️ **The pin is legal for exactly one reason**: this row's height does not
 * vary with scroll state. It is the same string pinned and unpinned, and it
 * carries no `scroll-state()` query, no clamp, no max-height. That is F10's
 * second link and its absence is what keeps the oscillation unreachable — see
 * the head note, which also records why the pin cannot simply be moved to an
 * element that clamps itself.
 *
 * **`bg-background` is the one thing the pin still requires, and it is not
 * decoration.** A transparent sticky row lets the rows it is stuck over show
 * THROUGH it, which is the user's own standing ruling against
 * (「吸顶后不得出现内容穿插在折叠按钮后面」). `--background` is the surface the
 * timeline already paints, so the band is opaque without reading as a block —
 * exactly what 「太丑了」 ruled out. Do not "simplify" it away: the defect it
 * prevents only appears while scrolling a long group, which is the one state
 * a static render never enters.
 *
 * No `px-*`: with no visible face left, horizontal padding would only push the
 * head's text out of alignment with the prose column under it.
 *
 * Deliberately NOT added: any `h-*` or `shrink-0`. The row's intrinsic height
 * already satisfies the height rule, and pinning a pixel height would make the
 * head a different height from `turnHeadClass()`, its other shape.
 */
export function turnWorkGroupSummaryClass(): string {
  return `sticky top-0 z-10 ${TURN_CLOCK_ROW_BASE} cursor-pointer list-none marker:content-none`;
}

/**
 * The same row when there is nothing to fold behind it (decision 037).
 *
 * The turn's duration sits at the TOP of the turn in every case — 「什么情况都
 * 让 已工作 x 分 xx 秒 落在顶部」 — but a head only exists where a group folds,
 * and T112 refuses a fold below two steps. This is that line for the turns
 * T112 leaves headless. Every class that has a LOOK comes from the shared
 * constant below, so the two cannot drift: 「那样展示出来的风格都不统一」 is the
 * failure this construction exists to make impossible.
 *
 * ⚠️ **It is NOT pinned, and that is not an oversight.** T096 allows exactly one
 * sticky surface in the timeline (see `chatTimelineLayout.test.ts` and the F10
 * oscillation note at the top of this file), and the pin buys this row nothing:
 * it heads a group of at most one step, so there is no long body to scroll past
 * while keeping the clock in view. `sticky` / `z-10` change nothing about how
 * the line LOOKS when it is not stuck, so the unified appearance is intact.
 */
export function turnClockRowClass(): string {
  return TURN_CLOCK_ROW_BASE;
}

/**
 * ⚠️ Shared by the two functions above and by nothing else. Edit it, not them:
 * a change made to one call site instead of here is how the folded and the
 * unfolded turn start looking like different products.
 *
 * Holds every class that AFFECTS THE LOOK. The pin (`sticky top-0 z-10`) is
 * deliberately outside it — see `turnClockRowClass` for why only one of the two
 * carries it.
 */
const TURN_CLOCK_ROW_BASE =
  'flex min-w-0 items-center gap-1.5 bg-background py-1 text-ui tabular-nums text-muted-foreground';
/**
 * The turn's status row: `Awaiting first token 8s`, `Stalled`, `Failed`, the
 * retry counter — i.e. the things that are only true WHILE the turn is running.
 *
 * §4.7 used to describe this as "one slot, two states" (status in flight,
 * `Worked for Ns · 2 tools` once complete). T12-b removed the second state on
 * the ground that a finished turn should say nothing about itself at all
 * (pi-app's model — see `turnMetaRowClass()`'s retirement note below).
 *
 * T113 (2026-09-21, user decision) reverses that ground but NOT this row. A
 * finished turn does describe itself again — 「已工作 54 秒 · 完成于 17:05 · 8
 * 次工具调用 · 思考 12 秒」 — because the user named those four figures. They
 * live on `turnWorkZoneClass()` below, a row of their own, rather than coming
 * back here: this slot is owned by `deriveTurnStatus`, whose whole vocabulary
 * is about a turn in trouble or in flight, and giving it a settled state again
 * would re-merge two questions T12-b was right to separate. So this row still
 * exists only while something is happening. `PendingTurnHead` renders the
 * identical shape for the window before the user echo lands, which is why both
 * paths spell it the same way.
 *
 * `tabular-nums` keeps the second counter from jittering the row width as it
 * ticks; `min-w-0` lets the status text truncate rather than wrap, because a
 * row that can wrap can change HEIGHT every second underneath a
 * stick-to-bottom follower.
 *
 * `text-ui` for the reason recorded on `turnWorkGroupSummaryClass()` above,
 * including the recorded deviation: this row and that one are the same line in
 * two shapes and share one size.
 */
export function turnHeadClass(): string {
  return 'flex min-w-0 items-center gap-1.5 text-ui tabular-nums text-muted-foreground';
}

/**
 * The turn's WORK ZONE row (T113, user decision 2026-09-21): one line pinned
 * after the turn's last paragraph. 「✻ 工作中 47 秒 · 读取中」 while it runs,
 * 「✻ 已工作 54 秒 · 完成于 17:05 · 8 次工具调用 · 思考 12 秒」 once it stops.
 *
 * Same three classes as `turnHeadClass()` above, and they are the same three on
 * purpose rather than by copy-paste:
 *
 *  - `text-ui` — this row INHERITED the job the 2026-09-19 decision raised the
 *    head to 14px for: it is what the reader watches for the whole length of a
 *    wait, and 13px was reported as too small to be that. The registered
 *    deviation from `docs/design-system.md`'s Typography table (which files a
 *    status line under `meta`) is recorded on `turnWorkGroupSummaryClass()` and
 *    covers this row for the same reason. The three must move together or the
 *    turn appears to change type size between its head and its tail.
 *  - `tabular-nums` — the row ticks once a second while the turn runs, and a
 *    proportional `1` re-measures the row underneath a stick-to-bottom
 *    follower.
 *  - `min-w-0` — the settled line carries four clauses and has to truncate
 *    rather than wrap, because a row that wraps changes HEIGHT under that same
 *    follower.
 *
 * No `overflow-hidden` and no height: it sits inside the turn body's own gap
 * (`turnBodyClass()`), and the standing prohibition on creating a containing
 * block above `position: sticky` applies to every row in this chain.
 */
export function turnWorkZoneClass(): string {
  return 'flex min-w-0 items-center gap-1.5 text-ui tabular-nums text-muted-foreground';
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
 *
 * ## Where those four stand after 2026-09-21 (T113 / T114)
 *
 * Three of the four came back, and NOT to this row — they are on
 * `turnWorkZoneClass()` above, which is always visible:
 *
 *  - duration and tool count are two of the four figures the user named for
 *    it, which reverses "dropped outright" (the pi-app precedent stands as a
 *    fact about pi-app; it stopped being this app's ruling);
 *  - the timestamp moved OFF the hover strip and onto that row too (T114), so
 *    it is read without a pointer. The strip is copy and nothing else now,
 *    which is what T12-b said it re-homes — an ACTION rather than a statistic;
 *  - the model name is the one that stayed dropped, for its original reason.
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
 * ## Mechanism — and why it is the OPPOSITE of what T12-b shipped
 *
 * The strip reserves its height at all times and only fades in. Hovering a turn
 * therefore changes nothing about the layout: the row below stays exactly where
 * it was.
 *
 * T12-b shipped the other choice — `grid-rows-[0fr] -> [1fr]`, pi-app's
 * animate-height-to-auto trick — and argued for it explicitly: a strip that
 * always occupies its height spends the vertical budget removing the meta row
 * had just given back. **The user overruled that on 2026-08-30**, having seen
 * it in the running app: growing a row under the cursor shoves everything below
 * it down, and reading text that jumps as the mouse moves across it is worse
 * than 24px of permanent whitespace. So the earlier reasoning is not wrong
 * about the cost — it just weighed a cost the user does not accept paying.
 *
 * Concretely: the collapsed strip is now 24px tall and transparent, and
 * `turnActionsInnerClass()` is REQUIRED to carry that definite height (see its
 * note, which used to prohibit exactly that).
 *
 * No `pointer-events-none` on the transparent state, deliberately. It looks
 * like the obvious companion to `opacity-0` and it would be dead weight: the
 * pointer cannot reach an invisible strip without first entering the turn, and
 * entering the turn is what makes it visible. The state "transparent and
 * clickable" is unreachable.
 *
 * `motion-reduce:transition-none` is ours, not pi-app's — the repo honours the
 * OS setting everywhere else.
 */
export function turnActionsSlotClass(): string {
  return 'opacity-0 transition-opacity duration-150 ease-out group-hover/turn:opacity-100 motion-reduce:transition-none';
}

/**
 * The strip's inner row.
 *
 * ⚠️ **This row must carry a definite height, and it must equal the button's.**
 * That is a straight reversal of the prohibition that stood here until
 * 2026-08-30, and the history is worth keeping because both halves were true at
 * different times:
 *
 *  - Under T12-b's `grid-rows-[0fr]` collapse, a definite height was a DEFECT.
 *    A grid item with a fixed height is not squashable, so the `auto` half of
 *    the implied `minmax(auto, 0fr)` resolved to it and the "collapsed" strip
 *    stood at full size, invisible but still spending its space. It shipped
 *    that way for one build (`h-7`, copied from pi-app) with every class
 *    assertion green — measured in the browser at `28px`, `0px` once the height
 *    came off.
 *  - Under the reserved-space strip the user asked for, a definite height is
 *    the REQUIREMENT. Height that comes from content is height that appears
 *    when the content does, and the transparent strip has to occupy the same
 *    space as the visible one or the hover still moves the page.
 *
 * `h-6` is 24px, the copy button's own `size-6`. Those two numbers are one
 * number: if the button tier ever changes, this must change with it, or the
 * strip either clips the button or reserves more room than it needs.
 *
 * `overflow-hidden` and `min-h-0` retired with the `0fr` track — they existed
 * only to make that track clip rather than merely shrink.
 *
 * It keeps `text-meta` while the turn's status line moved to `text-ui`
 * (2026-09-19). Not an oversight: what this row carries is a wall clock and a
 * copy button — the meta tier's own examples, read once if at all — and it must
 * stay inside `h-6`, which is the copy button's tier, not a type decision.
 */
export function turnActionsInnerClass(): string {
  return 'flex h-6 items-center gap-1.5 text-meta tabular-nums text-muted-foreground';
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
