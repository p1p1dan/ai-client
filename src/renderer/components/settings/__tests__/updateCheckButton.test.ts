// @vitest-environment happy-dom
import type { UpdateStatus } from '@shared/types/updater';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUpdaterStore } from '@/stores/updater';
import { GeneralSettings } from '../GeneralSettings';

/**
 * Decision 213: 「检查更新」 stays usable while an update is ready, because a
 * newer release now replaces the ready one. The `electronAPI` stub lives in
 * `vi.hoisted` for the reason `experimentalCacheControlSection.test.ts` gives.
 */
const updater = vi.hoisted(() => {
  const control = { finish: () => {} };
  const status: UpdateStatus = { status: 'downloaded', info: { version: '2.0.0' } };
  const checkForUpdates = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        control.finish = resolve;
      })
  );
  window.electronAPI = {
    env: { platform: 'linux', appVersion: '1.0.4' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    updater: { onStatus: () => () => {}, getStatus: async () => status, checkForUpdates },
  } as unknown as typeof window.electronAPI;
  return { control, checkForUpdates };
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useUpdaterStore.setState({ reminderHidden: false });
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === label);
}

it('checks while an update is ready, names it, and brings back a hidden reminder', async () => {
  useUpdaterStore.setState({ reminderHidden: true });
  await act(async () => root.render(createElement(GeneralSettings)));
  expect(container.textContent).toContain('(Update ready: v2.0.0)');
  expect(button('Check for updates')?.disabled).toBe(false);
  await act(async () => button('Check for updates')!.click());
  expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  expect(useUpdaterStore.getState().reminderHidden).toBe(false);
  // The status stays `downloaded` during this check, so the button itself
  // shows that the check is running.
  expect(button('Checking...')?.disabled).toBe(true);
  await act(async () => updater.control.finish());
  expect(button('Check for updates')?.disabled).toBe(false);
});
