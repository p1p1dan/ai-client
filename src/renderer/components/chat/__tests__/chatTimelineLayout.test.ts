import { describe, expect, it } from 'vitest';
import {
  chatTurnClass,
  readingColumnSpacingClass,
  turnActionsInnerClass,
  turnActionsSlotClass,
  turnBodyClass,
  turnCopyButtonClass,
  turnHeadClass,
  turnProcessShellClass,
  turnStatusToneClass,
  userBubbleClass,
  userBubbleRowClass,
  userBubbleTextClass,
} from '../chatTimelineLayout';

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
 * T12 retired `turnBubbleBandClass()` — the `position: sticky` band that pinned
 * the user's prompt to the top of the viewport — and with it the F-B8 sticky
 * prohibitions, because there is no longer a sticky element for an ancestor's
 * `overflow` / `transform` / `contain` to switch off.
 *
 * The claim worth keeping from that block is the NEGATIVE one, and it moves
 * here: no element in the turn chrome may pin itself back without the rest of
 * the chain being rebuilt. A `sticky` reintroduced on its own would bring back
 * F10's oscillation (scroll position -> clamp -> height -> scroll position),
 * which is precisely what this batch removed the preconditions for.
 */
describe('T12: the turn chrome pins nothing', () => {
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
      expect(cls, `sticky must not return without the rest of the chain: ${cls}`).not.toMatch(
        /(?:^|\s)(?:sticky|fixed)(?:\s|$)/
      );
      expect(cls).not.toMatch(/(?:^|\s)z-\d+(?:\s|$)/);
    }
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

  // The 10px that used to be the band's BOTTOM padding: prompt -> first content
  // segment. It had to land somewhere when the band retired, and the section is
  // the only element that spans both.
  it('F-B10: owns the 10px prompt-to-body beat the band used to pad', () => {
    expect(spacingPx(chatTurnClass(), 'gap')).toBe(10);
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

  // …and it has to be strictly bigger than the within-turn tier, or a reply and
  // the next prompt read as one block. This is the relation the absolute
  // numbers above exist to protect.
  it('F-B9: turn-to-turn spacing is double the 10px within-turn tier (P-17)', () => {
    const between = spacingPx(readingColumnSpacingClass(), 'space-y');
    const within = spacingPx(turnBodyClass(), 'gap');
    expect(within).toBe(10);
    expect(between).toBe(within * 2);
    // The prompt-to-body gap is the within-turn tier too, not a third number.
    expect(spacingPx(chatTurnClass(), 'gap')).toBe(within);
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
  it('F11: the shell stacks its trigger and panel on the 10px within-turn tier', () => {
    const cls = turnProcessShellClass();
    expect(cls).toContain('flex');
    expect(cls).toContain('flex-col');
    expect(spacingPx(cls, 'gap')).toBe(10);
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
  it('is a single-line meta row whose ticking seconds cannot jitter its width', () => {
    const cls = turnHeadClass();
    expect(cls).toContain('items-center');
    expect(cls).toContain('min-w-0');
    expect(cls).toContain('tabular-nums');
    expect(cls).toContain('text-meta');
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
