// @vitest-environment happy-dom
import { englishTranslate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase decision 176, mounted in the real `ChatComposer`: `/compact` in a
 * conversation the engine is not running (reopened after the app restarted,
 * reclaimed after 15 idle minutes, let go by an engine rebuild).
 *
 * It used to go straight to Main, which answered `session_not_found`, and the
 * toast read 「压缩上下文失败：No ready Pi WorkerSlot exists for …」. Now the
 * conversation is started the way a send starts it (`ensureHost`, then the
 * send path's resume with the send path's arguments), and every refusal is
 * said in words. A message sent while the conversation starts waits in the
 * queue (decision 179, as decision 178 has it while it compacts); a second
 * `/compact` is answered locally; ending the conversation while it starts
 * cancels the compaction.
 *
 * Decision 180: it shows in the timeline — its command line, then its
 * running row, which says 「正在启动对话…」 and then 「正在压缩上下文…」 — the
 * box is cleared as for a message, and Esc or Stop cancels it. How it ended is
 * said in its row; one that never ran leaves no row, a toast, and its line
 * back in the box.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

const mocks = vi.hoisted(() => {
  const api = {
    getSlashCommands: vi.fn(async () => ({ commands: [], truncated: false })),
    ensureHost: vi.fn(async () => ({ state: 'ready' })),
    resumeSession: vi.fn(),
    compactSession: vi.fn(),
    createSession: vi.fn(async () => {
      throw new Error('createSession refused (test)');
    }),
    send: vi.fn(async () => {
      throw new Error('send refused (test)');
    }),
    stop: vi.fn(async () => ({ requestId: 'stop-1' })),
    cancelCompact: vi.fn(async () => ({ cancelled: true })),
    interject: vi.fn(async () => ({ interjected: false })),
    ensureScratchWorkspace: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      path: `/tmp/scratch/${sessionId}`,
    })),
  };
  window.electronAPI = {
    env: { platform: 'linux', HOME: '/home/test' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat: { onRuntimeEvent: () => () => undefined, ...api },
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

import { supersededSummaryIds } from '@shared/dshHistory/types';
import {
  applyRuntimeEvent,
  type ChatMessage,
  type ChatSession,
  useChatSessionsStore,
} from '@/stores/chatSessions';
import { useCompactRunsStore } from '@/stores/compactRuns';
import { resetComposerDraftsForTests } from '@/stores/composerDrafts';
import { resetHomeDraftForTests } from '@/stores/homeDraft';
import { useMessageQueueStore } from '@/stores/messageQueue';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { useScratchWorkspaceStore } from '@/stores/scratchWorkspace';
import { ChatComposer } from '../ChatComposer';
import { COMPACT_INTERRUPTED_TEXT, COMPACT_STOPPED_TEXT, COMPACTING_LINE } from '../compactCommand';
import { createEmptyState, selectSessionQueue } from '../messageQueue';
import { announceSessionEnded } from '../sessionEndSignal';
import { SESSION_START_FAILED, SESSION_STARTING_LINE } from '../sessionStart';

const STUB = '/dsh-home/aiclient-sessions/aiclient-c1.dsh.json';
/** Typed with its space, as picking it from the menu leaves it: the menu is closed. */
const COMMAND = '/compact ';

let root: Root | undefined;
let container: HTMLDivElement;

function chat(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'c1',
    projectId: 'p-alpha',
    workspaceId: 'ws-alpha',
    title: 'Chat one',
    status: 'idle',
    updatedAt: 5,
    runtimeIdentity: STUB,
    ...extra,
  };
}

function setStore(over: { session?: ChatSession; hostBound?: string[] } = {}) {
  useChatSessionsStore.setState({
    activeSessionId: 'c1',
    sessions: [over.session ?? chat()],
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
    // Reopened after a restart, or reclaimed: the engine does not run it.
    hostBoundSessionIds: over.hostBound ?? [],
    historyErrors: {},
    pendingPermissions: [],
    pendingQuestions: [],
    lastError: null,
  } as never);
}

/** A call the test answers when it chooses to. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function mountComposer() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(ChatComposer, { mode: 'session' })));
}

const box = () => container.querySelector('textarea') as HTMLTextAreaElement;
const text = () => container.textContent ?? '';
const stopButton = () => container.querySelector('button[aria-label="Stop the running turn"]');

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(box(), value);
    box().setSelectionRange(value.length, value.length);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function press(key: string) {
  await act(async () => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await settle();
}

const toastTitles = () =>
  mocks.toast.mock.calls.map(([toast]) => (toast as { title: string }).title);

/**
 * Decision 180: the chat's timeline as the `/compact` left it, one entry a
 * row: `command <text>`, `running <key>`, `note <key>`, `summary <id>`.
 */
function timeline(sessionId = 'c1'): string[] {
  return (useChatSessionsStore.getState().messages[sessionId] ?? []).map((row: ChatMessage) => {
    const first = row.blocks[0];
    const part = first?.id.slice(row.id.length + 1).split(':')[0];
    if (part === 'compact-command') return `command ${first?.text}`;
    if (part === 'compaction-running') return `running ${first?.notice?.key}`;
    if (part === 'compaction-failed') return `note ${first?.notice?.key}`;
    if (part === 'summary') return `summary ${row.id}`;
    return `${row.role} ${row.id}`;
  });
}

/** Decision 180: the round Stop while it cancels the `/compact`, named for that. */
const cancelButton = () => container.querySelector('button[aria-label="Cancel the compaction"]');

async function event(value: Record<string, unknown>) {
  await act(async () =>
    useChatSessionsStore.setState((state) =>
      applyRuntimeEvent(state, { seq: 1, timestamp: 1, sessionId: 'c1', ...value } as never)
    )
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetComposerDraftsForTests();
  resetHomeDraftForTests();
  for (const fn of Object.values(mocks.api)) fn.mockClear();
  mocks.api.resumeSession.mockReset();
  mocks.api.compactSession.mockReset();
  mocks.toast.mockClear();
  localStorage.clear();
  usePendingUserMessagesStore.setState({ bySession: {} });
  useCompactRunsStore.setState({ phases: {}, compactingSince: {}, cancelling: {} });
  useMessageQueueStore.setState({ state: createEmptyState() });
  useScratchWorkspaceStore.setState({ pathsBySession: {} });
  setStore();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('/compact in a conversation the engine is not running (decision 176)', () => {
  it('[176-C-01] starts it the way a send does, saying so, then compacts it', async () => {
    const resume = deferred<{ requestId: string }>();
    const compact = deferred<{ compacted: true }>();
    mocks.api.resumeSession.mockReturnValue(resume.promise);
    mocks.api.compactSession.mockReturnValue(compact.promise);
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    // The send path's start: the engine first, then its resume, with the
    // arguments a send would carry (none pinned here: Automatic, Default).
    expect(mocks.api.ensureHost).toHaveBeenCalled();
    expect(mocks.api.resumeSession).toHaveBeenCalledWith({
      sessionId: 'c1',
      runtimeIdentity: STUB,
      workspacePath: '/repo/alpha',
    });
    expect(mocks.api.compactSession).not.toHaveBeenCalled();
    // Decision 180: in the timeline, not on a status line; the box is cleared.
    expect(timeline()).toEqual(['command /compact', `running ${SESSION_STARTING_LINE}`]);
    expect(text()).not.toContain(SESSION_STARTING_LINE);
    expect(box().value).toBe('');
    // Stop is offered, and cancels the compaction.
    expect(cancelButton()).not.toBeNull();
    expect(stopButton()).toBeNull();

    await act(async () => resume.resolve({ requestId: 'resume-1' }));
    await settle();
    expect(mocks.api.compactSession).toHaveBeenCalledWith({ sessionId: 'c1' });
    expect(timeline()).toEqual(['command /compact', `running ${COMPACTING_LINE}`]);
    expect(useChatSessionsStore.getState().hostBoundSessionIds).toContain('c1');

    // No summary row came back with the answer: the success is said as before.
    await act(async () => compact.resolve({ compacted: true }));
    await settle();
    expect(timeline()).toEqual([]);
    expect(toastTitles()).toEqual(['Conversation compacted']);
    expect(box().value).toBe('');
    expect(cancelButton()).toBeNull();
  });

  it('[176-C-02] a start Main refuses: the card says why, the toast in words, nothing raw', async () => {
    mocks.api.resumeSession.mockRejectedValue(
      new Error(
        "Error invoking remote method 'chat:resumeSession': Error: pi_session_workspace_mismatch: Indexed workspace does not match the resume request"
      )
    );
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    expect(mocks.api.compactSession).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      type: 'error',
      title: 'Could not compact the conversation',
      description: SESSION_START_FAILED,
    });
    // The existing non-retryable card carries Main's sentence under Details.
    expect(useChatSessionsStore.getState().historyErrors.c1).toMatch(/^session_cwd_mismatch: /);
    // Nothing above the composer quotes Main.
    expect(useChatSessionsStore.getState().lastError).toBeNull();
    expect(text()).not.toMatch(/pi_session|WorkerSlot|session_not_found/);
    // Decision 180: it never ran — no row, and its line is back in the box.
    expect(timeline()).toEqual([]);
    expect(box().value).toBe(COMMAND.trim());
  });

  it('[176-C-04] a second /compact while one runs is answered here, not queued', async () => {
    const compact = deferred<{ compacted: true }>();
    mocks.api.compactSession.mockReturnValue(compact.promise);
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');
    expect(timeline()).toEqual(['command /compact', `running ${COMPACTING_LINE}`]);

    await type(COMMAND);
    await press('Enter');
    expect(mocks.toast).toHaveBeenCalledWith({
      type: 'info',
      title: 'This conversation is already being compacted',
    });
    expect(mocks.api.compactSession).toHaveBeenCalledTimes(1);
    expect(mocks.api.resumeSession).not.toHaveBeenCalled();
    // The second one stays in the box; the timeline still has the first only.
    expect(box().value).toBe(COMMAND);
    expect(timeline()).toHaveLength(2);

    await act(async () => compact.resolve({ compacted: true }));
    await settle();
    expect(timeline()).toEqual([]);
  });

  it('[176-C-05] ended while it starts: the compaction is not asked, and it says so', async () => {
    const resume = deferred<{ requestId: string }>();
    mocks.api.resumeSession.mockReturnValue(resume.promise);
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    announceSessionEnded('c1');
    await act(async () => resume.resolve({ requestId: 'resume-1' }));
    await settle();

    expect(mocks.api.compactSession).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      type: 'error',
      title: 'Could not compact the conversation',
      description: COMPACT_STOPPED_TEXT,
    });
    expect(timeline()).toEqual([]);
    expect(box().value).toBe(COMMAND.trim());
  });

  it('[176-C-06] the window believed it running, Main had no slot: started, then compacted', async () => {
    setStore({ hostBound: ['c1'] });
    mocks.api.compactSession
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'chat:compactSession': Error: session_not_found: Session c1 is not running on the DSH host"
        )
      )
      .mockResolvedValueOnce({ compacted: true });
    mocks.api.resumeSession.mockResolvedValue({ requestId: 'resume-1' });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    expect(mocks.api.compactSession).toHaveBeenCalledTimes(2);
    expect(mocks.api.resumeSession).toHaveBeenCalledTimes(1);
    expect(toastTitles()).toEqual(['Conversation compacted']);
  });

  it('[176-C-07] cut short by a close or an engine restart while compacting: said in words', async () => {
    setStore({ hostBound: ['c1'] });
    mocks.api.compactSession.mockRejectedValue(
      new Error(
        "Error invoking remote method 'chat:compactSession': Error: worker_compact_interrupted: The compaction of c1 got no answer: its engine session ended first (WORKER_EXITED)"
      )
    );
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    // Decision 180: said where it ran; it did run, so the box stays clear.
    expect(timeline()).toEqual(['command /compact', `note ${COMPACT_INTERRUPTED_TEXT}`]);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(box().value).toBe('');
  });

  it('[176-C-08] a conversation that never ran has nothing to compact: nothing is started', async () => {
    setStore({ session: chat({ runtimeIdentity: undefined }) });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    expect(mocks.api.resumeSession).not.toHaveBeenCalled();
    expect(mocks.api.createSession).not.toHaveBeenCalled();
    expect(mocks.api.compactSession).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      type: 'info',
      title: 'Nothing to compact yet',
      description: 'This conversation has no earlier history that compaction could shorten.',
    });
    expect(timeline()).toEqual([]);
    expect(box().value).toBe(COMMAND.trim());
  });

  it('[176-C-09] Esc while it starts (decision 180): no Stop for a turn, the compaction is not asked, its row says cancelled', async () => {
    const resume = deferred<{ requestId: string }>();
    mocks.api.resumeSession.mockReturnValue(resume.promise);
    await mountComposer();
    await type(COMMAND);
    await press('Enter');
    expect(timeline()).toEqual(['command /compact', `running ${SESSION_STARTING_LINE}`]);

    await press('Escape');
    expect(mocks.api.stop).not.toHaveBeenCalled();
    // Nothing is with Main yet: nothing to ask it.
    expect(mocks.api.cancelCompact).not.toHaveBeenCalled();
    expect(useCompactRunsStore.getState().cancelling.c1).toBe(true);
    // The start carries on to its end (the conversation runs now), then nothing more.
    mocks.api.compactSession.mockResolvedValue({ compacted: true });
    await act(async () => resume.resolve({ requestId: 'resume-1' }));
    await settle();
    expect(mocks.api.compactSession).not.toHaveBeenCalled();
    expect(timeline()).toEqual([
      'command /compact',
      'note Compaction cancelled. Nothing was compacted.',
    ]);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(cancelButton()).toBeNull();
  });
});

/**
 * GUI point-check 2026-10-11: `/compact` in a temporary chat (「不选仓库（临时
 * 对话）」) the engine let go. One made in this run carries no record of its
 * scratch directory — `session.unbound` is written by a restart's index merge
 * or by a fork — and the start refused it: 「压缩上下文失败 / 这个对话没有可以
 * 运行的文件夹。」, while a message sent in the same chat went through. The start
 * now names the directory the send path names (`runDirectory.ts`).
 */
describe('/compact in a temporary chat the engine let go (decision 176, 2026-10-11)', () => {
  const temporary = (extra: Partial<ChatSession> = {}) =>
    chat({ projectId: '', workspaceId: '', ...extra });

  it('[176-C-10] made in this run: started in the scratch directory its first send got, then compacted', async () => {
    setStore({ session: temporary() });
    // What its first send left behind (`useScratchWorkspaceStore.ensure`).
    useScratchWorkspaceStore.setState({ pathsBySession: { c1: '/tmp/scratch/c1-first-send' } });
    mocks.api.resumeSession.mockResolvedValue({ requestId: 'resume-1' });
    mocks.api.compactSession.mockResolvedValue({ compacted: true });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    expect(mocks.api.ensureScratchWorkspace).not.toHaveBeenCalled();
    expect(mocks.api.resumeSession).toHaveBeenCalledWith({
      sessionId: 'c1',
      runtimeIdentity: STUB,
      workspacePath: '/tmp/scratch/c1-first-send',
    });
    expect(mocks.api.compactSession).toHaveBeenCalledWith({ sessionId: 'c1' });
    expect(toastTitles()).toEqual(['Conversation compacted']);
    expect(box().value).toBe('');
  });

  it('[176-C-11] made in this run, its directory unknown to this window: asked of Main as a send asks', async () => {
    setStore({ session: temporary() });
    mocks.api.resumeSession.mockResolvedValue({ requestId: 'resume-1' });
    mocks.api.compactSession.mockResolvedValue({ compacted: true });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    expect(mocks.api.ensureScratchWorkspace).toHaveBeenCalledWith({ sessionId: 'c1' });
    expect(mocks.api.resumeSession).toHaveBeenCalledWith({
      sessionId: 'c1',
      runtimeIdentity: STUB,
      workspacePath: '/tmp/scratch/c1',
    });
    expect(toastTitles()).toEqual(['Conversation compacted']);
  });

  it('[176-C-12] reopened after a restart: started in the directory recorded on it', async () => {
    setStore({ session: temporary({ unbound: { workspacePath: '/tmp/scratch/c1-recorded' } }) });
    mocks.api.resumeSession.mockResolvedValue({ requestId: 'resume-1' });
    mocks.api.compactSession.mockResolvedValue({ compacted: true });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    expect(mocks.api.ensureScratchWorkspace).not.toHaveBeenCalled();
    expect(mocks.api.resumeSession).toHaveBeenCalledWith({
      sessionId: 'c1',
      runtimeIdentity: STUB,
      workspacePath: '/tmp/scratch/c1-recorded',
    });
    expect(toastTitles()).toEqual(['Conversation compacted']);
  });
});

/**
 * dsh-rebase decision 178: a message sent while this window's `/compact`
 * summarizes. It used to go to Main, wait behind the compaction in the
 * worker's one request queue, be reported failed after 10 s, and then start
 * its turn anyway. It waits in the composer's queue now, as a message sent
 * while a turn runs does; the queue holds while the compaction runs
 * (`isInFlight`, `useQueueRelease` — mocked here, its hold is
 * `compactQueueRelease.test.ts`'s).
 */
describe('a message while /compact summarizes (decision 178)', () => {
  const queued = () =>
    selectSessionQueue(useMessageQueueStore.getState().state, 'c1').entries.map(
      (entry) => entry.text
    );

  it('[178-C-01] Enter queues it instead of sending; the compaction clears only its command', async () => {
    const compact = deferred<{ compacted: true }>();
    mocks.api.compactSession.mockReturnValue(compact.promise);
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');
    expect(timeline()).toEqual(['command /compact', `running ${COMPACTING_LINE}`]);

    await type('and then run the tests');
    await press('Enter');
    expect(mocks.api.send).not.toHaveBeenCalled();
    expect(mocks.api.interject).not.toHaveBeenCalled();
    expect(queued()).toEqual(['and then run the tests']);
    // Owned by its queue entry now, like a message queued behind a turn.
    expect(box().value).toBe('');
    // Nothing is said: the strip shows it.
    expect(toastTitles()).toEqual([]);

    await act(async () => compact.resolve({ compacted: true }));
    await settle();
    expect(timeline()).toEqual([]);
    expect(queued()).toEqual(['and then run the tests']);
    expect(mocks.api.send).not.toHaveBeenCalled();
  });

  it('[178-C-02] Ctrl+Enter queues it too: a compaction is no turn to steer into', async () => {
    const compact = deferred<{ compacted: true }>();
    mocks.api.compactSession.mockReturnValue(compact.promise);
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    await type('one more thing');
    await act(async () => {
      box().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
      );
    });
    await settle();
    expect(mocks.api.interject).not.toHaveBeenCalled();
    expect(mocks.api.send).not.toHaveBeenCalled();
    expect(queued()).toEqual(['one more thing']);

    await act(async () => compact.resolve({ compacted: true }));
    await settle();
  });

  it('[178-C-03] a failed compaction leaves what was queued queued, to go out next', async () => {
    const compact = deferred<{ compacted: true }>();
    mocks.api.compactSession.mockReturnValue(compact.promise);
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');
    await type('carry on');
    await press('Enter');

    await act(async () =>
      compact.reject(
        new Error(
          "Error invoking remote method 'chat:compactSession': Error: WORKER_COMPACT_FAILED: Compaction could not produce a useful summary. The attempt is recorded in the session log."
        )
      )
    );
    await settle();
    // Decision 180: said in its row, not a toast.
    expect(timeline()).toEqual([
      'command /compact',
      'note No useful summary could be written, so nothing was compacted. The attempt is recorded in the session log.',
    ]);
    expect(queued()).toEqual(['carry on']);
    expect(toastTitles()).toEqual([]);
  });
});

/**
 * dsh-rebase decision 179 (revising 176 §5): a message sent while this
 * window's `/compact` starts the conversation waits in the queue too, as it
 * does while it compacts (decision 178): the box is cleared, nothing is said,
 * and it goes out once the `/compact` ends — compacted or not, started or not
 * (`useQueueRelease` is mocked here; its hold is `compactQueueRelease.test.ts`'s).
 */
describe('a message while /compact starts the conversation (decision 179)', () => {
  const queued = () =>
    selectSessionQueue(useMessageQueueStore.getState().state, 'c1').entries.map(
      (entry) => entry.text
    );

  it('[179-C-01] Enter queues it, clears the box, says nothing; the compaction clears only its command', async () => {
    const resume = deferred<{ requestId: string }>();
    mocks.api.resumeSession.mockReturnValue(resume.promise);
    mocks.api.compactSession.mockResolvedValue({ compacted: true });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');
    expect(timeline()).toEqual(['command /compact', `running ${SESSION_STARTING_LINE}`]);

    await type('and then run the tests');
    await press('Enter');
    expect(queued()).toEqual(['and then run the tests']);
    expect(box().value).toBe('');
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.api.send).not.toHaveBeenCalled();
    expect(mocks.api.resumeSession).toHaveBeenCalledTimes(1);

    await act(async () => resume.resolve({ requestId: 'resume-1' }));
    await settle();
    expect(mocks.api.compactSession).toHaveBeenCalledTimes(1);
    expect(toastTitles()).toEqual(['Conversation compacted']);
    expect(queued()).toEqual(['and then run the tests']);
    expect(mocks.api.send).not.toHaveBeenCalled();
  });

  it('[179-C-02] Ctrl+Enter queues it too: a conversation being started has no turn to steer', async () => {
    const resume = deferred<{ requestId: string }>();
    mocks.api.resumeSession.mockReturnValue(resume.promise);
    mocks.api.compactSession.mockResolvedValue({ compacted: true });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    await type('one more thing');
    await act(async () => {
      box().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
      );
    });
    await settle();
    expect(mocks.api.interject).not.toHaveBeenCalled();
    expect(mocks.api.send).not.toHaveBeenCalled();
    expect(queued()).toEqual(['one more thing']);

    await act(async () => resume.resolve({ requestId: 'resume-1' }));
    await settle();
  });

  it('[179-C-03] a start that fails leaves what was queued queued; the card says why, as before', async () => {
    const resume = deferred<{ requestId: string }>();
    mocks.api.resumeSession.mockReturnValue(resume.promise);
    await mountComposer();
    await type(COMMAND);
    await press('Enter');
    await type('carry on');
    await press('Enter');

    await act(async () =>
      resume.reject(
        new Error(
          "Error invoking remote method 'chat:resumeSession': Error: pi_session_workspace_mismatch: Indexed workspace does not match the resume request"
        )
      )
    );
    await settle();
    expect(mocks.api.compactSession).not.toHaveBeenCalled();
    expect(timeline()).toEqual([]);
    expect(queued()).toEqual(['carry on']);
    expect(mocks.toast).toHaveBeenCalledWith({
      type: 'error',
      title: 'Could not compact the conversation',
      description: SESSION_START_FAILED,
    });
    expect(useChatSessionsStore.getState().historyErrors.c1).toMatch(/^session_cwd_mismatch: /);
  });
});

/** dsh-rebase decision 179: the text after `/compact` goes with it. */
describe('/compact with instructions (decision 179)', () => {
  it('[179-C-04] passes the instructions on, as plain text', async () => {
    mocks.api.compactSession.mockResolvedValue({ compacted: true, instructionsApplied: true });
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type('/compact   保留未完成的任务和失败经验  ');
    await press('Enter');

    expect(mocks.api.compactSession).toHaveBeenCalledWith({
      sessionId: 'c1',
      instructions: '保留未完成的任务和失败经验',
    });
    expect(toastTitles()).toEqual(['Conversation compacted']);
    expect(box().value).toBe('');
  });

  it('[179-C-05] longer than the engine takes: said here, nothing sent, the text kept', async () => {
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    const command = `/compact ${'字'.repeat(2001)}`;
    await type(command);
    await press('Enter');

    expect(mocks.api.compactSession).not.toHaveBeenCalled();
    expect(mocks.api.resumeSession).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      type: 'info',
      title: 'The instructions after /compact are too long',
      description: 'Keep them to 2000 characters (now 2001).',
    });
    expect(box().value).toBe(command);
  });

  it('[179-C-06] compacted without them: the success, then the word that they were not used', async () => {
    mocks.api.compactSession.mockResolvedValue({ compacted: true, instructionsApplied: false });
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type('/compact keep the API decisions');
    await press('Enter');

    expect(toastTitles()).toEqual([
      'Conversation compacted',
      'Compacted without your instructions',
    ]);
  });
});

/**
 * dsh-rebase decision 180: `/compact` in the timeline — its command line,
 * then its running row, renamed by the bridge's live events to the ids the
 * history gives the same rows — and Esc or Stop to cancel it.
 */
describe('/compact in the timeline, and its cancel (decision 180)', () => {
  const summaryRow = {
    id: 'h:cp1',
    entryId: 'cp1',
    role: 'system',
    liveMessageId: 'dsh-compaction-k1',
    blocks: [{ id: 'h:cp1:summary:0', type: 'text', text: 'Context summary\n\n- x' }],
  };
  const ids = () => (useChatSessionsStore.getState().messages.c1 ?? []).map((row) => row.id);

  it('[180-C-01] the running row becomes the summary the answer carried, in place; the command line takes its live id', async () => {
    mocks.api.compactSession.mockResolvedValue({ compacted: true, summary: summaryRow });
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type('/compact keep the tests');
    await press('Enter');

    expect(timeline()).toEqual(['command /compact keep the tests', 'summary h:cp1']);
    expect(ids()).toEqual(['dsh-compact-command-k1', 'h:cp1']);
    expect(toastTitles()).toEqual([]);
    expect(box().value).toBe('');
  });

  it('[180-C-02] the bridge’s live rows: renamed in place, then the summary, then the answer’s own row', async () => {
    const compact = deferred<unknown>();
    mocks.api.compactSession.mockReturnValue(compact.promise);
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type('/compact keep the tests');
    await press('Enter');
    await event({
      type: 'session.compaction',
      payload: {
        messageId: 'dsh-compaction-k1',
        phase: 'started',
        trigger: 'manual',
        commandMessageId: 'dsh-compact-command-k1',
        command: '/compact keep the tests',
      },
    });
    expect(ids()).toEqual(['dsh-compact-command-k1', 'dsh-compaction-k1']);
    expect(timeline()).toEqual(['command /compact keep the tests', `running ${COMPACTING_LINE}`]);

    await event({
      type: 'session.compaction',
      payload: {
        messageId: 'dsh-compaction-k1',
        phase: 'completed',
        trigger: 'manual',
        summary: 'Context summary\n\n- x',
        instructions: 'keep the tests',
      },
    });
    expect(timeline()).toEqual(['command /compact keep the tests', 'summary dsh-compaction-k1']);
    const live = useChatSessionsStore.getState().messages.c1?.[1];
    expect(live?.blocks[1]?.notice).toEqual({
      key: 'Instructions for this summary: {{instructions}}',
      params: { instructions: 'keep the tests' },
    });

    await act(async () => compact.resolve({ compacted: true, summary: summaryRow }));
    await settle();
    expect(ids()).toEqual(['dsh-compact-command-k1', 'h:cp1']);
  });

  // Found in the dev app on 2026-10-18: the bridge's events wait for their batch (a
  // second, in a hidden window) while the answer settles the run at once.
  // Its summary row names the live id; the late events are that row's.
  const started = {
    type: 'session.compaction',
    payload: {
      messageId: 'dsh-compaction-k1',
      phase: 'started',
      trigger: 'manual',
      commandMessageId: 'dsh-compact-command-k1',
      command: '/compact',
    },
  };
  const completed = {
    type: 'session.compaction',
    payload: {
      messageId: 'dsh-compaction-k1',
      phase: 'completed',
      trigger: 'manual',
      summary: 'Context summary\n\n- x',
    },
  };

  it('[180-C-06] the answer lands before the bridge’s live rows: they add no second command line or summary', async () => {
    mocks.api.compactSession.mockResolvedValue({ compacted: true, summary: summaryRow });
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');
    expect(ids()).toEqual(['dsh-compact-command-k1', 'h:cp1']);

    await event(started);
    await event(completed);
    expect(ids()).toEqual(['dsh-compact-command-k1', 'h:cp1']);
    expect(timeline()).toEqual(['command /compact', 'summary h:cp1']);
    expect(supersededSummaryIds(useChatSessionsStore.getState().messages.c1 ?? []).size).toBe(0);
  });

  it('[180-C-07] the answer lands between the live rows: the late summary event adds no second summary', async () => {
    const compact = deferred<unknown>();
    mocks.api.compactSession.mockReturnValue(compact.promise);
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');
    await event(started);
    await act(async () => compact.resolve({ compacted: true, summary: summaryRow }));
    await settle();
    expect(ids()).toEqual(['dsh-compact-command-k1', 'h:cp1']);

    await event(completed);
    expect(ids()).toEqual(['dsh-compact-command-k1', 'h:cp1']);
    expect(timeline()).toEqual(['command /compact', 'summary h:cp1']);
  });

  it('[180-C-03] Esc while it compacts: Main is asked to cancel, and the row says cancelled', async () => {
    const compact = deferred<unknown>();
    mocks.api.compactSession.mockReturnValue(compact.promise);
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');
    expect(cancelButton()).not.toBeNull();
    expect(stopButton()).toBeNull();

    await press('Escape');
    expect(mocks.api.stop).not.toHaveBeenCalled();
    expect(mocks.api.cancelCompact).toHaveBeenCalledWith({ sessionId: 'c1' });
    // A second press is no second request.
    await press('Escape');
    expect(mocks.api.cancelCompact).toHaveBeenCalledTimes(1);

    await act(async () =>
      compact.reject(
        new Error(
          "Error invoking remote method 'chat:compactSession': WorkerSlotError: WORKER_COMPACT_CANCELLED: the compaction was cancelled before its summary was written; nothing was compacted"
        )
      )
    );
    await settle();
    expect(timeline()).toEqual([
      'command /compact',
      'note Compaction cancelled. Nothing was compacted.',
    ]);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(box().value).toBe('');
    expect(cancelButton()).toBeNull();
  });

  it('[180-C-04] the Stop button cancels too; a cancel that found nothing yet is asked again', async () => {
    const compact = deferred<unknown>();
    mocks.api.compactSession.mockReturnValue(compact.promise);
    mocks.api.cancelCompact.mockResolvedValueOnce({ cancelled: false });
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type(COMMAND);
    await press('Enter');

    await act(async () => (cancelButton() as HTMLButtonElement).click());
    await vi.waitFor(() => expect(mocks.api.cancelCompact).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    });
    expect(mocks.api.stop).not.toHaveBeenCalled();
    await act(async () => compact.resolve({ compacted: true, summary: summaryRow }));
    await settle();
    // Too late: the summary was written, and that is what it shows.
    expect(timeline()).toEqual(['command /compact', 'summary h:cp1']);
  });

  it('[180-C-05] refused before anything ran: no rows, the toast, the line back with its instructions', async () => {
    mocks.api.compactSession.mockRejectedValue(
      new Error(
        "Error invoking remote method 'chat:compactSession': WorkerSlotError: WORKER_COMPACT_INSTRUCTIONS_UNSUPPORTED: this engine cannot add instructions to /compact (no hook); nothing was compacted"
      )
    );
    setStore({ hostBound: ['c1'] });
    await mountComposer();
    await type('/compact keep the tests');
    await press('Enter');
    expect(timeline()).toEqual([]);
    expect(toastTitles()).toEqual(['This engine version cannot add instructions to /compact']);
    expect(box().value).toBe('/compact keep the tests');
  });
});
