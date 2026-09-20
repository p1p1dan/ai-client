import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHAT_BODY_FONT_SIZE_MAX,
  CHAT_BODY_FONT_SIZE_MIN,
  CHAT_PROCESS_FONT_SIZE_MAX,
  CHAT_PROCESS_FONT_SIZE_MIN,
  DEFAULT_CHAT_BODY_FONT_SIZE,
  DEFAULT_CHAT_PROCESS_FONT_SIZE,
} from '@shared/types/chatTypography';
import { describe, expect, it } from 'vitest';

/**
 * T104: the two runtime-configurable chat tiers, as CSS.
 *
 * These are the repo's only font-size tokens whose value is expected to change
 * at runtime — `ChatWorkspace`'s root `<section>` re-declares both as inline
 * custom properties from the user's settings, and the utilities resolve through
 * `var()`. Everything else about them is ordinary token discipline, which is
 * what this file asserts: a declared value, declared once, in `@theme`.
 *
 * The default here and `DEFAULT_CHAT_*_FONT_SIZE` in
 * `@shared/types/chatTypography` are the same fact spelled in two places (a
 * stylesheet cannot import a TS module), so they are cross-checked rather than
 * trusted. `middleColumnLayout`'s composer height arithmetic is derived from
 * the TS side, which makes a silent divergence between the two a wrong card
 * height rather than a cosmetic difference.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(__dirname, '..', 'globals.css'), 'utf8');

/** The `@theme` block's body, via brace-depth counting (reformatting-proof). */
function themeBlock(css: string): string {
  const start = css.indexOf('@theme {');
  expect(start, '@theme must exist').toBeGreaterThan(-1);
  let depth = 0;
  let bodyStart = -1;
  for (let i = start; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      depth++;
      if (depth === 1) bodyStart = i + 1;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return css.slice(bodyStart, i);
    }
  }
  throw new Error('globals.css: unterminated @theme block');
}

/** The declared value of one custom property, or null when absent. */
function declaredValue(block: string, prop: string): string | null {
  const match = new RegExp(`${prop}:\\s*([^;]+);`).exec(block);
  return match ? (match[1] ?? '').trim() : null;
}

const theme = themeBlock(source);

describe('T104: the chat area’s two size tiers are declared tokens', () => {
  it('declares both tiers in @theme, in px, at D1’s defaults', () => {
    expect(declaredValue(theme, '--text-chat-body')).toBe(`${DEFAULT_CHAT_BODY_FONT_SIZE}px`);
    expect(declaredValue(theme, '--text-chat-process')).toBe(`${DEFAULT_CHAT_PROCESS_FONT_SIZE}px`);
  });

  it('spells them in px, not rem, because the runtime override writes px', () => {
    // A rem default and a px override would leave the same scale expressed two
    // ways; `--text-2xs` above is the existing px precedent.
    for (const prop of ['--text-chat-body', '--text-chat-process']) {
      expect(declaredValue(theme, prop), prop).toMatch(/^\d+px$/);
    }
  });

  it('declares each tier exactly once in @theme', () => {
    // A second declaration would win by source order and silently override the
    // inline value's sibling, which is the one bug class a runtime-applied
    // token is actually exposed to.
    for (const prop of ['--text-chat-body', '--text-chat-process']) {
      const occurrences = theme.split(`${prop}:`).length - 1;
      expect(occurrences, prop).toBe(1);
    }
  });

  it('keeps the stylesheet’s own declaration on :root, never on a scoped node', () => {
    // The override point is `ChatWorkspace`'s section, and it is the only one:
    // a stylesheet rule that set these on something like `.chat-shell` would
    // outrank nothing (inline styles win) but would make the defaults
    // conditional on a class the app may not render.
    const chatRules = source
      .split('\n')
      .filter((line) => /--text-chat-(body|process)\s*:/.test(line) && line.includes('{'));
    expect(chatRules, 'no selector-scoped redeclaration').toEqual([]);
  });

  it('keeps the range constants coherent with the shipped defaults', () => {
    // The defaults have to be inside the clamp range, or the settings page
    // would open showing a value it refuses to store.
    expect(DEFAULT_CHAT_BODY_FONT_SIZE).toBeGreaterThanOrEqual(CHAT_BODY_FONT_SIZE_MIN);
    expect(DEFAULT_CHAT_BODY_FONT_SIZE).toBeLessThanOrEqual(CHAT_BODY_FONT_SIZE_MAX);
    expect(DEFAULT_CHAT_PROCESS_FONT_SIZE).toBeGreaterThanOrEqual(CHAT_PROCESS_FONT_SIZE_MIN);
    expect(DEFAULT_CHAT_PROCESS_FONT_SIZE).toBeLessThanOrEqual(CHAT_PROCESS_FONT_SIZE_MAX);
    // Process ≤ body holds at the defaults too: the shipped pair is 13 ≤ 16.
    expect(DEFAULT_CHAT_PROCESS_FONT_SIZE).toBeLessThanOrEqual(DEFAULT_CHAT_BODY_FONT_SIZE);
  });
});
