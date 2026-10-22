import { describe, expect, it } from 'vitest';
import { cn } from '../utils';

/**
 * D25: tailwind-merge 3.4's default config treats any unregistered
 * `text-<word>` utility (our custom font-size tokens included) as a
 * `text-color` candidate via its `isAny` catch-all, so it silently evicts
 * whatever colour class preceded it. `cn` must register the D25 font-size
 * tokens into the `font-size` class group so they only conflict with other
 * font-size utilities, never with colour.
 */
describe('cn (tailwind-merge font-size vs text-color conflict)', () => {
  it('keeps both a text-color class and a D25 size token together', () => {
    expect(cn('text-muted-foreground', 'text-ui')).toBe('text-muted-foreground text-ui');
    expect(cn('text-muted-foreground', 'text-code')).toBe('text-muted-foreground text-code');
    expect(cn('text-muted-foreground', 'text-title')).toBe('text-muted-foreground text-title');
    expect(cn('text-muted-foreground', 'text-2xs')).toBe('text-muted-foreground text-2xs');
  });

  it('still dedupes two font-size utilities, keeping only the later one', () => {
    expect(cn('text-xs', 'text-small')).toBe('text-small');
    expect(cn('text-base', 'text-ui')).toBe('text-ui');
    expect(cn('text-sm', 'text-code')).toBe('text-code');
  });

  it('leaves text-foreground-faint classified as a colour token (unregistered on purpose)', () => {
    expect(cn('text-muted-foreground', 'text-foreground-faint')).toBe('text-foreground-faint');
  });
});

/**
 * Decision 170 (issue #6): `text-foreground-soft` is a colour and must stay in
 * the colour group, so it replaces another colour and never a size.
 */
describe('cn with the sidebar region tokens (decision 170)', () => {
  it('treats text-foreground-soft as a colour: it keeps the size and replaces a colour', () => {
    expect(cn('text-small', 'text-foreground-soft')).toBe('text-small text-foreground-soft');
    expect(cn('text-foreground-soft', 'text-small')).toBe('text-foreground-soft text-small');
    expect(cn('text-foreground', 'text-foreground-soft')).toBe('text-foreground-soft');
    expect(cn('text-foreground-soft', 'text-accent-foreground')).toBe('text-accent-foreground');
  });

  it('treats border-muted-foreground-faint (decision 183) as a border colour', () => {
    expect(cn('border-muted-foreground', 'border-muted-foreground-faint')).toBe(
      'border-muted-foreground-faint'
    );
    expect(cn('border', 'border-muted-foreground-faint')).toBe(
      'border border-muted-foreground-faint'
    );
  });
});

/**
 * Decision 174 (issue #6, second wave): the home title's 26px tier
 * `text-display` is a size. Unregistered, twMerge would read it as a colour and
 * drop the title's `text-muted-foreground`.
 */
describe('cn with the home title token (decision 174)', () => {
  it('keeps a colour next to text-display, in either order', () => {
    expect(cn('text-muted-foreground', 'text-display')).toBe('text-muted-foreground text-display');
    expect(cn('text-display', 'text-muted-foreground')).toBe('text-display text-muted-foreground');
    expect(cn('text-foreground', 'text-display')).toBe('text-foreground text-display');
  });

  it('dedupes text-display against the other size tokens', () => {
    expect(cn('text-title', 'text-display')).toBe('text-display');
    expect(cn('text-display', 'text-heading')).toBe('text-heading');
  });

  // Design system v2: text-small / text-heading are sizes, not colours.
  it.each(['text-small', 'text-heading'])('keeps a colour next to %s, in either order', (size) => {
    expect(cn('text-muted-foreground', size)).toBe(`text-muted-foreground ${size}`);
    expect(cn(size, 'text-foreground')).toBe(`${size} text-foreground`);
    expect(cn('text-ui', size)).toBe(size);
  });
});
