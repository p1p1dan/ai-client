// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', async () => {
  const defaults = await import('@/stores/settings/defaults');
  const state = {
    xtermKeybindings: defaults.defaultXtermKeybindings,
    editorKeybindings: defaults.defaultEditorKeybindings,
    sourceControlKeybindings: defaults.defaultSourceControlKeybindings,
    searchKeybindings: defaults.defaultSearchKeybindings,
    setXtermKeybindings: vi.fn(),
    setEditorKeybindings: vi.fn(),
    setSourceControlKeybindings: vi.fn(),
    setSearchKeybindings: vi.fn(),
  };
  return { useSettingsStore: Object.assign(() => state, { getState: () => state }) };
});

import { useSettingsStore } from '@/stores/settings';
import { KeybindingsSettings } from '../KeybindingsSettings';

afterEach(() => vi.unstubAllGlobals());

describe('active keybinding controls', () => {
  it('renders all twelve bindings and saves a recorded search shortcut without replacing its sibling', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(() => root.render(createElement(KeybindingsSettings)));
      expect(container.querySelectorAll('[role="button"]')).toHaveLength(12);
      const search = container.querySelector('[aria-label="Search files"]') as HTMLElement;
      await act(() => search.click());
      expect(search.hasAttribute('data-keybinding-recording')).toBe(true);
      await act(() =>
        search.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true })
        )
      );
      const state = useSettingsStore.getState();
      expect(state.setSearchKeybindings).toHaveBeenCalledExactlyOnceWith({
        ...state.searchKeybindings,
        searchFiles: { key: 'k', ctrl: true },
      });
      expect(search.hasAttribute('data-keybinding-recording')).toBe(false);
    } finally {
      await act(() => root.unmount());
      container.remove();
    }
  });
});
