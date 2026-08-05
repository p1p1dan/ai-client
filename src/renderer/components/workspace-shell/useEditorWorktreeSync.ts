/**
 * T-32 m7: keeps the editor store pointed at the active workspace.
 *
 * This effect used to live inside `EditorColumn`. That was fine while the
 * column was mounted unconditionally, and became a deadlock the moment m6
 * gated it on `editorOpen` — because `switchWorktree` CLEARS the tab list
 * (`stores/editor.ts`: `tabs: savedState?.tabs ?? []`):
 *
 *   1. no tabs  → EditorColumn unmounted → `currentWorktreePath` stays null
 *   2. click a file → a tab is added → `editorOpen` flips true
 *   3. EditorColumn mounts for the FIRST time → its effect fires
 *      `switchWorktree(rootPath)` → no saved state for that path → tabs = []
 *   4. tabs empty → `editorOpen` false → EditorColumn unmounts again
 *
 * The file never appeared. So this belongs somewhere always mounted: the shell
 * itself, which lives for as long as the new shell is on screen. Per-workspace
 * tab isolation is a property of the SHELL's workspace, not of whether an
 * editor happens to be open.
 */
import { normalizePath } from '@shared/utils/path';
import { useEffect } from 'react';
import { useEditorStore } from '@/stores/editor';
import { useWorkspaceRootPath } from './useWorkspaceRootPath';

export function useEditorWorktreeSync(): void {
  const rootPath = useWorkspaceRootPath();

  useEffect(() => {
    const normalized = rootPath ? normalizePath(rootPath) : null;
    // Idempotence matters as much as placement: without this guard the effect
    // would re-clear the tabs on every re-render that changes `rootPath`'s
    // identity but not its value.
    if (useEditorStore.getState().currentWorktreePath === normalized) {
      return;
    }
    useEditorStore.getState().switchWorktree(normalized);
  }, [rootPath]);
}
