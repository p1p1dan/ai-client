// @vitest-environment happy-dom
import type { SubagentCatalogView } from '@shared/types/subagentManagement';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import { PiSubagentsSettings } from '../PiSubagentsSettings';

/**
 * P5-2-5 / SA17 — the page mounts, lists, searches, switches and rolls back.
 *
 * The pure model next door already pins the decisions. What a mount adds is the
 * part no unit test can: Base UI parts that throw only when rendered, and the
 * wiring between a click and the IPC call it is supposed to make. The
 * rollback case is here rather than in the model test for exactly that reason —
 * it is the component that has to put the old view back, and "it does" is only
 * true if the switch is actually wired to that path.
 */

const catalog: SubagentCatalogView = {
  rows: [
    {
      name: 'helper',
      description: 'finds things',
      tools: ['Read', 'Grep'],
      prompt: 'Look.',
      source: 'user',
      filePath: '/agent/subagents/helper.md',
      enabled: true,
    },
    {
      name: 'explorer',
      description: 'reads the codebase',
      tools: ['Read', 'Glob', 'Grep'],
      prompt: 'Explore.',
      source: 'builtin',
      enabled: true,
    },
  ],
  broken: [],
  directory: '/agent/subagents',
  staleDisabled: [],
};

const api = {
  list: vi.fn(async () => catalog),
  save: vi.fn(async () => catalog),
  remove: vi.fn(async () => catalog),
  setEnabled: vi.fn(async () => catalog),
  clearStale: vi.fn(async () => catalog),
  reveal: vi.fn(async () => undefined),
};

// `PiSubagentsSettings` also renders `SubagentPromptCacheTtlRow`, which reads
// and writes `useSettingsStore`. Importing that store triggers zustand
// persist's auto-rehydrate immediately, at module-evaluation time — before any
// `beforeEach` runs — and rehydrate hydrates through `window.electronAPI.settings`.
// Without `settings` here from the start, that hydrate promise never settles
// and the whole suite hangs before the first assertion (`env`/`app` are what
// `onRehydrateStorage` reaches for right after). So the base stub has to live
// in `vi.hoisted`, not `beforeEach` — `beforeEach` runs too late.
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
const i18n = { t: (key: string) => key, locale: 'en' };
vi.mock('@/i18n', () => ({ useI18n: () => i18n }));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
  api.list.mockResolvedValue(catalog);
  api.setEnabled.mockResolvedValue(catalog);
  window.electronAPI = {
    ...window.electronAPI,
    piSubagents: api,
  } as unknown as typeof window.electronAPI;
});

async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PiSubagentsSettings));
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it('lists both sources and marks what ships with the app', async () => {
  const view = await mount();
  try {
    expect(view.container.textContent).toContain('helper');
    expect(view.container.textContent).toContain('explorer');
    expect(view.container.textContent).toContain('Built in');
    // The summary line says the turn cap out loud, including "unlimited",
    // because absent and unlimited are the same thing and a blank would read
    // as "unknown".
    expect(view.container.textContent).toContain('unlimited turns');
  } finally {
    await view.cleanup();
  }
});

it('narrows the list as the user types, without asking Main again', async () => {
  const view = await mount();
  try {
    const search = view.container.querySelector('input');
    if (!search) throw new Error('no search box');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      setter?.call(search, 'explor');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(view.container.textContent).toContain('explorer');
    expect(view.container.textContent).not.toContain('finds things');
    // Searching is local: a keystroke must not become a round trip.
    expect(api.list).toHaveBeenCalledTimes(1);
  } finally {
    await view.cleanup();
  }
});

it('rolls the row back when the switch fails, and says why', async () => {
  api.setEnabled.mockRejectedValueOnce(new Error('disk is read-only'));
  const view = await mount();
  try {
    const toggle = view.container.querySelector('[data-slot="switch"]');
    if (!toggle) throw new Error('no switch');
    await act(async () => {
      (toggle as HTMLElement).click();
    });

    expect(api.setEnabled).toHaveBeenCalledWith('helper', false);
    expect(view.container.textContent).toContain('disk is read-only');
    // The optimistic flip is gone: the row must not keep showing a state it
    // never reached.
    expect(view.container.textContent).not.toContain('Switched off');
  } finally {
    await view.cleanup();
  }
});

it('keeps the list on screen when a reload fails', async () => {
  const view = await mount();
  try {
    expect(view.container.textContent).toContain('helper');
    // A failed refresh must not blank a list the user is reading. Driven
    // through the switch because that is the path that re-reads.
    api.setEnabled.mockRejectedValueOnce(new Error('nope'));
    const toggle = view.container.querySelector('[data-slot="switch"]');
    await act(async () => {
      (toggle as HTMLElement).click();
    });
    expect(view.container.textContent).toContain('helper');
    expect(view.container.textContent).toContain('explorer');
  } finally {
    await view.cleanup();
  }
});

it('opens an editor prefilled from the row', async () => {
  const view = await mount();
  try {
    const edit = view.container.querySelector('[aria-label="Edit {{name}}"]');
    if (!edit) throw new Error('no edit button');
    await act(async () => {
      (edit as HTMLElement).click();
    });
    const textarea = view.container.querySelector('textarea');
    expect(textarea?.value).toBe('Look.');
    const inputs = [...view.container.querySelectorAll('input')].map((input) => input.value);
    expect(inputs).toContain('helper');
    expect(inputs).toContain('finds things');
  } finally {
    await view.cleanup();
  }
});

it('shows a document that does not load instead of hiding it', async () => {
  api.list.mockResolvedValueOnce({
    ...catalog,
    broken: [
      { filePath: '/agent/subagents/bad.md', name: 'bad', errors: ['missing `description`'] },
    ],
  });
  const view = await mount();
  try {
    expect(view.container.textContent).toContain('These documents do not load');
    expect(view.container.textContent).toContain('missing `description`');
    // The rest of the catalog is still usable.
    expect(view.container.textContent).toContain('helper');
  } finally {
    await view.cleanup();
  }
});
