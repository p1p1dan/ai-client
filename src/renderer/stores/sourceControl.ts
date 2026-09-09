import { create } from 'zustand';

type ViewMode = 'list' | 'tree';

interface SourceControlState {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
}

export const useSourceControlStore = create<SourceControlState>((set) => ({
  viewMode: 'list',
  setViewMode: (viewMode) => set({ viewMode }),
  expandedFolders: new Set<string>(),
  toggleFolder: (path) =>
    set((state) => {
      const newExpanded = new Set(state.expandedFolders);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
      } else {
        newExpanded.add(path);
      }
      return { expandedFolders: newExpanded };
    }),
}));
