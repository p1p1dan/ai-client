import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Without an explicit @custom-variant, Tailwind's `dark:` utilities key off
 * prefers-color-scheme, while the app's theme toggle keys off a `.dark`
 * class on the root element. The two only happen to agree when the user's
 * theme setting is 'system'. This asserts the class-scoped variant is wired
 * up ahead of the @theme block that consumes it.
 */

const GLOBALS_CSS = join(process.cwd(), 'src/renderer/styles/globals.css');
const DARK_VARIANT_DIRECTIVE = '@custom-variant dark (&:where(.dark, .dark *));';

describe('dark: variant is bound to the .dark class, not prefers-color-scheme', () => {
  it('globals.css declares the custom dark variant before @theme', () => {
    const source = readFileSync(GLOBALS_CSS, 'utf8');
    const variantIndex = source.indexOf(DARK_VARIANT_DIRECTIVE);
    const themeIndex = source.indexOf('@theme {');

    expect(variantIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeGreaterThan(-1);
    expect(variantIndex).toBeLessThan(themeIndex);
  });
});
