// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { useSettingsStore } from '@/stores/settings';
import { ComposerModelTrigger } from '../ComposerModelTrigger';
import { readSessionModel, writeSessionModel } from '../sessionPreferenceStore';

/**
 * Route B, S-1 (claude-sdk-engine topics/s1-engine-selection.md decision 5),
 * mounted: a chat on the Claude engine can switch only to the models of its
 * own route (`AgentModelOption.sdkRoute === session.engineRoute`); a DSH chat
 * and a draft offer the whole catalog. A stored model outside the list stays
 * selected and reads `· unverified`.
 *
 * S-6 feedback 3 (README ruling 25): the Claude-engine chat still lists the
 * other models, greyed out, with a hover hint to start a new chat; clicking
 * one changes nothing.
 */

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
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../usePiModelCatalog', () => ({
  usePiModelCatalog: () => ({
    catalog: {
      models: [
        {
          id: 'company/claude-opus-5',
          label: 'Claude Opus 5',
          tags: ['claude'],
          sdkRoute: 'claude',
        },
        {
          id: 'byok/claude-opus-5',
          label: 'Claude Opus 5 (own key)',
          tags: ['claude'],
          sdkRoute: 'claude~2',
        },
        { id: 'china/glm5.2', label: 'GLM 5.2', tags: ['china'] },
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

function session(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p',
    workspaceId: 'w',
    title: id,
    status: 'idle',
    updatedAt: 1,
    ...extra,
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  useSettingsStore.setState({ chatAgentDefaults: {} });
  useChatSessionsStore.setState({
    sessions: [
      session('sdk', { engine: 'claude-sdk', engineRoute: 'claude' }),
      session('sdk-glm', { engine: 'claude-sdk', engineRoute: 'claude' }),
      session('dsh'),
    ],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useChatSessionsStore.setState({ sessions: [] });
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

const LOCKED_HINT =
  'An Agent SDK chat can only switch to models of the same service. Start a new chat to use another model.';
const disabled = (node: Element | undefined) => node?.getAttribute('aria-disabled') === 'true';

describe('S-1 the model menu of a Claude-engine chat', () => {
  it('lists the other route greyed out, and only its own route selectable', async () => {
    writeSessionModel('sdk', 'company/claude-opus-5');
    await render('sdk');
    await click(container.querySelector('button'));
    await click(row('claude'));
    expect(row('Claude Opus 5')).toBeTruthy();
    expect(disabled(row('Claude Opus 5'))).toBe(false);
    expect(row('Claude Opus 5')?.closest('[data-slot="locked-model-row"]')).toBeNull();
    // The other route's Claude model sits in its group, disabled.
    expect(row('Claude Opus 5 (own key)')).toBeTruthy();
    expect(disabled(row('Claude Opus 5 (own key)'))).toBe(true);
  });

  it('lists the models of the other engine greyed out, in their own group', async () => {
    writeSessionModel('sdk', 'company/claude-opus-5');
    await render('sdk');
    await click(container.querySelector('button'));
    await click(row('china'));
    expect(row('GLM 5.2')).toBeTruthy();
    expect(disabled(row('GLM 5.2'))).toBe(true);
    expect(row('GLM 5.2')?.getAttribute('aria-checked')).toBe('false');
  });

  it('hints why a greyed-out model cannot be picked, on hover', async () => {
    writeSessionModel('sdk', 'company/claude-opus-5');
    await render('sdk');
    await click(container.querySelector('button'));
    await click(row('china'));
    const wrapper = row('GLM 5.2')?.closest('[data-slot="locked-model-row"]');
    expect(wrapper).toBeTruthy();
    expect(document.body.textContent).not.toContain(LOCKED_HINT);
    await act(async () => {
      for (const type of ['pointerenter', 'mouseenter', 'pointermove', 'mousemove']) {
        wrapper?.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith('move') }));
      }
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain(LOCKED_HINT), {
      timeout: 2000,
    });
  });

  it.each([
    ['claude', 'Claude Opus 5 (own key)'],
    ['china', 'GLM 5.2'],
  ])('keeps the selection when greyed-out %s / %s is clicked', async (group, label) => {
    writeSessionModel('sdk', 'company/claude-opus-5');
    await render('sdk');
    const trigger = container.querySelector('button');
    const before = trigger?.textContent;
    const template = useSettingsStore.getState().chatAgentDefaults;
    await click(trigger);
    await click(row(group));
    await click(row(label));
    expect(readSessionModel('sdk')).toBe('company/claude-opus-5');
    expect(useSettingsStore.getState().chatAgentDefaults).toEqual(template);
    expect(container.querySelector('button')?.textContent).toBe(before);
    expect(row(label)?.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps a stored model of the other engine selected, marked unverified', async () => {
    writeSessionModel('sdk-glm', 'china/glm5.2');
    await render('sdk-glm');
    expect(container.textContent).toContain('china/glm5.2 · unverified');
    await click(container.querySelector('button'));
    const leftover = row('china/glm5.2 · unverified');
    expect(leftover?.getAttribute('aria-checked')).toBe('true');
    // Nothing was rewritten behind the user's back.
    expect(readSessionModel('sdk-glm')).toBe('china/glm5.2');
  });

  it.each(['dsh', null])('offers chat %s the whole catalog', async (sessionId) => {
    await render(sessionId);
    await click(container.querySelector('button'));
    expect(row('china')).toBeTruthy();
    await click(row('claude'));
    expect(row('Claude Opus 5')).toBeTruthy();
    expect(row('Claude Opus 5 (own key)')).toBeTruthy();
    // Nothing is greyed out, and nothing carries the new-chat hint.
    expect(document.querySelector('[data-slot="locked-model-row"]')).toBeNull();
    expect(disabled(row('Claude Opus 5 (own key)'))).toBe(false);
    await click(row('Claude Opus 5 (own key)'));
    if (sessionId) expect(readSessionModel(sessionId)).toBe('byok/claude-opus-5');
    expect(useSettingsStore.getState().chatAgentDefaults.model).toBe('byok/claude-opus-5');
  });
});
