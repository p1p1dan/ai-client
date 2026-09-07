// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SettingsCategory } from '../constants';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

const panels = [
  'GeneralSettings',
  'AppearanceSettings',
  'TerminalSettings',
  'TerminalAppearanceSettings',
  'EditorSettings',
  'GitSettings',
  'AISettings',
  'PiModelManagementSettings',
  'PermissionPolicySettings',
  'PiResourcesSettings',
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
      ['PiModelManagementSettings', 'PermissionPolicySettings', 'PiResourcesSettings'],
      ['KeybindingsSettings'],
      ['NetworkSettings', 'RemoteSettings'],
      ['AdvancedSettings', 'WebInspectorSettings'],
    ];
    const buttons = Array.from(container.querySelectorAll('nav button'));
    expect(buttons).toHaveLength(9);
    for (const [index, button] of buttons.entries()) {
      await act(() => (button as HTMLButtonElement).click());
      expect(
        Array.from(container.querySelectorAll('[data-panel]'), (panel) =>
          panel.getAttribute('data-panel')
        )
      ).toEqual(expected[index]);
      expect(button.getAttribute('aria-current')).toBe('page');
      if (index === 5)
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
        createElement(SettingsContent, { activeCategory: 'pi', onCategoryChange: change })
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
