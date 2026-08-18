import { describe, expect, it } from 'vitest';
import { COLLAPSIBLE_PANEL_BASE_CLASS } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  chatTurnClass,
  readingColumnSpacingClass,
  turnBodyClass,
  turnBubbleBandClass,
  turnCopyButtonClass,
  turnFooterClass,
  turnHeadClass,
  turnProcessPanelClass,
  turnProcessShellClass,
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

describe('turnBubbleBandClass (F-B8)', () => {
  it('F-B8: pins to the top of the viewport on an opaque, layered band', () => {
    const cls = turnBubbleBandClass();
    expect(cls).toContain('sticky');
    expect(cls).toContain('top-0');
    expect(cls).toContain('py-2.5');
    // The timeline surface, not `bg-card`: the band has to hide content
    // scrolling underneath it, and a card fill would read as a second panel.
    expect(cls).toContain('bg-background');
    expect(cls).toMatch(/(?:^|\s)z-\d+(?:\s|$)/);
  });

  // Each of these silently disables `position: sticky` (or re-parents its
  // containing block). The failure mode is invisible in review — the element
  // just stops sticking — so the prohibition is asserted rather than commented.
  it('F-B8: carries nothing that would silently kill sticky', () => {
    const cls = turnBubbleBandClass();
    expect(cls).not.toMatch(/overflow-/);
    expect(cls).not.toMatch(/transform/);
    expect(cls).not.toMatch(/filter/);
    expect(cls).not.toMatch(/(?:^|\s)contain-/);
  });
});

describe('chatTurnClass (F-B10)', () => {
  it('F-B10: the per-turn section stays a clean sticky containing block', () => {
    const cls = chatTurnClass();
    expect(cls).not.toContain('overflow-hidden');
    expect(cls).not.toMatch(/overflow-/);
    expect(cls).not.toMatch(/(?:^|\s)contain-/);
    expect(cls).not.toMatch(/transform/);
  });

  it('F-B10: owns no gap of its own — the band bottom padding is the bubble-to-head beat', () => {
    expect(chatTurnClass()).not.toMatch(/(?:^|\s)gap-/);
    expect(chatTurnClass()).not.toMatch(/(?:^|\s)space-y-/);
  });
});

describe('turn spacing arithmetic (F-B9)', () => {
  // §5.4: the 20px turn-to-turn beat (A07 :846) is unchanged in TOTAL, but its
  // composition moved from one 20px gap to 10 + 10. Reading `space-y-2.5`
  // alone looks like the rhythm was halved; this assertion is what says it
  // was not, and it fails the moment either half is edited on its own.
  it('F-B9: ReadingColumn spacing + band top padding === 20px between turns', () => {
    const columnGap = spacingPx(readingColumnSpacingClass(), 'space-y');
    const bandPadding = spacingPx(turnBubbleBandClass(), 'py');
    expect(columnGap).toBe(10);
    expect(bandPadding).toBe(10);
    expect(columnGap + bandPadding).toBe(20);
  });

  it('F-B9: the band padding equals the 10px within-turn tier (P-17)', () => {
    const bandPadding = spacingPx(turnBubbleBandClass(), 'py');
    const bodyGap = spacingPx(turnBodyClass(), 'gap');
    expect(bandPadding).toBe(bodyGap);
    expect(bodyGap).toBe(10);
  });
});

describe('turnProcessPanelClass', () => {
  // Base UI freezes the panel at the `scrollHeight` it measured when it opened
  // and clips the overflow. The process segment grows AFTER opening — tokens
  // stream into it, and a tool row's IN/OUT body expands inside it — so the
  // frozen height would swallow content with no visible cause. These three
  // together are what opt the panel out of that mechanism.
  it('opts the process panel out of the measured fixed-height mechanism', () => {
    const cls = turnProcessPanelClass();
    expect(cls).toContain('h-auto');
    expect(cls).toContain('overflow-visible');
    // The strategy switch: Base UI reads the computed style once and only takes
    // the measuring path when a transition (or animation) is present. It probes
    // the DURATION, so both halves are needed — `transition-none` on its own
    // leaves the base class's `duration-150` in place and the probe still sees
    // a transition.
    expect(cls).toContain('transition-none');
    expect(cls).toContain('duration-0');
  });

  it('neutralises the enter/exit height keyframes too', () => {
    const cls = turnProcessPanelClass();
    expect(cls).toContain('data-starting-style:h-auto');
    expect(cls).toContain('data-ending-style:h-auto');
  });

  // Review batch F15/F8③: the two assertions that used to sit in the blocks
  // above ("the override string does not contain `h-(--collapsible-panel-height)`",
  // "…does not contain `data-*-style:h-0`") could never have failed — those are
  // the BASE class's utilities, and the override never had them to begin with.
  // They read like a guarantee about the rendered element and asserted nothing.
  //
  // What actually has to hold is the MERGE: `CollapsiblePanel` applies
  // `cn(COLLAPSIBLE_PANEL_BASE_CLASS, className)`, and tailwind-merge has to
  // resolve every one of those pairs in the override's favour. If it does not —
  // a group rename in tailwind-merge, a variant modifier it stops recognising —
  // the panel silently goes back to measuring its height and clipping the
  // process segment. The base class is imported, never copied, so this fails
  // the moment either side is edited on its own.
  describe('F8③: the real merged panel class', () => {
    const merged = cn(COLLAPSIBLE_PANEL_BASE_CLASS, turnProcessPanelClass());

    it('the override survives the merge', () => {
      expect(merged).toContain('h-auto');
      expect(merged).toContain('overflow-visible');
      expect(merged).toContain('transition-none');
      expect(merged).toContain('duration-0');
      expect(merged).toContain('data-starting-style:h-auto');
      expect(merged).toContain('data-ending-style:h-auto');
    });

    it('every measured-height utility is actually gone from the merge', () => {
      expect(merged).not.toContain('h-(--collapsible-panel-height)');
      expect(merged).not.toContain('overflow-hidden');
      expect(merged).not.toContain('transition-[height]');
      expect(merged).not.toContain('duration-150');
      expect(merged).not.toMatch(/data-(?:starting|ending)-style:h-0/);
    });

    // Guards the premise of the test above: if the base class ever stops
    // carrying these, the negative assertions become vacuous again — exactly
    // the failure this block was written to remove.
    it('the base class is the one being overridden', () => {
      expect(COLLAPSIBLE_PANEL_BASE_CLASS).toContain('h-(--collapsible-panel-height)');
      expect(COLLAPSIBLE_PANEL_BASE_CLASS).toContain('overflow-hidden');
      expect(COLLAPSIBLE_PANEL_BASE_CLASS).toContain('duration-150');
    });
  });
});

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

describe('userBubbleTextClass (F10 — the unconditional clamp)', () => {
  // The pinned-only clamp (`@container scroll-state(stuck: top)`) coupled
  // scroll position to layout height and oscillated: collapse → scrollHeight
  // shrinks → browser clamps scrollTop below the sticky threshold → expand →
  // follower pushes the offset back. The fix is structural: the clamp must be
  // UNCONDITIONAL, so band height depends on content alone and no scroll →
  // height edge exists. These assertions pin exactly that.
  it('F10: clamps the prompt with a bare, unconditional line-clamp utility', () => {
    const cls = userBubbleTextClass();
    // Bare utility — no variant prefix (`hover:`, `group-*:`, `data-[...]:`),
    // which is what "unconditional" means in a Tailwind class string.
    expect(cls).toMatch(/(?:^|\s)line-clamp-\d+(?:\s|$)/);
    expect(cls).not.toMatch(/:line-clamp/);
    const lines = Number(/line-clamp-(\d+)/.exec(cls)?.[1]);
    expect(lines).toBeGreaterThanOrEqual(3);
  });

  it('F10: keeps the selection opt-in and the paragraph rhythm', () => {
    const cls = userBubbleTextClass();
    expect(cls).toContain('select-text');
    expect(cls).toContain('space-y-2');
  });

  it('F10: carries no scroll-state hook — the coupling must not return', () => {
    expect(userBubbleTextClass()).not.toContain('fx-');
    expect(turnBubbleBandClass()).not.toContain('fx-');
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

describe('turn footer (F-B15)', () => {
  it('F-B15: the footer is right-aligned', () => {
    expect(turnFooterClass()).toContain('justify-end');
  });

  it('F-B15: the copy button is a 24px ghost icon button', () => {
    const cls = turnCopyButtonClass();
    expect(cls).toContain('size-6');
    expect(cls).toContain('rounded-sm');
    expect(cls).toContain('hover:bg-hover');
  });

  // A control only a mouse can discover is unreachable by touch and by
  // keyboard — hover-only is the failure this button was specified against
  // (§4.6), not a style preference.
  it('F-B15: the copy button is never hover-only', () => {
    const cls = turnCopyButtonClass();
    expect(cls).not.toContain('opacity-0');
    expect(cls).not.toContain('group-hover:');
  });
});
