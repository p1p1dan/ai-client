// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceSearch } from '../useWorkspaceSearch';

const fixture = vi.hoisted(() => ({
  rootPath: '/repo' as string | null,
  navigateToFile: vi.fn().mockResolvedValue(undefined),
  searchKeybindings: {
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
});
