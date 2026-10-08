// @vitest-environment happy-dom
/**
 * Decision 162: on the encrypted host a git read that failed reached the git
 * panel as `data: undefined`, and the panel drew it as 「没有更改」 and
 * 「暂无提交记录」 — a failed read looked like a clean, empty repository. The
 * changes list and the history now say the read failed, in one line, and
 * still say "no changes" / "no commits" when that is the answer.
 *
 * Mounted for real (`ChangesList`, `GitHistoryList`); the `electronAPI` stub is
 * hoisted because persisted stores rehydrate at import.
 */

import { englishTranslate, zhTranslations } from '@shared/i18n';
import type { FileChange, GitLogEntry } from '@shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  const git = {
    getCommitFiles: async (_workdir: string, _hash: string): Promise<unknown[]> => [],
  };
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    git,
  } as unknown as typeof window.electronAPI;
  return { git };
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));
// The review dialog is not under test and pulls the model catalog.
vi.mock('@/components/source-control/CodeReviewModal', () => ({ CodeReviewModal: () => null }));

const { ChangesList } = await import('@/components/source-control/ChangesList');
const { GitHistoryList } = await import('../GitHistoryList');
const { describeGitReadError } = await import('../gitSurfaceModel');
const { describeDiffLoadError } = await import('@/components/source-control/diffLoadError');

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, element));
  });
}

function changesList(props: { staged?: FileChange[]; loadError?: string | null }) {
  return createElement(ChangesList, {
    staged: props.staged ?? [],
    unstaged: [],
    selectedFile: null,
    onFileClick: () => undefined,
    onStage: () => undefined,
    onUnstage: () => undefined,
    onDiscard: () => undefined,
    loadError: props.loadError,
  });
}

const COMMIT: GitLogEntry = {
  hash: 'a'.repeat(40),
  date: '2026-10-08T00:00:00Z',
  message: 'first commit',
  fullMessage: 'first commit',
  author_name: 'Test',
  author_email: 'test@example.com',
};

function historyList(props: {
  commits?: GitLogEntry[];
  loadError?: string | null;
  expandedCommitHash?: string | null;
}) {
  return createElement(GitHistoryList, {
    commits: props.commits ?? [],
    expanded: true,
    onToggle: () => undefined,
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    onLoadMore: () => undefined,
    workdir: '/repo',
    expandedCommitHash: props.expandedCommitHash ?? null,
    onToggleCommit: () => undefined,
    selectedCommitFile: null,
    onSelectCommitFile: () => undefined,
    loadError: props.loadError,
  });
}

const testId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  client.clear();
  vi.unstubAllGlobals();
});

describe('describeGitReadError', () => {
  it('is null without an error and the unwrapped reason with one', () => {
    expect(describeGitReadError(null)).toBeNull();
    expect(describeGitReadError(undefined)).toBeNull();
    expect(
      describeGitReadError(
        new Error(
          "Error invoking remote method 'git:fileChanges': GitOutputLostError: git status via the node runner exited 0 without emitting branch headers; its output was lost"
        )
      )
    ).toBe(
      'git status via the node runner exited 0 without emitting branch headers; its output was lost'
    );
    expect(describeGitReadError(new Error(''))).toBe('Unknown error');
  });
});

describe('ChangesList: a failed read is not 「没有更改」', () => {
  it('says the read failed instead of "No changes" when nothing is listed', async () => {
    await render(changesList({ loadError: 'its output was lost' }));

    expect(testId('changes-load-error')?.textContent).toBe(
      'Could not read the changes: its output was lost'
    );
    expect(container.textContent).not.toContain('No changes');
  });

  it('keeps the last listed changes under the error line', async () => {
    await render(
      changesList({
        staged: [{ path: 'kept.txt', status: 'M', staged: true }],
        loadError: 'timed out',
      })
    );

    expect(testId('changes-load-error')).not.toBeNull();
    expect(container.textContent).toContain('kept.txt');
  });

  it('still says "No changes" for a clean tree', async () => {
    await render(changesList({ loadError: null }));

    expect(testId('changes-load-error')).toBeNull();
    expect(container.textContent).toContain('No changes');
  });
});

describe('GitHistoryList: a failed read is not 「暂无提交记录」', () => {
  it('says the read failed instead of "No commits yet" when nothing is listed', async () => {
    await render(historyList({ loadError: 'its output was lost' }));

    expect(testId('history-load-error')?.textContent).toBe(
      'Could not read the commit history: its output was lost'
    );
    expect(container.textContent).not.toContain('No commits yet');
  });

  it('still says "No commits yet" for an empty history', async () => {
    await render(historyList({ loadError: null }));

    expect(testId('history-load-error')).toBeNull();
    expect(container.textContent).toContain('No commits yet');
  });

  it('says an expanded commit\'s files could not be read instead of "No files"', async () => {
    api.git.getCommitFiles = async () => {
      throw new Error(
        "Error invoking remote method 'git:commitFiles': GitOutputLostError: its output was lost"
      );
    };

    await render(historyList({ commits: [COMMIT], expandedCommitHash: COMMIT.hash }));
    await act(async () => {
      await vi.waitFor(() => expect(testId('commit-files-load-error')).not.toBeNull());
    });

    expect(testId('commit-files-load-error')?.textContent).toBe(
      'Could not read the files of this commit: its output was lost'
    );
    expect(container.textContent).not.toContain('No files');
  });
});

describe('describeDiffLoadError (the reason under 「无法加载差异」)', () => {
  const ipc = (message: string) =>
    new Error(`Error invoking remote method 'git:fileDiff': Error: ${message}`);

  it('names a blob too large or too slow to read, and passes anything else through', () => {
    expect(
      describeDiffLoadError(
        ipc('GIT_BLOB_TOO_LARGE: HEAD:big.bin is larger than 32 MB'),
        englishTranslate
      )
    ).toBe('This file is too large to show a diff (over 32 MB).');
    expect(
      describeDiffLoadError(
        ipc('GIT_BLOB_READ_TIMEOUT: reading :a.txt took longer than 120 s'),
        englishTranslate
      )
    ).toBe('Reading this file from Git timed out.');
    expect(
      describeDiffLoadError(ipc('git show via the node runner failed: exit 9'), englishTranslate)
    ).toBe('git show via the node runner failed: exit 9');
    expect(describeDiffLoadError(null, englishTranslate)).toBeNull();
  });
});

describe('the new lines are translated', () => {
  it('has a zh entry for every new key', () => {
    for (const key of [
      'Could not read the changes',
      'Could not read the commit history',
      'Could not read the files of this commit',
      'Could not read the current branch',
      'This file is too large to show a diff (over {{size}}).',
      'Reading this file from Git timed out.',
    ]) {
      expect(zhTranslations[key], key).toBeTruthy();
    }
  });
});
