// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoCompactionPolicy } from '@shared/dshAutoCompaction';
import type { AgentModelCatalog, AgentModelOption } from '@shared/types/agentCatalog';
import type { UserModelMeta, UserProviderState } from '@shared/userProviders';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase decision 177 — the automatic compaction note: one sentence per
 * model in the custom service's model settings panel (decision 168) and in
 * the models page's list, from the shared rules the host configures DSH with.
 */

// Substitutes `{{token}}` the way `translate()` does, so the sentences are checked filled in.
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? key.replace(/\{\{(\w+)\}\}/g, (match, token: string) =>
            token in params ? String(params[token]) : match
          )
        : key,
    locale: 'en',
  }),
}));

import { AutoCompactionSection } from '../AutoCompactionSection';
import { formatApproxTokens } from '../autoCompactionText';
import { ModelSettingsPanel, type TokenDrafts } from '../ModelSettingsPanel';
import { UserProvidersSettings } from '../UserProvidersSettings';

const listPiModels = vi.fn<() => Promise<AgentModelCatalog>>();
const userProviders = {
  get: vi.fn<() => Promise<UserProviderState>>(),
  upsert: vi.fn(),
  remove: vi.fn(),
  setEnabled: vi.fn(),
  fetchModels: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    chat: { listPiModels },
    userProviders,
    env: { platform: 'linux' },
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Render, then let the IPC promises the effects started settle inside the same act. */
async function mount(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('formatApproxTokens', () => {
  it('says the threshold round', () => {
    expect(formatApproxTokens(800_000)).toBe('800k');
    expect(formatApproxTokens(1_200_000)).toBe('1.2M');
    expect(formatApproxTokens(1_000_000)).toBe('1M');
    expect(formatApproxTokens(33_751)).toBe('34k');
    expect(formatApproxTokens(9_175)).toBe('9.2k');
    expect(formatApproxTokens(4_000)).toBe('4k');
    expect(formatApproxTokens(512)).toBe('512');
  });
});

describe('the model settings panel (decision 168) says how the model compacts', () => {
  async function renderPanel(meta: UserModelMeta, drafts: TokenDrafts = {}): Promise<void> {
    await act(() =>
      root.render(
        createElement(ModelSettingsPanel, {
          models: ['m'],
          activeId: 'm',
          onActiveChange: () => undefined,
          api: 'openai-completions',
          meta: { m: meta },
          drafts: { m: drafts },
          onPatch: () => undefined,
          onTokenDraft: () => undefined,
          onReset: () => undefined,
          onRemove: () => undefined,
        })
      )
    );
  }

  function note(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-slot="auto-compaction"]');
  }

  it('gives the threshold on the default window, and says it is the default', async () => {
    await renderPanel({});
    expect(note()?.textContent).toBe(
      'Automatic compaction: starts at about 54k tokens (worked out on the default context window, 128000).'
    );
    expect(note()?.dataset.auto).toBe('on');
    expect(note()?.className).toContain('text-muted-foreground');
  });

  it('turns a 64k window on with its own threshold', async () => {
    await renderPanel({ contextWindow: 65536 });
    expect(note()?.textContent).toBe('Automatic compaction: starts at about 34k tokens.');
  });

  it('says a 32k window is too small, as a warning', async () => {
    await renderPanel({ contextWindow: 32768 });
    expect(note()?.dataset.auto).toBe('off');
    expect(note()?.className).toContain('text-warning');
    expect(note()?.textContent).toBe(
      'No automatic compaction for this model: its context window (32768) is too small to leave room for it. A conversation that outgrows the window is still compacted and retried; for long tasks, pick a model with a larger window.'
    );
  });

  it('says how far to lower an output limit that eats the window', async () => {
    await renderPanel({ contextWindow: 65536, maxTokens: 32768 });
    expect(note()?.textContent).toBe(
      'No automatic compaction for this model: the output limit (32768) takes up too much of the context window (65536). Set the output limit to 26527 or less to turn it on.'
    );
    await renderPanel({ maxTokens: 100000 });
    expect(note()?.textContent).toBe(
      'No automatic compaction for this model: the output limit (100000) takes up too much of the default context window (128000). Fill in the real context window, or set the output limit to 88991 or less.'
    );
  });

  it('works from the output the plan will send (decision 146), beside its warning', async () => {
    // 150000 over half of 200000: planned as 50000.
    await renderPanel({ contextWindow: 200000, maxTokens: 150000 });
    expect(container.textContent).toContain('the reply reservation is planned as 50000 tokens');
    const expected = autoCompactionPolicy({ contextWindow: 200000, maxTokens: 50000 });
    expect(expected?.auto && formatApproxTokens(expected.thresholdTokens)).toBe('84k');
    expect(note()?.textContent).toBe('Automatic compaction: starts at about 84k tokens.');
  });

  it('says nothing while a number is not valid', async () => {
    await renderPanel({ contextWindow: 65536 }, { maxTokens: '32k' });
    expect(note()).toBeNull();
    expect(container.textContent).toContain('Enter a whole number greater than 0.');
  });
});

function option(
  id: string,
  label: string,
  contextWindow: number,
  maxTokens: number
): AgentModelOption {
  const policy = autoCompactionPolicy({ contextWindow, maxTokens });
  if (!policy) throw new Error('sized');
  return { id, label, autoCompaction: { ...policy, contextWindowDefaulted: false } };
}

function catalog(models: AgentModelOption[]): AgentModelCatalog {
  return { models, source: 'local', stale: false, fetchedAt: null };
}

describe("the models page's automatic compaction list", () => {
  function rows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('li[data-model]')];
  }

  it('lists every offered model with its sentence, the ones without a policy left out', async () => {
    listPiModels.mockResolvedValue(
      catalog([
        option('claude/sonnet', 'Claude Sonnet', 1_000_000, 128_000),
        option('own/small', 'Small', 32_768, 4096),
        { id: 'legacy/x', label: 'No plan' },
        option('own/w64k', 'W64k', 65_536, 8192),
      ])
    );
    await mount(createElement(AutoCompactionSection));
    await settle();

    expect(container.textContent).toContain('Automatic compaction');
    expect(rows().map((row) => row.dataset.model)).toEqual([
      'claude/sonnet',
      'own/small',
      'own/w64k',
    ]);
    expect(rows().map((row) => row.dataset.auto)).toEqual(['on', 'off', 'on']);
    expect(rows()[0]?.textContent).toBe(
      'Claude SonnetAutomatic compaction: starts at about 800k tokens.'
    );
    const small = rows()[1];
    expect(small?.querySelector('.text-warning')?.textContent).toContain(
      'its context window (32768) is too small'
    );
    expect(small?.querySelector('[title]')?.getAttribute('title')).toBe('own/small');
    expect(container.textContent).toContain('edit it under AI services above');
  });

  it('shows nothing when no offered model has a policy', async () => {
    listPiModels.mockResolvedValue(catalog([{ id: 'legacy/x', label: 'No plan' }]));
    await mount(createElement(AutoCompactionSection));
    await settle();
    expect(container.textContent).toBe('');
  });

  it('reads the menu again when its reload key changes', async () => {
    listPiModels.mockResolvedValue(catalog([option('a/b', 'B', 65_536, 8192)]));
    await mount(createElement(AutoCompactionSection, { reloadKey: '0:0' }));
    await settle();
    listPiModels.mockResolvedValue(catalog([option('a/b', 'B', 32_768, 4096)]));
    await mount(createElement(AutoCompactionSection, { reloadKey: '1:0' }));
    await settle();
    expect(listPiModels).toHaveBeenCalledTimes(2);
    expect(rows()[0]?.dataset.auto).toBe('off');
  });
});

describe('the list follows an edit of the AI services', () => {
  it('tells the page when a service changed', async () => {
    const provider = {
      id: 'svc-1',
      name: 'Own',
      baseUrl: 'https://api.example.test/v1',
      api: 'openai-completions' as const,
      hasApiKey: true,
      models: ['m'],
      enabled: true,
      createdAt: '2026-10-11T00:00:00.000Z',
    };
    userProviders.get.mockResolvedValue({ providers: [provider], encrypted: true });
    userProviders.setEnabled.mockResolvedValue({ ...provider, enabled: false });
    const onChanged = vi.fn();
    await mount(createElement(UserProvidersSettings, { onChanged }));
    await settle();
    expect(onChanged).not.toHaveBeenCalled();

    const toggle = container.querySelector<HTMLElement>('[role="switch"][aria-label="Enabled"]');
    await act(async () => {
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(userProviders.setEnabled).toHaveBeenCalledWith('svc-1', false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('is wired from the services to the list on the models page', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (name: string) => readFileSync(join(here, '..', name), 'utf8');
    expect(read('SettingsContent.tsx')).toMatch(
      /<UserProvidersSettings\s+onChanged=\{\(\) => setProvidersVersion\(\(version\) => version \+ 1\)\}\s*\/>\s*<PiModelManagementSettings providersVersion=\{providersVersion\} \/>/
    );
    expect(read('PiModelManagementSettings.tsx')).toMatch(
      /<AutoCompactionSection reloadKey=\{`\$\{providersVersion\}:\$\{syncVersion\}`\} \/>/
    );
  });
});
