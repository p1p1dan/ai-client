// @vitest-environment happy-dom
import type { LegacyImportProject, LegacyImportSessionPreview } from '@shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * H/21 C5 — the Settings pane that makes Claude Code / Codex import reachable.
 *
 * Mounted for real against a stubbed bridge, because the three things worth
 * checking are all behavioural: does a machine with no history say so instead
 * of showing an empty list, does an unmatched folder warn BEFORE the import
 * rather than after, and does the request carry the match verdict the pane is
 * the only one able to make.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

vi.mock('@/components/chat/sessionIndex/useSessionIndex', () => ({
  refreshSessionIndexNow: vi.fn(async () => true),
}));

import { refreshSessionIndexNow } from '@/components/chat/sessionIndex/useSessionIndex';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { ConversationImportSettings } from '../ConversationImportSettings';

const api = {
  listProjects: vi.fn<() => Promise<LegacyImportProject[]>>(),
  listSessions: vi.fn<() => Promise<LegacyImportSessionPreview[]>>(),
  importBatch: vi.fn(),
};

const MATCHED_PROJECT: LegacyImportProject = {
  sourceKind: 'claude-code',
  id: 'project-known',
  path: '/home/u/code/known',
  sessionCount: 2,
  lastActivityAt: 1_700_000_000_000,
};

const UNMATCHED_PROJECT: LegacyImportProject = {
  sourceKind: 'codex',
  id: 'project-stranger',
  path: '/home/u/code/stranger',
  sessionCount: 1,
  lastActivityAt: 1_700_000_000_000,
};

function preview(id: string): LegacyImportSessionPreview {
  return {
    id,
    projectId: 'project-known',
    firstMessage: `first message of ${id}`,
    createdAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_000_000,
    model: null,
    importedSnapshots: 0,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.listProjects.mockResolvedValue([MATCHED_PROJECT, UNMATCHED_PROJECT]);
  api.listSessions.mockResolvedValue([preview('session-1'), preview('session-2')]);
  api.importBatch.mockResolvedValue({
    results: [
      {
        source: {
          sourceKind: 'claude-code',
          projectId: 'project-known',
          sourceSessionId: 'session-1',
        },
        status: 'imported',
      },
      {
        source: {
          sourceKind: 'claude-code',
          projectId: 'project-known',
          sourceSessionId: 'session-2',
        },
        status: 'already-imported',
      },
    ],
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = { legacyImport: api };
  useChatSessionsStore.setState({
    workspaces: [
      { id: 'ws-1', projectId: 'p-1', name: 'known', path: '/home/u/code/known', isMain: true },
    ],
  } as never);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function text(): string {
  return document.body.textContent ?? '';
}

function selectAll(): HTMLElement | null {
  return document.body.querySelector('[aria-label="Select all"]');
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(label)
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(() =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(ConversationImportSettings))
    )
  );
  await settle();
}

describe('ConversationImportSettings (H/21 C5)', () => {
  it('[CI-01] lists what was found and names the source of each project', async () => {
    await mount();
    expect(text()).toContain('/home/u/code/known');
    expect(text()).toContain('Claude Code');
    expect(text()).toContain('Codex');
  });

  it('[CI-02] says so plainly on a machine with no Claude/Codex history', async () => {
    api.listProjects.mockResolvedValue([]);
    await mount();
    expect(text()).toContain('No Claude Code or Codex conversations were found on this machine.');
  });

  it('[CI-03] marks a folder this app does not know, and leaves the known one unmarked', async () => {
    await mount();
    const rows = [...document.body.querySelectorAll('li')];
    const known = rows.find((row) => row.textContent?.includes('/home/u/code/known'));
    const stranger = rows.find((row) => row.textContent?.includes('/home/u/code/stranger'));
    expect(known?.textContent).not.toContain('No matching folder');
    expect(stranger?.textContent).toContain('No matching folder');
  });

  it('[CI-04] warns before the import that an unmatched folder lands as a temporary chat', async () => {
    await mount();
    await act(() => button('stranger')?.click());
    await settle();
    expect(text()).toContain(
      'This folder is not one of your projects here, so these conversations import as temporary chats.'
    );
  });

  it('[CI-05] sends the match verdict, reports the outcome, and refreshes the sidebar', async () => {
    await mount();
    await act(() => button('known')?.click());
    await settle();
    await act(() => selectAll()?.click());
    await settle();
    await act(() => button('Import selected')?.click());
    await settle();

    expect(api.importBatch).toHaveBeenCalledTimes(1);
    const request = api.importBatch.mock.calls[0][0] as {
      sources: Array<{ sourceSessionId: string; workspaceMatched: boolean }>;
    };
    expect(request.sources.map((source) => source.sourceSessionId).sort()).toEqual([
      'session-1',
      'session-2',
    ]);
    expect(request.sources.every((source) => source.workspaceMatched === true)).toBe(true);
    expect(text()).toContain('Imported {{imported}}, already here {{skipped}}, failed {{failed}}.');
    expect(refreshSessionIndexNow).toHaveBeenCalledTimes(1);
  });

  it('[CI-06] sends workspaceMatched=false for a folder this app does not know', async () => {
    await mount();
    await act(() => button('stranger')?.click());
    await settle();
    await act(() => selectAll()?.click());
    await settle();
    await act(() => button('Import selected')?.click());
    await settle();

    const request = api.importBatch.mock.calls[0][0] as {
      sources: Array<{ workspaceMatched: boolean }>;
    };
    expect(request.sources.every((source) => source.workspaceMatched === false)).toBe(true);
  });
});
