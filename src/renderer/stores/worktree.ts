import type { GitWorktree } from '@shared/types';
import { create } from 'zustand';

interface WorktreeState {
  worktrees: GitWorktree[];
  /**
   * Structurally always `null`: the only writer, `setCurrentWorktree`, had no
   * callers anywhere in the app and was removed. Kept as a field because
   * `GitView.tsx` still reads it (and correctly renders its "no worktree"
   * branch); a real writer belongs with whatever revives that view.
   */
  currentWorktree: GitWorktree | null;
  isLoading: boolean;
  error: string | null;

  setWorktrees: (worktrees: GitWorktree[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useWorktreeStore = create<WorktreeState>((set) => ({
  worktrees: [],
  currentWorktree: null,
  isLoading: false,
  error: null,

  setWorktrees: (worktrees) => set({ worktrees }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
