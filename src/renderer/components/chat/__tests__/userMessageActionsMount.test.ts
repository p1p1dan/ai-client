// @vitest-environment happy-dom
/**
 * Issue #26 item 1, painted: the action row under a user message. Copy is
 * always there; edit & resend and fork need the session tree, so a Claude SDK
 * chat (whose runtime answers rewind / fork with "unsupported") has neither,
 * and mid-run they are disabled rather than gone.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Persisted stores rehydrate at import, so the bridge stub is hoisted.
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: {
      onRuntimeEvent: () => () => undefined,
      rewindSession: async () => ({ editorText: '' }),
    },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));

import { type ChatMessage, type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { UserMessageActions } from '../UserMessageActions';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const initial = useChatSessionsStore.getState();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useChatSessionsStore.setState(initial, true);
  vi.unstubAllGlobals();
});

const MESSAGE: ChatMessage = {
  id: 'h:m1',
  entryId: 'm1',
  sessionId: 's1',
  role: 'user',
  blocks: [{ id: 't', type: 'text', text: 'hello there' }],
};

async function paint(session: Partial<ChatSession>) {
  useChatSessionsStore.setState({
    sessions: [
      { id: 's1', runtimeIdentity: '/x.dsh.json', status: 'idle', ...session } as ChatSession,
    ],
  });
  await act(async () => root.render(createElement(UserMessageActions, { message: MESSAGE })));
}

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

it('[26-1] a DSH chat offers copy, edit & resend and fork, in one frameless reserved row', async () => {
  await paint({});
  expect(button('Copy message')).not.toBeNull();
  expect(button('Edit and resend')).not.toBeNull();
  expect(button('Fork from here')).not.toBeNull();
  const row = container.querySelector<HTMLElement>('[data-testid="user-message-actions"]');
  expect(row?.className).toContain('h-6');
  expect(row?.className).toContain('group-hover/user:opacity-100');
  expect(row?.className).not.toMatch(/(?:^|\s)border(?:\s|-)/);
});

it('[26-1] copy puts the prompt on the clipboard', async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  await paint({});
  await act(async () => button('Copy message')?.click());
  expect(writeText).toHaveBeenCalledWith('hello there');
});

it('[26-1] a Claude SDK chat keeps copy only', async () => {
  await paint({ engine: 'claude-sdk' });
  expect(button('Copy message')).not.toBeNull();
  expect(button('Edit and resend')).toBeNull();
  expect(button('Fork from here')).toBeNull();
});

it('[26-1] mid-run the tree actions are disabled, not hidden', async () => {
  await paint({ status: 'running' });
  expect(button('Edit and resend')?.disabled).toBe(true);
  expect(button('Fork from here')?.disabled).toBe(true);
  expect(button('Copy message')?.disabled).toBe(false);
});

it('[26-1] edit & resend asks first, and only the confirmation rewinds', async () => {
  const rewind = vi.spyOn(window.electronAPI.chat, 'rewindSession');
  await paint({});
  await act(async () => button('Edit and resend')?.click());
  expect(rewind).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Edit and resend this message?');
});
