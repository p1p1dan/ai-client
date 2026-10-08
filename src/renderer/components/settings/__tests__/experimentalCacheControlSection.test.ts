// @vitest-environment happy-dom
import { DEFAULT_CACHE_CONTROL_ON_TOOLS } from '@shared/types/cacheControlOnTools';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { ExperimentalCacheControlSection } from '../ExperimentalCacheControlSection';

/**
 * GW-16 temporary switch (dsh-rebase decisions 149 rule 19, 159): the settings
 * half. The store starts off (the plan's own default) and the switch writes the
 * boolean Main reads into the model plan.
 *
 * The `electronAPI` stub lives in `vi.hoisted`: importing `useSettingsStore`
 * starts zustand persist's rehydrate at module-evaluation time (see
 * `providerIdleTimeoutSection.test.ts`).
 */
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

it('starts off, says it is experimental and temporary, and writes the switch to the store', async () => {
  // Untouched install: the store's default is the plan's default, off.
  expect(DEFAULT_CACHE_CONTROL_ON_TOOLS).toBe(false);
  expect(useSettingsStore.getState().experimentalCacheControlOnTools).toBe(false);

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const toggle = () => container.querySelector<HTMLElement>('[role="switch"]');
  try {
    await act(async () => {
      root.render(createElement(ExperimentalCacheControlSection));
    });
    expect(container.textContent).toContain('Cache breakpoint on tool definitions');
    expect(container.textContent).toContain('Experimental · temporary');
    expect(container.textContent).toContain('at most 2 cache_control marks per request; on: 3');
    expect(container.textContent).toContain('Takes effect from the next turn; no restart needed.');
    expect(toggle()?.getAttribute('aria-label')).toBe('Cache tool definitions');
    expect(toggle()?.hasAttribute('data-checked')).toBe(false);

    await act(async () => toggle()?.click());
    expect(useSettingsStore.getState().experimentalCacheControlOnTools).toBe(true);
    expect(toggle()?.hasAttribute('data-checked')).toBe(true);

    await act(async () => toggle()?.click());
    expect(useSettingsStore.getState().experimentalCacheControlOnTools).toBe(false);
    expect(toggle()?.hasAttribute('data-checked')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useSettingsStore.setState({ experimentalCacheControlOnTools: false });
    vi.unstubAllGlobals();
  }
});
