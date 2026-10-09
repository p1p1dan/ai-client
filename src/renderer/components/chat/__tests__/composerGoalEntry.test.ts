// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerGoalEntry } from '../ComposerPermissionTrigger';

/**
 * Decision 166 (GitHub issue #5), mounted in the real `ChatComposer`: the
 * permission menu's 「设定目标…」 puts `/goal ` in this chat's box and focuses
 * it, and is off while the chat has an unfinished goal or is sending. The
 * menu itself is stubbed; the entry it would render is read off its props.
 */

const trigger = vi.hoisted(() => ({ goalEntry: undefined as ComposerGoalEntry | undefined }));

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
vi.mock('../ComposerPermissionTrigger', () => ({
  ComposerPermissionTrigger: (props: { goalEntry?: ComposerGoalEntry }) => {
    trigger.goalEntry = props.goalEntry;
    return null;
  },
}));
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
import { resetComposerDraftsForTests } from '@/stores/composerDrafts';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { ChatComposer } from '../ChatComposer';
import { GOAL_ENTRY_HINT_LIVE, GOAL_ENTRY_HINT_OFFLINE } from '../goalStart';

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

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(box(), text);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Pick the entry, then let the deferred focus run. */
async function pickGoal() {
  expect(trigger.goalEntry?.disabled).toBe(false);
  await act(async () => {
    trigger.goalEntry?.onSelect();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function goalPanels(phase: 'active' | 'paused' | 'complete', live: boolean) {
  return {
    goal: {
      goal: { id: 'g1', revision: 1, objective: 'ship it', phase, maxGoalRounds: 256 },
      roundsStarted: 1,
      createdAt: 0,
      updatedAt: 0,
    },
    live,
    seq: {},
  };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  trigger.goalEntry = undefined;
  resetComposerDraftsForTests();
  useSessionPanelsStore.setState({ bySession: {} });
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

describe('「设定目标…」 fills the box', () => {
  it('[GOAL-PREFILL] puts `/goal ` in an empty box and focuses it, caret at the end', async () => {
    await mountComposer();
    expect(trigger.goalEntry).toMatchObject({ disabled: false, hint: null });
    await pickGoal();
    expect(box().value).toBe('/goal ');
    expect(document.activeElement).toBe(box());
    expect(box().selectionStart).toBe(6);
    expect(box().selectionEnd).toBe(6);
  });

  it('[GOAL-PREFILL-DRAFT] keeps what was typed as the objective', async () => {
    await mountComposer();
    await type('make CI green');
    await pickGoal();
    expect(box().value).toBe('/goal make CI green');
    expect(box().selectionStart).toBe('/goal make CI green'.length);
  });

  it('[GOAL-PREFILL-START] works on the start screen, before the chat exists', async () => {
    useChatSessionsStore.setState({ activeSessionId: null } as never);
    await mountComposer();
    await pickGoal();
    expect(box().value).toBe('/goal ');
  });
});

describe('「设定目标…」 is off when a goal could not be created', () => {
  it('[GOAL-ENTRY-LIVE] while the chat has an unfinished goal its worker holds', async () => {
    useSessionPanelsStore.setState({ bySession: { a: goalPanels('paused', true) } } as never);
    await mountComposer();
    expect(trigger.goalEntry).toMatchObject({ disabled: true, hint: GOAL_ENTRY_HINT_LIVE });
  });

  it('[GOAL-ENTRY-OFFLINE] with no live worker, it names the commands instead', async () => {
    useSessionPanelsStore.setState({ bySession: { a: goalPanels('active', false) } } as never);
    await mountComposer();
    expect(trigger.goalEntry).toMatchObject({ disabled: true, hint: GOAL_ENTRY_HINT_OFFLINE });
  });

  it('[GOAL-ENTRY-COMPLETE] but not for a completed goal, or another chat’s', async () => {
    useSessionPanelsStore.setState({
      bySession: { a: goalPanels('complete', true), b: goalPanels('active', true) },
    } as never);
    await mountComposer();
    expect(trigger.goalEntry).toMatchObject({ disabled: false, hint: null });
  });
});
