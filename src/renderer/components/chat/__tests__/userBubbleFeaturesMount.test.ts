// @vitest-environment happy-dom
/**
 * Issue #26 items 1, 5 and 6, mounted in the real `MessageTimeline`:
 *
 * - a long prompt starts folded and a button opens and folds it again;
 *   a short one has no button (the fold is decided from the text, F10);
 * - a sent message carries the action row under its bubble, a message still
 *   being sent does not;
 * - a DSH image attachment is a thumbnail read back by its store reference,
 *   and a click opens it in a dialog; a file stays an icon chip.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */
import { englishTranslate } from '@shared/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const PNG_REF = `sha256:${'ab'.repeat(32)}`;

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: {
      onRuntimeEvent: () => () => undefined,
      readSentAttachment: async () => ({ ok: true, mediaType: 'image/png', data: 'iVBORw0K' }),
    },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));
vi.mock('@/stores/settings', () => {
  const state = { showToolDiff: false };
  return {
    useSettingsStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});
vi.mock('@/stores/runtimeEventBus', () => ({ subscribeRuntimeEvent: () => () => undefined }));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => () => undefined }));
vi.mock('../sessionIndex/useResumeSession', () => ({ useResumeSession: () => () => undefined }));

import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { useTurnSendStatusStore } from '@/stores/turnSendStatus';
import { MessageTimeline } from '../MessageTimeline';
import { clearSentAttachmentCache } from '../sentAttachmentPreview';

let root: Root | undefined;
let container: HTMLDivElement;

const LONG = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');

function user(id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    blocks: [{ id: `${id}-t`, type: 'text', text }],
    ...extra,
  };
}
function reply(id: string): ChatMessage {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    blocks: [{ id: `${id}-a`, type: 'text', text: 'ok' }],
  };
}

async function render(messages: ChatMessage[]) {
  useChatSessionsStore.setState({
    activeSessionId: 's1',
    sessions: [
      {
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 's1',
        status: 'idle',
        updatedAt: 0,
        runtimeIdentity: '/x.dsh.json',
      },
    ],
    messages: { s1: messages },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageTimeline, { sessionId: 's1', status: 'idle', thinkingEnabled: false })
      )
    )
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useTurnSendStatusStore.setState({ status: null });
  usePendingUserMessagesStore.setState({ bySession: {} });
  clearSentAttachmentCache();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const foldButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    ['Show more', 'Show less'].includes(button.textContent ?? '')
  );

it('[26-5] a long prompt starts folded; the button opens and folds it', async () => {
  await render([user('h:u1', LONG, { entryId: 'u1' }), reply('a1')]);
  const box = () => container.querySelector('article p')?.parentElement as HTMLElement;
  expect(foldButton()?.textContent).toBe('Show more');
  expect(foldButton()?.getAttribute('aria-expanded')).toBe('false');
  expect(box().className).toContain('max-h-75');
  // Folded is a clip, not a cut: the whole prompt is still in the DOM.
  expect(box().textContent).toContain('line 30');

  await act(async () => foldButton()?.click());
  expect(foldButton()?.textContent).toBe('Show less');
  expect(box().className).not.toContain('max-h-');

  await act(async () => foldButton()?.click());
  expect(box().className).toContain('max-h-75');
});

it('[26-5] a short prompt has no fold and no button', async () => {
  await render([user('h:u1', 'short', { entryId: 'u1' }), reply('a1')]);
  expect(foldButton()).toBeUndefined();
});

it('[26-1] a sent prompt carries the action row under its bubble', async () => {
  await render([user('h:u1', 'short', { entryId: 'u1' }), reply('a1')]);
  const article = container.querySelector('article');
  const row = article?.querySelector('[data-testid="user-message-actions"]');
  expect(row).not.toBeNull();
  // A sibling of the bubble, not inside it.
  expect(row?.parentElement).toBe(article);
  expect(row?.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
  expect(row?.querySelector('button[aria-label="Edit and resend"]')).not.toBeNull();
  expect(row?.querySelector('button[aria-label="Fork from here"]')).not.toBeNull();
});

it('[26-6] a stored image is a thumbnail that opens a preview; a file stays a chip', async () => {
  await render([
    user('h:u1', 'look', {
      entryId: 'u1',
      attachments: [
        { kind: 'image', mediaType: 'image/png', name: 'shot.png', attachmentId: PNG_REF },
        { kind: 'text', mediaType: 'text/plain', name: 'notes.txt' },
      ],
    }),
    reply('a1'),
  ]);
  await act(async () => undefined);
  const thumb = container.querySelector<HTMLButtonElement>('[data-slot="sent-image-thumbnail"]');
  expect(thumb).not.toBeNull();
  expect(thumb?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0K');
  expect(container.querySelector('[data-slot="sent-attachment-chip"]')?.textContent).toContain(
    'notes.txt'
  );

  await act(async () => thumb?.click());
  const preview = [...document.body.querySelectorAll('img')].find(
    (img) => img.getAttribute('alt') === 'shot.png'
  );
  expect(preview?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0K');
});

it('[26-6] an image the store cannot give back stays an icon chip', async () => {
  vi.spyOn(window.electronAPI.chat, 'readSentAttachment').mockResolvedValue({
    ok: false,
    reason: 'not-found',
  });
  await render([
    user('h:u1', 'look', {
      entryId: 'u1',
      attachments: [
        { kind: 'image', mediaType: 'image/png', name: 'gone.png', attachmentId: PNG_REF },
      ],
    }),
    reply('a1'),
  ]);
  await act(async () => undefined);
  expect(container.querySelector('[data-slot="sent-image-thumbnail"]')).toBeNull();
  expect(container.querySelector('[data-slot="sent-attachment-chip"]')?.textContent).toContain(
    'gone.png'
  );
});
