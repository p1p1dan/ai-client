import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composerModelSuffixClass } from '../middleColumnLayout';

/**
 * T-30b2 F-A17: the merged trigger's two-tone label leans on a weight
 * difference as well as a colour one — the model name is quiet, the effort
 * suffix is darker AND heavier.
 *
 * The weight half only works on a proportional font stack. Under an
 * all-monospace UI stack `font-medium` (500) is a no-op, because most system
 * monospace faces ship 400 and 700 only, so the emphasis silently collapses to
 * a single dimension. That makes the font-domain split a hard PREREQUISITE of
 * this styling rather than a neighbouring concern, which is why the ordering
 * is asserted here in the same suite instead of being left as a note.
 */

const GLOBALS_CSS = join(process.cwd(), 'src/renderer/styles/globals.css');

function readThemeToken(source: string, token: string): string {
  const match = source.match(new RegExp(`\\n\\s*${token}:\\s*([\\s\\S]*?);`));
  if (!match) throw new Error(`token ${token} not found in globals.css`);
  return match[1];
}

describe('F-A17: two-tone model label depends on the proportional UI stack', () => {
  // Ordered first on purpose: if the UI stack is still monospace, the weight
  // assertion below is meaningless and this failure is the honest report.
  it('the UI font stack is proportional — its first entry is not a monospace family', () => {
    const source = readFileSync(GLOBALS_CSS, 'utf8');
    const fontSans = readThemeToken(source, '--font-sans');
    const firstEntry = fontSans
      .split(',')
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)[0];

    expect(firstEntry).toBeTruthy();
    expect(firstEntry).not.toBe('ui-monospace');
    expect(firstEntry.toLowerCase()).not.toContain('mono');
    // The two domains have to be genuinely different stacks, not aliases.
    expect(fontSans).not.toBe(readThemeToken(source, '--font-mono'));
  });

  it('the effort suffix carries the heavier weight', () => {
    expect(composerModelSuffixClass()).toContain('font-medium');
    expect(composerModelSuffixClass()).toContain('text-foreground');
  });
});
