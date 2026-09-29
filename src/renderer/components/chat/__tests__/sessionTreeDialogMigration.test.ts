// @vitest-environment happy-dom
/**
 * dsh-rebase P1-9e (decision 122 rule 14): the session tree over a chat from
 * the previous version. Main answers the tree, a rewind and a fork with
 * `legacy_migration_required` until the chat is on the current engine; the
 * dialog resumes it (which moves it) and asks again. A move that fails says so
 * in words — its card, with the reason, is in the conversation.
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
  // Both hooks hand out stable functions in the app (a module constant and a
  // `useCallback`); the stubs must too, or the dialog's tree effect, which
  // depends on them, re-runs on every render.
  return { chat, resume: vi.fn(), resolveModel: () => 'glm/glm-5' };
});

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../useResolvedSessionModel', () => ({ useResolvedSessionModel: () => api.resolveModel }));
vi.mock('../sessionIndex/useResumeSession', () => ({
  useResumeSession: () => ({ resume: api.resume }),
}));

import { SessionTreeDialog } from '../SessionTreeDialog';
import { LEGACY_MIGRATION_OPERATION_FAILED } from '../sessionIndex/legacyMigration';

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
  api.chat.getSessionTree.mockRejectedValueOnce(REQUIRED).mockImplementation(tree);
  api.resume.mockResolvedValue(true);
  const root = await openDialog();
  await act(async () => {
    await vi.waitFor(() => expect(document.body.textContent).toContain('preview a1'));
  });
  expect(api.resume).toHaveBeenCalledTimes(1);
  expect(api.resume).toHaveBeenCalledWith('s1', { model: 'glm/glm-5' });
  expect(api.chat.getSessionTree).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
});

it('says in words that the move failed, instead of Main’s code', async () => {
  api.chat.getSessionTree.mockRejectedValue(REQUIRED);
  api.resume.mockResolvedValue(false);
  const root = await openDialog();
  await act(async () => {
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(zh(LEGACY_MIGRATION_OPERATION_FAILED))
    );
  });
  const text = document.body.textContent ?? '';
  expect(zh(LEGACY_MIGRATION_OPERATION_FAILED)).not.toBe(LEGACY_MIGRATION_OPERATION_FAILED);
  expect(text).not.toContain('legacy_migration_required');
  // Asked once; the failed move is not retried behind the user's back.
  expect(api.chat.getSessionTree).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it('a fork asked of a chat not moved yet moves it and forks', async () => {
  api.chat.getSessionTree.mockImplementation(tree);
  api.chat.forkSession
    .mockRejectedValueOnce(REQUIRED)
    .mockRejectedValueOnce(new Error('WORKER_FORK_FAILED: stop here'));
  api.resume.mockResolvedValue(true);
  const root = await openDialog();
  await act(async () => {
    await vi.waitFor(() => expect(document.body.textContent).toContain('preview a1'));
  });
  const fork = [...document.body.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === zh('Fork from here') && !button.disabled
  );
  await act(async () => fork?.click());
  expect(api.resume).toHaveBeenCalledWith('s1', { model: 'glm/glm-5' });
  expect(api.chat.forkSession).toHaveBeenCalledTimes(2);
  expect(api.chat.forkSession).toHaveBeenLastCalledWith({ sessionId: 's1', entryId: 'a1' });
  // The second answer is an ordinary failure, shown as it came.
  expect(document.body.textContent).toContain('WORKER_FORK_FAILED: stop here');
  await act(async () => root.unmount());
});
