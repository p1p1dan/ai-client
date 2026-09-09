// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('@/components/files/EditorArea', () => ({
  EditorArea: () => createElement('div', { 'data-editor-mounted': true }),
}));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (select: (s: unknown) => unknown) =>
    select({ editorSettings: { autoSave: 'off' } }),
}));
vi.mock('@/i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock('@/components/ui/toast', () => ({ toastManager: { add: vi.fn() } }));

import { toastManager } from '@/components/ui/toast';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useEditorStore } from '@/stores/editor';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { EditorColumn } from '../../center/EditorColumn';
import { useEditorWorktreeSync } from '../../useEditorWorktreeSync';

function ShellGate() {
  useEditorWorktreeSync();
  const open = useEditorStore((s) => s.tabs.length > 0);
  const pending = useFileOpenIntentStore((s) => s.intent !== null);
  return open || pending ? createElement(EditorColumn) : null;
}
it('mounts the first editor, reuses tabs, jumps to lines, and reports a failed read', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const read = vi
    .fn()
    .mockResolvedValue({ content: 'one\ntwo\nthree', encoding: 'utf8', isBinary: false });
  vi.stubGlobal('electronAPI', { file: { read } });
  useChatSessionsStore.setState({
    activeSessionId: 's',
    sessions: [
      { id: 's', workspaceId: 'w', projectId: 'p', title: 'test', status: 'idle', updatedAt: 0 },
    ],
    workspaces: [{ id: 'w', projectId: 'p', kind: 'main', name: 'repo', path: 'C:/repo' }],
  });
  useEditorStore.setState({ tabs: [], activeTabPath: null, currentWorktreePath: null });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  const request = async (path: string, line = 2) => {
    await act(async () => {
      useFileOpenIntentStore.getState().requestFileOpen({ path, line, source: 'tool-row' });
    });
  };
  try {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(ShellGate)));
    });
    expect(container.querySelector('[data-editor-mounted]')).toBeNull();
    await request('src/app.ts');
    expect(read).toHaveBeenCalledWith('C:/repo/src/app.ts');
    expect(container.querySelector('[data-editor-mounted]')).not.toBeNull();
    expect(useEditorStore.getState().pendingCursor).toMatchObject({ line: 2 });
    await request('C:\\repo\\src\\app.ts', 3);
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().pendingCursor).toMatchObject({ line: 3 });
    await request('/outside/absolute.ts');
    expect(useEditorStore.getState().tabs).toHaveLength(2);
    read.mockRejectedValueOnce(new Error('missing'));
    await request('missing.ts');
    expect(toastManager.add).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(useFileOpenIntentStore.getState().intent).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  }
});
