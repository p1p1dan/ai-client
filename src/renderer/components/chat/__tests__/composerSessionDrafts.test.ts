// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-7e (problems 1 and 33, decision 139), mounted in the real
 * `ChatComposer`:
 *
 * - its draft belongs to the chat it was typed in: switching chats parks it,
 *   coming back hands it back, and the other chat's box is its own (problem
 *   33 — a message a failed migration returned to chat A was still in the box
 *   over chat B, and one Enter sent it there);
 * - the prompt a rewind hands back lands in that chat's box, after anything
 *   already typed there (problem 1).
 *
 * Only the draft behaviour is under test: the target bar, the model and
 * permission chips, the attach menu and the queue are stubbed out.
 */

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: {
      onRuntimeEvent: () => () => undefined,
      getSlashCommands: async () => ({ commands: [], truncated: false }),
    },
  } as unknown as typeof window.electronAPI;
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

import { useChatSessionsStore } from '@/stores/chatSessions';
import { resetComposerDraftsForTests, useComposerDraftsStore } from '@/stores/composerDrafts';
import { ChatComposer } from '../ChatComposer';

let root: Root | undefined;
let container: HTMLDivElement;

function session(id: string) {
  return { id, projectId: 'p', workspaceId: 'w', title: id, status: 'idle', updatedAt: 0 };
}

async function mountComposer() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(ChatComposer, { mode: 'session' })));
}

const box = () => container.querySelector('textarea') as HTMLTextAreaElement;

/** Type the way React sees it: the native setter, then an input event. */
async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(box(), text);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function open(sessionId: string) {
  await act(async () => useChatSessionsStore.getState().selectSession(sessionId));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetComposerDraftsForTests();
  useChatSessionsStore.setState({
    activeSessionId: 'a',
    sessions: [session('a'), session('b')],
    projects: [{ id: 'p', name: 'repo' }],
    workspaces: [{ id: 'w', projectId: 'p', name: 'Main', kind: 'main', path: '/repo' }],
    messages: {},
    hostBoundSessionIds: [],
    historyErrors: {},
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  } as never);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the composer draft belongs to its chat (problem 33)', () => {
  it('[P7E-33-SWITCH] leaves the draft behind on a switch and gives it back on return', async () => {
    await mountComposer();
    await type('only for chat A');
    expect(box().value).toBe('only for chat A');

    await open('b');
    expect(box().value).toBe('');
    await type('and this is B');

    await open('a');
    expect(box().value).toBe('only for chat A');
    await open('b');
    expect(box().value).toBe('and this is B');
  });

  it('[P7E-33-PRUNE] forgets the draft of a chat that is gone', async () => {
    await mountComposer();
    await type('about to be deleted');
    await open('b');
    expect(useComposerDraftsStore.getState().parked.a?.text).toBe('about to be deleted');
    useComposerDraftsStore.getState().pruneSessions(['b']);
    expect(useComposerDraftsStore.getState().parked.a).toBeUndefined();
  });
});

describe('a rewound prompt comes back to its chat (problem 1)', () => {
  it('[P7E-1-EMPTY] fills an empty box', async () => {
    await mountComposer();
    await act(async () => useComposerDraftsStore.getState().offerText('a', 'the second prompt'));
    expect(box().value).toBe('the second prompt');
    expect(useComposerDraftsStore.getState().offered).toEqual({});
  });

  it('[P7E-1-MERGE] goes after what the user already typed, never over it', async () => {
    await mountComposer();
    await type('a note I was writing');
    await act(async () => useComposerDraftsStore.getState().offerText('a', 'the second prompt'));
    expect(box().value).toBe('a note I was writing\n\nthe second prompt');
  });

  it('[P7E-1-AWAY] waits for its chat when the user has moved on', async () => {
    await mountComposer();
    await open('b');
    await act(async () => useComposerDraftsStore.getState().offerText('a', 'the second prompt'));
    // Not in B's box…
    expect(box().value).toBe('');
    // …but in A's, once the user is back.
    await open('a');
    expect(box().value).toBe('the second prompt');
  });
});

describe('a withdrawn Ctrl+Enter message comes back to its chat (issue #8, decision 172 §4)', () => {
  const IMAGE = {
    id: 'att-withdrawn',
    kind: 'image' as const,
    mediaType: 'image/png',
    name: 'shot.png',
    byteLength: 4,
    data: 'AAAA',
  };
  const removeChip = () => container.querySelector('[aria-label="Remove shot.png"]');

  it('[I8-OFFER-EMPTY] fills an empty box, its attachments with it', async () => {
    await mountComposer();
    await act(async () =>
      useComposerDraftsStore
        .getState()
        .offerDraft('a', { text: 'also run lint', attachments: [IMAGE] })
    );
    expect(box().value).toBe('also run lint');
    expect(removeChip()).not.toBeNull();
    expect(useComposerDraftsStore.getState().offered).toEqual({});
    expect(useComposerDraftsStore.getState().offeredAttachments).toEqual({});
  });

  it('[I8-OFFER-MERGE] goes on a new line after what is typed, never over it', async () => {
    await mountComposer();
    await type('a note I was writing');
    await act(async () =>
      useComposerDraftsStore
        .getState()
        .offerDraft('a', { text: 'also run lint', attachments: [IMAGE] })
    );
    expect(box().value).toBe('a note I was writing\n\nalso run lint');
    expect(removeChip()).not.toBeNull();
  });

  it('[I8-OFFER-AWAY] waits for its chat when the user has moved on', async () => {
    await mountComposer();
    await open('b');
    await act(async () =>
      useComposerDraftsStore
        .getState()
        .offerDraft('a', { text: 'also run lint', attachments: [IMAGE] })
    );
    expect(box().value).toBe('');
    expect(removeChip()).toBeNull();
    await open('a');
    expect(box().value).toBe('also run lint');
    expect(removeChip()).not.toBeNull();
  });
});
