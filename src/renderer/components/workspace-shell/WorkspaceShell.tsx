import type { TempWorkspaceItem } from '@shared/types';
import {
  type CSSProperties,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/shallow';
import type { Repository } from '@/App/constants';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';
import { GlobalSearchDialog } from '@/components/search/GlobalSearchDialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { columnTerminalKey, useColumnTerminalStore } from '@/stores/columnTerminal';
import { isDiffTabActive } from '@/stores/diffTabTarget';
import { useEditorStore } from '@/stores/editor';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSettingsStore } from '@/stores/settings';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { useWorktreeActivityStore } from '@/stores/worktreeActivity';
import {
  deriveEditorOpen,
  resolveShellAllocation,
  resolveShellChrome,
  type ShellAllocation,
} from './centerLayoutModel';
import { HomeView } from './HomeView';
import { LeftDock } from './LeftDock';
import { SessionBar, type SessionReviewTotals } from './SessionBar';
import { deriveSessionReview, type SessionReviewEntry } from './sessionReview';
import { resolveTerminalWorkspace } from './surfaces/terminalWorkspace';
import { useCapacityReclaimNotice } from './useCapacityReclaimNotice';
import { useEditorWorktreeSync } from './useEditorWorktreeSync';
import { useShellShortcuts } from './useShellShortcuts';
import { useSyncChatWorkspaceTree } from './useSyncChatWorkspaceTree';
import { useWorkspaceSearch } from './useWorkspaceSearch';
import { WorkPanel } from './WorkPanel';
import {
  deriveTerminalButtonState,
  deriveWorkPanelTabs,
  resolveWorkPanelView,
  type WorkPanelTab,
} from './workPanelModel';

const NO_REVIEW_ENTRIES: SessionReviewEntry[] = [];

interface WorkspaceShellProps {
  onOpenSettings?: () => void;
  repositories?: Repository[];
  selectedRepoPath?: string | null;
  /** T-24: opens the shared AddRepositoryDialog mounted in App. */
  onAddRepository?: () => void;
  onRemoveRepository?: (repoPath: string) => void;
  /**
   * T-24: drop zone for `useFileDragDrop`. Legacy binds this ref to its
   * repository sidebar; in the new shell the whole shell body is the target,
   * otherwise folder drops are swallowed with no feedback at all.
   */
  dropZoneRef?: Ref<HTMLDivElement>;
  fileDragOver?: boolean;
  /** Temp session items (App's `useTempWorkspaceStore`), threaded down to the sidebar's
   * chat list so it can map a Temp folder row to the item its delete button targets. */
  tempWorkspaces?: TempWorkspaceItem[];
  /** Opens the shared `TempWorkspaceDialogs` delete confirmation (App's
   * `useTempWorkspaceStore.openDelete`), same as the legacy shell's `onRequestTempDelete`. */
  onRequestTempDelete?: (id: string) => void;
}

/**
 * Layout 5a (ui-cohesion §6): sidebar │ title bar over chat │ work panel.
 *
 *   left   — `LeftDock`: the chat list; collapses to nothing (ruling L1)
 *   center — `SessionBar` (the title bar) over the conversation, and the
 *            work panel beside it when open (rulings L3, L4)
 *
 * The allocator is unchanged in shape: it budgets sidebar → chat → editor →
 * panel, and the work panel takes the "editor" term (one pixel width shared
 * by every tab, default 480). The last term stays retired (`panelVisible:
 * false`), as under D08.
 */
export function WorkspaceShell({
  onOpenSettings,
  repositories = [],
  selectedRepoPath = null,
  onAddRepository,
  onRemoveRepository,
  dropZoneRef,
  fileDragOver = false,
  tempWorkspaces = [],
  onRequestTempDelete,
}: WorkspaceShellProps) {
  const { t } = useI18n();

  const sidebarWidth = useShellLayoutStore((state) => state.sidebarWidth);
  const setSidebarWidth = useShellLayoutStore((state) => state.setSidebarWidth);
  const sidebarCollapsed = useShellLayoutStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useShellLayoutStore((state) => state.toggleSidebar);
  const expanded = useShellLayoutStore((state) => state.expanded);
  const toggleExpanded = useShellLayoutStore((state) => state.toggleExpanded);

  const workPanelOpen = useShellLayoutStore((state) => state.workPanelOpen);
  const workPanelTab = useShellLayoutStore((state) => state.workPanelTab);
  const workPanelHistory = useShellLayoutStore((state) => state.workPanelHistory);
  const workPanelWidth = useShellLayoutStore((state) => state.workPanelWidth);
  const setWorkPanelWidth = useShellLayoutStore((state) => state.setWorkPanelWidth);
  const setupTerminalOpened = useShellLayoutStore((state) => state.setupTerminalOpened);
  const openWorkPanel = useShellLayoutStore((state) => state.openWorkPanel);
  const toggleWorkPanel = useShellLayoutStore((state) => state.toggleWorkPanel);
  const closeWorkPanel = useShellLayoutStore((state) => state.closeWorkPanel);

  // D35: `manualChat` stays (it also gates the "close all tabs snaps chat
  // back to full width" reset below); nothing sets it any more, so
  // `chatVisible` reads `true` by default.
  const manualChat = useShellLayoutStore((state) => state.manualChat);
  const clearManualOverrides = useShellLayoutStore((state) => state.clearManualOverrides);

  // T-32: a file being open is what gives the panel its editor tab.
  const editorOpen = deriveEditorOpen(useEditorStore((state) => state.tabs).length);
  // D35 round 2 (2026-08-14): a diff tab, while ACTIVE and on screen, takes
  // the whole center row — see `resolveShellChrome`'s `diffTabActive` note.
  const diffTabActive = useEditorStore((state) => isDiffTabActive(state.tabs, state.activeTabPath));
  // Round-10 ⑥: primitive selector — mounts the intent consumer (the editor,
  // inside the panel) even before any tab exists.
  const fileIntentPending = useFileOpenIntentStore((state) => state.intent !== null);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const showSessionReview = useSettingsStore((state) => state.showSessionReview);
  // Shallow-compared so streaming text deltas do not re-render the shell.
  const reviewEntries = useChatSessionsStore(
    useShallow((state) =>
      showSessionReview && activeSessionId
        ? deriveSessionReview(state.messages[activeSessionId] ?? [])
        : NO_REVIEW_ENTRIES
    )
  );
  const reviewAvailable = showSessionReview && activeSessionId !== null;
  const reviewTotals = useMemo<SessionReviewTotals | undefined>(
    () =>
      reviewAvailable
        ? {
            count: reviewEntries.length,
            added: reviewEntries.reduce((sum, entry) => sum + entry.added, 0),
            removed: reviewEntries.reduce((sum, entry) => sum + entry.removed, 0),
          }
        : undefined,
    [reviewAvailable, reviewEntries]
  );

  /**
   * dsh-rebase P1-11 (decisions 109, 126, 128): the conversation's folder, and
   * its shell in the work panel. The folder is the chain the init terminal
   * uses (`resolveTerminalWorkspace`: session → workspace → non-empty path);
   * an unbound chat's scratch directory is not one, and nothing falls back to
   * the home directory (decision 126 rule 2).
   */
  const terminalCwd = useChatSessionsStore((state) => {
    const target = resolveTerminalWorkspace({
      activeSessionId: state.activeSessionId,
      sessions: state.sessions,
      workspaces: state.workspaces,
    });
    return target.status === 'ready' ? target.path : null;
  });
  const terminalKey = terminalCwd ? columnTerminalKey(terminalCwd) : null;
  const terminalAlive = useColumnTerminalStore((state) =>
    terminalKey ? state.terminals[terminalKey] !== undefined : false
  );
  const hasColumnTerminals = useColumnTerminalStore(
    (state) => Object.keys(state.terminals).length > 0
  );

  // Which tabs exist, and what the panel shows. Derived, never written back:
  // a tab that is gone only for a while (another folder has no shell) comes
  // back by itself, the way the stacked right column used to behave.
  const panelTabs = deriveWorkPanelTabs({
    reviewAvailable,
    editorOpen: editorOpen || fileIntentPending,
    terminalAlive,
    setupTerminalOpened,
  });
  const panelView = resolveWorkPanelView(
    { open: workPanelOpen, tab: workPanelTab, history: workPanelHistory },
    panelTabs
  );
  const shownTab = panelView.tab;
  const togglePanelTab = useCallback(
    (tab: WorkPanelTab) => toggleWorkPanel(tab, shownTab),
    [toggleWorkPanel, shownTab]
  );

  const activeEditorPath = useEditorStore((state) => state.activeTabPath);
  const editorWorktreePath = useEditorStore((state) => state.currentWorktreePath);
  // P1-7e (problem 21, decision 142): every request to show a file, the
  // active one included, which changes no tab.
  const revealSeq = useEditorStore((state) => state.revealSeq);
  const previousEditor = useRef({
    worktreePath: editorWorktreePath,
    path: activeEditorPath,
    revealSeq,
  });
  useEffect(() => {
    // Opening a file from anywhere switches the panel to the editor tab
    // (opening it if it was closed). A worktree switch restoring its own tabs
    // is not a request to show one, hence the same-worktree condition.
    if (
      fileIntentPending ||
      previousEditor.current.revealSeq !== revealSeq ||
      (previousEditor.current.worktreePath === editorWorktreePath &&
        previousEditor.current.path !== activeEditorPath &&
        activeEditorPath !== null)
    ) {
      openWorkPanel('editor');
    }
    previousEditor.current = {
      worktreePath: editorWorktreePath,
      path: activeEditorPath,
      revealSeq,
    };
  }, [fileIntentPending, activeEditorPath, editorWorktreePath, revealSeq, openWorkPanel]);

  // A workspace being deleted takes its column shells with it, through the
  // same hook the init terminal answers (`closeTerminalSessions`).
  const registerTerminalCloseHandler = useWorktreeActivityStore(
    (state) => state.registerTerminalCloseHandler
  );
  useEffect(
    () =>
      registerTerminalCloseHandler((worktreePath) =>
        useColumnTerminalStore.getState().closeUnder(worktreePath)
      ),
    [registerTerminalCloseHandler]
  );
  // The shells live in this component's subtree; when it goes, so do they
  // (the unmount detaches every pty), and the entries must not outlive them.
  useEffect(() => () => useColumnTerminalStore.getState().reset(), []);

  const temporaryWorkspaceEnabled = useSettingsStore((state) => state.temporaryWorkspaceEnabled);
  useSyncChatWorkspaceTree({
    repositories,
    selectedRepoPath,
    temporaryWorkspaceEnabled,
  });

  // A08: global shell shortcuts (Ctrl/Cmd+B/1-5). Only live while this
  // component is mounted, i.e. only for the new shell.
  useShellShortcuts({ shownPanelTab: shownTab });
  const workspaceSearch = useWorkspaceSearch();

  // m7: per-workspace editor tab isolation. Must live somewhere ALWAYS mounted
  // — see the hook for the deadlock that put it here.
  useEditorWorktreeSync();

  // D12: one sentence when the pool reclaims an idle conversation.
  useCapacityReclaimNotice();

  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [panelResizing, setPanelResizing] = useState(false);

  // The allocator budgets the WHOLE shell (the sidebar is one of the columns
  // it satisfies first).
  const shellRef = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el) {
      return;
    }
    setShellWidth(el.clientWidth || null);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setShellWidth(width > 0 ? width : null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const terminalVisible = shownTab === 'terminal';
  const terminalState = deriveTerminalButtonState({
    available: terminalCwd !== null,
    alive: terminalAlive,
    visible: terminalVisible,
  });
  const toggleTerminal = useCallback(() => {
    if (!terminalCwd) return;
    if (terminalVisible) {
      closeWorkPanel();
      return;
    }
    useColumnTerminalStore.getState().show(terminalCwd);
    openWorkPanel('terminal');
  }, [terminalCwd, terminalVisible, closeWorkPanel, openWorkPanel]);

  // Layout 5a: `panelOpen: false` keeps the allocator's last term retired.
  const chrome = resolveShellChrome({
    sidebarUserCollapsed: sidebarCollapsed,
    panelOpen: false,
    manualChat,
    diffTabActive: shownTab === 'editor' && diffTabActive,
  });
  const chatVisible = chrome.chatVisible;

  const allocationInput = {
    shellWidth,
    sidebarWidth,
    sidebarCollapsed: chrome.sidebarCollapsed,
    chatVisible,
    editorOpen: panelView.open,
    editorWidth: workPanelWidth,
    panelVisible: false,
    panelWidth: 0,
  };
  const allocation = resolveShellAllocation(allocationInput);
  /**
   * Where the closed panel waits: the width it would have if it opened. A
   * parked terminal keeps a real box (no FitAddon collapse to two columns),
   * at the width it will show at, so opening does not resize it.
   */
  const parkedPanelWidth =
    allocation.editorWidth > 0
      ? allocation.editorWidth
      : resolveShellAllocation({ ...allocationInput, editorOpen: true }).editorWidth;

  /**
   * Round-12 (drag performance). Every column's width is published as a CSS
   * custom property on the shell root, and the columns read them
   * (`width: var(--shell-chat-w)`). React sets them on commit; a drag sets the
   * SAME properties directly on the root node, from the SAME pure model, so
   * the two paths cannot disagree and a drag costs zero React renders.
   */
  const shellVars = useMemo(
    () =>
      ({
        '--shell-sidebar-w': `${allocation.sidebarWidth}px`,
        '--shell-center-w': `${allocation.centerWidth}px`,
        '--shell-chat-w': `${allocation.chatWidth}px`,
        '--shell-editor-w': `${allocation.editorWidth}px`,
      }) as CSSProperties,
    [allocation]
  );

  const paintAllocation = useCallback((next: ShellAllocation) => {
    const root = shellRef.current;
    if (!root) {
      return;
    }
    root.style.setProperty('--shell-sidebar-w', `${next.sidebarWidth}px`);
    root.style.setProperty('--shell-center-w', `${next.centerWidth}px`);
    root.style.setProperty('--shell-chat-w', `${next.chatWidth}px`);
    root.style.setProperty('--shell-editor-w', `${next.editorWidth}px`);
  }, []);

  // Kept in a ref so the drag callbacks below stay identity-stable across the
  // renders that happen between drags (they must not re-subscribe pointers).
  const allocationInputRef = useRef(allocationInput);
  allocationInputRef.current = allocationInput;

  const paintSidebarDrag = useCallback(
    (nextSidebarWidth: number) => {
      paintAllocation(
        resolveShellAllocation({ ...allocationInputRef.current, sidebarWidth: nextSidebarWidth })
      );
    },
    [paintAllocation]
  );
  const paintPanelDrag = useCallback(
    (nextPanelWidth: number) => {
      paintAllocation(
        resolveShellAllocation({ ...allocationInputRef.current, editorWidth: nextPanelWidth })
      );
    },
    [paintAllocation]
  );
  const clampPanelDrag = useCallback(
    (candidate: number) =>
      resolveShellAllocation({ ...allocationInputRef.current, editorWidth: candidate }).editorWidth,
    []
  );

  // A08 §06-4: the override was scoped to the open file, so closing it clears
  // it. Guarded on the current value so this only writes on the closing edge.
  useEffect(() => {
    if (!editorOpen && manualChat !== null) {
      clearManualOverrides();
    }
  }, [editorOpen, manualChat, clearManualOverrides]);

  // The expand overlay belongs to the open panel. A panel that fell back to
  // closed (its last tab went away) must not reopen as a full-bleed overlay.
  useEffect(() => {
    if (expanded && !panelView.open) {
      toggleExpanded();
    }
  }, [expanded, panelView.open, toggleExpanded]);

  return (
    <div
      ref={(node) => {
        shellRef.current = node;
        // `dropZoneRef` is a forwarded prop (T-24's drag-drop target); both
        // owners need this node, so fan out rather than choosing one.
        if (typeof dropZoneRef === 'function') {
          dropZoneRef(node);
        } else if (dropZoneRef) {
          (dropZoneRef as { current: HTMLDivElement | null }).current = node;
        }
      }}
      data-resizing={sidebarResizing || panelResizing || undefined}
      // The columns read these; a drag rewrites them on this node alone.
      style={shellVars}
      className="group/shell relative flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background"
    >
      <LeftDock
        onOpenSearch={() => workspaceSearch.openSearch('files')}
        dockWidth={allocation.sidebarWidth}
        sidebarWidth={sidebarWidth}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        onCommitWidth={setSidebarWidth}
        onDragFrame={paintSidebarDrag}
        onResizingChange={setSidebarResizing}
        onOpenSettings={onOpenSettings}
        repositories={repositories}
        onAddRepository={onAddRepository}
        onRemoveRepository={onRemoveRepository}
        tempWorkspaces={tempWorkspaces}
        onRequestTempDelete={onRequestTempDelete}
      />

      {/*
        Round-11: THE clip boundary. `overflow-clip`, not `overflow-hidden` —
        hidden is still a scroll container, so focusing something inside a
        clipped-off column would scroll the whole row sideways and drag chat off
        screen. Clip cannot scroll at all. Every child below carries an explicit
        width and `shrink-0`: a child allowed to shrink would absorb the
        overflow instead of letting the edge cut it, which is the mechanism.
      */}
      <div className="relative flex min-w-0 flex-1 overflow-clip">
        <div
          className="relative flex shrink-0 flex-col overflow-clip transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none"
          style={{ width: 'var(--shell-center-w)' }}
        >
          {/* Layout 5a: the title bar spans the center row — the conversation
              AND the work panel under it, as in the reference. */}
          <SessionBar
            sidebarCollapsed={sidebarCollapsed}
            onExpandSidebar={toggleSidebar}
            review={reviewTotals}
            shownPanelTab={shownTab}
            onTogglePanelTab={togglePanelTab}
            onOpenPanelTab={openWorkPanel}
            terminalState={terminalState}
            onToggleTerminal={toggleTerminal}
          />
          <div className="relative flex min-h-0 flex-1">
            <div
              className={cn(
                'relative min-w-0 shrink-0 flex-col',
                // Round-13: animates with the center row, so a sidebar
                // collapse/expand never leaves chat + panel narrower or wider
                // than the animating row. `group-data-[resizing]` kills it
                // during any drag, where painted variables apply per frame.
                'transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none',
                // `hidden`, not an unmount: ChatWorkspace owns scroll position
                // and in-flight composer state.
                chatVisible ? 'flex' : 'hidden'
              )}
              style={chatVisible ? { width: 'var(--shell-chat-w)' } : undefined}
            >
              {/* Decision 174 (issue #6): the home page fills the column while
                  no conversation is open; ChatWorkspace keeps the composer. */}
              <ChatWorkspace
                className="min-w-0 flex-1"
                onAddRepository={onAddRepository}
                home={<HomeView />}
              />
            </div>
            {/*
              Layout 5a: the one right-hand container. Always mounted — closed,
              it parks out of the row (see WorkPanel) so running shells and the
              file-intent consumer survive. When `expanded` it overlays THIS
              row (not the shell), so the sidebar and title bar stay reachable.
            */}
            <WorkPanel
              view={panelView}
              tabs={panelTabs}
              rememberedTab={workPanelTab}
              onSelectTab={openWorkPanel}
              onClose={closeWorkPanel}
              expanded={expanded}
              onToggleExpanded={toggleExpanded}
              parkedWidth={parkedPanelWidth}
              resize={{
                width: allocation.editorWidth,
                clamp: clampPanelDrag,
                onCommit: setWorkPanelWidth,
                onDragFrame: paintPanelDrag,
                onResizingChange: setPanelResizing,
              }}
              editorOpen={editorOpen}
              fileIntentPending={fileIntentPending}
              review={
                reviewAvailable ? { sessionId: activeSessionId, entries: reviewEntries } : null
              }
              hasColumnTerminals={hasColumnTerminals}
              terminalKey={terminalKey}
              onSearch={workspaceSearch.openSearch}
            />
          </div>
        </div>
      </div>

      {workspaceSearch.request && (
        <GlobalSearchDialog
          key={workspaceSearch.request.rootPath}
          open
          onOpenChange={(open) => {
            if (!open) workspaceSearch.closeSearch();
          }}
          rootPath={workspaceSearch.request.rootPath}
          initialMode={workspaceSearch.request.mode}
          onOpenFile={workspaceSearch.onOpenFile}
        />
      )}

      {fileDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-md border-2 border-primary border-dashed bg-primary/5">
          <span className="rounded-md bg-surface-3 px-3 py-1.5 text-ui text-foreground elev-md">
            {t('Add Repository')}
          </span>
        </div>
      )}
    </div>
  );
}
