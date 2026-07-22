import { useEffect } from 'react';
import { useEditor } from '@/hooks/useEditor';
import { useNavigationStore } from '@/stores/navigation';

export function useTerminalNavigation(activeWorktreePath: string | null) {
  const pendingNavigation = useNavigationStore((s) => s.pendingNavigation);
  const clearNavigation = useNavigationStore((s) => s.clearNavigation);
  const setActiveTab = useNavigationStore((s) => s.setActiveTab);
  const setWorktreeTab = useNavigationStore((s) => s.setWorktreeTab);
  const { navigateToFile } = useEditor();

  useEffect(() => {
    if (!pendingNavigation) return;

    const { path, line, column, previewMode } = pendingNavigation;

    // Open the file and set cursor position
    navigateToFile(path, line, column, undefined, previewMode);

    // Switch to file tab and update worktree tab map
    setActiveTab('file');
    if (activeWorktreePath) {
      setWorktreeTab(activeWorktreePath, 'file');
    }

    // Clear the navigation request
    clearNavigation();
  }, [
    pendingNavigation,
    navigateToFile,
    clearNavigation,
    activeWorktreePath,
    setActiveTab,
    setWorktreeTab,
  ]);
}
