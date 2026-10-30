import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toasts: Array<{ type?: string; title: string; description?: string }> = [];
vi.mock('@/components/ui/toast', () => ({
  toastManager: {
    add: (toast: { type?: string; title: string; description?: string }) => toasts.push(toast),
  },
}));

const read = vi.fn(async (_path: string) => ({ content: 'B\n', isBinary: false }));
vi.stubGlobal('window', { electronAPI: { file: { read } } });

const { useEditorStore } = await import('@/stores/editor');
const {
  describeFileSaveFailure,
  flagConflictingDiskContent,
  isFileContentConflict,
  reportEditorSaveFailure,
} = await import('../fileSaveFailure');

const t = (key: string) => key;
const CONFLICT = new Error(
  "Error invoking remote method 'file:write': Error: FILE_CONTENT_CONFLICT: File changed on disk"
);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  toasts.length = 0;
  read.mockClear();
  useEditorStore.setState({ tabs: [], activeTabPath: null, worktreeStates: {} });
  useEditorStore.getState().openFile({ path: '/w/a.txt', content: 'A\n', isDirty: false });
  useEditorStore.getState().updateFileContent('/w/a.txt', 'edit-A\n', true);
});

afterEach(() => {
  useEditorStore.setState({ tabs: [], activeTabPath: null });
});

describe('save failure wording', () => {
  it('recognises the conflict through the IPC wrapper', () => {
    expect(isFileContentConflict(CONFLICT)).toBe(true);
    expect(isFileContentConflict(new Error('FILE_CONTENT_CONFLICT: File changed on disk'))).toBe(
      true
    );
    expect(isFileContentConflict(new Error('EACCES: permission denied'))).toBe(false);
  });

  it('explains a conflict instead of echoing the error code', () => {
    expect(describeFileSaveFailure(CONFLICT, t)).toBe(
      'The file was changed outside the editor after you opened it, so nothing was written.'
    );
    const withHint = describeFileSaveFailure(CONFLICT, t, { withBannerHint: true });
    expect(withHint).toContain('Keep Mine');
    expect(withHint).not.toContain('FILE_CONTENT_CONFLICT');
  });

  it("passes any other failure through without Electron's wrapper", () => {
    const error = new Error("Error invoking remote method 'file:write': Error: EACCES: denied");
    expect(describeFileSaveFailure(error, t)).toBe('EACCES: denied');
  });
});

describe('reportEditorSaveFailure', () => {
  it('toasts and raises the external-change banner with the disk text on a conflict', async () => {
    reportEditorSaveFailure('/w/a.txt', CONFLICT, t);
    await flush();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: 'error', title: 'Save failed' });
    expect(read).toHaveBeenCalledWith('/w/a.txt');
    expect(useEditorStore.getState().tabs[0]).toMatchObject({
      content: 'edit-A\n',
      baseContent: 'A\n',
      isDirty: true,
      hasExternalChange: true,
      externalContent: 'B\n',
    });
  });

  it('adds no second toast while the banner already asks about the file (auto-save)', async () => {
    reportEditorSaveFailure('/w/a.txt', CONFLICT, t);
    await flush();
    reportEditorSaveFailure('/w/a.txt', CONFLICT, t);
    reportEditorSaveFailure('/w/a.txt', CONFLICT, t);
    await flush();
    expect(toasts).toHaveLength(1);
  });

  it('after Keep Mine the next conflict (a newer outside write) is reported again', async () => {
    reportEditorSaveFailure('/w/a.txt', CONFLICT, t);
    await flush();
    useEditorStore.getState().keepLocalOverExternalChange('/w/a.txt');
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ baseContent: 'B\n', isDirty: true });

    reportEditorSaveFailure('/w/a.txt', CONFLICT, t);
    await flush();
    expect(toasts).toHaveLength(2);
  });

  it('toasts a non-conflict failure without touching the banner', async () => {
    reportEditorSaveFailure('/w/a.txt', new Error('EACCES: denied'), t);
    await flush();
    expect(toasts).toEqual([
      { type: 'error', title: 'Save failed', description: 'EACCES: denied' },
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0].hasExternalChange).toBeFalsy();
  });

  it('does not open a tab for a file that is no longer open', async () => {
    await flagConflictingDiskContent('/w/closed.txt');
    expect(useEditorStore.getState().tabs.map((tab) => tab.path)).toEqual(['/w/a.txt']);
  });
});

describe('every editor save entry point reports its failure', () => {
  const src = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../', file), 'utf8');

  it('Ctrl+S / auto-save and the close-tab prompt (EditorColumn)', () => {
    const text = src('components/workspace-shell/center/EditorColumn.tsx');
    expect(text).toMatch(
      /saveFile\.mutate\(path,\s*\{\s*onError:\s*\(error\)\s*=>\s*reportEditorSaveFailure\(path,\s*error,\s*t\)/
    );
    expect(text).toMatch(
      /catch \(err\) \{\s*reportEditorSaveFailure\(path, err, t\);\s*return 'failed';/
    );
  });

  it('closing a tab with a pending auto-save keeps the tab on failure (EditorArea)', () => {
    const text = src('components/files/EditorArea.tsx');
    expect(text).toMatch(
      /catch \(error\) \{[\s\S]{0,160}reportEditorSaveFailure\(path, error, t\);\s*return;/
    );
  });

  it('switching worktree, app close and Diff word the failure through the helper', () => {
    expect(src('App/hooks/useWorktreeSelection.ts')).toContain(
      'reportEditorSaveFailure(tab.path, err, t)'
    );
    expect(src('App/hooks/useAppLifecycle.ts')).toContain(
      'error: describeFileSaveFailure(err, t, { withBannerHint: true })'
    );
    expect(src('components/source-control/DiffViewer.tsx')).toContain(
      'description: describeFileSaveFailure(error, t)'
    );
  });
});
