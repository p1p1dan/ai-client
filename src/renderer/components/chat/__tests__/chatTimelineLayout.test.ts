import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COLLAPSIBLE_PANEL_BASE_CLASS } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import * as layout from '../chatTimelineLayout';
import {
  chatTurnClass,
  readingColumnSpacingClass,
  thoughtFoldHeaderClass,
  turnActionsInnerClass,
  turnActionsSlotClass,
  turnAnswerToneClass,
  turnBodyClass,
  turnCopyButtonClass,
  turnHeadClass,
  turnProcessShellClass,
  turnProcessToneClass,
  turnStatusToneClass,
  turnWorkGroupSummaryClass,
  userBubbleClass,
  userBubbleRowClass,
  userBubbleTextClass,
} from '../chatTimelineLayout';
import { TIMELINE_PADDING_CLASS } from '../middleColumnLayout';
import { stripComments } from './stripComments';

/** A source file on the thought row's ancestor chain, comments blanked. */
function readSource(relative: string): string {
  const file = fileURLToPath(new URL(`../${relative}`, import.meta.url));
  return stripComments(readFileSync(file, 'utf8'), file);
}

/**
 * Every whitespace-separated token inside every quoted literal of a source
 * file.
 *
 * Tokenised rather than regex-matched against the raw text, because the
 * obvious form of that regex (`"…\ssticky\s…"`) silently misses the case that
 * matters most — a class string that BEGINS with the banned token, e.g.
 * `className="sticky top-0"`. Splitting first removes the position from the
 * question entirely.
 */
function classTokens(source: string): string[] {
  return [...source.matchAll(/["'`]([^"'`\n]*)["'`]/g)].flatMap(([, body]) =>
    body.split(/\s+/).filter(Boolean)
  );
}

/** `sticky`, `fixed`, and any variant-prefixed form of either (`md:sticky`). */
const PIN_TOKEN = /(?:^|:)(?:sticky|fixed)$/;

/** The four properties that switch `position: sticky` off, or re-parent it. */
const CLIPPING_PATTERNS: readonly [string, RegExp][] = [
  ['overflow', /(?:^|\s)overflow-/],
  ['transform', /(?:^|\s)(?:transform|translate-|scale-|rotate-)/],
  ['filter', /(?:^|\s)(?:filter|blur-|backdrop-)/],
  ['contain', /(?:^|\s)contain-/],
];

/** Tailwind's spacing scale: one step is 4px (`py-2.5` -> 10px). */
const SPACING_STEP_PX = 4;

/** Pull the numeric step off a `<prefix>-<n>` utility, e.g. `py-2.5` -> 2.5. */
function spacingStep(classes: string, prefix: string): number {
  const match = new RegExp(`(?:^|\\s)${prefix}-([0-9]+(?:\\.[0-9]+)?)(?:\\s|$)`).exec(classes);
  if (!match) throw new Error(`no \`${prefix}-*\` utility in: ${classes}`);
  return Number(match[1]);
}

function spacingPx(classes: string, prefix: string): number {
  return spacingStep(classes, prefix) * SPACING_STEP_PX;
}

/**
 * T096 (decision 028) replaces T12's blanket "the timeline pins nothing" rule.
 *
 * ## What the old rule was, and why it is not the lesson
 *
 * T12 retired `turnBubbleBandClass()` — the `position: sticky` band that pinned
 * the user's prompt — and this group used to forbid `sticky` outright, on the
 * grounds that bringing one back would bring F10's oscillation back with it.
 * That was the cheap way to be certain, not the accurate way. F10 needs a
 * CYCLE, and the cycle needs one specific link: a height that is a function of
 * scroll state.
 *
 * ```
 * stuck? -> height -> scrollHeight -> browser clamps scrollTop -> stuck?
 * ```
 *
 * The retired band closed it with `scroll-state(stuck: top)` + `line-clamp-3`.
 * The thought fold header cannot: its height is identical pinned and unpinned,
 * nothing it carries reads a scroll offset, and the only thing that varies
 * about it keys off `data-panel-open` — a click, which settles in one frame.
 *
 * ## The rule that replaces it
 *
 * **A sticky element in this timeline may not change its own height as a
 * function of scroll state, and there may be exactly one of them.** The turn
 * chrome is still not allowed to pin itself; what changed is that the thought
 * fold header now is, by name.
 */
describe('T096: one pinned surface, and its height never moves with the scroll', () => {
  it('T12: no turn-level class assembler carries a sticky/fixed hook', () => {
    for (const cls of [
      chatTurnClass(),
      userBubbleRowClass(),
      userBubbleClass(),
      userBubbleTextClass(),
      turnBodyClass(),
      turnHeadClass(),
      turnActionsSlotClass(),
      turnActionsInnerClass(),
    ]) {
      expect(
        cls,
        `only the thought fold header may pin; the turn chrome may not: ${cls}`
      ).not.toMatch(/(?:^|\s)(?:sticky|fixed)(?:\s|$)/);
      expect(cls).not.toMatch(/(?:^|\s)z-\d+(?:\s|$)/);
    }
  });

  /**
   * Exactly one, and it is the thought header. The scan is over every zero-arg
   * export of this module plus the two `.tsx` files that render the chain, so
   * a second pinned element cannot be added anywhere on it without landing
   * here — which is the half of the rule that "the turn chrome is clean" does
   * not cover.
   */
  it('the thought trigger is the only sticky surface in the timeline', () => {
    const pinned = Object.entries(layout)
      .filter(([, value]) => typeof value === 'function' && value.length === 0)
      .map(([name, value]) => [name, (value as () => string)()] as const)
      .filter(([, cls]) => /(?:^|\s)(?:sticky|fixed)(?:\s|$)/.test(cls))
      .map(([name]) => name);
    expect(pinned).toEqual(['thoughtFoldHeaderClass']);

    // …and no inline class string on the chain pins anything either. Every file
    // is scanned with comments blanked, so the prose above (and in the modules
    // themselves) explaining WHY sticky is allowed cannot satisfy the scan.
    for (const relative of ['ToolRows.tsx', 'MessageTimeline.tsx', 'ReadingColumn.tsx']) {
      const offenders = classTokens(readSource(relative)).filter((token) => PIN_TOKEN.test(token));
      expect(
        offenders,
        `${relative}: the pin belongs in thoughtFoldHeaderClass(), not in a class literal`
      ).toEqual([]);
    }
    // The one legal reference: `ToolRows.tsx` reaches the pin by calling the
    // function above, on the thinking-body condition and nothing else.
    const toolRows = readSource('ToolRows.tsx');
    expect(toolRows).toContain("view.body === 'thinking'");
    expect(toolRows).toContain('pinsHeader && thoughtFoldHeaderClass()');
  });

  /**
   * The user's ruling was 「不要透视效果，吸顶后不得出现内容穿插在折叠按钮后面」.
   * A `backdrop-blur` is still see-through, and an `/NN` alpha suffix is
   * see-through by definition — so both are banned, and the background has to
   * be a theme token rather than a literal colour so the two themes stay one
   * decision.
   */
  it('the sticky thought trigger has an opaque themed background and no backdrop filter', () => {
    const cls = thoughtFoldHeaderClass();
    expect(cls).toContain('bg-background');
    expect(cls, 'a translucent background IS the defect, not the feature').not.toMatch(
      /bg-\S+\/\d/
    );
    expect(cls, 'a blur is still see-through').not.toMatch(/backdrop-|blur-/);
    expect(cls, 'no raw colour: the header must follow the theme token').not.toMatch(
      /bg-(?:white|black|\[)/
    );
    // Pinned above its own body, and nothing else — see the function's note on
    // why the competition is scoped to the scrollport's stacking context.
    expect(cls).toMatch(/(?:^|\s)sticky(?:\s|$)/);
    expect(cls).toMatch(/(?:^|\s)top-0(?:\s|$)/);
    expect(cls).toMatch(/(?:^|\s)z-10(?:\s|$)/);

    // The height half of the T096 rule, as a prohibition. Anything here that
    // could resize the header — a clamp, a height cap, a scroll-state query —
    // re-opens F10 even though the class itself looks harmless.
    for (const banned of ['line-clamp', 'max-h-', 'min-h-', 'h-[', 'scroll-state']) {
      expect(cls, `height must not vary under the pin: ${banned}`).not.toContain(banned);
    }
    // The hairline is gated on OPEN, never on stuck: `data-panel-open` is a
    // click's state, so the 1px it adds is not in any scroll feedback loop.
    expect(cls).toContain('data-panel-open:border-b');
    expect(cls).toContain('data-panel-open:border-border');
  });

  /**
   * `position: sticky` dies silently. Any `overflow` / `transform` / `filter` /
   * `contain` on an element BETWEEN the header and the scroll viewport either
   * switches it off or re-parents it onto a scrollport the reader never sees —
   * with every other assertion in this file still green.
   *
   * The chain, viewport-first:
   *
   * ```
   * ScrollArea Viewport   overflow: scroll (inline, base-ui) — the scrollport
   *   TIMELINE_PADDING_CLASS
   *     ReadingColumn
   *       <section chatTurnClass()>
   *         <div turnBodyClass()>
   *           <details turnBodyClass()>            the work group
   *             <div turnProcessShellClass()>
   *               <div turnProcessShellClass() + turnBodyClass()>  process segment
   *                 <div "flex flex-col gap-1">    ToolGroup
   *                   <div data-slot="collapsible">
   *                     <button> <- the pinned header
   * ```
   */
  it('no ancestor between the thought row and the scroll viewport clips overflow or transforms', () => {
    const chain: readonly [string, string][] = [
      ['TIMELINE_PADDING_CLASS', TIMELINE_PADDING_CLASS],
      ['readingColumnSpacingClass', readingColumnSpacingClass()],
      ['chatTurnClass', chatTurnClass()],
      ['turnBodyClass', turnBodyClass()],
      ['turnProcessShellClass', turnProcessShellClass()],
      ['turnProcessToneClass', turnProcessToneClass()],
      ['turnWorkGroupSummaryClass', turnWorkGroupSummaryClass()],
    ];
    for (const [name, cls] of chain) {
      for (const [property, pattern] of CLIPPING_PATTERNS) {
        expect(cls, `${name} must not introduce ${property}: ${cls}`).not.toMatch(pattern);
      }
    }

    // The two inline wrappers `ToolRows.tsx` puts above a row. Pinned as exact
    // strings on purpose: an editor who adds `overflow-hidden` to either breaks
    // the `toContain` first and has to read this note before re-stating it.
    const toolRows = readSource('ToolRows.tsx');
    for (const wrapper of ['flex flex-col gap-1', 'ml-0.5 border-l border-border pl-3.5']) {
      expect(toolRows, `ToolRows.tsx no longer wraps rows in: ${wrapper}`).toContain(
        `"${wrapper}"`
      );
      for (const [property, pattern] of CLIPPING_PATTERNS) {
        expect(wrapper, `the row wrapper must not introduce ${property}`).not.toMatch(pattern);
      }
    }

    // The panel below DOES clip (`overflow-hidden` is how base-ui animates its
    // height), which is exactly why the header is its SIBLING and not inside
    // it. This is the assertion that keeps the trigger outside the panel.
    expect(COLLAPSIBLE_PANEL_BASE_CLASS).toContain('overflow-hidden');
    const triggerOpen = toolRows.indexOf('<CollapsibleTrigger');
    const triggerClose = toolRows.indexOf('</CollapsibleTrigger>');
    const panelOpen = toolRows.indexOf('<CollapsibleContent');
    expect(triggerOpen).toBeGreaterThan(-1);
    expect(triggerClose, 'the trigger must close before the clipping panel opens').toBeLessThan(
      panelOpen
    );

    // The scrollport itself: base-ui sets `overflow: scroll` inline, so the
    // only thing this repo could break is adding a clip of its own — and the
    // fade has to stay bottom-only, because a top mask would wash out the very
    // header being pinned.
    const scrollArea = stripComments(
      readFileSync(fileURLToPath(new URL('../../ui/scroll-area.tsx', import.meta.url)), 'utf8'),
      'scroll-area.tsx'
    );
    expect(scrollArea).not.toContain('overflow-hidden');
    expect(readSource('MessageTimeline.tsx')).toContain('scrollFade="bottom"');
  });
});

describe('chatTurnClass (F-B10)', () => {
  // Not a sticky prohibition any more (T12) — a clipping one. The turn contains
  // markdown whose wide code blocks and tables scroll at their own leaves; an
  // `overflow-*` here clips them instead, silently.
  it('F-B10: the per-turn section never clips its own content', () => {
    const cls = chatTurnClass();
    expect(cls).not.toContain('overflow-hidden');
    expect(cls).not.toMatch(/overflow-/);
    expect(cls).not.toMatch(/(?:^|\s)contain-/);
    expect(cls).not.toMatch(/transform/);
  });

  // The prompt -> turn body beat. It was 10px (the retired band's bottom
  // padding, inherited whole); on 2026-09-19 it moved to the 12px loose tier so
  // the turn's own line stops reading as the tail of the prompt above it.
  it('F-B10: owns the 12px prompt-to-body beat', () => {
    expect(spacingPx(chatTurnClass(), 'gap')).toBe(12);
    expect(chatTurnClass()).not.toMatch(/(?:^|\s)space-y-/);
  });
});

describe('turn spacing arithmetic (F-B9)', () => {
  /**
   * The 20px turn-to-turn beat (A07 :846) is unchanged in TOTAL across T12 —
   * only its composition moved back. T-31 had split it into 10px of
   * `ReadingColumn` gap plus 10px of sticky-band top padding; with the band
   * gone, `space-y-2.5` alone would have silently HALVED the rhythm between
   * turns, and nothing else in the suite would have noticed. That regression is
   * the whole reason this assertion is written as an absolute number rather
   * than as a relation between two live values.
   */
  it('F-B9: the whole 20px turn-to-turn beat lives in ReadingColumn', () => {
    expect(spacingPx(readingColumnSpacingClass(), 'space-y')).toBe(20);
  });

  /**
   * …and the three beats have to stay a strictly descending ladder, or the
   * structure stops being readable at a glance: turns must separate more than
   * the parts of one turn do, and the prompt must separate from the turn's own
   * line more than that line does from the output it is about.
   *
   * The third rung is the 2026-09-19 change. It used to be "prompt-to-body IS
   * the within-turn tier" — one number for both — and at that equality the
   * status / work-group line read as the tail of the user's bubble rather than
   * as the header of the reply (the user's report). So this asserts the ORDER,
   * plus each tier's absolute number so a failure names which one moved.
   */
  it('F-B9: the three beats descend — 20 between turns, 12 to the turn line, 8 inside', () => {
    const between = spacingPx(readingColumnSpacingClass(), 'space-y');
    const toTurnLine = spacingPx(chatTurnClass(), 'gap');
    const within = spacingPx(turnBodyClass(), 'gap');
    expect(between).toBe(20);
    expect(toTurnLine).toBe(12);
    expect(within).toBe(8);
    expect(between).toBeGreaterThan(toTurnLine);
    expect(toTurnLine).toBeGreaterThan(within);
  });
});

/**
 * `turnProcessPanelClass()` and its whole block retired with the Base UI
 * `Collapsible` they existed to neutralise (see `MessageTimeline`'s panel
 * note): every class in the override — `h-auto`, `overflow-visible`,
 * `transition-none duration-0`, the two `data-*-style` overrides — was there to
 * opt that component out of measuring and clipping the panel height, and a
 * plain `hidden` panel measures nothing. The one claim worth keeping is the
 * prohibition, and it moved to the panel's own assertion in
 * `messageTimelineWiring.test.ts`: no `overflow-hidden`, because it would make
 * the panel a containing block and switch off the pinned band's sticky.
 */
describe('turnProcessShellClass (F11)', () => {
  // `Collapsible.Root` renders a bare `<div>`; without this the trigger row and
  // the panel sat flush at 0px while every other pair inside the turn kept
  // P-17's 10px beat.
  it('F11: the shell stacks its trigger and panel on the within-turn tier', () => {
    const cls = turnProcessShellClass();
    expect(cls).toContain('flex');
    expect(cls).toContain('flex-col');
    // Read from `turnBodyClass()` rather than hard-coded a second time: the
    // shell sits inside one of its slots, so the two are one number by design
    // and F-B9 above is where that number is pinned.
    expect(spacingPx(cls, 'gap')).toBe(spacingPx(turnBodyClass(), 'gap'));
  });

  // The shell sits INSIDE one `turnBodyClass()` slot, so its own gap cannot
  // move the 20px turn-to-turn beat F-B9 pins. Anything sticking a margin or a
  // padding on this element would.
  it('F11: adds no margin or padding that could disturb the F-B9 arithmetic', () => {
    const cls = turnProcessShellClass();
    expect(cls).not.toMatch(/(?:^|\s)[mp][txybl]?-/);
    expect(cls).not.toMatch(/(?:^|\s)space-y-/);
  });
});

/**
 * The user's prompt (T12 — pi-app `.timeline-user-bubble`, retokenised).
 *
 * Three things retired together here and the causal order is the point:
 * `turnBubbleBandClass()`'s `position: sticky` forced F10's unconditional
 * six-line clamp (the pinned-only clamp coupled scroll position to layout
 * height and oscillated), and the clamp forced FB3's always-visible
 * `Show more`. Removing the first removes the reason for the other two.
 *
 * ⚠️ What that costs, stated rather than hidden: a very long pasted prompt now
 * renders at full height. pi-app accepts the same trade. If a clamp comes back,
 * it must NOT come back together with a sticky band.
 */
describe('userBubbleTextClass / userBubbleClass (T12)', () => {
  it('T12: the prompt is no longer clamped, in any form', () => {
    const cls = userBubbleTextClass();
    expect(cls).not.toMatch(/line-clamp/);
    // Including as a variant — a `group-hover:line-clamp-6` would be the same
    // defect wearing a different prefix.
    expect(cls).not.toMatch(/:line-clamp/);
  });

  it('T12: keeps the selection opt-in and the paragraph rhythm', () => {
    // `globals.css` sets `user-select: none` on `*`, so without `select-text`
    // the operator's own prompt can only be copied through a button.
    expect(userBubbleTextClass()).toContain('select-text');
    expect(userBubbleTextClass()).toContain('space-y-2');
  });

  it('T12: carries no scroll-state hook — F10 coupling must not return', () => {
    expect(userBubbleTextClass()).not.toContain('fx-');
    expect(userBubbleClass()).not.toContain('fx-');
  });

  /**
   * The cap and the shrink release are ONE claim, not two. This box is a flex
   * item, so its `min-width` resolves to `auto` (= min-content) and `min-width`
   * outranks `max-width`: `max-w-[80%]` alone is silently defeated by any
   * content with no break opportunity (a long URL, one long word), the bubble
   * goes full width, and it does so for SOME content only — which is why review
   * never catches it.
   */
  it('T12: the 80% cap comes with the min-width release that makes it hold', () => {
    const cls = userBubbleClass();
    expect(cls).toContain('max-w-[80%]');
    expect(cls).toContain('min-w-0');
  });

  /**
   * The role signal. The assistant side has no face and no edge at all now
   * (`turnAnswerContainerClass()` retired), so everything that says "this is
   * the operator, not the model" is on this one element: right alignment, a
   * visible face, and one sharp corner pointing back at the composer.
   *
   * The face/edge pair is F5 D3-c's measured one and is deliberately NOT
   * pi-app's (which has no edge): the face alone reads 1.161 light / 1.292 dark
   * against the timeline surface, and the edge carries the remaining
   * definition at 1.350 / 1.322.
   */
  it('T12: right-aligned, faced, and edged — the whole role signal', () => {
    expect(userBubbleRowClass()).toContain('justify-end');
    const cls = userBubbleClass();
    expect(cls).toContain('bg-accent');
    expect(cls).toContain('border border-input');
    // The corner MOVED from bottom-right to top-right (pi-app's form): it now
    // points back at the composer the message was typed in.
    expect(cls).toContain('rounded-tr-xs');
    expect(cls, 'the old bottom-right tail is not kept alongside it').not.toContain(
      'rounded-br-xs'
    );
  });

  // Radii are token steps, never raw pixels (design-system.md Border Radius):
  // `rounded-md` is the 12px tier for containers ≥32px tall, `rounded-*-xs` the
  // 4px inset tier. An arbitrary `rounded-[10px]` here would read as a one-off.
  it('T12: the bubble radii are design-system tiers, not arbitrary values', () => {
    const cls = userBubbleClass();
    expect(cls).toContain('rounded-md');
    expect(cls).not.toMatch(/rounded-\[/);
  });
});

describe('turnHeadClass', () => {
  it('is a single line whose ticking seconds cannot jitter its width', () => {
    const cls = turnHeadClass();
    expect(cls).toContain('items-center');
    expect(cls).toContain('min-w-0');
    expect(cls).toContain('tabular-nums');
  });

  /**
   * The status row and the work-group head are the SAME line in two shapes —
   * which one renders depends only on whether the turn has work to fold — so a
   * size that differs between them makes the turn appear to change type scale
   * the moment its first tool call lands. Asserted as an equality plus the
   * token, so moving one without the other fails here rather than in a
   * screenshot.
   *
   * 14px (`text-ui`) rather than 13px (`text-meta`) by user decision
   * 2026-09-19; the deviation from the Typography table's "status line -> meta"
   * row is recorded on `turnWorkGroupSummaryClass()`.
   */
  it('shares one size token with the work-group head, and it is the 14px tier', () => {
    expect(turnHeadClass()).toContain('text-ui');
    expect(turnWorkGroupSummaryClass()).toContain('text-ui');
    expect(turnHeadClass(), 'the 13px tier must not linger on one of the pair').not.toContain(
      'text-meta'
    );
    expect(turnWorkGroupSummaryClass()).not.toContain('text-meta');
  });
});

/**
 * T12-b: the meta row (`turnMetaRowClass()`) is gone, and with it `[FB6-2]`.
 * What replaced it is the hover strip, and the two things worth pinning about
 * that are its MECHANISM (a real zero-height row, not a transparent one) and
 * the exact scope of the F-B15 reversal.
 */
describe('turn hover action strip (T12-b)', () => {
  /**
   * REVERSED on 2026-08-30 by user decision, after seeing it in the running
   * app: hovering a turn must not move anything.
   *
   * The assertion this replaces required the opposite — a genuinely zero-height
   * collapsed strip (`grid-rows-[0fr] -> [1fr]`), on the argument that an
   * always-present strip spends the vertical budget removing the meta row had
   * just given back. That cost is real and is still real; the user weighed it
   * against text that shifts under the cursor and chose the whitespace.
   *
   * So the strip now reserves its height and only fades. The negative half is
   * what keeps the old behaviour from creeping back: NO height animation of any
   * kind on this strip, because every one of them moves the page.
   */
  it('T12-d follow-up: the strip reserves its height and only fades', () => {
    const slot = turnActionsSlotClass();
    expect(slot).toContain('opacity-0');
    expect(slot).toContain('group-hover/turn:opacity-100');
    expect(slot, 'only opacity may transition, or the hover moves the page').toContain(
      'transition-opacity'
    );
    for (const banned of ['grid-rows-[0fr]', 'grid-rows-[1fr]', 'grid-template-rows', 'h-0']) {
      expect(slot, `a height animation shifts the turn below: ${banned}`).not.toContain(banned);
    }
    // `hidden` / `max-h-0` reach the same place by a different route.
    expect(slot).not.toMatch(/(?:^|\s)(?:hidden|max-h-0|scale-y-0)(?:\s|$)/);
  });

  /**
   * The transparent state stays clickable on purpose — see the note on
   * `turnActionsSlotClass()`. `pointer-events-none` looks like the natural
   * companion to `opacity-0`, but the pointer cannot be over an invisible strip
   * without already being inside the turn, and being inside the turn is what
   * makes it visible. Adding the guard would protect a state nothing can enter.
   */
  it('the transparent state is not additionally gated on pointer-events', () => {
    expect(turnActionsSlotClass()).not.toContain('pointer-events-none');
  });

  /**
   * ALSO REVERSED on 2026-08-30, and the reversal is exact: the assertion this
   * replaces prohibited any height utility on this row.
   *
   * Both versions were correct for their mechanism. Under `grid-rows-[0fr]` a
   * definite height was the defect that shipped for one build (`h-7` from
   * pi-app; a fixed-height grid item is not squashable, so the collapsed strip
   * measured 28px in the browser while every class assertion stayed green).
   * Under a reserved-space strip a definite height is the whole point: height
   * that comes from content appears when the content does, which is the hover
   * shift all over again.
   *
   * The two numbers must stay one number, so this reads the button's tier
   * rather than hard-coding 24px twice.
   */
  it('T12-d follow-up: the inner row reserves exactly the button’s height', () => {
    const inner = turnActionsInnerClass();
    expect(inner, 'content-derived height reappears with the content').toContain('h-6');
    // Same tier, asserted from the button's own class so the pair cannot drift.
    expect(turnCopyButtonClass()).toContain('size-6');
    // The `0fr` squash machinery retired with the track it served; leaving it
    // behind would clip a strip that no longer collapses.
    expect(inner).not.toContain('min-h-0');
    expect(inner).not.toContain('overflow-hidden');
  });

  // The hover scope is a NAMED group. Tool rows and the thinking chain inside
  // the turn run their own hover groups; an anonymous `group` here would become
  // the nearest ancestor for some of them and silently change what they react
  // to.
  it('T12-b: the strip reacts to the turn group by name, never an anonymous one', () => {
    expect(chatTurnClass()).toContain('group/turn');
    // A bare `group` alongside it would make this element the nearest anonymous
    // ancestor for every `group-hover:` inside the turn.
    expect(chatTurnClass()).not.toMatch(/(?:^|\s)group(?:\s|$)/);
    // Every hover variant in the slot is scoped to that name — an unscoped
    // `group-hover:` would bind to whichever group happens to be nearest.
    for (const utility of turnActionsSlotClass().split(/\s+/)) {
      if (!utility.startsWith('group-hover')) continue;
      expect(utility, 'unscoped group-hover in the strip').toMatch(/^group-hover\/turn:/);
    }
    expect(turnActionsSlotClass()).toContain('group-hover/turn:');
  });

  it('T12-b: the OS reduced-motion setting is honoured', () => {
    expect(turnActionsSlotClass()).toContain('motion-reduce:transition-none');
  });

  it('the copy button is a 24px ghost icon button', () => {
    const cls = turnCopyButtonClass();
    expect(cls).toContain('size-6');
    expect(cls).toContain('rounded-sm');
    expect(cls).toContain('hover:bg-hover');
  });

  /**
   * `F-B15` REVERSED, deliberately and by name.
   *
   * The old rule was "the copy button is never hover-only", because a control
   * only a mouse can discover is unreachable by touch and by keyboard. The user
   * overruled it on 2026-08-29 in favour of matching pi-app exactly, having
   * been shown that cost. So the strip may hide, and this asserts the one piece
   * of the old rule that survives: the reveal lives on the CONTAINER, never on
   * the button. A button that also faded would mean two independent things had
   * to agree before a click could land — the classic "it's visible but it
   * doesn't work" bug.
   */
  it('T12-b: the reveal is on the container; the button itself never fades', () => {
    const cls = turnCopyButtonClass();
    expect(cls).not.toContain('opacity-0');
    expect(cls).not.toContain('group-hover');
    expect(cls).not.toContain('pointer-events-none');
  });
});

/**
 * T12: the assistant's answer segment has no container of its own.
 *
 * `turnAnswerContainerClass()` (F5 D3-b, 2026-08-18) put one `rounded-sm border
 * border-border p-3.5` ring around each answer segment. It is gone — pi-app
 * renders reply prose bare, and after FB4 made answer segments repeat within a
 * turn, that ring had become one box per prose run: a single reply could be
 * three stacked boxes with tool rows between them (the look question Q14 left
 * open).
 *
 * The role signal is now an ASYMMETRY rather than two kinds of box — the user
 * side is a shaped object, the agent side is not an object at all. What that
 * makes assertable is a prohibition rather than a shape, and it is the one
 * below: nothing in the turn body may grow a face or an edge, because the first
 * edit that does re-creates "everything is a card" from the other direction.
 */
describe('assistant answer segment (T12 — no container)', () => {
  it('T12: the answer segment mounts the body class and nothing else', () => {
    // `turnBodyClass()` is what the answer branch renders; if it ever acquires
    // a fill or a ring, the container is back under a different name.
    const cls = turnBodyClass();
    expect(cls, 'a face here re-creates the retired answer box').not.toMatch(/(?:^|\s)bg-/);
    expect(cls, 'an edge here re-creates the retired answer box').not.toMatch(
      /(?:^|\s)(?:border|ring)(?:-|\s|$)/
    );
    expect(cls).not.toMatch(/(?:^|\s)shadow-/);
  });

  /**
   * The named degradation, kept from D3-4 because it is still true and still
   * the tempting edit: a `bg-muted` container would put inline code chips
   * (`bg-muted`) and fenced blocks (`bg-muted/50`) at 1.000 against their own
   * parent — i.e. delete them. That measurement is why the answer surface must
   * stay the timeline surface, with or without a ring.
   */
  it('T12: the prose sits directly on the timeline surface, with no inset', () => {
    expect(turnBodyClass()).not.toMatch(/(?:^|\s)p[xy]?-/);
  });
});

/**
 * F456 slice ④ §7.5 / §8.4 `[F4-6]` — the turn head's tone tiers.
 *
 * `turnStatusToneClass` moved here from `MessageTimeline.tsx`, where it was a
 * module-private function no node-environment suite could reach. It belongs in
 * this file on its own merits: it is turn-level class assembly, the same job as
 * `turnHeadClass()` right next to it.
 */
describe('turnStatusToneClass (F456 §7.5)', () => {
  /**
   * `[F4-6]` The slow tier stops shouting. With a 300s silence ceiling, a first
   * token arriving after 45s is the ordinary shape of a long prompt, and a
   * warning colour that is on for minutes at a time is not a warning. The tier
   * still reads: it falls back to the head's own muted colour, which this batch
   * raised to a 7.20 / 6.70 contrast pair.
   */
  it('[F4-6] slow falls back to the head colour instead of a warning', () => {
    expect(turnStatusToneClass('slow')).toBe(false);
    // The fallback has to land somewhere legible, or "muted" is just "gone".
    expect(turnHeadClass()).toContain('text-muted-foreground');
  });

  /**
   * `[F4-6]` The stalled tier is the one moment on the timeline that earns a
   * colour, so it takes the one it needs.
   */
  it('[F4-6] stalled is the single tier that takes a colour', () => {
    expect(turnStatusToneClass('stalled')).toBe('text-warning');
  });

  it('[F4-6] failure stays destructive; every other kind stays muted', () => {
    expect(turnStatusToneClass('failed')).toBe('text-destructive');
    for (const kind of ['handshake', 'awaiting', 'streaming', 'retrying'] as const) {
      expect(turnStatusToneClass(kind), kind).toBe(false);
    }
  });
});

/**
 * `process fold (2026-09-10)` moved to `turnProcessFold.test.ts` along with the
 * rest of that module's rules — `countProcessSteps` is now one of five exports
 * there, and splitting its test away from the other four would have left the
 * work group's placement rules and its fallback copy asserted in two files.
 */

/**
 * The three-tier reading ladder (user decision 2026-09-18).
 *
 * The assertion that matters is the ORDER — three DISTINCT tokens, brightest
 * for the answer, dimmest for the process rows — because the defect this
 * replaces was two of the three being the same colour, which is invisible in
 * any single-class assertion.
 */
describe('reading ladder (2026-09-18)', () => {
  it('[LADDER-1] the three rungs are pairwise different colours, and all three are tokens', () => {
    const answer = turnAnswerToneClass();
    const process = turnProcessToneClass();
    const head = turnWorkGroupSummaryClass();
    // Written as three CONTAINMENT claims rather than "3 distinct `text-*`
    // tokens": the head also carries `text-ui`, a SIZE, so a naive
    // first-match extraction reads the size as the colour and the whole check
    // passes even when two rungs have collapsed onto one colour. (Verified: a
    // mutation setting the process rows back to `text-muted-foreground`
    // survived that version of this assertion.)
    expect(answer).not.toBe(process);
    expect(head, 'the head must not be as bright as the answer').not.toContain(answer);
    expect(head, 'nor as dim as the rows it summarises').not.toContain(process);
    for (const cls of [answer, process, head]) {
      // A hex/oklch/rgb literal or an arbitrary-value bracket means the ladder
      // has left the token system and the themes can no longer retune it.
      expect(cls, cls).not.toMatch(/#[0-9a-f]{3,8}|oklch\(|rgb\(|\[/i);
    }
  });

  it('[LADDER-2] the answer is the brightest rung and the process rows the dimmest', () => {
    expect(turnAnswerToneClass()).toBe('text-foreground');
    expect(turnProcessToneClass()).toBe('text-tool-arg');
    // The head sits between them, on the same tier as the status row it
    // replaced at the end of a completed turn.
    expect(turnWorkGroupSummaryClass()).toContain('text-muted-foreground');
  });

  /**
   * The tone is applied through `cn()` on top of `turnBodyClass()`, and
   * `turnBodyClass()` carries `text-markdown` — a SIZE token. `utils.ts`
   * registers the repo's custom size tokens into tailwind-merge's `font-size`
   * group precisely because they would otherwise fall through to `text-color`
   * and be dropped by the colour that follows them. This is the assertion that
   * that registration is still doing its job for the two new call sites:
   * without it the answer would silently lose the markdown type scale.
   */
  it('[LADDER-5] adding a tone to the body class keeps the size token', () => {
    const answer = cn(turnBodyClass(), turnAnswerToneClass());
    expect(answer).toContain('text-markdown');
    expect(answer).toContain('text-foreground');
    const process = cn(turnProcessShellClass(), turnBodyClass(), turnProcessToneClass());
    expect(process).toContain('text-markdown');
    expect(process).toContain('text-tool-arg');
  });

  it('[LADDER-3] the group head strips the native disclosure marker', () => {
    const head = turnWorkGroupSummaryClass();
    // Without both of these a `<summary>` draws a triangle that cannot be
    // styled and points the wrong way in half the browsers that draw one.
    expect(head).toContain('list-none');
    expect(head).toContain('marker:content-none');
    expect(head).toContain('cursor-pointer');
    // Its size is asserted next to the status row's (`turnHeadClass` above):
    // the two are one line in two shapes and share one token.
  });

  /**
   * The standing prohibition, re-checked at the one place it could re-enter:
   * the work group is the first collapsible the turn has owned since FB6, and
   * the Base UI panel it deliberately does NOT use carries `overflow-hidden`.
   */
  it('[LADDER-4] no turn-level class assembler carries overflow-hidden', () => {
    for (const cls of [
      chatTurnClass(),
      turnBodyClass(),
      turnProcessShellClass(),
      turnWorkGroupSummaryClass(),
      turnAnswerToneClass(),
      turnProcessToneClass(),
    ]) {
      expect(cls, cls).not.toContain('overflow-hidden');
    }
    expect(COLLAPSIBLE_PANEL_BASE_CLASS, 'the component this rules out').toContain(
      'overflow-hidden'
    );
  });
});
