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
