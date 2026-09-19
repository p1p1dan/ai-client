// @vitest-environment happy-dom
import {
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  PROVIDER_IDLE_TIMEOUT_CHOICES,
  PROVIDER_IDLE_TIMEOUT_DISABLED,
} from '@shared/types/providerTimeout';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { ProviderIdleTimeoutSection } from '../PiModelManagementSettings';

/**
 * T093 / decision 029 — the settings half of the provider idle timeout.
 *
 * Mounted rather than asserted as source text because the claim is about a
 * WRITE: the picker's values are strings (`'0'`, `'30000'`), the store holds
 * milliseconds, and every shortcut between the two turns the "off" rung back
 * into the 120 s default. That conversion only runs when the control is real.
 *
 * Only the section is mounted, not the whole model-management page — the page
 * loads the model catalog over IPC on mount, which has nothing to do with this
 * control.
 *
 * The `electronAPI` stub lives in `vi.hoisted` for the reason
 * `subagentPanelMount.test.ts` documents: importing `useSettingsStore` starts
 * zustand persist's rehydrate at module-evaluation time, and a stub installed
 * in `beforeEach` arrives after that promise has already been left unsettled.
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

it('the idle timeout select writes providerIdleTimeoutMs and keeps 0 for "off"', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useSettingsStore.setState({ providerIdleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  // Same open-then-pick sequence `terminalInteraction.test.ts` uses for a Base
  // UI select: the keydown arms the popup, the click commits, and the timeout
  // lets the positioner settle.
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
  const pick = async (label: string) => {
    await click(container.querySelector<HTMLElement>('[data-slot="select-trigger"]')!);
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    // Every rung the shared module offers is offered here: a picker missing
    // the "off" rung would make this test's whole subject unreachable.
    expect(options).toHaveLength(PROVIDER_IDLE_TIMEOUT_CHOICES.length);
    const option = options.find((item) => item.textContent?.trim() === label);
    expect(option, `no option labelled ${label}`).toBeTruthy();
    await click(option!);
  };

  try {
    await act(async () => {
      root.render(createElement(ProviderIdleTimeoutSection));
    });
    // The untouched install shows the number the runtime actually applies.
    expect(container.textContent).toContain('2 minutes');

    await pick('Off');
    // Strict equality, deliberately: `toBeFalsy()` would pass on `undefined`,
    // which is the shape a dropped write has, and the difference between the
    // two is whether requests time out at 120 s behind the user's back.
    expect(useSettingsStore.getState().providerIdleTimeoutMs).toBe(PROVIDER_IDLE_TIMEOUT_DISABLED);
    expect(useSettingsStore.getState().providerIdleTimeoutMs).toBe(0);
    expect(container.textContent).toContain('Off');

    // And back off the "off" rung — a zero that cannot be left would be its
    // own trap.
    await pick('30 seconds');
    expect(useSettingsStore.getState().providerIdleTimeoutMs).toBe(30_000);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    useSettingsStore.setState({ providerIdleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS });
    vi.unstubAllGlobals();
  }
});
