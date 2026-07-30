import { useCallback, useEffect, useRef, useState } from 'react';
import { getStoredBoolean, STORAGE_KEYS } from '../storage';

export function usePanelState() {
  // Panel collapsed states - initialize from localStorage
  const [repositoryCollapsed, setRepositoryCollapsed] = useState(() =>
    getStoredBoolean(STORAGE_KEYS.REPOSITORY_COLLAPSED, false)
  );
  const [worktreeCollapsed, setWorktreeCollapsed] = useState(() =>
    getStoredBoolean(STORAGE_KEYS.WORKTREE_COLLAPSED, false)
  );

  // Dialog states
  const [addRepoDialogOpen, setAddRepoDialogOpen] = useState(false);
  const [initialLocalPath, setInitialLocalPath] = useState<string | null>(null);
  // T-27: which AddRepositoryDialog tab to open on (Composer target bar footer actions).
  const [addRepoInitialMode, setAddRepoInitialMode] = useState<
    'local' | 'remote' | 'ssh' | undefined
  >(undefined);
  const [actionPanelOpen, setActionPanelOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);

  // Refs
  const toggleSelectedRepoExpandedRef = useRef<(() => void) | null>(null);
  const switchWorktreePathRef = useRef<((path: string) => void) | null>(null);

  // Save collapsed states to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.REPOSITORY_COLLAPSED, String(repositoryCollapsed));
  }, [repositoryCollapsed]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.WORKTREE_COLLAPSED, String(worktreeCollapsed));
  }, [worktreeCollapsed]);

  const handleAddRepository = useCallback((mode?: 'local' | 'remote' | 'ssh') => {
    setAddRepoInitialMode(mode);
    setAddRepoDialogOpen(true);
  }, []);

  return {
    repositoryCollapsed,
    worktreeCollapsed,
    addRepoDialogOpen,
    initialLocalPath,
    addRepoInitialMode,
    actionPanelOpen,
    closeDialogOpen,
    toggleSelectedRepoExpandedRef,
    switchWorktreePathRef,
    setRepositoryCollapsed,
    setWorktreeCollapsed,
    setAddRepoDialogOpen,
    setInitialLocalPath,
    setAddRepoInitialMode,
    setActionPanelOpen,
    setCloseDialogOpen,
    handleAddRepository,
  };
}
