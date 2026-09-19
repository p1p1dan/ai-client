// @vitest-environment happy-dom
/**
 * F1 regression: clicking a hit in a tool row's hit list opened the file's tab
 * but never jumped to the line, and left `pendingCursor` hanging forever —
 * unless the editor happened to be empty, i.e. this was the first file ever
 * opened.
 *
 * Cause: `<Editor path=… />` has no `key`, so switching tabs swaps Monaco's
 * model IN PLACE instead of remounting. `handleEditorMount` therefore fires
 * once per editor instance, and the path it captured there stayed pinned to
 * the first file. The pending-cursor effect compared against that captured
 * path, so for every later file the comparison failed and the effect returned
 * early — no `setPosition`, no `onClearPendingCursor`.
 *
 * The fix keys off the editor's LIVE model URI instead. These tests drive the
 * real component against a fake `@monaco-editor/react` whose model-swap
 * timing mirrors the real one (a child effect on `[path]`, so it lands before
 * the parent's effects in the same commit — see the library's `useUpdate`).
 * Monaco itself cannot be loaded under vitest (`monacoSetup` does a top-level
 * `await loader.init()` plus `?worker` imports), hence the stubs.
 */

import { act, createElement, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

// The settings store rehydrates through `window.electronAPI.settings` at
// IMPORT time — stubbing it later (in `beforeEach`) hangs the whole file with
// no error. Same reason `settings/__tests__/terminalInteraction.test.ts` uses
// a hoisted block.
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined },
    file: {
      read: async () => ({ content: '', encoding: 'utf8', isBinary: false }),
      write: async () => undefined,
      onChange: () => () => {},
    },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));

const h = vi.hoisted(() => {
  const uriFor = (path: string) => `file://${path}`;

  // `<Editor path=…/>` is handed a URI string (`toMonacoFileUri`), and Monaco
  // keys the model on exactly that — so the fake model echoes it back.
  function createModel(uri: string) {
    return {
      uri: { toString: () => uri },
      getLanguageId: () => 'typescript',
    };
  }

  interface FakeEditor {
    positions: { lineNumber: number; column: number }[];
    selections: unknown[];
    revealed: unknown[];
    focusCount: number;
    getModel: () => ReturnType<typeof createModel>;
    setModel: (next: ReturnType<typeof createModel>) => void;
    [key: string]: unknown;
  }

  function createEditor(path: string, readValue: () => string): FakeEditor {
    const modelListeners = new Set<() => void>();
    let model = createModel(path);
    const base: FakeEditor = {
      positions: [],
      selections: [],
      revealed: [],
      focusCount: 0,
      getModel: () => model,
      setModel: (next) => {
        model = next;
        for (const listener of [...modelListeners]) listener();
      },
      setPosition: (position: { lineNumber: number; column: number }) => {
        base.positions.push(position);
      },
      getPosition: () => base.positions.at(-1) ?? null,
      setSelection: (selection: unknown) => {
        base.selections.push(selection);
      },
      getSelection: () => null,
      revealLineInCenter: (line: unknown) => {
        base.revealed.push(line);
      },
      revealRangeInCenter: (range: unknown) => {
        base.revealed.push(range);
      },
      focus: () => {
        base.focusCount += 1;
      },
      getValue: () => readValue(),
      setValue: () => {},
      updateOptions: () => {},
      onDidChangeModel: (listener: () => void) => {
        modelListeners.add(listener);
        return { dispose: () => modelListeners.delete(listener) };
      },
    };
    // Everything else Monaco exposes at mount time (addCommand, addAction,
    // onKeyDown, onDidScrollChange, content widgets…) is a no-op that returns
    // a disposable — none of it is what these tests are about.
    return new Proxy(base, {
      get: (target, prop) =>
        prop in target ? target[prop as string] : () => ({ dispose: () => {} }),
    }) as FakeEditor;
  }

  const monaco = {
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 },
    KeyCode: new Proxy({} as Record<string, number>, { get: () => 1 }),
    Uri: { file: (path: string) => ({ toString: () => uriFor(path) }) },
    editor: {
      ContentWidgetPositionPreference: { EXACT: 0, ABOVE: 1, BELOW: 2 },
      setModelLanguage: () => {},
    },
  };

  const state = {
    editors: [] as FakeEditor[],
    /** When true, a tab switch parks the swap in `pendingModelSwap` instead. */
    deferModelSwap: false,
    pendingModelSwap: null as null | (() => void),
  };

  return { uriFor, createModel, createEditor, monaco, state };
});

vi.mock('@/components/files/monacoSetup', () => ({ monaco: h.monaco }));
vi.mock('@/components/files/monacoTheme', () => ({
  CUSTOM_THEME_NAME: 'test-theme',
  defineMonacoTheme: () => {},
}));
vi.mock('@/components/files/editorDefinitionProvider', () => ({
  setupDefinitionNavigation: () => ({ dispose: () => {} }),
}));
vi.mock('@/components/files/editorScopeSelection', () => ({ setupDoubleClickScope: () => {} }));
vi.mock('@/components/files/useEditorBlame', () => ({
  useEditorBlame: () => ({ refreshBlame: () => {} }),
}));
vi.mock('@/components/files/EditorLineComment', () => ({
  useEditorLineComment: () => {},
  CommentForm: () => null,
}));
vi.mock('@/components/files/EditorTabs', () => ({ EditorTabs: () => null }));
vi.mock('@/components/files/BreadcrumbTreeMenu', () => ({ BreadcrumbTreeMenu: () => null }));
vi.mock('@/components/files/MarkdownPreview', () => ({ MarkdownPreview: () => null }));
vi.mock('@/components/files/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('@/components/files/PdfPreview', () => ({ PdfPreview: () => null }));
vi.mock('@/components/source-control/DiffViewer', () => ({ DiffViewer: () => null }));
vi.mock('@/hooks/useGitHistory', () => ({
  useCommitDiff: () => ({ data: null, isPending: false }),
}));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

vi.mock('@monaco-editor/react', () => {
  function FakeEditor({
    path,
    value,
    onMount,
  }: {
    path: string;
    value: string;
    onMount: (editor: unknown, monaco: unknown) => void;
  }) {
    const editorRef = useRef<ReturnType<typeof h.createEditor> | null>(null);
    const valueRef = useRef(value);
    const pathRef = useRef(path);
    const onMountRef = useRef(onMount);
    const isFirstPathRef = useRef(true);
    valueRef.current = value;
    pathRef.current = path;
    onMountRef.current = onMount;

    useEffect(() => {
      const editor = h.createEditor(pathRef.current, () => valueRef.current);
      editorRef.current = editor;
      h.state.editors.push(editor);
      onMountRef.current(editor, h.monaco);
      // Mount-only, exactly like the real component's editor creation.
    }, []);

    // Mirrors @monaco-editor/react's `useUpdate(..., [path])`: the model is
    // swapped on the SAME instance, from a child effect.
    useEffect(() => {
      if (isFirstPathRef.current) {
        isFirstPathRef.current = false;
        return;
      }
      const editor = editorRef.current;
      if (!editor) return;
      const swap = () => editor.setModel(h.createModel(path));
      if (h.state.deferModelSwap) {
        h.state.pendingModelSwap = swap;
      } else {
        swap();
      }
    }, [path]);

    return createElement('div', { 'data-fake-editor': path });
  }

  return {
    default: FakeEditor,
    DiffEditor: () => null,
    loader: { config: () => {}, init: () => Promise.resolve(h.monaco) },
  };
});

const { EditorArea } = await import('../EditorArea');

const FILE_A = '/repo/src/App.tsx';
const FILE_B = '/repo/src/renderer/components/chat/toolCard.ts';

function tab(path: string, content: string) {
  return { path, title: path.split('/').pop() ?? path, content, isDirty: false };
}

interface Scene {
  activeTabPath: string;
  pendingCursor: { path: string; line: number; column?: number; matchLength?: number } | null;
}

function render(scene: Scene, onClearPendingCursor: () => void) {
  const tabs = [tab(FILE_A, 'a\n'.repeat(20)), tab(FILE_B, 'b\n'.repeat(500))];
  const activeTab = tabs.find((item) => item.path === scene.activeTabPath) ?? null;
  return createElement(EditorArea, {
    tabs,
    activeTab,
    activeTabPath: scene.activeTabPath,
    pendingCursor: scene.pendingCursor,
    rootPath: '/repo',
    onTabClick: () => {},
    onTabClose: () => {},
    onTabReorder: () => {},
    onContentChange: () => {},
    onViewStateChange: () => {},
    onSave: () => {},
    onClearPendingCursor,
  });
}

beforeEach(() => {
  h.state.editors.length = 0;
  h.state.deferModelSwap = false;
  h.state.pendingModelSwap = null;
});

it('jumps to the line when the target file opens into an editor that already held another file', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const clear = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    // 1. First file opens the editor, no cursor intent.
    await act(async () => {
      root.render(render({ activeTabPath: FILE_A, pendingCursor: null }, clear));
    });
    expect(h.state.editors).toHaveLength(1);
    const editor = h.state.editors[0];
    expect(editor.positions).toHaveLength(0);

    // 2. A hit-list click opens a SECOND file with a line intent. The editor
    //    instance is reused — only its model changes.
    await act(async () => {
      root.render(
        render({ activeTabPath: FILE_B, pendingCursor: { path: FILE_B, line: 464 } }, clear)
      );
    });

    expect(h.state.editors).toHaveLength(1);
    expect(editor.getModel().uri.toString()).toBe(h.uriFor(FILE_B));
    expect(editor.positions).toEqual([{ lineNumber: 464, column: 1 }]);
    expect(editor.revealed).toEqual([464]);
    expect(editor.focusCount).toBe(1);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('waits for the model swap instead of moving the caret in the previous file — and applies once it lands', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const clear = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(render({ activeTabPath: FILE_A, pendingCursor: null }, clear));
    });
    const editor = h.state.editors[0];

    h.state.deferModelSwap = true;
    await act(async () => {
      root.render(
        render({ activeTabPath: FILE_B, pendingCursor: { path: FILE_B, line: 464 } }, clear)
      );
    });

    // The editor still shows file A — moving the caret now would scroll the
    // WRONG file, and clearing the intent would lose the jump for good.
    expect(editor.getModel().uri.toString()).toBe(h.uriFor(FILE_A));
    expect(editor.positions).toHaveLength(0);
    expect(clear).not.toHaveBeenCalled();

    // The swap lands late; `onDidChangeModel` re-drives the effect.
    await act(async () => {
      h.state.pendingModelSwap?.();
    });
    expect(editor.positions).toEqual([{ lineNumber: 464, column: 1 }]);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('selects the match range when the intent carries a column and match length', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const clear = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(render({ activeTabPath: FILE_A, pendingCursor: null }, clear));
    });
    const editor = h.state.editors[0];
    await act(async () => {
      root.render(
        render(
          {
            activeTabPath: FILE_B,
            pendingCursor: { path: FILE_B, line: 12, column: 4, matchLength: 6 },
          },
          clear
        )
      );
    });
    expect(editor.selections).toEqual([
      { startLineNumber: 12, startColumn: 5, endLineNumber: 12, endColumn: 11 },
    ]);
    expect(editor.positions).toHaveLength(0);
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
