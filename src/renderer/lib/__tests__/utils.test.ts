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
    expect(cn('text-muted-foreground', 'text-meta')).toBe('text-muted-foreground text-meta');
    expect(cn('text-muted-foreground', 'text-code')).toBe('text-muted-foreground text-code');
    expect(cn('text-muted-foreground', 'text-markdown')).toBe(
      'text-muted-foreground text-markdown'
    );
    expect(cn('text-muted-foreground', 'text-title')).toBe('text-muted-foreground text-title');
    expect(cn('text-muted-foreground', 'text-2xs')).toBe('text-muted-foreground text-2xs');
  });

  it('still dedupes two font-size utilities, keeping only the later one', () => {
    expect(cn('text-xs', 'text-meta')).toBe('text-meta');
    expect(cn('text-base', 'text-ui')).toBe('text-ui');
    expect(cn('text-sm', 'text-code')).toBe('text-code');
  });

  it('leaves text-tool-arg classified as a colour token (unregistered on purpose)', () => {
    expect(cn('text-muted-foreground', 'text-tool-arg')).toBe('text-tool-arg');
  });
});

/**
 * Decision 170 (issue #6): the 16px tier `text-section` is a size, registered
 * like the D25 tokens; `text-foreground-soft` is a colour and must stay in the
 * colour group, so it replaces another colour and never a size.
 */
describe('cn with the sidebar region tokens (decision 170)', () => {
  it('keeps a colour next to text-section, in either order', () => {
    expect(cn('text-foreground', 'text-section')).toBe('text-foreground text-section');
    expect(cn('text-section', 'text-foreground')).toBe('text-section text-foreground');
    expect(cn('text-muted-foreground', 'text-section')).toBe('text-muted-foreground text-section');
  });

  it('dedupes text-section against the other size tokens', () => {
    expect(cn('text-ui', 'text-section')).toBe('text-section');
    expect(cn('text-section', 'text-meta')).toBe('text-meta');
  });

  it('treats text-foreground-soft as a colour: it keeps the size and replaces a colour', () => {
    expect(cn('text-meta', 'text-foreground-soft')).toBe('text-meta text-foreground-soft');
    expect(cn('text-foreground-soft', 'text-meta')).toBe('text-foreground-soft text-meta');
    expect(cn('text-foreground', 'text-foreground-soft')).toBe('text-foreground-soft');
    expect(cn('text-foreground-soft', 'text-accent-foreground')).toBe('text-accent-foreground');
  });
});
