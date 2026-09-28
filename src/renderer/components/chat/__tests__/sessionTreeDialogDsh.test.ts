// @vitest-environment happy-dom
/**
 * dsh-rebase P1-4b — the session tree dialog over a DSH session (decisions 026
 * and 027; P1-1 point-check defect D4: the dialog showed no nodes, so neither
 * rewind nor fork had an entry point).
 *
 * A DSH tree merges the current session with the ones earlier rewinds
 * retired: the abandoned branch is listed, not active, and every node offers
 * both actions. The copy names no engine — a rewind here truncates nothing
 * because nothing is ever deleted, not because a "Pi session file" survives.
 * And the one refusal specific to DSH, a background job still running, reads
 * as a sentence, not as an error code.
 */

import { translate } from '@shared/i18n';
import type { SessionTreeNode, SessionTreeSnapshot } from '@shared/types/sessionHistory';
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
  return { chat };
});

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));

import { SessionTreeDialog } from '../SessionTreeDialog';

function node(
  id: string,
  parentId: string | null,
  depth: number,
  over: Partial<SessionTreeNode> = {}
): SessionTreeNode {
  return {
    id,
    parentId,
    depth,
    entryType: 'message',
    role: id.startsWith('u') ? 'user' : 'assistant',
    preview: `preview ${id}`,
    childCount: 0,
    forkable: !id.startsWith('u1'),
    active: true,
    leaf: false,
    ...over,
  };
}

/** u1 -> a1 -> {u2 -> a2 (retired by a rewind), u3 (current leaf)}. */
const SNAPSHOT: SessionTreeSnapshot = {
  logicalSessionId: 's1',
  sessionFile: '/dsh-home/aiclient-sessions/aiclient-s1.dsh.json',
  workspacePath: '/repo',
  leaf: { activeEntryId: 'u3', fileTailEntryId: 'aiclient-s1.r2#40' },
  nodes: [
    node('u1', null, 0, { childCount: 1 }),
    node('a1', 'u1', 1, { childCount: 2 }),
    node('u2', 'a1', 2, { active: false, childCount: 1 }),
    node('a2', 'u2', 3, { active: false }),
    node('u3', 'a1', 2, { leaf: true }),
  ],
  totalNodes: 5,
  returnedNodes: 5,
  truncated: false,
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.chat.getSessionTree.mockImplementation(
    async ({ requestSequence }: { requestSequence: number }) => ({
      sessionKey: 's1:key',
      requestSequence,
      branchRevision: 0,
      snapshot: SNAPSHOT,
    })
  );
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
  await act(async () => {
    await vi.waitFor(() => expect(document.body.textContent).toContain('preview a2'));
  });
  return root;
}

/** The row of the node whose preview is `preview`, and its two action buttons. */
function row(preview: string) {
  const title = [...document.body.querySelectorAll('span')].find(
    (span) => span.textContent === preview
  );
  const element = title?.parentElement as HTMLElement;
  const [rewind, fork] = [...element.querySelectorAll('button')];
  return { element, rewind: rewind as HTMLButtonElement, fork: fork as HTMLButtonElement };
}

it('lists the retired branch beside the current one, with rewind and fork on every node (D4)', async () => {
  const root = await openDialog();
  const text = document.body.textContent ?? '';
  expect(text).toContain(zh('{{shown}} of {{total}} nodes', { shown: 5, total: 5 }));
  for (const preview of ['preview u1', 'preview a1', 'preview u2', 'preview a2', 'preview u3']) {
    const { rewind, fork } = row(preview);
    expect(rewind.getAttribute('aria-label')).toBe(zh('Rewind here'));
    expect(fork.getAttribute('aria-label')).toBe(zh('Fork from here'));
  }
  // The abandoned branch can be returned to and forked from; the leaf cannot be rewound to.
  expect(row('preview a2').rewind.disabled).toBe(false);
  expect(row('preview a2').fork.disabled).toBe(false);
  expect(row('preview u3').rewind.disabled).toBe(true);
  // Before the first answer there is nothing to fork.
  expect(row('preview u1').fork.disabled).toBe(true);
  await act(async () => root.unmount());
});

it('says what a rewind does without naming an engine', async () => {
  const root = await openDialog();
  await act(async () => row('preview a2').rewind.click());
  const text = document.body.textContent ?? '';
  expect(text).toContain(zh('Rewind this session?'));
  expect(text).toContain('之后的消息会保留为另一条分支，不会被删除。');
  expect(text).not.toMatch(/\bPi\b/);
  expect(text).not.toContain('截断');
  await act(async () => root.unmount());
});

it('rewinds to the node the user picked, confirmed', async () => {
  api.chat.rewindSession.mockResolvedValue({ tree: SNAPSHOT });
  const root = await openDialog();
  await act(async () => row('preview a2').rewind.click());
  const confirm = [...document.body.querySelectorAll('button')].find(
    (button) => button.textContent === zh('Rewind')
  );
  await act(async () => confirm?.click());
  expect(api.chat.rewindSession).toHaveBeenCalledWith({
    sessionId: 's1',
    entryId: 'a2',
    confirmed: true,
  });
  await act(async () => root.unmount());
});

it('explains the background-job refusal instead of showing its code', async () => {
  api.chat.rewindSession.mockRejectedValue(
    new Error(
      "Error invoking remote method 'chat:rewind-session': WorkerSlotError: WORKER_REWIND_JOBS_RUNNING: A background job of this session is still running"
    )
  );
  const root = await openDialog();
  await act(async () => row('preview a2').rewind.click());
  const confirm = [...document.body.querySelectorAll('button')].find(
    (button) => button.textContent === zh('Rewind')
  );
  await act(async () => confirm?.click());
  const text = document.body.textContent ?? '';
  expect(text).toContain('这个会话还有后台任务在运行。请等它结束或先停止它，再回退。');
  expect(text).not.toContain('WORKER_REWIND_JOBS_RUNNING');
  await act(async () => root.unmount());
});
