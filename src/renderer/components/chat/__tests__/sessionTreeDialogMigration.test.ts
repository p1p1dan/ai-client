// @vitest-environment happy-dom
/**
 * dsh-rebase P1-9e (decision 122 rule 14): the session tree over a chat from
 * the previous version. Main answers the tree, a rewind and a fork with
 * `legacy_migration_required` until the chat is on the current engine; the
 * dialog starts it (a resume, which moves it) and asks again. A move that
 * fails says so in words — its card, with the reason, is in the conversation.
 *
 * Decision 176: the same for any conversation the engine is not running
 * (reopened after a restart, reclaimed when idle): it is started the way a
 * send starts it first — the dialog says so meanwhile — and a window that
 * believed it running is corrected by Main's `session_not_found`.
 *
 * The `electronAPI` stub is hoisted: persisted stores rehydrate at import.
 */

import { translate } from '@shared/i18n';
import type { SessionTreeSnapshot } from '@shared/types/sessionHistory';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  const chat = {
    getSessionTree: vi.fn(),
    rewindSession: vi.fn(),
    forkSession: vi.fn(),
  };
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined },
    chat,
  } as unknown as typeof window.electronAPI;
  // A module constant in the app (`sessionStartEffects`); the stub must be
  // stable too, or the dialog's tree effect, which depends on it, re-runs.
  const effects = { start: vi.fn(), isRunning: vi.fn(() => false), forgetRunning: vi.fn() };
  return { chat, effects };
});

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../sessionStartDeps', () => ({ sessionStartEffects: api.effects }));

import { SessionTreeDialog } from '../SessionTreeDialog';
import { LEGACY_MIGRATION_OPERATION_FAILED } from '../sessionIndex/legacyMigration';
import { SESSION_START_FAILED, SESSION_STARTING_LINE } from '../sessionStart';

const REQUIRED = new Error(
  "Error invoking remote method 'chat:getSessionTree': Error: legacy_migration_required: Session s1 was written by the previous chat engine; resume it first, which moves it to the current engine"
);

const SNAPSHOT: SessionTreeSnapshot = {
  logicalSessionId: 's1',
  sessionFile: '/dsh-home/aiclient-sessions/aiclient-s1.dsh.json',
  workspacePath: '/repo',
  leaf: { activeEntryId: 'a1', fileTailEntryId: 'aiclient-s1#4' },
  nodes: [
    {
      id: 'u1',
      parentId: null,
      depth: 0,
      entryType: 'message',
      role: 'user',
      preview: 'preview u1',
      childCount: 1,
      forkable: false,
      active: true,
      leaf: false,
    },
    {
      id: 'a1',
      parentId: 'u1',
      depth: 1,
      entryType: 'message',
      role: 'assistant',
      preview: 'preview a1',
      childCount: 0,
      forkable: true,
      active: true,
      leaf: true,
    },
  ],
  totalNodes: 2,
  returnedNodes: 2,
  truncated: false,
};

const tree = async ({ requestSequence }: { requestSequence: number }) => ({
  sessionKey: 's1:key',
  requestSequence,
  branchRevision: 0,
  snapshot: SNAPSHOT,
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.effects.isRunning.mockReturnValue(false);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function openDialog() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(SessionTreeDialog, {
        sessionId: 's1',
        open: true,
        onOpenChange: () => undefined,
        isIdle: true,
      })
    )
  );
  return root;
}

it('moves a chat from the previous version first, then shows its tree', async () => {
  // Never started on the current engine: not running, so the start (which
  // moves it) comes first and the tree is asked once.
  api.effects.start.mockResolvedValue({ kind: 'started' });
  api.chat.getSessionTree.mockImplementation(tree);
  const root = await openDialog();
  await act(async () => {
    await vi.waitFor(() => expect(document.body.textContent).toContain('preview a1'));
  });
  expect(api.effects.start).toHaveBeenCalledTimes(1);
  expect(api.effects.start).toHaveBeenCalledWith('s1');
  expect(api.chat.getSessionTree).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it('says in words that the move failed, instead of Main’s code', async () => {
  api.effects.start.mockResolvedValue({ kind: 'failed', code: 'legacy_migration_failed' });
  const root = await openDialog();
  await act(async () => {
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(zh(LEGACY_MIGRATION_OPERATION_FAILED))
    );
  });
  const text = document.body.textContent ?? '';
  expect(zh(LEGACY_MIGRATION_OPERATION_FAILED)).not.toBe(LEGACY_MIGRATION_OPERATION_FAILED);
  expect(text).not.toContain('legacy_migration');
  // The move failed: the tree is not asked of what is left.
  expect(api.chat.getSessionTree).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it('a fork asked of a chat not moved yet moves it and forks', async () => {
  // The window took it for running; Main says it is still legacy.
  api.effects.isRunning.mockReturnValue(true);
  api.effects.start.mockResolvedValue({ kind: 'started' });
  api.chat.getSessionTree.mockImplementation(tree);
  api.chat.forkSession
    .mockRejectedValueOnce(REQUIRED)
    .mockRejectedValueOnce(new Error('WORKER_FORK_FAILED: stop here'));
  const root = await openDialog();
  await act(async () => {
    await vi.waitFor(() => expect(document.body.textContent).toContain('preview a1'));
  });
  const fork = [...document.body.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === zh('Fork from here') && !button.disabled
  );
  await act(async () => fork?.click());
  expect(api.effects.forgetRunning).toHaveBeenCalledWith('s1');
  expect(api.effects.start).toHaveBeenCalledWith('s1');
  expect(api.chat.forkSession).toHaveBeenCalledTimes(2);
  expect(api.chat.forkSession).toHaveBeenLastCalledWith({ sessionId: 's1', entryId: 'a1' });
  // The second answer is an ordinary failure, shown as it came.
  expect(document.body.textContent).toContain('WORKER_FORK_FAILED: stop here');
  await act(async () => root.unmount());
});

it('[176-TREE-START] a conversation the engine is not running is started first, and the dialog says so', async () => {
  let finishStart: () => void = () => undefined;
  api.effects.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishStart = () => resolve({ kind: 'started' });
      })
  );
  api.chat.getSessionTree.mockImplementation(tree);
  const root = await openDialog();
  expect(document.body.textContent).toContain(zh(SESSION_STARTING_LINE));
  expect(zh(SESSION_STARTING_LINE)).toBe('正在启动对话…');
  expect(api.chat.getSessionTree).not.toHaveBeenCalled();
  await act(async () => finishStart());
  await act(async () => {
    await vi.waitFor(() => expect(document.body.textContent).toContain('preview a1'));
  });
  expect(document.body.textContent).not.toContain(zh(SESSION_STARTING_LINE));
  await act(async () => root.unmount());
});

it('[176-TREE-STALE] the window believed it running and Main had no slot: started, then asked again', async () => {
  api.effects.isRunning.mockReturnValue(true);
  api.effects.start.mockResolvedValue({ kind: 'started' });
  api.chat.getSessionTree
    .mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'chat:getSessionTree': Error: session_not_found: Session s1 is not running on the DSH host"
      )
    )
    .mockImplementation(tree);
  const root = await openDialog();
  await act(async () => {
    await vi.waitFor(() => expect(document.body.textContent).toContain('preview a1'));
  });
  expect(api.effects.forgetRunning).toHaveBeenCalledWith('s1');
  expect(api.effects.start).toHaveBeenCalledTimes(1);
  expect(api.chat.getSessionTree).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain('session_not_found');
  await act(async () => root.unmount());
});

it('[176-TREE-START-FAILED] a start that failed says so in words; the reason is on the card', async () => {
  api.effects.start.mockResolvedValue({ kind: 'failed', code: 'session_cwd_mismatch' });
  const root = await openDialog();
  await act(async () => {
    await vi.waitFor(() => expect(document.body.textContent).toContain(zh(SESSION_START_FAILED)));
  });
  expect(zh(SESSION_START_FAILED)).toBe('对话没能启动，原因见对话里的提示。');
  expect(document.body.textContent).not.toContain('No ready Pi WorkerSlot');
  expect(api.chat.getSessionTree).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
