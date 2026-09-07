import { useCallback, useEffect, useState } from 'react';
import type { SearchMode } from '@/components/search/useGlobalSearch';
import { useEditor } from '@/hooks/useEditor';
import { useSettingsStore } from '@/stores/settings';
import { readWorkspaceRootPath, useWorkspaceRootPath } from './useWorkspaceRootPath';
import { resolveWorkspaceSearchShortcut } from './workspaceSearchShortcuts';

export function useWorkspaceSearch() {
  const rootPath = useWorkspaceRootPath();
  const bindings = useSettingsStore((state) => state.searchKeybindings);
  const { navigateToFile } = useEditor();
  const [request, setRequest] = useState<{ rootPath: string; mode: SearchMode } | null>(null);

  useEffect(() => {
    setRequest((current) => (current?.rootPath === rootPath ? current : null));
  }, [rootPath]);

  const openSearch = useCallback((mode: SearchMode) => {
    const currentRoot = readWorkspaceRootPath();
    if (currentRoot) setRequest({ rootPath: currentRoot, mode });
  }, []);

  const closeSearch = useCallback(() => setRequest(null), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!readWorkspaceRootPath()) return;
      const mode = resolveWorkspaceSearchShortcut(event, bindings);
      if (!mode || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      openSearch(mode);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [bindings, openSearch]);

  const onOpenFile = useCallback(
    (path: string, line?: number, column?: number, matchLength?: number) => {
      const searchRoot = request?.rootPath;
      if (!searchRoot || readWorkspaceRootPath() !== searchRoot) return;
      void navigateToFile(path, line, column, matchLength, undefined, {
        stillValid: () => readWorkspaceRootPath() === searchRoot,
      });
    },
    [request, navigateToFile]
  );

  return {
    request: request?.rootPath === rootPath ? request : null,
    openSearch,
    closeSearch,
    onOpenFile,
  };
}
