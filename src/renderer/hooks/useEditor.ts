import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { isUnsupportedBinaryFile } from '@/components/files/fileIcons';
import { useEditorStore } from '@/stores/editor';

/**
 * Pure guard for `navigateToFile`'s `options.stillValid` (adversarial review
 * batch B, Codex major) — exported for direct unit testing without mounting
 * the hook. Only an explicit `false` return aborts; `undefined` (no guard
 * passed) or any other value always proceeds, matching "旧调用点零影响".
 */
export function isNavigationRequestAborted(stillValid?: () => boolean): boolean {
  return stillValid?.() === false;
}

export function useEditor() {
  const {
    tabs,
    activeTabPath,
    pendingCursor,
    openFile,
    closeFile,
    closeOtherFiles,
    closeFilesToLeft,
    closeFilesToRight,
    closeAllFiles,
    setActiveFile,
    updateFileContent,
    markFileSaved,
    setTabViewState,
    reorderTabs,
    setPendingCursor,
  } = useEditorStore();

  const queryClient = useQueryClient();

  // Background refresh: re-read file from disk and silently update store (only if tab is not dirty)
  const refreshFileContent = useCallback(
    async (path: string) => {
      const currentTabs = useEditorStore.getState().tabs;
      const tab = currentTabs.find((t) => t.path === path);
      if (!tab || tab.isDirty) return;

      try {
        const result = await window.electronAPI.file.read(path);
        const { content, encoding, isBinary, tooLarge, byteLength, maxPreviewBytes } = result;
        // Re-check after async IO to avoid race conditions
        const latestTab = useEditorStore.getState().tabs.find((t) => t.path === path);
        if (!latestTab || latestTab.isDirty) return;
        if (isBinary || tooLarge) {
          openFile({
            path,
            content: '',
            encoding,
            isDirty: false,
            isUnsupported: isUnsupportedBinaryFile(path, isBinary),
            isTooLarge: tooLarge,
            byteLength,
            maxPreviewBytes,
          });
          return;
        }
        if (latestTab.content !== content) {
          updateFileContent(path, content, false);
        }
      } catch {
        // File may have been deleted or become inaccessible
      }
    },
    [openFile, updateFileContent]
  );

  const loadFile = useMutation({
    mutationFn: async (path: string) => {
      const result = await window.electronAPI.file.read(path);
      const { content, encoding, isBinary, tooLarge, byteLength, maxPreviewBytes } = result;
      openFile({
        path,
        content,
        encoding,
        isDirty: false,
        isUnsupported: isUnsupportedBinaryFile(path, isBinary),
        isTooLarge: tooLarge,
        byteLength,
        maxPreviewBytes,
      });
      return result;
    },
  });

  const saveFile = useMutation({
    mutationFn: async (path: string) => {
      // Get latest tabs from store to avoid stale closure issue
      const currentTabs = useEditorStore.getState().tabs;
      const file = currentTabs.find((f) => f.path === path);
      if (!file) throw new Error('File not found');
      await window.electronAPI.file.write(path, file.content, file.encoding);
      markFileSaved(path);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['file', 'list'] });
    },
  });

  // Load file and navigate to specific line/column
  const navigateToFile = useCallback(
    async (
      path: string,
      line?: number,
      column?: number,
      matchLength?: number,
      previewMode?: 'off' | 'split' | 'fullscreen',
      // Adversarial review batch B (Codex major): purely optional, so every
      // existing call site — none of which pass it — is unaffected. Lets a
      // caller that awaits this function (e.g. an effect resolving a
      // fileOpenIntent) abort the read's side effects if it has been
      // superseded while the read was in flight, WITHOUT waiting for this
      // promise to settle first — checking only after `navigateToFile`
      // returns is too late, because by then `openFile` has already run.
      options?: { stillValid?: () => boolean }
    ) => {
      const existingTab = tabs.find((t) => t.path === path);

      if (existingTab) {
        setActiveFile(path);
        // Background refresh to pick up external modifications
        refreshFileContent(path);
      } else {
        try {
          const { content, encoding, isBinary, tooLarge, byteLength, maxPreviewBytes } =
            await window.electronAPI.file.read(path);
          // Re-check right after the async read, before any side effect
          // lands — a caller-provided guard can veto a stale request here.
          if (isNavigationRequestAborted(options?.stillValid)) {
            return;
          }
          openFile({
            path,
            content,
            encoding,
            isDirty: false,
            isUnsupported: isUnsupportedBinaryFile(path, isBinary),
            isTooLarge: tooLarge,
            byteLength,
            maxPreviewBytes,
          });
        } catch {
          return;
        }
      }

      // Set pending cursor position if line is specified
      if (line !== undefined) {
        setPendingCursor({ path, line, column, matchLength, previewMode });
      }
    },
    [tabs, setActiveFile, openFile, setPendingCursor, refreshFileContent]
  );

  const activeTab = tabs.find((f) => f.path === activeTabPath) || null;

  return {
    tabs,
    activeTab,
    pendingCursor,
    loadFile,
    saveFile,
    closeFile,
    closeOtherFiles,
    closeFilesToLeft,
    closeFilesToRight,
    closeAllFiles,
    setActiveFile,
    updateFileContent,
    setTabViewState,
    reorderTabs,
    setPendingCursor,
    navigateToFile,
    refreshFileContent,
  };
}
