// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { TerminalAppearanceSettings } from '../TerminalAppearanceSettings';
import { TerminalSettings } from '../TerminalSettings';

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
it('mounts terminal settings and appearance with real controls', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', {
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined },
    env: { platform: 'linux' },
    shell: { detect: async () => [] },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(TerminalSettings));
    });
    expect(container.textContent).toContain('Shell');
    const click = async (element: HTMLElement) => {
      await act(async () => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      await act(async () => {
        element.click();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
    };
    await click(container.querySelector<HTMLElement>('[data-slot="select-trigger"]')!);
    await click(
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) =>
        item.textContent?.includes('Custom')
      )!
    );
    expect(useSettingsStore.getState().shellConfig.shellType).toBe('custom');
    expect(container.querySelectorAll('input').length).toBeGreaterThanOrEqual(2);
    const renderer = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="select-trigger"]')
    ).find((item) => item.textContent?.includes('DOM'))!;
    await click(renderer);
    await click(
      Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) =>
        item.textContent?.includes('WebGL')
      )!
    );
    expect(useSettingsStore.getState().terminalRenderer).toBe('webgl');
    await act(() => root.render(createElement(TerminalAppearanceSettings)));
    expect(container.textContent).toContain('Preview');
    await click(container.querySelector<HTMLElement>('[data-slot="combobox-trigger"]')!);
    expect(document.querySelector('[data-slot="combobox-popup"]')).not.toBeNull();
    await act(async () => {
      document
        .querySelector('[data-slot="combobox-input"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
      root.render(createElement('div', null, 'Other settings'));
    });
    await act(async () => {
      root.render(createElement(TerminalSettings));
    });
    expect(container.textContent).toContain('WebGL');
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
