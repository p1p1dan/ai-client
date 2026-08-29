import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../chat/__tests__/stripComments';
import { isSettingsCategory, SETTINGS_CATEGORIES } from '../constants';

/**
 * Every settings category must have a way in and something to show.
 *
 * `SETTINGS_CATEGORIES` is now the one list, so the union and the
 * localStorage validator can no longer disagree. What a type cannot check is
 * the other two halves of a pane: a nav button that opens it, and a branch that
 * renders it. Both are JSX, both fail silently — a category with no nav entry is
 * unreachable, and one with no render branch opens to an empty panel.
 *
 * Scans read CODE, not prose, for the usual reason: a doc comment naming a
 * category should not be able to satisfy the check.
 */

const SETTINGS_CONTENT = join(__dirname, '..', 'SettingsContent.tsx');
const source = stripComments(readFileSync(SETTINGS_CONTENT, 'utf8'), SETTINGS_CONTENT);

describe('settings categories', () => {
  it('gives every category a nav entry', () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(source).toContain(`id: '${category}'`);
    }
  });

  it('gives every category something to render', () => {
    for (const category of SETTINGS_CATEGORIES) {
      expect(source).toContain(`activeCategory === '${category}'`);
    }
  });

  /** The validator that decides whether a restored category is honoured. */
  it('accepts exactly the categories it lists', () => {
    for (const category of SETTINGS_CATEGORIES) expect(isSettingsCategory(category)).toBe(true);
    expect(isSettingsCategory('piPermission')).toBe(false);
    expect(isSettingsCategory(null)).toBe(false);
    expect(isSettingsCategory(undefined)).toBe(false);
  });
});
