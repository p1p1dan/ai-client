// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { NetworkSettings } from '../NetworkSettings';
import { RemoteSettings } from '../RemoteSettings';

/**
 * The network category renders both panels at once, so a render-time throw in
 * either one takes the whole category down. Base UI Field parts throw when they
 * are used outside a <Field.Root>, and that throw only happens on mount — no
 * type check and no static scan sees it. Mount both panels for real.
 */

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    remote: { listProfiles: async () => [] },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
const i18n = { t: (key: string) => key, locale: 'en' };
vi.mock('@/i18n', () => ({ useI18n: () => i18n }));

it('mounts both network category panels without throwing', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(Fragment, null, createElement(NetworkSettings), createElement(RemoteSettings))
      );
    });
    expect(container.textContent).toContain('Proxy server');
    expect(container.textContent).toContain('SSH Profiles');
    // The four labelled rows are the ones that need a Field root.
    expect(container.querySelectorAll('[data-slot="field"]')).toHaveLength(4);
    expect(container.querySelectorAll('[data-slot="field-label"]')).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
