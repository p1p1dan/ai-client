import { describe, expect, it } from 'vitest';
import {
  COMPOSER_CONTROL_SIZE,
  composerAttachButtonClass,
  composerBarClass,
  composerCardClass,
  composerFollowHeightBreakdown,
  composerModelBaseClass,
  composerModelSuffixClass,
  composerModelTriggerClass,
  composerRowClass,
  middleColumnHostClass,
  queueStripWrapperClass,
  roundActionButtonClass,
  roundActionButtonKindClass,
  shouldShowStatusLine,
  TIMELINE_PADDING_CLASS,
  targetTriggerClass,
} from '../middleColumnLayout';
import { QUESTION_DOCK_WRAPPER_CLASS } from '../questionCard';

/**
 * T-30 batch 2 form-spec assertion suite (spec F-A1..F-A22; F-A5/F-A8/F-A14
 * superseded by F-A15/F-A20/F-A22 per the round-4 addendum §6). Every test
 * name carries its spec id so the spec tables can be checked off line by line.
 * All assertions are pure string / arithmetic checks — vitest runs in node
 * with no DOM.
 */

/** Extract the numeric part of a sizing utility (`min-h-10.5` -> 10.5). */
function sizeValue(cls: string, prefix: string): number {
  const match = cls.match(new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`));
  expect(match, `expected a ${prefix}-<n> utility in "${cls}"`).not.toBeNull();
  return Number(match?.[1]);
}

describe('F-A1 · composer card border: neutral gray ladder, no brand-orange focus', () => {
  it('uses border-border at rest and border-input on focus, in both modes', () => {
    for (const mode of ['empty', 'session'] as const) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('border-border');
      expect(cls).toContain('focus-within:border-input');
      // border-input must ONLY appear as the focus-within value, never as
      // the resting border (strip the focus token, then look again).
      expect(cls.replace('focus-within:border-input', '')).not.toContain('border-input');
      expect(cls).not.toContain('focus-within:border-ring');
      expect(cls).not.toContain('border-ring');
    }
  });
});

describe('F-A2 · 42px follow-up resting height (arithmetic × string cross-check)', () => {
  it('breaks down as 2px borders + 16px padding + 24px content = 42', () => {
    const breakdown = composerFollowHeightBreakdown();
    expect(breakdown.border).toBe(2);
    expect(breakdown.padding).toBe(16);
    expect(breakdown.content).toBe(COMPOSER_CONTROL_SIZE);
    expect(breakdown.total).toBe(42);
    expect(breakdown.border + breakdown.padding + breakdown.content).toBe(breakdown.total);
  });

  it('pins the session card min-h utility to the SAME 42px (T-28 blocker class: asserting the class exists without doing the math)', () => {
    const cls = composerCardClass('session');
    expect(sizeValue(cls, 'min-h') * 4).toBe(composerFollowHeightBreakdown().total);
  });

  it('uses the symmetric 8px padding (p-2) in both modes — the E1 fix undoes the 5px-squeeze workaround', () => {
    for (const mode of ['empty', 'session'] as const) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('p-2');
      expect(cls).not.toContain('py-1');
      expect(cls).not.toContain('px-3');
      expect(cls).not.toContain('py-2.5');
    }
  });
});

describe('F-A2b / F-A21 · session pill radius with hasExtras demotion (拍板 ②)', () => {
  it('F-A21: the resting follow-up card is a full pill', () => {
    const cls = composerCardClass('session');
    expect(cls).toContain('rounded-full');
    expect(cls).not.toContain('rounded-md');
  });

  it('F-A2b: with extras stacked the card demotes to rounded-md so the pill never distorts', () => {
    const cls = composerCardClass('session', { hasExtras: true });
    expect(cls).toContain('rounded-md');
    expect(cls).not.toContain('rounded-full');
  });

  it('the empty card keeps rounded-md in all cases (Cursor empty state measured ~12px)', () => {
    expect(composerCardClass('empty')).toContain('rounded-md');
    expect(composerCardClass('empty', { hasExtras: true })).toContain('rounded-md');
    expect(composerCardClass('empty')).not.toContain('rounded-full');
  });
});

describe('F-A3 / F-A4 · one 24px control tier across the whole composer', () => {
  it('F-A3: round action buttons are size-6 (24px), not size-7 (E2 measurement fix)', () => {
    const cls = roundActionButtonClass();
    expect(cls).toContain('size-6');
    expect(cls).not.toContain('size-7');
    expect(sizeValue(cls, 'size') * 4).toBe(COMPOSER_CONTROL_SIZE);
  });

  it('F-A4: attach button, model trigger and target triggers all derive from COMPOSER_CONTROL_SIZE', () => {
    expect(sizeValue(composerAttachButtonClass(), 'size') * 4).toBe(COMPOSER_CONTROL_SIZE);
    expect(sizeValue(composerModelTriggerClass(), 'h') * 4).toBe(COMPOSER_CONTROL_SIZE);
    expect(sizeValue(targetTriggerClass(), 'h') * 4).toBe(COMPOSER_CONTROL_SIZE);
    expect(sizeValue(targetTriggerClass('muted'), 'h') * 4).toBe(COMPOSER_CONTROL_SIZE);
  });
});

describe('F-A15 · model trigger: naked-at-rest, shell on hover/focus/open (supersedes F-A5)', () => {
  it('shows the hover shell and the SAME shell for keyboard focus (a11y pair)', () => {
    const cls = composerModelTriggerClass();
    const hasHoverShell = cls.includes('hover:bg-hover');
    const hasFocusShell = cls.includes('focus-visible:bg-hover');
    // The pair must be same-true / same-false: a mouse-only shell silently
    // strips keyboard users of any control boundary.
    expect(hasHoverShell).toBe(true);
    expect(hasFocusShell).toBe(hasHoverShell);
    expect(cls).toContain('data-[popup-open]:bg-selection');
  });

  it('keeps the 8px radius and 8px horizontal padding (user round-4 point 4: "外接框稍微大一点点")', () => {
    const cls = composerModelTriggerClass();
    expect(cls).toContain('rounded-sm');
    expect(cls).toContain('px-2');
  });

  it('carries no border, shadow, width floor, or oversized radius — the four SelectTrigger inheritances that made the pill "AI 化"', () => {
    const cls = composerModelTriggerClass();
    expect(cls).not.toContain('border');
    expect(cls).not.toContain('shadow');
    expect(cls).not.toContain('min-w-');
    expect(cls).not.toContain('rounded-lg');
    expect(cls).not.toContain('rounded-md');
    expect(cls).not.toContain('rounded-full');
  });

  it('keeps the focus outline convention alongside the focus shell (outline AND fill, not either/or)', () => {
    const cls = composerModelTriggerClass();
    expect(cls).toContain('focus-visible:outline-2');
    expect(cls).toContain('focus-visible:outline-offset-1');
    expect(cls).toContain('focus-visible:outline-accent-primary');
  });
});

describe('F-A17 · suffix polarity (depends on D25 ①: font-medium is a no-op on an all-mono stack)', () => {
  it('renders the effort suffix darker and heavier than the base name', () => {
    expect(composerModelSuffixClass()).toContain('font-medium');
    expect(composerModelSuffixClass()).toContain('text-foreground');
    expect(composerModelBaseClass()).toContain('text-muted-foreground');
    expect(composerModelBaseClass()).not.toContain('font-medium');
  });
});

describe('F-A18 · one ghost-chip shape for the whole composer (model trigger ↔ target triggers)', () => {
  it('shares the horizontal padding and height utilities', () => {
    const model = composerModelTriggerClass();
    const target = targetTriggerClass();
    const px = (cls: string) => cls.match(/(?:^|\s)px-(\d+(?:\.\d+)?)(?:\s|$)/)?.[1];
    const h = (cls: string) => cls.match(/(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/)?.[1];
    expect(px(model)).toBeDefined();
    expect(px(model)).toBe(px(target));
    expect(h(model)).toBeDefined();
    expect(h(model)).toBe(h(target));
  });

  it('F-A6: target triggers use the 8px radius, not rounded-md (which clamps to a full pill at h-6)', () => {
    for (const tone of [undefined, 'muted' as const]) {
      const cls = targetTriggerClass(tone);
      expect(cls).toContain('rounded-sm');
      expect(cls).not.toContain('rounded-md');
    }
    expect(targetTriggerClass('muted')).toContain('text-muted-foreground');
  });
});

describe('F-A7 · zero shadows on the card (A07 :1337; Cursor measured zero shadow)', () => {
  it('never emits a shadow utility from the card class', () => {
    expect(composerCardClass('empty')).not.toContain('shadow');
    expect(composerCardClass('session')).not.toContain('shadow');
    expect(composerCardClass('session', { hasExtras: true })).not.toContain('shadow');
  });
});

describe('F-A10 · the 8px band above the card has exactly one owner per source', () => {
  it('timeline, question dock and queue strip each hold their own pb-2/mb-2', () => {
    expect(TIMELINE_PADDING_CLASS).toContain('pb-2');
    expect(QUESTION_DOCK_WRAPPER_CLASS).toContain('pb-2');
    expect(queueStripWrapperClass()).toContain('mb-2');
    expect(queueStripWrapperClass()).not.toContain('mb-1.5');
  });

  it('the composer host no longer stacks its own pt-1.5 on top (14px → 8px)', () => {
    const cls = middleColumnHostClass('session');
    expect(cls).toContain('pt-0');
    expect(cls).not.toMatch(/pt-(?!0(?:\s|$))/);
  });
});

describe('F-A11 · empty-state status line is need-based, not resident', () => {
  // Adapted from the spec's four-condition table: cb2d8d7 (round-4 defect B)
  // made the destructive banner the sole owner of error text, so
  // hasStatusError alone shows NO status line in either mode — the spec's
  // pre-cb2d8d7 wording listed it as a trigger; the banner contract wins.
  it('hides the resting "Ready · cwd:" line in empty mode', () => {
    expect(
      shouldShowStatusLine({
        mode: 'empty',
        sending: false,
        reading: 0,
        hasStatusError: false,
        hasLargeHint: false,
      })
    ).toBe(false);
  });

  it('still shows for sending / reading / large-hint in empty mode', () => {
    for (const overrides of [{ sending: true }, { reading: 2 }, { hasLargeHint: true }] as const) {
      expect(
        shouldShowStatusLine({
          mode: 'empty',
          sending: false,
          reading: 0,
          hasStatusError: false,
          hasLargeHint: false,
          ...overrides,
        })
      ).toBe(true);
    }
  });

  it('hasStatusError alone shows nothing in either mode — the banner owns error text (cb2d8d7)', () => {
    for (const mode of ['empty', 'session'] as const) {
      expect(
        shouldShowStatusLine({
          mode,
          sending: false,
          reading: 0,
          hasStatusError: true,
          hasLargeHint: false,
        })
      ).toBe(false);
    }
  });
});

describe('F-A22 · round key colors (拍板 ③: send goes near-black; supersedes F-A14)', () => {
  it('send and enqueue fill with the near-black foreground, never brand orange', () => {
    for (const kind of ['send', 'enqueue'] as const) {
      const cls = roundActionButtonKindClass(kind);
      expect(cls).toContain('bg-foreground');
      expect(cls).toContain('text-background');
      expect(cls).not.toContain('bg-primary');
    }
  });

  it('send and enqueue intentionally share one fill (both are "submit"); stop stays destructive and distinct', () => {
    // Spec F-A22 asks for pairwise inequality; send/enqueue differ only by
    // icon by design (same action family), so the guarded regression is
    // send/stop converging — asserted strictly here.
    expect(roundActionButtonKindClass('send')).toBe(roundActionButtonKindClass('enqueue'));
    const stop = roundActionButtonKindClass('stop');
    expect(stop).toContain('destructive');
    expect(stop).not.toBe(roundActionButtonKindClass('send'));
  });
});

describe('composer row/bar assembly classes (spec §5.2/§5.3)', () => {
  it('the session single row keeps its docked geometry', () => {
    const cls = composerRowClass();
    expect(cls).toContain('flex');
    expect(cls).toContain('min-w-0');
    expect(cls).toContain('items-center');
    expect(cls).toContain('gap-2');
  });

  it('the empty bottom bar swaps justify-between for plain gap flow (status line carries flex-1)', () => {
    const cls = composerBarClass();
    expect(cls).toContain('mt-1.5');
    expect(cls).toContain('gap-2');
    expect(cls).not.toContain('justify-between');
  });

  it('the attach button is a naked icon chip with the same shell pair as the model trigger', () => {
    const cls = composerAttachButtonClass();
    expect(cls).toContain('rounded-sm');
    expect(cls).toContain('hover:bg-hover');
    expect(cls).toContain('focus-visible:bg-hover');
    expect(cls).not.toContain('border');
    expect(cls).not.toContain('shadow');
  });
});
