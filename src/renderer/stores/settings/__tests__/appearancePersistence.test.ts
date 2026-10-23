// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 1.0.4 field report (Windows tester, 2026-10-08): "every launch I have to set
 * Appearance again".
 *
 * Every case here is a restart: the store is set through the same setter the
 * Appearance page calls, the write lands on a fake settings file, then the
 * module graph is thrown away and the store is imported again — which is what
 * a relaunch does, hydration included. Asserting on the re-imported store is
 * the only way to see a migration that runs on EVERY load rather than once:
 * an in-process `rehydrate()` that skips the module reset would still pass
 * through `migrateSettings`, but a test that never re-reads the file cannot
 * tell "kept" from "never written".
 */

const disk = vi.hoisted(() => ({ value: null as unknown }));
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: {
      read: async () => (disk.value === null ? null : structuredClone(disk.value)),
      write: async (value: unknown) => {
        disk.value = structuredClone(value);
      },
    },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    git: { setAutoFetchEnabled: () => undefined },
    webInspector: { start: async () => ({ success: true }), stop: async () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));

type SettingsModule = typeof import('../index');

/** A fresh process: new module graph, new store, hydrated from `disk`. */
async function launch(): Promise<SettingsModule['useSettingsStore']> {
  vi.resetModules();
  const { useSettingsStore } = await import('../index');
  await vi.waitFor(() => expect(useSettingsStore.persist.hasHydrated()).toBe(true));
  return useSettingsStore;
}

function persistedState(): Record<string, unknown> {
  const file = disk.value as { 'aiclient-settings'?: { state?: Record<string, unknown> } } | null;
  return file?.['aiclient-settings']?.state ?? {};
}

beforeEach(() => {
  disk.value = null;
  localStorage.clear();
  document.documentElement.className = '';
});

describe('Appearance settings survive a restart', () => {
  it.each([
    'light',
    'dark',
    'system',
    'sync-terminal',
  ] as const)('theme mode "%s" is still selected after relaunch', async (theme) => {
    // Start from a different mode so the write is a real change.
    disk.value = {
      'aiclient-settings': { state: { theme: theme === 'dark' ? 'light' : 'dark' }, version: 0 },
    };
    const first = await launch();
    first.getState().setTheme(theme);
    await vi.waitFor(() => expect(persistedState().theme).toBe(theme));

    const second = await launch();
    expect(second.getState().theme).toBe(theme);
  });

  it('every field the Appearance page writes comes back unchanged', async () => {
    const first = await launch();
    const s = first.getState();
    s.setTheme('system');
    s.setChatFontFamily('Fira Sans');
    s.setChatBodyFontSize(19);
    s.setChatProcessFontSize(15);
    s.setBackgroundImageEnabled(true);
    s.setBackgroundSourceType('folder');
    s.setBackgroundFolderPath('/tmp/backgrounds');
    s.setBackgroundImagePath('/tmp/backgrounds/one.png');
    s.setBackgroundUrlPath('https://example.invalid/bg.png');
    s.setBackgroundRandomEnabled(true);
    s.setBackgroundRandomInterval(600);
    s.setBackgroundOpacity(0.5);
    s.setBackgroundBlur(4);
    s.setBackgroundBrightness(1.2);
    s.setBackgroundSaturation(0.8);
    s.setBackgroundSizeMode('contain');
    const expected = {
      theme: 'system',
      chatFontFamily: 'Fira Sans',
      chatBodyFontSize: 19,
      chatProcessFontSize: 15,
      backgroundImageEnabled: true,
      backgroundSourceType: 'folder',
      backgroundFolderPath: '/tmp/backgrounds',
      backgroundImagePath: '/tmp/backgrounds/one.png',
      backgroundUrlPath: 'https://example.invalid/bg.png',
      backgroundRandomEnabled: true,
      backgroundRandomInterval: 600,
      backgroundOpacity: 0.5,
      backgroundBlur: 4,
      backgroundBrightness: 1.2,
      backgroundSaturation: 0.8,
      backgroundSizeMode: 'contain',
    };
    await vi.waitFor(() => expect(persistedState()).toMatchObject(expected));

    const second = await launch();
    expect(second.getState()).toMatchObject(expected);
  });

  it('an unrecognised persisted theme falls back to the default instead of being applied', async () => {
    disk.value = { 'aiclient-settings': { state: { theme: 'neon' }, version: 0 } };
    const store = await launch();
    expect(store.getState().theme).toBe('light');
  });

  it('a restart with no change in between does not rewrite the theme on its own', async () => {
    disk.value = { 'aiclient-settings': { state: { theme: 'system' }, version: 0 } };
    const first = await launch();
    expect(first.getState().theme).toBe('system');
    // Any later save writes the whole store back; it must carry the same mode.
    first.getState().setChatFontFamily('Fira Sans');
    await vi.waitFor(() => expect(persistedState().chatFontFamily).toBe('Fira Sans'));
    expect(persistedState().theme).toBe('system');
  });
});

/**
 * Design system v2 (user ruling 2026-10-21): chat sizes saved under the old
 * 17 / 14 scale are reset once to the current defaults (13 / 12 since scale version 3). One-shot across restarts: after the
 * reset, a size the user picks again must survive the next launch.
 */
describe('v2 chat type scale: saved sizes are reset once', () => {
  it('an old-scale file comes up on the v2 defaults', async () => {
    disk.value = {
      'aiclient-settings': {
        state: { chatBodyFontSize: 17, chatProcessFontSize: 14, chatFontFamily: 'Fira Sans' },
        version: 0,
      },
    };
    const store = await launch();
    expect(store.getState()).toMatchObject({
      chatBodyFontSize: 13,
      chatProcessFontSize: 12,
      chatTypographyScaleVersion: 3,
      // Only the two sizes are reset; the family is the user's own pick.
      chatFontFamily: 'Fira Sans',
    });
  });

  it('a size picked after the reset survives the next launch', async () => {
    disk.value = {
      'aiclient-settings': { state: { chatBodyFontSize: 17, chatProcessFontSize: 14 }, version: 0 },
    };
    const first = await launch();
    first.getState().setChatBodyFontSize(16);
    await vi.waitFor(() =>
      expect(persistedState()).toMatchObject({
        chatBodyFontSize: 16,
        chatTypographyScaleVersion: 3,
      })
    );

    const second = await launch();
    expect(second.getState().chatBodyFontSize).toBe(16);
  });
});
