import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLegacyPresentationModeMirror,
  LEGACY_PRESENTATION_MODE_MIRROR_KEY,
  migrateSettings,
} from '../migration';

vi.mock('@/lib/ghosttyTheme', () => ({}));
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('../storage', () => ({
  electronStorage: {
    // Keep automatic hydration pending; the tests call the migration directly.
    getItem: () => new Promise(() => {}),
  },
}));

/**
 * dsh-rebase P1-11 (decision 127): the GUI / TUI switch went with the pi TUI.
 *
 * `presentationMode` was a persisted setting, mirrored into localStorage so the
 * first render could read it before rehydration. An old profile saved in TUI
 * mode must come back in the chat view — the only view left — and neither copy
 * may linger as state something could read again.
 */

afterEach(() => vi.unstubAllGlobals());

async function currentState() {
  vi.stubGlobal('window', { electronAPI: { env: { platform: 'linux' } } });
  const { useSettingsStore } = await import('../index');
  return useSettingsStore.getState();
}

describe('P1-11 · presentationMode is normalised away', () => {
  it.each([
    'tui',
    'gui',
    'something-else',
  ])("drops a persisted presentationMode of '%s' on load", async (value) => {
    const current = await currentState();
    const migrated = migrateSettings(
      { presentationMode: value, language: 'zh' } as never,
      current
    ) as unknown as Record<string, unknown>;
    expect(migrated).not.toHaveProperty('presentationMode');
    // Nothing else is lost with it.
    expect(migrated.language).toBe('zh');
  });

  it('the store has no presentationMode field or setter to restore it into', async () => {
    const current = (await currentState()) as unknown as Record<string, unknown>;
    expect(current).not.toHaveProperty('presentationMode');
    expect(current).not.toHaveProperty('setPresentationMode');
  });

  it('removes the stale localStorage mirror', () => {
    const removed: string[] = [];
    clearLegacyPresentationModeMirror({ removeItem: (key) => removed.push(key) });
    expect(removed).toEqual([LEGACY_PRESENTATION_MODE_MIRROR_KEY]);
    expect(LEGACY_PRESENTATION_MODE_MIRROR_KEY).toBe('aiclient-presentation-mode');
  });

  it('tolerates a storage that throws, or none at all', () => {
    expect(() =>
      clearLegacyPresentationModeMirror({
        removeItem: () => {
          throw new Error('denied');
        },
      })
    ).not.toThrow();
    expect(() => clearLegacyPresentationModeMirror(undefined)).not.toThrow();
  });

  it('clears the mirror when the persisted settings rehydrate', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const rehydrate = source.slice(source.indexOf('onRehydrateStorage'));
    expect(rehydrate).toContain('clearLegacyPresentationModeMirror()');
    expect(source).not.toContain('readPresentationMode');
    expect(source).not.toContain('writePresentationMode');
  });
});
