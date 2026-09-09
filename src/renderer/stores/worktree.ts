import type { GitWorktree } from '@shared/types';
import { create } from 'zustand';

interface WorktreeState {
  worktrees: GitWorktree[];
  isLoading: boolean;
  error: string | null;

  setWorktrees: (worktrees: GitWorktree[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useWorktreeStore = create<WorktreeState>((set) => ({
  worktrees: [],
  isLoading: false,
  error: null,

  setWorktrees: (worktrees) => set({ worktrees }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
