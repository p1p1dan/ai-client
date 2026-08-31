import { create } from 'zustand';
import { type DiffTabTarget, diffTabPath, diffTabTitle } from './diffTabTarget';

export type { DiffTabTarget } from './diffTabTarget';

export interface EditorTab {
  path: string;
  title: string;
  content: string;
  isDirty: boolean;
  encoding?: string;
  viewState?: unknown;
  isUnsupported?: boolean;
  isTooLarge?: boolean;
  byteLength?: number;
  maxPreviewBytes?: number;
  // External change conflict: set when file is modified externally while user has unsaved edits
  hasExternalChange?: boolean;
  externalContent?: string;
  /**
   * D34-E: set only for a "diff tab" — a center-column page showing a git
   * diff instead of file content (`EditorArea` branches on this before its
   * isUnsupported/image/pdf checks, the same precedent those already are).
   * Every other tab operation (open/close/reorder/worktree isolation/active
   * pointer) treats a diff tab as an ordinary tab keyed by its `git-diff://`
   * pseudo `path` — see `diffTabTarget.ts` for why that scheme is safe to
   * mix into the same array as real fs paths.
   */
  diffTarget?: DiffTabTarget;
}

export interface PendingCursor {
  path: string;
  line: number;
  column?: number;
  matchLength?: number;
  previewMode?: 'off' | 'split' | 'fullscreen';
}

// Navigation history entry: file path + cursor position (Monaco 1-indexed)
export interface NavEntry {
  path: string;
  line: number;
  column: number;
}

interface WorktreeEditorState {
  tabs: EditorTab[];
  activeTabPath: string | null;
}

interface EditorState {
  // Current active state
  tabs: EditorTab[];
  activeTabPath: string | null;
  pendingCursor: PendingCursor | null;
  currentCursorLine: number | null; // Current cursor line in active editor

  // Navigation history (back/forward)
  navBackStack: NavEntry[];
  navForwardStack: NavEntry[];

  // Per-worktree state storage
  worktreeStates: Record<string, WorktreeEditorState>;
  currentWorktreePath: string | null;

  openFile: (file: Omit<EditorTab, 'title' | 'viewState'> & { title?: string }) => void;
  /**
   * D34-E introduced this as "open (or, if the SAME target is already open,
   * reuse-and-refresh)". D35 (user feedback, 2026-08-14, 「一次只看一份，点另一个
   * 直接切换，不要多 tab」) tightens it to a global singleton: AT MOST ONE diff
   * tab ever exists, keyed off "is a diff tab" rather than "is the same
   * target" — opening any target REPLACES whichever diff tab is already open
   * (in its same array slot) instead of comparing paths, so two different
   * targets opened back to back never coexist. A plain file tab is a
   * different `path` namespace (no `diffTarget`) and is NOT touched by this
   * rule — the D34-E "diff tab coexists with a real file tab for the same
   * path" guarantee is unchanged. Content freshness for a workdir target
   * still comes from `DiffViewer`'s own live `useFileDiff` poll, not from
   * this action.
   */
  openDiffTab: (target: DiffTabTarget) => void;
  closeFile: (path: string) => void;
  closeOtherFiles: (keepPath: string) => void;
  closeFilesToLeft: (path: string) => void;
  closeFilesToRight: (path: string) => void;
  closeAllFiles: () => void;
  setActiveFile: (path: string | null) => void;
  updateFileContent: (path: string, content: string, isDirty?: boolean) => void;
  markFileSaved: (path: string) => void;
  markExternalChange: (path: string, externalContent: string) => void;
  applyExternalChange: (path: string) => void;
  dismissExternalChange: (path: string) => void;
  setTabViewState: (path: string, viewState: unknown) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  setPendingCursor: (cursor: PendingCursor | null) => void;
  setCurrentCursorLine: (line: number | null) => void;
  // Push current position into back stack and clear forward stack
  pushNavHistory: (current: NavEntry) => void;
  // Go back: push current to forward stack, return previous entry (or null if empty)
  navBack: (current: NavEntry) => NavEntry | null;
  // Go forward: push current to back stack, return next entry (or null if empty)
  navForward: (current: NavEntry) => NavEntry | null;
  switchWorktree: (worktreePath: string | null) => void;
  clearAllWorktreeStates: () => void;
  clearWorktreeState: (worktreePath: string) => void;
}

const getTabTitle = (path: string) => path.split(/[/\\]/).pop() || path;

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabPath: null,
  pendingCursor: null,
  currentCursorLine: null,
  navBackStack: [],
  navForwardStack: [],
  worktreeStates: {},
  currentWorktreePath: null,

  openFile: (file) =>
    set((state) => {
      const exists = state.tabs.some((tab) => tab.path === file.path);
      if (exists) {
        return {
          tabs: state.tabs.map((tab) =>
            tab.path === file.path
              ? {
                  ...tab,
                  ...file,
                  title: file.title ?? tab.title,
                  // Clear external change state on explicit file open (fresh load)
                  hasExternalChange: false,
                  externalContent: undefined,
                }
              : tab
          ),
          activeTabPath: file.path,
        };
      }
      return {
        tabs: [
          ...state.tabs,
          {
            ...file,
            title: file.title ?? getTabTitle(file.path),
          },
        ],
        activeTabPath: file.path,
      };
    }),

  openDiffTab: (target) =>
    set((state) => {
      const path = diffTabPath(target);
      const title = diffTabTitle(target);
      const existingDiffIndex = state.tabs.findIndex((tab) => tab.diffTarget != null);
      if (existingDiffIndex === -1) {
        return {
          tabs: [...state.tabs, { path, title, content: '', isDirty: false, diffTarget: target }],
          activeTabPath: path,
        };
      }
      // D35: replace the ONE existing diff tab in its own array slot (keeps
      // its position among any file tabs stable) rather than appending —
      // `path` is derived from `target`, so replacing the target also
      // replaces the tab's own key; `activeTabPath` is repointed to the new
      // path in this same update so it is never left dangling at the old one.
      const tabs = state.tabs.map((tab, index) =>
        index === existingDiffIndex ? { ...tab, path, title, diffTarget: target } : tab
      );
      return { tabs, activeTabPath: path };
    }),

  closeFile: (path) =>
    set((state) => {
      const newTabs = state.tabs.filter((tab) => tab.path !== path);
      const newActive =
        state.activeTabPath === path
          ? newTabs.length > 0
            ? newTabs[newTabs.length - 1].path
            : null
          : state.activeTabPath;
      return { tabs: newTabs, activeTabPath: newActive };
    }),

  closeOtherFiles: (keepPath) =>
    set((state) => {
      const keepTab = state.tabs.find((tab) => tab.path === keepPath);
      if (!keepTab) return { tabs: state.tabs, activeTabPath: state.activeTabPath };
      return { tabs: [keepTab], activeTabPath: keepPath };
    }),

  closeFilesToLeft: (path) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.path === path);
      if (index <= 0) return { tabs: state.tabs, activeTabPath: state.activeTabPath };
      const newTabs = state.tabs.slice(index);
      const activeStillOpen = state.activeTabPath
        ? newTabs.some((t) => t.path === state.activeTabPath)
        : false;
      const newActive = activeStillOpen ? state.activeTabPath : (newTabs[0]?.path ?? null);
      return { tabs: newTabs, activeTabPath: newActive };
    }),

  closeFilesToRight: (path) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.path === path);
      if (index < 0 || index >= state.tabs.length - 1) {
        return { tabs: state.tabs, activeTabPath: state.activeTabPath };
      }
      const newTabs = state.tabs.slice(0, index + 1);
      const activeStillOpen = state.activeTabPath
        ? newTabs.some((t) => t.path === state.activeTabPath)
        : false;
      const newActive = activeStillOpen
        ? state.activeTabPath
        : (newTabs[newTabs.length - 1]?.path ?? null);
      return { tabs: newTabs, activeTabPath: newActive };
    }),

  closeAllFiles: () =>
    set({ tabs: [], activeTabPath: null, pendingCursor: null, currentCursorLine: null }),

  setActiveFile: (path) => set({ activeTabPath: path }),

  updateFileContent: (path, content, isDirty = true) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, content, isDirty } : tab)),
    })),

  markFileSaved: (path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === path
          ? { ...tab, isDirty: false, hasExternalChange: false, externalContent: undefined }
          : tab
      ),
    })),

  markExternalChange: (path, externalContent) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === path ? { ...tab, hasExternalChange: true, externalContent } : tab
      ),
    })),

  applyExternalChange: (path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === path
          ? {
              ...tab,
              content: tab.externalContent ?? tab.content,
              isDirty: false,
              hasExternalChange: false,
              externalContent: undefined,
            }
          : tab
      ),
    })),

  dismissExternalChange: (path) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.path === path ? { ...tab, hasExternalChange: false, externalContent: undefined } : tab
      ),
    })),

  setTabViewState: (path, viewState) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, viewState } : tab)),
    })),

  reorderTabs: (fromIndex, toIndex) =>
    set((state) => {
      if (fromIndex === toIndex) return { tabs: state.tabs };
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      if (!moved) return { tabs: state.tabs };
      tabs.splice(toIndex, 0, moved);
      return { tabs };
    }),

  setPendingCursor: (cursor) => set({ pendingCursor: cursor }),

  setCurrentCursorLine: (line) => set({ currentCursorLine: line }),

  pushNavHistory: (current) =>
    set((state) => {
      const top = state.navBackStack[state.navBackStack.length - 1];
      // Skip if same file and same line as the top entry (avoid duplicate noise)
      if (
        top &&
        top.path === current.path &&
        top.line === current.line &&
        top.column === current.column
      )
        return {};
      const newStack = [...state.navBackStack, current];
      // Cap back stack at 100 entries
      if (newStack.length > 100) newStack.shift();
      return { navBackStack: newStack, navForwardStack: [] };
    }),

  navBack: (current) => {
    const { navBackStack, navForwardStack } = get();
    if (navBackStack.length === 0) return null;
    const newBackStack = [...navBackStack];
    // Skip entries at the same position as current to avoid no-op navigation
    // (can occur when navForward pushes the target as a checkpoint)
    while (newBackStack.length > 0) {
      const top = newBackStack[newBackStack.length - 1];
      if (top.path !== current.path || top.line !== current.line || top.column !== current.column)
        break;
      newBackStack.pop();
    }
    if (newBackStack.length === 0) return null;
    const target = newBackStack.pop()!;
    const newForwardStack = [...navForwardStack, current];
    if (newForwardStack.length > 100) newForwardStack.shift();
    set({ navBackStack: newBackStack, navForwardStack: newForwardStack });
    return target;
  },

  navForward: (current) => {
    const { navBackStack, navForwardStack } = get();
    if (navForwardStack.length === 0) return null;
    const newForwardStack = [...navForwardStack];
    const target = newForwardStack.pop()!;
    const newBackStack = [...navBackStack];
    // Push current position (skip if duplicate of top)
    const top = newBackStack[newBackStack.length - 1];
    if (
      !top ||
      top.path !== current.path ||
      top.line !== current.line ||
      top.column !== current.column
    ) {
      newBackStack.push(current);
    }
    // Push target as a checkpoint: allows Alt+Left to return here after the user
    // clicks away. Skip if target is the same position as current (would be no-op).
    if (
      target.path !== current.path ||
      target.line !== current.line ||
      target.column !== current.column
    ) {
      newBackStack.push(target);
    }
    while (newBackStack.length > 100) newBackStack.shift();
    set({ navBackStack: newBackStack, navForwardStack: newForwardStack });
    return target;
  },

  switchWorktree: (worktreePath) => {
    const state = get();
    const currentPath = state.currentWorktreePath;

    // Save current worktree state (if we have one)
    let newWorktreeStates = state.worktreeStates;
    if (currentPath) {
      newWorktreeStates = {
        ...newWorktreeStates,
        [currentPath]: {
          tabs: state.tabs,
          activeTabPath: state.activeTabPath,
        },
      };
    }

    // Load new worktree state (or empty if none)
    const savedState = worktreePath ? newWorktreeStates[worktreePath] : null;

    set({
      worktreeStates: newWorktreeStates,
      currentWorktreePath: worktreePath,
      tabs: savedState?.tabs ?? [],
      activeTabPath: savedState?.activeTabPath ?? null,
      pendingCursor: null,
      currentCursorLine: null,
      navBackStack: [],
      navForwardStack: [],
    });
  },

  clearAllWorktreeStates: () => {
    set({
      worktreeStates: {},
      currentWorktreePath: null,
      tabs: [],
      activeTabPath: null,
      pendingCursor: null,
      currentCursorLine: null,
      navBackStack: [],
      navForwardStack: [],
    });
  },

  clearWorktreeState: (worktreePath) => {
    set((state) => {
      const { [worktreePath]: _, ...rest } = state.worktreeStates;
      return { worktreeStates: rest };
    });
  },
}));
