// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { ComposerModelTrigger } from '../ComposerModelTrigger';
import {
  readSessionEffort,
  writeSessionEffort,
  writeSessionModel,
} from '../sessionPreferenceStore';

/**
 * dsh-rebase P1-5a (decisions 033, 036), mounted: the effort rows come from
 * the plan's `efforts` on the catalog row, and the models the plan left out
 * are counted in a footer instead of vanishing.
 */

const fixture = vi.hoisted(() => ({
  catalog: {
    models: [
      {
        id: 'china/glm',
        label: 'GLM',
        tags: ['china'],
        reasoning: true,
        // The map alone would offer Low / Medium / High; the plan says otherwise.
        thinkingLevelMap: { off: null },
        efforts: ['high', 'max'],
      },
    ],
    source: 'managed',
    stale: false,
    fetchedAt: 1,
    unavailable: [
      { label: 'Gemini', reason: 'unsupported_api' },
      { label: 'Own', reason: 'no_api_key' },
    ],
  } as AgentModelCatalog,
}));

vi.mock('@/stores/settings', async () => {
  const { create } = await import('zustand');
  return {
    useSettingsHydrated: () => true,
    useSettingsStore: create<{
      chatAgentDefaults: { model?: string; effort?: string };
      setChatAgentDefaults: (value: { model?: string; effort?: string }) => void;
    }>((set) => ({
      chatAgentDefaults: {},
      setChatAgentDefaults: (chatAgentDefaults) => set({ chatAgentDefaults }),
    })),
  };
});
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => translate('en', key, params),
  }),
}));
vi.mock('../usePiModelCatalog', () => ({
  usePiModelCatalog: () => ({
    catalog: fixture.catalog,
    loaded: true,
    authoritative: true,
    loading: false,
    status: {},
    refresh: () => {},
    retry: () => {},
  }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  useSettingsStore.setState({ chatAgentDefaults: { model: 'china/glm', effort: 'high' } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openMenu(sessionId: string) {
  await act(async () => {
    root.render(
      createElement(ComposerModelTrigger, { sessionId, hostState: 'ready', mode: 'session' })
    );
  });
  await act(async () => {
    container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function rowLabels(): string[] {
  return [...document.querySelectorAll('[role="menuitemradio"]')].map(
    (node) => node.textContent ?? ''
  );
}

describe('the model menu under the DSH model plan', () => {
  it('offers the planned effort levels only', async () => {
    writeSessionModel('a', 'china/glm');
    await openMenu('a');
    const labels = rowLabels();
    expect(labels).toEqual(expect.arrayContaining(['Default', 'High', 'Max']));
    expect(labels).not.toContain('Low');
    expect(labels).not.toContain('Medium');
  });

  it('reconciles a stored level the plan does not offer back to Default', async () => {
    writeSessionModel('b', 'china/glm');
    writeSessionEffort('b', 'medium');
    await openMenu('b');
    expect(readSessionEffort('b')).toBe('default');
  });

  it('counts the models left out in a footer that names them', async () => {
    writeSessionModel('c', 'china/glm');
    await openMenu('c');
    const footer = [...document.querySelectorAll('span[title]')].find((node) =>
      node.textContent?.includes('unavailable with the current engine')
    );
    expect(footer?.textContent).toBe('2 models are unavailable with the current engine');
    expect(footer?.getAttribute('title')).toBe('Gemini, Own');
  });
});
