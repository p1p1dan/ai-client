// @vitest-environment happy-dom
import type { DshPluginsState, DshPluginView } from '@shared/dshPluginSettings';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-10c (topic §4.4, decision 117) — Settings → Extensions →
 * Plugins, mounted: one row per allowlisted plugin with its facts and a
 * switch, the engine's last word on each, the "takes effect at the next
 * engine start" notice after a switch, and nothing to install or remove.
 * P1-7e e5 (decision 143): and the page following the engine's restarts.
 */

// Anything that imports `useSettingsStore` rehydrates zustand persist at
// module-evaluation time through `window.electronAPI.settings`; without this
// stub from the very start the suite hangs, so it lives in `vi.hoisted`.
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
const i18n = {
  t: (key: string, params?: Record<string, string | number>) =>
    params ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name])) : key,
  locale: 'en',
};
vi.mock('@/i18n', () => ({ useI18n: () => i18n }));

import { DshPluginsSettings } from '../DshPluginsSettings';

function plugin(extra: Partial<DshPluginView> = {}): DshPluginView {
  return {
    name: 'dsh-office-tools',
    version: '1.0.4',
    kind: 'internal',
    defaultEnabled: false,
    description: 'DSH model-facing Office tools',
    readTools: ['excel_read', 'ppt_read', 'word_read'],
    writeTools: ['excel_create', 'word_create'],
    askTools: [],
    unlistedToolsAsk: false,
    review: { date: '2026-09-28', verdict: 'conditional' },
    enabled: false,
    overridden: false,
    host: { state: 'disabled' },
    pendingRestart: false,
    ...extra,
  };
}

function snapshot(extra: Partial<DshPluginsState> = {}): DshPluginsState {
  return {
    plugins: [plugin()],
    delisted: [],
    hostReported: true,
    selectionInvalid: false,
    catalogError: null,
    ...extra,
  };
}

/** P1-7e e5: the page's subscription to Main's pushes; `push` stands in for Main. */
const pushes = {
  listeners: new Set<(state: DshPluginsState) => void>(),
  unsubscribed: 0,
};

async function push(state: DshPluginsState): Promise<void> {
  await act(async () => {
    for (const listener of pushes.listeners) listener(state);
  });
}

const api = {
  list: vi.fn<() => Promise<DshPluginsState>>(),
  setEnabled: vi.fn<(name: string, enabled: boolean) => Promise<DshPluginsState>>(),
  onChanged: vi.fn((listener: (state: DshPluginsState) => void) => {
    pushes.listeners.add(listener);
    return () => {
      pushes.unsubscribed += 1;
      pushes.listeners.delete(listener);
    };
  }),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  pushes.listeners.clear();
  pushes.unsubscribed = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.list.mockResolvedValue(snapshot());
  window.electronAPI = {
    ...window.electronAPI,
    dshPlugins: api,
  } as unknown as typeof window.electronAPI;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function text(): string {
  return container.textContent ?? '';
}

function switches(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="switch"]')];
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(): Promise<void> {
  // Async act: the mount effect's `list()` resolves in a microtask, and the
  // state it sets must land inside act.
  await act(async () => root.render(createElement(DshPluginsSettings)));
  await settle();
}

const RESTART_NOTICE =
  'Plugin changes take effect the next time the chat engine starts. If it is running, it restarts on its own once no chat has work in progress.';

describe('DshPluginsSettings', () => {
  it('[PLS-01] shows each plugin’s name, version, summary, source and review', async () => {
    await render();
    expect(text()).toContain('dsh-office-tools');
    expect(text()).toContain('1.0.4');
    // Our own summary, not the package's English description.
    expect(text()).toContain(
      'Create, read and update Word, Excel and PowerPoint files in the workspace.'
    );
    expect(text()).not.toContain('DSH model-facing Office tools');
    expect(text()).toContain('Third-party plugin, reviewed by this app');
    expect(text()).toContain('Reviewed 2026-09-28: approved with conditions');
  });

  it('[PLS-02] flags the tools that write files, apart from the ones that read', async () => {
    await render();
    expect(text()).toContain('Writes files');
    expect(text()).toContain('excel_create, word_create');
    expect(text()).toContain('Reads files');
    expect(text()).toContain('excel_read, ppt_read, word_read');
    const writeBadge = [...container.querySelectorAll('[data-slot="badge"]')].find((node) =>
      node.textContent?.includes('Writes files')
    );
    expect(writeBadge?.className).toContain('text-warning');
  });

  it('[PLS-03] offers one switch per plugin and nothing to install or remove', async () => {
    api.list.mockResolvedValue(
      snapshot({ plugins: [plugin(), plugin({ name: 'dsh-other', kind: 'official' })] })
    );
    await render();
    expect(switches()).toHaveLength(2);
    // The only inputs are the switches' own hidden checkboxes: no install box.
    expect(container.querySelectorAll('input:not([type="checkbox"])')).toHaveLength(0);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    // And no button at all: nothing to install, remove or refresh.
    expect(container.querySelectorAll('button:not([role="switch"])')).toHaveLength(0);
    expect(text()).toContain('Official DSH plugin');
    // The package description is the fallback for a plugin without our own summary.
    expect(text()).toContain('DSH model-facing Office tools');
  });

  it('[PLS-04] switching stores the choice and says when it takes effect', async () => {
    api.setEnabled.mockResolvedValue(
      snapshot({ plugins: [plugin({ enabled: true, overridden: true, pendingRestart: true })] })
    );
    await render();
    expect(text()).not.toContain(RESTART_NOTICE);
    const toggle = switches()[0];
    expect(toggle?.hasAttribute('data-checked')).toBe(false);
    await act(async () => toggle?.click());
    await settle();
    expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith('dsh-office-tools', true);
    expect(switches()[0]?.hasAttribute('data-checked')).toBe(true);
    expect(text()).toContain(RESTART_NOTICE);
    expect(text()).toContain('Restart pending');
  });

  it('[PLS-05] names the switch after its plugin', async () => {
    await render();
    const labelledBy = switches()[0]?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(container.querySelector(`[id="${labelledBy}"]`)?.textContent).toBe('dsh-office-tools');
  });

  it('[PLS-06] shows what the engine did at its last start, with the reason', async () => {
    api.list.mockResolvedValue(
      snapshot({
        plugins: [
          plugin({ name: 'dsh-a', enabled: true, host: { state: 'loaded' } }),
          plugin({ name: 'dsh-b', host: { state: 'disabled' } }),
          plugin({
            name: 'dsh-c',
            enabled: true,
            host: { state: 'rejected', reason: 'declares no dsh.bundle.patch' },
          }),
          plugin({
            name: 'dsh-d',
            enabled: true,
            host: { state: 'missing', reason: 'not in the install directory' },
          }),
          plugin({ name: 'dsh-e', enabled: true, host: { state: 'loaded', inactiveRows: ['x'] } }),
        ],
      })
    );
    await render();
    expect(text()).toContain('Loaded');
    expect(text()).toContain('Switched off');
    expect(text()).toContain('Refused to load');
    expect(text()).toContain('Reason: declares no dsh.bundle.patch');
    expect(text()).toContain('Missing from the install');
    expect(text()).toContain('Reason: not in the install directory');
    expect(text()).toContain('Loaded, but part of it did not start: x');
    // Nothing disagrees with the switches, so no restart is claimed.
    expect(text()).not.toContain(RESTART_NOTICE);
  });

  it('[PLS-07] says a restart is pending when the last start disagrees', async () => {
    api.list.mockResolvedValue(
      snapshot({ plugins: [plugin({ enabled: true, pendingRestart: true })] })
    );
    await render();
    expect(text()).toContain('Restart pending');
    expect(text()).toContain(RESTART_NOTICE);
  });

  it('[PLS-08] before the engine has started, shows no state and says why', async () => {
    api.list.mockResolvedValue(
      snapshot({ hostReported: false, plugins: [plugin({ host: null })] })
    );
    await render();
    expect(text()).toContain(
      'The chat engine has not started since the app opened, so what it loaded is not shown yet.'
    );
    expect(text()).not.toContain('Switched off');
  });

  it('[PLS-09] shows an empty state when this build ships no plugin', async () => {
    api.list.mockResolvedValue(snapshot({ plugins: [] }));
    await render();
    expect(text()).toContain('No plugins available');
    expect(text()).toContain('This version ships without any plugins.');
    expect(switches()).toHaveLength(0);
  });

  it('[PLS-10] lists plugins this build no longer ships, with the engine’s reason', async () => {
    api.list.mockResolvedValue(
      snapshot({
        delisted: [
          { name: 'dsh-gone', reason: 'not on the allowlist' },
          { name: 'dsh-quiet', reason: null },
        ],
      })
    );
    await render();
    expect(text()).toContain('No longer available');
    expect(text()).toContain('dsh-gone');
    expect(text()).toContain('Reason: not on the allowlist');
    expect(text()).toContain('dsh-quiet');
    expect(switches()).toHaveLength(1);
  });

  it('[PLS-11] shows failures instead of an empty list', async () => {
    api.list.mockResolvedValue(
      snapshot({ plugins: [], catalogError: 'allowlist.json is unreadable' })
    );
    await render();
    expect(text()).toContain('The plugin list could not be read: allowlist.json is unreadable');
    expect(text()).not.toContain('No plugins available');

    await act(() => root.unmount());
    root = createRoot(container);
    api.list.mockRejectedValue(new Error('bridge down'));
    await render();
    expect(text()).toContain('bridge down');
  });

  it('[PLS-12] keeps the switch where it was when saving fails', async () => {
    api.setEnabled.mockRejectedValue(new Error('disk full'));
    await render();
    await act(async () => switches()[0]?.click());
    await settle();
    expect(text()).toContain('disk full');
    expect(switches()[0]?.hasAttribute('data-checked')).toBe(false);
    expect(text()).not.toContain(RESTART_NOTICE);
  });

  it('[PLS-13] warns when the engine could not read the plugin settings', async () => {
    api.list.mockResolvedValue(snapshot({ selectionInvalid: true }));
    await render();
    expect(text()).toContain(
      'The chat engine could not read the plugin settings when it last started, so it loaded no plugin.'
    );
  });

  /**
   * P1-7e e5 (problem 29, decision 143): the engine restarts on its own after
   * a switch, and Main pushes what the new start loaded. The page follows it:
   * the badge turns to Loaded and the notice goes, with no re-entry.
   */
  it('[PLS-15] follows the engine restart a switch caused, without reopening the page', async () => {
    api.setEnabled.mockResolvedValue(
      snapshot({
        plugins: [
          plugin({
            enabled: true,
            overridden: true,
            host: { state: 'disabled' },
            pendingRestart: true,
          }),
        ],
      })
    );
    await render();
    await act(async () => switches()[0]?.click());
    await settle();
    expect(text()).toContain(RESTART_NOTICE);
    expect(text()).toContain('Restart pending');
    expect(text()).toContain('Switched off');

    await push(
      snapshot({
        plugins: [
          plugin({
            enabled: true,
            overridden: true,
            host: { state: 'loaded' },
            pendingRestart: false,
          }),
        ],
      })
    );
    expect(text()).toContain('Loaded');
    expect(text()).not.toContain('Switched off');
    expect(text()).not.toContain('Restart pending');
    expect(text()).not.toContain(RESTART_NOTICE);
    expect(switches()[0]?.hasAttribute('data-checked')).toBe(true);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('[PLS-16] a first engine start while the page is open fills in what it loaded', async () => {
    api.list.mockResolvedValue(
      snapshot({ hostReported: false, plugins: [plugin({ host: null })] })
    );
    await render();
    expect(text()).toContain('The chat engine has not started since the app opened');
    await push(snapshot());
    expect(text()).not.toContain('The chat engine has not started since the app opened');
    expect(text()).toContain('Switched off');
  });

  it('[PLS-17] a push that still disagrees keeps the notice; leaving the page unsubscribes', async () => {
    await render();
    await push(snapshot({ plugins: [plugin({ enabled: true, pendingRestart: true })] }));
    expect(text()).toContain(RESTART_NOTICE);
    expect(pushes.listeners.size).toBe(1);
    await act(() => root.unmount());
    expect(pushes.unsubscribed).toBe(1);
    expect(pushes.listeners.size).toBe(0);
    root = createRoot(container);
  });

  it('[PLS-14] never mentions pi extensions', async () => {
    api.list.mockResolvedValue(
      snapshot({ delisted: [{ name: 'dsh-gone', reason: null }], hostReported: false })
    );
    await render();
    expect(text()).not.toMatch(/\bpi\b/i);
  });
});
