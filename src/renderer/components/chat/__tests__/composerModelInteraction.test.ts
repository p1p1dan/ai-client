// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { ComposerModelTrigger } from '../ComposerModelTrigger';
import { AUTOMATIC_MODEL_ID, resolveResumeModel } from '../models';
import {
  captureSessionGenerationPreferences,
  restoreIndexedSessionModels,
} from '../sessionGenerationPreferences';
import {
  readSessionEffort,
  readSessionModel,
  writeSessionEffort,
  writeSessionModel,
} from '../sessionPreferenceStore';

const hydration = vi.hoisted(() => ({ ready: true }));

vi.mock('@/stores/settings', async () => {
  const { create } = await import('zustand');
  return {
    useSettingsHydrated: () => hydration.ready,
    useSettingsStore: create<{
      chatAgentDefaults: { model?: string; effort?: string };
      setChatAgentDefaults: (value: { model?: string; effort?: string }) => void;
    }>((set) => ({
      chatAgentDefaults: {},
      setChatAgentDefaults: (chatAgentDefaults) => set({ chatAgentDefaults }),
    })),
  };
});
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../usePiModelCatalog', () => ({
  usePiModelCatalog: () => ({
    catalog: {
      models: [
        { id: 'china/glm5.2', label: 'GLM 5.2', tags: ['china'], reasoning: true },
        { id: 'other/plain', label: 'Plain', tags: ['other'], reasoning: false },
      ],
    },
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
  hydration.ready = true;
  useSettingsStore.setState({ chatAgentDefaults: { model: 'china/glm5.2', effort: 'high' } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(sessionId: string | null) {
  await act(async () => {
    root.render(
      createElement(ComposerModelTrigger, { sessionId, hostState: 'ready', mode: 'session' })
    );
  });
}
async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
function row(text: string) {
  return [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].find(
    (node) => node.textContent === text
  );
}

describe('composer model selection', () => {
  // Issue #18: a fresh install (no default model) once showed 「自动」, which the menu no
  // longer lists. The catalog's first model (the plan's own default) is seeded instead.
  it('a fresh install with no default shows the catalog default model, never Automatic', async () => {
    useSettingsStore.setState({ chatAgentDefaults: {} });
    await render(null);
    expect(useSettingsStore.getState().chatAgentDefaults.model).toBe('china/glm5.2');
    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toContain('GLM 5.2');
    expect(trigger?.textContent).not.toContain('Automatic');
    // A send without a choice of its own now names that model on the wire.
    expect(resolveResumeModel(readSessionModel, 'new-chat', 'china/glm5.2')).toBe('china/glm5.2');
    await click(trigger);
    expect(row('Automatic')).toBeUndefined();
  });

  it('a history chat stored as Automatic keeps it, and Automatic stays out of the menu', async () => {
    useSettingsStore.setState({ chatAgentDefaults: {} });
    writeSessionModel('automatic-history', AUTOMATIC_MODEL_ID);
    await render('automatic-history');
    await click(container.querySelector('button'));
    expect(row('Automatic')).toBeUndefined();
    expect(row('Default')).toBeTruthy();
    expect(readSessionModel('automatic-history')).toBe(AUTOMATIC_MODEL_ID);

    await click(row('china'));
    await click(row('GLM 5.2'));
    expect(container.textContent).toContain('GLM 5.2');
    expect(useSettingsStore.getState().chatAgentDefaults.model).toBe('china/glm5.2');
    expect(readSessionModel('automatic-history')).toBe('china/glm5.2');
    expect(row('Automatic')).toBeUndefined();
  });

  it('keeps an unverified historical model selectable while hiding Automatic', async () => {
    writeSessionModel('legacy', 'missing/model');
    await render('legacy');
    await click(container.querySelector('button'));
    expect(row('Automatic')).toBeUndefined();
    const historical = row('missing/model · unverified');
    expect(historical?.getAttribute('aria-checked')).toBe('true');
    await click(historical);
    expect(readSessionModel('legacy')).toBe('missing/model');
    expect(row('china')).toBeTruthy();
    expect(row('Default')).toBeTruthy();
  });

  it('does not freeze startup defaults before settings have hydrated', async () => {
    hydration.ready = false;
    useSettingsStore.setState({ chatAgentDefaults: {} });
    await render('a');
    expect(readSessionModel('a')).toBeNull();
    await act(async () => {
      hydration.ready = true;
      useSettingsStore.setState({ chatAgentDefaults: { model: 'china/glm5.2', effort: 'high' } });
    });
    expect(container.textContent).toContain('GLM 5.2');
    expect(container.textContent).toContain('High');
    expect(readSessionModel('a')).toBe('china/glm5.2');
    expect(readSessionEffort('a')).toBe('high');
  });

  it('changing model and effort in another chat leaves the first chat pinned', async () => {
    await render('a');
    writeSessionModel('b', 'other/plain');
    writeSessionEffort('b', 'default');
    await render('b');
    await click(container.querySelector('button'));
    await click(row('china'));
    await click(row('GLM 5.2'));
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    await click(row('Low'));
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(readSessionEffort('b')).toBe('low');
    await render('a');
    expect(container.textContent).toContain('High');
    expect(readSessionEffort('a')).toBe('high');
    await render('b');
    expect(container.textContent).toContain('Low');
    expect(readSessionModel('b')).toBe('china/glm5.2');
  });

  it('restores historical models without replacing an explicit current selection', () => {
    const entry = {
      sessionId: 'old',
      model: 'china/glm5.2',
      workspacePath: '/work',
      title: 'Old',
      updatedAt: 1,
      archived: false,
    };
    restoreIndexedSessionModels([entry]);
    expect(resolveResumeModel(readSessionModel, 'old', 'other/plain')).toBe('china/glm5.2');
    writeSessionModel('old', 'other/plain');
    restoreIndexedSessionModels([entry]);
    expect(readSessionModel('old')).toBe('other/plain');
  });
  it('restores each chat model and effort without reconciling against the previous model', async () => {
    writeSessionModel('a', 'other/plain');
    writeSessionEffort('a', 'default');
    writeSessionModel('b', 'china/glm5.2');
    writeSessionEffort('b', 'high');
    await render('a');
    expect(container.textContent).toContain('Plain');
    await render('b');
    expect(container.textContent).toContain('GLM 5.2');
    expect(container.textContent).toContain('High');
    expect(readSessionEffort('b')).toBe('high');
    expect(resolveResumeModel(readSessionModel, 'b', 'other/plain')).toBe('china/glm5.2');
    await render('a');
    expect(container.textContent).toContain('Plain');
    expect(readSessionEffort('a')).toBe('default');
  });

  it('snapshots inherited defaults for new chats including Automatic and Default', () => {
    captureSessionGenerationPreferences('a', { model: 'china/glm5.2', effort: 'high' });
    captureSessionGenerationPreferences('b', {});
    captureSessionGenerationPreferences('a', { model: 'other/plain', effort: 'low' });
    captureSessionGenerationPreferences('b', { model: 'other/plain', effort: 'low' });
    expect(readSessionModel('a')).toBe('china/glm5.2');
    expect(readSessionEffort('a')).toBe('high');
    expect(resolveResumeModel(readSessionModel, 'b', 'other/plain')).toBeUndefined();
    expect(readSessionEffort('b')).toBe('default');
  });

  it('closes only the provider submenu on model selection, then closes the menu on effort', async () => {
    await render('a');
    await click(container.querySelector('button'));
    await click(row('china'));
    await click(row('GLM 5.2'));
    expect(row('china')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    // Clicking the already selected effort must close too.
    await click(row('High'));
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(readSessionModel('a')).toBe('china/glm5.2');
    expect(readSessionEffort('a')).toBe('high');
  });
});
