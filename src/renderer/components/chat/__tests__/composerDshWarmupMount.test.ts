// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S-6 feedback 11c (user, 2026-10-17), mounted in the real `ChatComposer`: typing
 * in a DSH chat asks Main for the DSH host (`chat.warmDshHost`), so a host stopped
 * after 10 idle minutes is starting again before the send; typing in an Agent SDK
 * chat asks nothing (the SDK engine is not warmed). Harness as in
 * `claudeEngineRefusalMount.test.ts`.
 */

const mocks = vi.hoisted(() => {
  const warmDshHost = vi.fn(async () => undefined);
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: {
      onRuntimeEvent: () => () => undefined,
      getSlashCommands: async () => ({ commands: [], truncated: false }),
      ensureHost: vi.fn(async () => undefined),
      warmDshHost,
    },
  } as unknown as typeof window.electronAPI;
  return { warmDshHost, toast: vi.fn() };
});

vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));
vi.mock('@/stores/settings', () => {
  const state = { chatAgentDefaults: undefined, showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/components/ui/toast', () => ({ toastManager: { add: mocks.toast } }));
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../ComposerTargetBar', () => ({ ComposerTargetBar: () => null }));
vi.mock('../ComposerModelTrigger', () => ({ ComposerModelTrigger: () => null }));
vi.mock('../ComposerPermissionTrigger', () => ({ ComposerPermissionTrigger: () => null }));
vi.mock('../ComposerUsageChip', () => ({ ComposerUsageChip: () => null }));
vi.mock('../ComposerAttachMenu', () => ({ ComposerAttachMenu: () => null }));
vi.mock('../PiModelSyncNotice', () => ({ PiModelSyncNotice: () => null }));
vi.mock('../ModelMissingNotice', () => ({ ModelMissingNotice: () => null }));
vi.mock('../QueuedMessageStrip', () => ({ QueuedMessageStrip: () => null }));
vi.mock('../useQueueRelease', () => ({ useQueueRelease: () => undefined }));
vi.mock('../usePiModelCatalog', () => ({ usePiModelCatalog: () => ({ catalog: null }) }));
vi.mock('../useHostStatus', () => {
  const snapshot = { status: { state: 'ready' }, retry: async () => undefined };
  return { useHostStatus: () => snapshot };
});

import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { resetComposerDraftsForTests } from '@/stores/composerDrafts';
import { ChatComposer } from '../ChatComposer';

let root: Root | undefined;
let container: HTMLDivElement;

function chat(id: string, extra: Partial<ChatSession> = {}): ChatSession {
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

function setStore(active: 'sdk' | 'dsh') {
  useChatSessionsStore.setState({
    activeSessionId: active,
    sessions: [chat('sdk', { engine: 'claude-sdk', engineRoute: 'claude' }), chat('dsh')],
    projects: [{ id: 'p', name: 'repo' }],
    workspaces: [{ id: 'w', projectId: 'p', name: 'Main', kind: 'main', path: '/repo' }],
    messages: {},
    hostBoundSessionIds: ['sdk', 'dsh'],
    historyErrors: {},
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  } as never);
}

async function mountComposer() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(ChatComposer, { mode: 'session' })));
}

const box = () => container.querySelector('textarea') as HTMLTextAreaElement;

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(box(), text);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetComposerDraftsForTests();
  mocks.warmDshHost.mockClear();
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('S-6 feedback 11c: the DSH host warms up while the user types', () => {
  it('asks for the host once while typing in a DSH chat, and never in an Agent SDK chat', async () => {
    setStore('sdk');
    await mountComposer();
    await type('h');
    await type('hello sdk');
    expect(mocks.warmDshHost).not.toHaveBeenCalled();
    if (root) await act(async () => root?.unmount());

    setStore('dsh');
    await mountComposer();
    await type('h');
    await type('hello dsh');
    await type('hello dsh, more');
    // The throttle: at most once a minute, however much is typed.
    expect(mocks.warmDshHost).toHaveBeenCalledTimes(1);
  });
});
