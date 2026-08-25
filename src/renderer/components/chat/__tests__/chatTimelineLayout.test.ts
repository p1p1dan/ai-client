import { describe, expect, it } from 'vitest';
import { chatMarkdownParagraphClass } from '../chatMarkdownPolicy';
import {
  chatTurnClass,
  readingColumnSpacingClass,
  turnAnswerContainerClass,
  turnBodyClass,
  turnBubbleBandClass,
  turnCopyButtonClass,
  turnHeadClass,
  turnMetaRowClass,
  turnProcessShellClass,
  turnStatusToneClass,
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

describe('userBubbleTextClass (F10 — the unconditional clamp)', () => {
  // The pinned-only clamp (`@container scroll-state(stuck: top)`) coupled
  // scroll position to layout height and oscillated: collapse → scrollHeight
  // shrinks → browser clamps scrollTop below the sticky threshold → expand →
  // follower pushes the offset back. The fix is structural: the clamp must be
  // UNCONDITIONAL, so band height depends on content alone and no scroll →
  // height edge exists. These assertions pin exactly that.
  it('F10: clamps the prompt with a bare, unconditional line-clamp utility', () => {
    const cls = userBubbleTextClass(false);
    // Bare utility — no variant prefix (`hover:`, `group-*:`, `data-[...]:`),
    // which is what "unconditional" means in a Tailwind class string.
    expect(cls).toMatch(/(?:^|\s)line-clamp-\d+(?:\s|$)/);
    expect(cls).not.toMatch(/:line-clamp/);
    const lines = Number(/line-clamp-(\d+)/.exec(cls)?.[1]);
    expect(lines).toBeGreaterThanOrEqual(3);
  });

  it('F10: keeps the selection opt-in and the paragraph rhythm', () => {
    for (const expanded of [false, true]) {
      const cls = userBubbleTextClass(expanded);
      expect(cls).toContain('select-text');
      expect(cls).toContain('space-y-2');
    }
  });

  it('F10: carries no scroll-state hook — the coupling must not return', () => {
    expect(userBubbleTextClass(false)).not.toContain('fx-');
    expect(userBubbleTextClass(true)).not.toContain('fx-');
    expect(turnBubbleBandClass()).not.toContain('fx-');
  });

  // [FB3-1] The expanded state must actually lift the clamp -- a toggle that
  // flips a boolean while the class string keeps `line-clamp-6` would look
  // wired and do nothing.
  it('[FB3-1] the collapsed state clamps and the expanded state carries no clamp at all', () => {
    expect(userBubbleTextClass(false)).toContain('line-clamp-6');
    expect(userBubbleTextClass(true)).not.toMatch(/line-clamp-/);
  });

  // [FB3-1] The clamp stays unconditional WITHIN each state: F10's fix was to
  // remove the variant-driven clamp, and FB3 must not smuggle it back as
  // `group-*:`/`data-[...]:` on the collapsed string.
  it('[FB3-1] neither state introduces a variant-driven clamp', () => {
    for (const expanded of [false, true]) {
      expect(userBubbleTextClass(expanded)).not.toMatch(/:line-clamp/);
    }
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

describe('turn meta row (FB6 + F-B15)', () => {
  /**
   * `turnFooterClass()` retired with the footer row it named: FB6 merged the
   * head and the footer into this one row, so a second class assembler would
   * have been an export with no element to describe.
   */
  it('[FB6-2] the meta row is a single line whose ticking seconds cannot jitter it', () => {
    const cls = turnMetaRowClass();
    expect(cls).toContain('items-center');
    expect(cls).toContain('tabular-nums');
    expect(cls).toContain('text-meta');
    // The status text is the only thing in the row that gives way, and it can
    // only do that if the row lets it shrink.
    expect(cls).toContain('min-w-0');
    // The row carries a counter that changes every second; a row that can wrap
    // can change HEIGHT every second, underneath a stick-to-bottom follower.
    expect(cls).not.toContain('flex-wrap');
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

/**
 * F5 D3-b (user decision 2026-08-18): the assistant's answer segment gets one
 * neutral container per turn.
 *
 * The decision was taken over a designer objection ("three nested boxes"), and
 * the resolution was to spend a BORDER and nothing else. Everything below
 * guards that resolution, because the tempting edit — "give it a faint fill so
 * it reads as a container" — is exactly what the measurements ruled out:
 * `bg-muted` puts inline code chips and fenced blocks at 1.000 against their
 * own parent, i.e. it deletes them.
 */
describe('turnAnswerContainerClass (F5 D3-b)', () => {
  // The named degradation: someone adds `bg-muted` to make the container "a
  // bit more visible", and silently erases every inline code chip and fenced
  // block inside it. That is the whole reason candidate B was chosen over A.
  it('[D3-4] draws with an edge and never with a face', () => {
    const cls = turnAnswerContainerClass();
    expect(cls).toContain('border border-border');
    expect(cls, 'a fill here composites inner code surfaces to 1.000').not.toMatch(/(?:^|\s)bg-/);
  });

  // Cross-module equality, so "changed one side only" fails. The container's
  // inset is not a number chosen here: "container edge to first block" is the
  // same distance as "block to block", which `chatMarkdownPolicy.ts` owns.
  it('[D3-5] the inset is the prose block tier, not a new number', () => {
    expect(spacingPx(turnAnswerContainerClass(), 'p')).toBe(
      spacingPx(chatMarkdownParagraphClass(), 'mt')
    );
    expect(spacingPx(turnAnswerContainerClass(), 'p')).toBe(14);
  });

  /**
   * A SHAPE lock, not a safety assertion — the distinction matters and is the
   * reason this replaces an earlier draft that claimed the container sat on the
   * sticky chain. It does not: the sticky element is the bubble band, and this
   * container hangs off the band's following SIBLING, so it cannot re-parent
   * the band's containing block and `overflow-hidden` here would not unstick
   * anything. `chatTimelineLayout.ts`'s F-B8 / F-B10 prohibitions name "the
   * pinned bubble band and its containing block", which this is not.
   *
   * What the whitelist actually guards: this container's entire job is one
   * ring and one inset. Any addition — a shadow, a ring, a fill, a transform —
   * is a design change that has to go back through the spec, not a tidy-up,
   * and a whitelist catches the additions nobody thought to enumerate.
   */
  it('[D3-6′] is exactly one ring and one inset, with nothing else attached', () => {
    expect(new Set(turnAnswerContainerClass().split(/\s+/))).toEqual(
      new Set(['rounded-sm', 'border', 'border-border', 'p-3.5'])
    );
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
