// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route B, S-1 (claude-sdk-engine topics/s1-engine-selection.md decisions 5
 * and 9), mounted in the real `ChatComposer`:
 *
 * - a send into a Claude-engine chat that Main refuses with
 *   `model_engine_mismatch` gives the text back to the box, keeps the chat
 *   bound (the slot that answered is healthy), arms no Retry, and says why in
 *   words instead of Main's sentence;
 * - a new chat Main could not start on the Claude engine
 *   (`claude_sdk_credentials_unavailable`, `claude_sdk_host_unavailable`) is
 *   reported in words too.
 *
 * The rejections are the real wire shape: `<code>: <message>` inside
 * Electron's own wrapper. The chips, target bar and queue are stubbed out.
 */

const mocks = vi.hoisted(() => {
  const api = {
    ensureHost: vi.fn(async () => undefined),
    createSession: vi.fn(
      async (_input: { sessionId: string; workspacePath: string }): Promise<unknown> => {
        throw new Error('createSession refused (test)');
      }
    ),
    send: vi.fn(async (_input: { sessionId: string; text: string }): Promise<unknown> => {
      throw new Error('send refused (test)');
    }),
    retryLastTurn: vi.fn(async (_input: { sessionId: string }): Promise<unknown> => {
      throw new Error('retry refused (test)');
    }),
  };
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: {
      onRuntimeEvent: () => () => undefined,
      getSlashCommands: async () => ({ commands: [], truncated: false }),
      ensureHost: api.ensureHost,
      createSession: api.createSession,
      send: api.send,
      retryLastTurn: api.retryLastTurn,
    },
  } as unknown as typeof window.electronAPI;
  return { api, toast: vi.fn() };
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
// The target row carries the composer's bar controls at its two ends.
vi.mock('../ComposerTargetBar', () => ({
  ComposerTargetBar: (props: {
    leading?: import('react').ReactNode;
    trailing?: import('react').ReactNode;
  }) => [props.leading, props.trailing],
}));
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
import { useContinueIntentStore } from '@/stores/continueIntent';
import { ChatComposer } from '../ChatComposer';
import { CLAUDE_SDK_CREDENTIALS_HINT, CLAUDE_SDK_HOST_UNAVAILABLE_HINT } from '../historyError';
import { MODEL_ENGINE_MISMATCH_HINT } from '../sendDispatchError';

const wrapped = (channel: string, inner: string) =>
  new Error(`Error invoking remote method '${channel}': Error: ${inner}`);

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

function setStore(bound: string[]) {
  useChatSessionsStore.setState({
    activeSessionId: 'a',
    sessions: [chat('a', { engine: 'claude-sdk', engineRoute: 'claude' })],
    projects: [{ id: 'p', name: 'repo' }],
    workspaces: [{ id: 'w', projectId: 'p', name: 'Main', kind: 'main', path: '/repo' }],
    messages: {},
    hostBoundSessionIds: bound,
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

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function pressEnter() {
  await act(async () => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetComposerDraftsForTests();
  for (const fn of Object.values(mocks.api)) fn.mockClear();
  mocks.toast.mockClear();
  localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('S-1 a model the Claude engine cannot run (model_engine_mismatch)', () => {
  it('gives the text back, keeps the chat bound, and says why in words', async () => {
    setStore(['a']);
    mocks.api.send.mockImplementationOnce(async () => {
      throw wrapped(
        'chat:send',
        'model_engine_mismatch: china/glm5.2 cannot run in chat a, which runs on the Claude engine (route claude)'
      );
    });
    await mountComposer();
    await type('refactor the parser');
    await pressEnter();

    expect(mocks.api.send).toHaveBeenCalledTimes(1);
    expect(mocks.api.send.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'a',
      text: 'refactor the parser',
    });
    // Handed back, unsent, for the user to switch the model and send.
    expect(box().value).toBe('refactor the parser');
    // The slot that refused is healthy: the next send goes straight to it.
    expect(useChatSessionsStore.getState().hostBoundSessionIds).toEqual(['a']);
    expect(mocks.api.createSession).not.toHaveBeenCalled();
    // Said in words; Main's sentence and code stay off the screen.
    expect(container.textContent).toContain(MODEL_ENGINE_MISMATCH_HINT);
    expect(container.textContent).not.toContain('model_engine_mismatch');
    expect(container.textContent).not.toContain('Claude Code');
    // No Retry is armed for a payload that would be refused the same way.
    expect(container.querySelector('[aria-label="Retry"]')).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

describe('S-1 a new chat the Claude engine could not start', () => {
  it.each([
    [
      'claude_sdk_credentials_unavailable: no key for provider company (keyring locked)',
      CLAUDE_SDK_CREDENTIALS_HINT,
    ],
    [
      'claude_sdk_host_unavailable: the Claude engine host exited during startup (code 1)',
      CLAUDE_SDK_HOST_UNAVAILABLE_HINT,
    ],
  ])('reports %s in words', async (inner, hint) => {
    setStore([]);
    mocks.api.createSession.mockImplementationOnce(async () => {
      throw wrapped('chat:createSession', inner);
    });
    await mountComposer();
    await type('hello');
    await pressEnter();

    expect(mocks.api.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.api.send).not.toHaveBeenCalled();
    expect(container.textContent).toContain(hint);
    expect(container.textContent).not.toContain(inner.slice(0, inner.indexOf(':')));
    expect(container.textContent).not.toContain('Claude Code');
  });
});

describe('S-1 a Continue the Claude engine refuses for its model', () => {
  it('keeps the failure card standing and says why in a toast', async () => {
    setStore(['a']);
    useChatSessionsStore.setState({
      sessions: [chat('a', { engine: 'claude-sdk', engineRoute: 'claude', status: 'failed' })],
      messages: {
        a: [
          {
            id: 'u1',
            sessionId: 'a',
            role: 'user',
            blocks: [{ id: 'b1', type: 'text', text: 'refactor the parser' }],
          },
        ],
      },
    } as never);
    mocks.api.retryLastTurn.mockImplementationOnce(async () => {
      throw wrapped(
        'chat:retryLastTurn',
        'model_engine_mismatch: china/glm5.2 cannot run in chat a, which runs on the Claude engine (route claude)'
      );
    });
    await mountComposer();
    await act(async () => useContinueIntentStore.getState().requestContinue('a', 'u1'));
    await settle();

    expect(mocks.api.retryLastTurn).toHaveBeenCalledTimes(1);
    expect(mocks.api.send).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      type: 'warning',
      title: MODEL_ENGINE_MISMATCH_HINT,
    });
    const state = useChatSessionsStore.getState();
    // The card is still the way back once the model is switched.
    expect(state.sessions.find((item) => item.id === 'a')?.status).toBe('failed');
    expect(state.hostBoundSessionIds).toEqual(['a']);
    // Main's sentence does not replace the card's own error.
    expect(state.lastError).toBeNull();
    // A Continue carries no text: nothing is put in the box.
    expect(box().value).toBe('');
  });
});
