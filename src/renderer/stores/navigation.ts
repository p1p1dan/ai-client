import { create } from 'zustand';
import type { TabId } from '@/App/constants';
import { getStoredTabMap, STORAGE_KEYS } from '@/App/storage';

export interface FileNavigationRequest {
  path: string;
  line?: number;
  column?: number;
  previewMode?: 'off' | 'split' | 'fullscreen';
}

interface NavigationState {
  activeTab: TabId;
  previousTab: TabId | null;
  worktreeTabMap: Record<string, TabId>;

  setActiveTab: (tab: TabId) => void;
  setPreviousTab: (tab: TabId | null) => void;
  setWorktreeTab: (worktreePath: string, tab: TabId) => void;

  // Pending navigation request
  pendingNavigation: FileNavigationRequest | null;

  // Request navigation to a file (optionally with line/column)
  navigateToFile: (request: FileNavigationRequest) => void;

  // Clear pending navigation (called after handling)
  clearNavigation: () => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  activeTab: 'chat',
  previousTab: null,
  worktreeTabMap: getStoredTabMap(),

  setActiveTab: (activeTab) => set({ activeTab }),
  setPreviousTab: (previousTab) => set({ previousTab }),
  setWorktreeTab: (worktreePath, tab) =>
    set((state) => {
      const worktreeTabMap = { ...state.worktreeTabMap, [worktreePath]: tab };
      localStorage.setItem(STORAGE_KEYS.WORKTREE_TABS, JSON.stringify(worktreeTabMap));
      return { worktreeTabMap };
    }),

  pendingNavigation: null,

  navigateToFile: (request) => set({ pendingNavigation: request }),

  clearNavigation: () => set({ pendingNavigation: null }),
}));
