import { create } from 'zustand';

interface WorkspaceModeState {
  /**
   * Whether the currently selected folder is a git repository.
   * - `true`: git mode
   * - `false`: normal folder mode (non-git)
   * - `null`: unknown / checking
   */
  isGitRepo: boolean | null;
  setIsGitRepo: (isGitRepo: boolean | null) => void;
}

export const useWorkspaceModeStore = create<WorkspaceModeState>((set) => ({
  isGitRepo: null,
  setIsGitRepo: (isGitRepo) => set({ isGitRepo }),
}));

