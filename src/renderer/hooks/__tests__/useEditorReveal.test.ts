// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7e e3 (problem 21, decision 142): every request to show a
 * file counts (`revealSeq`), the file that is already the active tab included.
 * The file tree, the workspace search and the chat's file links all go through
 * `useEditor().navigateToFile`; the right column brings the files in front of
 * its terminal on each count (`rightColumnTerminalMount.test.ts`). Before,
 * a click on the active file changed no tab, and the terminal stayed on top.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/stores/editor';
import { useEditor } from '../useEditor';

const read = vi.hoisted(() => {
  const read = async (path: string) => ({
    content: `// ${path}`,
    encoding: 'utf-8',
    isBinary: false,
    tooLarge: false,
    byteLength: 10,
    maxPreviewBytes: 1_000_000,
  });
  window.electronAPI = { file: { read } } as unknown as typeof window.electronAPI;
  return read;
});

let root: Root;
let container: HTMLDivElement;
let navigate: ReturnType<typeof useEditor>['navigateToFile'] | undefined;

function Probe() {
  const { navigateToFile } = useEditor();
  useEffect(() => {
    navigate = navigateToFile;
  });
  return null;
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useEditorStore.setState({
    tabs: [{ path: '/repo/a.ts', title: 'a.ts', content: '', isDirty: false }],
    activeTabPath: '/repo/a.ts',
    revealSeq: 0,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)))
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useEditor().navigateToFile asks the files to the front (P1-7e problem 21)', () => {
  it('[E3-21-SEQ] the active file counts, and so does a new one', async () => {
    expect(read).toBeTypeOf('function');
    await act(async () => navigate?.('/repo/a.ts'));
    expect(useEditorStore.getState().revealSeq).toBe(1);
    expect(useEditorStore.getState().activeTabPath).toBe('/repo/a.ts');
    await act(async () => navigate?.('/repo/b.ts'));
    expect(useEditorStore.getState().revealSeq).toBe(2);
    expect(useEditorStore.getState().activeTabPath).toBe('/repo/b.ts');
  });
});
