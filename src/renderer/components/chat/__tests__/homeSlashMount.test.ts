// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase decision 175 (GitHub issue #6 follow-up), mounted in the real
 * `ChatComposer`:
 *
 * - on the home page the slash menu asks Main for the draft target's folder
 *   (its skills, before any session runs there) and has no `/archive` or
 *   `/compact`; in a conversation it names the chat and its folder;
 * - typed on the home page, `/archive`, `/compact` and a `/goal` that creates
 *   nothing are answered with a hint: no conversation is made and the text
 *   stays in the box. A skill, or `/goal <objective>`, goes out as the first
 *   message of the conversation made on the draft target, exactly as typed.
 *
 * The send is cut short at `createSession` (it rejects), as in
 * `homeSendMount.test.ts`: what is under test is everything up to it.
 */

const mocks = vi.hoisted(() => {
  const api = {
    getSlashCommands: vi.fn(async (_payload?: { sessionId?: string; workspacePath?: string }) => ({
      commands: [
        {
          name: 'goal',
          source: 'command',
          description: 'Set or view the goal for a long-running task',
        },
        { name: 'plan-tree', source: 'skill', description: 'Plans the work' },
      ],
      truncated: false,
    })),
    ensureHost: vi.fn(async () => undefined),
    createSession: vi.fn(async (_input: { sessionId: string; workspacePath: string }) => {
      throw new Error('createSession refused (test)');
    }),
    ensureScratchWorkspace: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      path: `/tmp/scratch/${sessionId}`,
    })),
  };
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: {
      onRuntimeEvent: () => () => undefined,
      getSlashCommands: api.getSlashCommands,
      ensureHost: api.ensureHost,
      createSession: api.createSession,
      ensureScratchWorkspace: api.ensureScratchWorkspace,
    },
    git: { checkout: vi.fn(), createBranch: vi.fn() },
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
import { resetHomeDraftForTests, useHomeDraftStore } from '@/stores/homeDraft';
import { useModelMenuIntentStore } from '@/stores/modelMenuIntent';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { ChatComposer } from '../ChatComposer';

let root: Root | undefined;
let container: HTMLDivElement;
let unsubscribePending: (() => void) | undefined;
/** Every text a send published as its bubble, i.e. what it carried to the host. */
let sentTexts: string[] = [];

function chat(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p-alpha',
    workspaceId: 'ws-alpha',
    title: id,
    status: 'idle',
    updatedAt: 5,
    ...extra,
  };
}

function setStore() {
  useChatSessionsStore.setState({
    activeSessionId: null,
    sessions: [chat('known-1')],
    projects: [{ id: 'p-alpha', name: 'alpha' }],
    workspaces: [
      {
        id: 'ws-alpha',
        projectId: 'p-alpha',
        name: 'Main',
        kind: 'main',
        path: '/repo/alpha',
        branch: 'main',
        gitEnabled: true,
      },
    ],
    messages: {},
    hostBoundSessionIds: [],
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

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Type `text` with the caret at its end, then let the menu's query and fetch run. */
async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(box(), text);
    box().setSelectionRange(text.length, text.length);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function pressEnter() {
  await act(async () => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
}

/** The names the open menu shows, as `/name`. */
const menuRows = () =>
  [...container.querySelectorAll('button span.font-mono')].map((span) => span.textContent);

const createdSessions = () =>
  useChatSessionsStore.getState().sessions.filter((session) => session.id !== 'known-1');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetComposerDraftsForTests();
  resetHomeDraftForTests();
  for (const fn of Object.values(mocks.api)) fn.mockClear();
  mocks.toast.mockClear();
  localStorage.clear();
  usePendingUserMessagesStore.setState({ bySession: {} });
  sentTexts = [];
  unsubscribePending = usePendingUserMessagesStore.subscribe((state) => {
    for (const messages of Object.values(state.bySession)) {
      for (const message of messages) {
        if (!sentTexts.includes(message.text)) sentTexts.push(message.text);
      }
    }
  });
  setStore();
});

afterEach(async () => {
  unsubscribePending?.();
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the slash menu before a session runs', () => {
  it('on the home page: asks for the draft target’s folder, and offers no /archive or /compact', async () => {
    await mountComposer();
    await type('/');

    expect(mocks.api.getSlashCommands).toHaveBeenLastCalledWith({
      workspacePath: '/repo/alpha',
      engine: 'dsh',
    });
    expect(menuRows()).toEqual(['/effort', '/goal', '/model', '/new', '/plan-tree', '/settings']);
  });

  it('「不选仓库」 names no folder: Main lists the user’s skills only', async () => {
    useHomeDraftStore.getState().setPick({ kind: 'unbound' });
    await mountComposer();
    await type('/pl');

    expect(mocks.api.getSlashCommands).toHaveBeenLastCalledWith({ engine: 'dsh' });
    expect(menuRows()).toEqual(['/plan-tree']);
  });

  it('in a conversation not started on the host: names the chat and its folder, and keeps /archive and /compact', async () => {
    useChatSessionsStore.setState({ activeSessionId: 'known-1' });
    await mountComposer();
    await type('/');

    expect(mocks.api.getSlashCommands).toHaveBeenLastCalledWith({
      sessionId: 'known-1',
      workspacePath: '/repo/alpha',
      engine: 'dsh',
    });
    expect(menuRows()).toEqual([
      '/archive',
      '/clear',
      '/compact',
      '/effort',
      '/goal',
      '/model',
      '/new',
      '/plan-tree',
      '/settings',
    ]);
  });
});

/** A keydown Enter as an IME sends it: flagged composing, or keyCode 229. */
async function pressImeEnter(signal: 'isComposing' | 'keyCode229') {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    isComposing: signal === 'isComposing',
  });
  if (signal === 'keyCode229') Object.defineProperty(event, 'keyCode', { value: 229 });
  await act(async () => {
    box().dispatchEvent(event);
  });
  await settle();
}

// Issue #26 item 9: the Enter that confirms an IME candidate picks nothing in
// the slash menu and sends nothing, whichever signal carries the composition.
describe('an IME composing in the box', () => {
  it.each([
    'isComposing',
    'keyCode229',
  ] as const)('Enter with %s leaves the slash menu row unpicked; a plain Enter picks it', async (signal) => {
    await mountComposer();
    await type('/pl');
    expect(menuRows()).toEqual(['/plan-tree']);

    await pressImeEnter(signal);
    expect(box().value).toBe('/pl');

    await pressEnter();
    expect(box().value.startsWith('/plan-tree')).toBe(true);
  });

  it.each(['isComposing', 'keyCode229'] as const)('Enter with %s sends nothing', async (signal) => {
    await mountComposer();
    await type('hello there');
    await pressImeEnter(signal);

    expect(mocks.api.createSession).not.toHaveBeenCalled();
    expect(createdSessions()).toEqual([]);
    expect(box().value).toBe('hello there');
  });
});

describe('a command typed on the home page that needs a conversation', () => {
  it.each([
    '/compact',
    '/compact keep the API notes',
    '/archive',
  ])('%s is answered with a hint; nothing is made and the text stays', async (line) => {
    await mountComposer();
    await type(line);
    await pressEnter();

    expect(createdSessions()).toEqual([]);
    expect(useChatSessionsStore.getState().activeSessionId).toBeNull();
    expect(mocks.api.createSession).not.toHaveBeenCalled();
    expect(sentTexts).toEqual([]);
    expect(box().value).toBe(line);
    const command = line.split(' ')[0]?.slice(1);
    expect(mocks.toast).toHaveBeenCalledWith({
      type: 'info',
      title: 'This command needs an open conversation',
      description: `/${command} works on an open conversation. Open one from the sidebar or the recent list, then run it there.`,
    });
  });

  it.each([
    '/goal ',
    '/goal pause',
    '/goal clear',
  ])('%s gets the goal hint; nothing is made', async (line) => {
    await mountComposer();
    await type(line);
    await pressEnter();

    expect(createdSessions()).toEqual([]);
    expect(mocks.api.createSession).not.toHaveBeenCalled();
    expect(box().value).toBe(line);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        title: 'This command needs an open conversation',
        description: expect.stringContaining('write it after /goal'),
      })
    );
  });
});

describe('what goes out from the home page as the first message', () => {
  it.each([
    '/plan-tree draft the roadmap',
    '/goal ship the release notes',
  ])('%s makes the conversation on the draft target and carries the line as typed', async (line) => {
    await mountComposer();
    await type(line);
    await pressEnter();

    const [made] = createdSessions();
    expect(made?.workspaceId).toBe('ws-alpha');
    expect(mocks.api.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.api.createSession.mock.calls[0]?.[0]).toMatchObject({
      sessionId: made?.id,
      workspacePath: '/repo/alpha',
    });
    expect(sentTexts).toEqual([line]);
    expect(mocks.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'This command needs an open conversation' })
    );
  });
});

describe('decision 194 Q2: /model, /effort and the SDK CLI’s settings commands', () => {
  it.each([
    ['/model glm-fake-1', 'model', 'glm-fake-1'],
    ['/model ', 'model', ''],
    ['/effort high', 'effort', 'high'],
  ] as const)('%s goes to this composer’s model menu; nothing is sent', async (line, kind, query) => {
    useModelMenuIntentStore.setState({ pending: null });
    await mountComposer();
    await type(line);
    await pressEnter();

    expect(useModelMenuIntentStore.getState().pending).toMatchObject({
      sessionId: null,
      kind,
      query,
    });
    expect(createdSessions()).toEqual([]);
    expect(mocks.api.createSession).not.toHaveBeenCalled();
    expect(sentTexts).toEqual([]);
    expect(box().value).toBe('');
  });

  it.each([
    '/config theme=dark',
    '/autocompact 200000',
  ])('%s in an SDK chat is not sent: a hint, and the text stays', async (line) => {
    useChatSessionsStore.setState((state) => ({
      activeSessionId: 'known-1',
      hostBoundSessionIds: ['known-1'],
      sessions: state.sessions.map((session) =>
        session.id === 'known-1' ? { ...session, engine: 'claude-sdk' as const } : session
      ),
    }));
    await mountComposer();
    await type(line);
    await pressEnter();

    const command = line.split(' ')[0]?.slice(1);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', title: `PiLab does not send /${command}` })
    );
    expect(sentTexts).toEqual([]);
    expect(box().value).toBe(line);
  });
});
