// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatJumpStore } from '@/stores/chatJump';
import { useWorkspaceSearch } from '../useWorkspaceSearch';

const fixture = vi.hoisted(() => ({
  rootPath: '/repo' as string | null,
  navigateToFile: vi.fn().mockResolvedValue(undefined),
  activate: vi.fn(),
  sessions: [{ id: 's1' }] as { id: string }[],
  searchKeybindings: {
    searchChats: { key: 'k', ctrl: true, shift: true },
    searchFiles: { key: 'p', ctrl: true },
    searchContent: { key: 'f', ctrl: true, shift: true },
  },
}));

vi.mock('@/hooks/useEditor', () => ({
  useEditor: () => ({ navigateToFile: fixture.navigateToFile }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: typeof fixture) => unknown) => selector(fixture),
}));
vi.mock('@/stores/chatSessions', () => ({
  useChatSessionsStore: { getState: () => ({ sessions: fixture.sessions }) },
}));
vi.mock('../useActivateSession', () => ({
  useActivateSession: () => fixture.activate,
}));
vi.mock('../useWorkspaceRootPath', () => ({
  useWorkspaceRootPath: () => fixture.rootPath,
  readWorkspaceRootPath: () => fixture.rootPath,
}));

let root: Root;
let container: HTMLDivElement;
let search: ReturnType<typeof useWorkspaceSearch>;

function Probe() {
  search = useWorkspaceSearch();
  return null;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.rootPath = '/repo';
  fixture.navigateToFile.mockClear();
  fixture.activate.mockClear();
  useChatJumpStore.setState({ request: null, lastSeq: 0 });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(createElement(Probe)));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('workspace search controller', () => {
  it('opens from a shell shortcut without mounting the files surface', async () => {
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      ctrlKey: true,
      cancelable: true,
    });
    await act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(search.request).toEqual({ rootPath: '/repo', mode: 'files' });
  });

  it('does not intercept shortcuts without a workspace or while a modal owns focus', async () => {
    fixture.rootPath = null;
    await act(() => search.openSearch('files'));
    expect(search.request).toBeNull();
    fixture.rootPath = '/repo';
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    container.append(dialog);
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      ctrlKey: true,
      cancelable: true,
    });
    await act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(search.request).toBeNull();
  });

  it('forwards match coordinates and aborts navigation after a workspace switch', async () => {
    await act(() => search.openSearch('content'));
    search.onOpenFile('/repo/file.ts', 8, 2, 3);
    expect(fixture.navigateToFile).toHaveBeenCalledWith('/repo/file.ts', 8, 2, 3, undefined, {
      stillValid: expect.any(Function),
    });
    const options = fixture.navigateToFile.mock.calls[0][5];
    expect(options.stillValid()).toBe(true);
    const oldOpenFile = search.onOpenFile;
    fixture.rootPath = '/other';
    expect(options.stillValid()).toBe(false);
    oldOpenFile('/repo/late.ts');
    expect(fixture.navigateToFile).toHaveBeenCalledTimes(1);
    await act(() => root.render(createElement(Probe)));
    expect(search.request).toBeNull();
  });

  it('opens the chats tab without a workspace, and only that tab', async () => {
    fixture.rootPath = null;
    await act(() => root.render(createElement(Probe)));
    await act(() => search.openSearch('files'));
    expect(search.request).toBeNull();
    await act(() => search.openSearch('chat'));
    expect(search.request).toEqual({ rootPath: null, mode: 'chat' });
  });

  it('opens chat search from its shortcut even without a workspace', async () => {
    fixture.rootPath = null;
    await act(() => root.render(createElement(Probe)));
    const event = new KeyboardEvent('keydown', {
      key: 'K',
      code: 'KeyK',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    await act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(search.request).toEqual({ rootPath: null, mode: 'chat' });
  });

  it('opens a picked chat through the sidebar activation and asks for its first match', async () => {
    search.onOpenChat(
      {
        sessionId: 's1',
        title: 'Lot yield',
        titleMatch: false,
        workspacePath: '/repo',
        repoName: 'repo',
        updatedAt: 1,
        snippet: null,
        hitCount: 2,
        messageKeys: ['h:a', 'h:b'],
      },
      '8GE21E15'
    );
    expect(fixture.activate).toHaveBeenCalledWith('s1');
    expect(useChatJumpStore.getState().request).toMatchObject({
      sessionId: 's1',
      query: '8GE21E15',
      messageKeys: ['h:a', 'h:b'],
      index: 0,
    });
  });

  it('opens a title-only match without a jump, and ignores a chat the renderer does not know', async () => {
    const row = {
      sessionId: 's1',
      title: 'Lot yield',
      titleMatch: true,
      workspacePath: null,
      repoName: null,
      updatedAt: 1,
      snippet: null,
      hitCount: 0,
      messageKeys: [],
    };
    search.onOpenChat(row, 'yield');
    expect(fixture.activate).toHaveBeenCalledWith('s1');
    expect(useChatJumpStore.getState().request).toBeNull();
    search.onOpenChat({ ...row, sessionId: 'gone' }, 'yield');
    expect(fixture.activate).toHaveBeenCalledTimes(1);
  });
});
