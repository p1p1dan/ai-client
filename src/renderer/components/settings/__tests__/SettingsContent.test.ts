// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SettingsCategory } from '../constants';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

// Several panels reach into `useSettingsStore` (e.g. `AppearanceSettings`,
// and `@/i18n` itself reads the language from it). Importing that
// store triggers zustand persist's auto-rehydrate at module-evaluation time,
// before any hook runs, and rehydrate hydrates through
// `window.electronAPI.settings`. Without a stub here from the start, that
// hydrate promise never settles and `beforeAll` hangs before the first test
// even starts. The base stub has to live in `vi.hoisted`, not `beforeAll` —
// `beforeAll` runs too late, after the dynamic import below already pulled in
// every unmocked panel.
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));

// Every panel `SettingsContent.tsx` actually imports, in source order. Every
// entry here must stay mocked — an entry left out renders the real panel
// (and whatever store/IPC it touches) instead of exercising navigation.
const panels = [
  'GeneralSettings',
  'AppearanceSettings',
  'TerminalSettings',
  'TerminalAppearanceSettings',
  'EditorSettings',
  'GitSettings',
  'AISettings',
  'AgentMigrationSettings',
  'ConversationImportSettings',
  'UserProvidersSettings',
  'PiModelManagementSettings',
  'PermissionPolicySettings',
  'PiResourcesSettings',
  'DshPluginsSettings',
  'LegacyAssetsSettings',
  'KeybindingsSettings',
  'NetworkSettings',
  'RemoteSettings',
  'AdvancedSettings',
  'WebInspectorSettings',
];

let SettingsContent: typeof import('../SettingsContent')['SettingsContent'];
let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const name of panels) {
    vi.doMock(`../${name}`, () => ({
      [name]: ({ repoPath }: { repoPath?: string }) =>
        createElement('div', { 'data-panel': name, 'data-repo': repoPath }),
    }));
  }
  ({ SettingsContent } = await import('../SettingsContent'));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

describe('settings navigation', () => {
  it('opens every category with its intended panels and keeps the repository scope', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(() => root.render(createElement(SettingsContent, { repoPath: '/workspace/repo' })));
    const expected = [
      ['GeneralSettings'],
      ['AppearanceSettings'],
      ['TerminalSettings', 'TerminalAppearanceSettings'],
      ['EditorSettings'],
      ['GitSettings', 'AISettings'],
      ['UserProvidersSettings', 'PiModelManagementSettings'],
      // dsh-rebase P1-16e (decision 104): skills, then the allowlisted DSH
      // plugins (P1-10c), then the legacy-asset entry; no sub-agent page, no
      // pi extension page.
      ['PiResourcesSettings', 'DshPluginsSettings', 'LegacyAssetsSettings'],
      ['AgentMigrationSettings', 'ConversationImportSettings'],
      ['KeybindingsSettings'],
      ['NetworkSettings', 'RemoteSettings'],
      ['AdvancedSettings', 'PermissionPolicySettings', 'WebInspectorSettings'],
    ];
    const buttons = Array.from(container.querySelectorAll('nav button'));
    expect(buttons).toHaveLength(11);
    for (const [index, button] of buttons.entries()) {
      await act(() => (button as HTMLButtonElement).click());
      expect(
        Array.from(container.querySelectorAll('[data-panel]'), (panel) =>
          panel.getAttribute('data-panel')
        )
      ).toEqual(expected[index]);
      expect(button.getAttribute('aria-current')).toBe('page');
      // P1-16e: the legacy-asset entry checks the open workspace's project
      // files (decision 104 rule 2), so it is scoped to the repository too.
      if (expected[index]?.includes('LegacyAssetsSettings'))
        expect(
          container.querySelector('[data-panel="LegacyAssetsSettings"]')?.getAttribute('data-repo')
        ).toBe('/workspace/repo');
      // The policy panel rides on `advanced` — the last entry.
      if (index === expected.length - 1)
        expect(
          container
            .querySelector('[data-panel="PermissionPolicySettings"]')
            ?.getAttribute('data-repo')
        ).toBe('/workspace/repo');
    }
  });

  it('notifies its owner and honors a restored category', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const change = vi.fn<(category: SettingsCategory) => void>();
    await act(() =>
      root.render(
        createElement(SettingsContent, { activeCategory: 'extensions', onCategoryChange: change })
      )
    );
    expect(container.querySelector('[data-panel="PiResourcesSettings"]')).not.toBeNull();
    const terminal = Array.from(container.querySelectorAll('nav button')).find(
      (button) => button.textContent === 'Terminal'
    ) as HTMLButtonElement;
    await act(() => terminal.click());
    expect(change).toHaveBeenCalledExactlyOnceWith('terminal');
    await act(() =>
      root.render(
        createElement(SettingsContent, { activeCategory: 'terminal', onCategoryChange: change })
      )
    );
    expect(container.querySelector('[data-panel="TerminalSettings"]')).not.toBeNull();
    expect(container.querySelector('[data-panel="PiResourcesSettings"]')).toBeNull();
  });
});
