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
import { SessionRailPresenceContext } from '@/components/chat/sessionRailPresence';
import { GlobalSearchDialog } from '@/components/search/GlobalSearchDialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { columnTerminalKey, useColumnTerminalStore } from '@/stores/columnTerminal';
import { isDiffTabActive } from '@/stores/diffTabTarget';
import { useEditorStore } from '@/stores/editor';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSessionRailStore } from '@/stores/sessionRail';
import { useSettingsStore } from '@/stores/settings';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { useSideChatStore } from '@/stores/sideChat';
import { useWorktreeActivityStore } from '@/stores/worktreeActivity';
import {
  deriveEditorOpen,
  resolveShellAllocation,
  resolveShellChrome,
  type ShellAllocation,
} from './centerLayoutModel';
import { HomeView } from './HomeView';
import { LeftDock } from './LeftDock';
import { type PaneActions, PaneArea } from './PaneArea';
import { SessionBar, type SessionReviewTotals } from './SessionBar';
import { SessionRail } from './sessionRail/SessionRail';
import { SessionRailToggle, sessionRailToggleLabel } from './sessionRail/SessionRailToggle';
import {
  resolveSessionRailVisibility,
  SESSION_RAIL_MIN_CHAT_WIDTH,
  SESSION_RAIL_WIDTH,
  sessionRailToggleEnabled,
} from './sessionRail/sessionRailModel';
import { deriveSessionReview, type SessionReviewEntry } from './sessionReview';
import { fitShell, type ShellSlot } from './shellFitModel';
import { clampSidebarWidth } from './shellLayoutModel';
import { SideChat } from './sideChat/SideChat';
import { SideChatToggle, sideChatShortcutLabel } from './sideChat/SideChatToggle';
import { SideChatWindow } from './sideChat/SideChatWindow';
import {
  resolveSideChatPlacement,
  SIDE_CHAT_DOCK_WIDTH,
  SIDE_CHAT_MIN_CHAT_WIDTH,
} from './sideChat/sideChatModel';
import { resolveTerminalWorkspace } from './surfaces/terminalWorkspace';
import { useCapacityReclaimNotice } from './useCapacityReclaimNotice';
import { useEditorWorktreeSync } from './useEditorWorktreeSync';
import { useShellShortcuts } from './useShellShortcuts';
import { useSyncChatWorkspaceTree } from './useSyncChatWorkspaceTree';
import { useWorkspaceSearch } from './useWorkspaceSearch';
import {
  deriveAvailablePanes,
  deriveTerminalButtonState,
  type PaneKind,
  paneAreaMinWidth,
  resolvePaneView,
} from './workPanelModel';

/** Decision 209 §4: the session rail as the slot right of the conversation. */
const RAIL_SLOT: ShellSlot = { width: SESSION_RAIL_WIDTH, minChat: SESSION_RAIL_MIN_CHAT_WIDTH };
/** Layout 5f: a docked side chat takes the same slot, wider. */
const DOCK_SLOT: ShellSlot = { width: SIDE_CHAT_DOCK_WIDTH, minChat: SIDE_CHAT_MIN_CHAT_WIDTH };

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
 * Layout 5a/5d (ui-cohesion §6): sidebar │ title bar over chat │ panes.
 *
 *   left   — `LeftDock`: the chat list; collapses to nothing (ruling L1)
 *   center — `SessionBar` (the title bar) over the conversation, and the
 *            pane cards beside it when any is open (ruling L3; layout 5d)
 *
 * The allocator is unchanged in shape: it budgets sidebar → chat → editor →
 * panel, and the pane area takes the "editor" term (its width per column
 * count, default 496 / 864 with the edge margins; its floor is 320 per
 * column). The last term stays retired (`panelVisible: false`), as under D08.
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

  // Layout 5d: the panes (session-only) and the area's persisted geometry.
  const panes = useShellLayoutStore((state) => state.panes);
  const paneFocus = useShellLayoutStore((state) => state.paneFocus);
  const expandedPane = useShellLayoutStore((state) => state.expandedPane);
  const paneAreaWidth = useShellLayoutStore((state) => state.paneAreaWidth);
  const paneAreaSplitWidth = useShellLayoutStore((state) => state.paneAreaSplitWidth);
  const paneSplits = useShellLayoutStore((state) => state.paneSplits);
  const setPaneAreaWidth = useShellLayoutStore((state) => state.setPaneAreaWidth);
  const setupTerminalOpened = useShellLayoutStore((state) => state.setupTerminalOpened);
  const openPane = useShellLayoutStore((state) => state.openPane);
  const togglePane = useShellLayoutStore((state) => state.togglePane);
  const closePane = useShellLayoutStore((state) => state.closePane);
  const focusPane = useShellLayoutStore((state) => state.focusPane);
  const toggleExpandedPane = useShellLayoutStore((state) => state.toggleExpandedPane);
  const swapPanes = useShellLayoutStore((state) => state.swapPanes);
  const setPaneColumnSplit = useShellLayoutStore((state) => state.setPaneColumnSplit);
  const setPaneRowSplit = useShellLayoutStore((state) => state.setPaneRowSplit);
  const revealChange = useShellLayoutStore((state) => state.revealChange);

  // Layout 5e: the session rail — the user's shown / hidden choice (persisted).
  const sessionRailShown = useSessionRailStore((state) => state.shown);
  const toggleSessionRail = useSessionRailStore((state) => state.toggleShown);

  // Layout 5f: the side chat (`/btw`, Ctrl+;) — open or not, and its form.
  const sideChatOpen = useSideChatStore((state) => state.open);
  const sideChatForm = useSideChatStore((state) => state.form);
  const toggleSideChat = useSideChatStore((state) => state.toggleFor);

  // D35: `manualChat` stays (it also gates the "close all tabs snaps chat
  // back to full width" reset below); nothing sets it any more, so
  // `chatVisible` reads `true` by default.
  const manualChat = useShellLayoutStore((state) => state.manualChat);
  const clearManualOverrides = useShellLayoutStore((state) => state.clearManualOverrides);

  // T-32: a file being open is what gives the editor pane its content.
  const editorOpen = deriveEditorOpen(useEditorStore((state) => state.tabs).length);
  // D35 round 2 (2026-08-14): a diff tab, while ACTIVE and on screen, takes
  // the whole center row — see `resolveShellChrome`'s `diffTabActive` note.
  const diffTabActive = useEditorStore((state) => isDiffTabActive(state.tabs, state.activeTabPath));
  // Round-10 ⑥: primitive selector — mounts the intent consumer (the editor,
  // inside its pane card) even before any tab exists.
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
   * its shell in the terminal pane. The folder is the chain the init terminal
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
  // The diff pane's header names the branch the conversation works on.
  const activeBranch = useChatSessionsStore((state) => {
    const session = state.sessions.find((item) => item.id === state.activeSessionId);
    const workspace = state.workspaces.find((item) => item.id === session?.workspaceId);
    return workspace?.branch ?? null;
  });
  const terminalAlive = useColumnTerminalStore((state) =>
    terminalKey ? state.terminals[terminalKey] !== undefined : false
  );
  const hasColumnTerminals = useColumnTerminalStore(
    (state) => Object.keys(state.terminals).length > 0
  );

  // Which panes can show, and what is on screen. Derived, never written
  // back: a pane that is gone only for a while (another folder has no shell)
  // comes back by itself, the way the stacked right column used to behave.
  const availablePanes = deriveAvailablePanes({
    reviewAvailable,
    editorOpen: editorOpen || fileIntentPending,
    terminalAlive,
    setupTerminalOpened,
    sessionOpen: activeSessionId !== null,
  });
  // What the user has open. `fitShell` (below, once the width is known) may
  // stack it into one column on a narrow window (decision 209 §5).
  const requestedPaneView = resolvePaneView(
    { panes, focus: paneFocus, expanded: expandedPane },
    availablePanes
  );
  const paneActions = useMemo<PaneActions>(
    () => ({
      open: openPane,
      close: closePane,
      focus: focusPane,
      toggleExpanded: toggleExpandedPane,
      swap: swapPanes,
      commitColumnSplit: setPaneColumnSplit,
      commitRowSplit: setPaneRowSplit,
    }),
    [
      openPane,
      closePane,
      focusPane,
      toggleExpandedPane,
      swapPanes,
      setPaneColumnSplit,
      setPaneRowSplit,
    ]
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
    // Opening a file from anywhere opens (or focuses) the editor pane. A
    // worktree switch restoring its own tabs is not a request to show one,
    // hence the same-worktree condition.
    if (
      fileIntentPending ||
      previousEditor.current.revealSeq !== revealSeq ||
      (previousEditor.current.worktreePath === editorWorktreePath &&
        previousEditor.current.path !== activeEditorPath &&
        activeEditorPath !== null)
    ) {
      openPane('editor');
    }
    previousEditor.current = {
      worktreePath: editorWorktreePath,
      path: activeEditorPath,
      revealSeq,
    };
  }, [fileIntentPending, activeEditorPath, editorWorktreePath, revealSeq, openPane]);

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

  // Layout 5a: `panelOpen: false` keeps the allocator's last term retired.
  // D35 round 2: a diff tab takes the whole center row only while the editor
  // is the one pane on screen — beside other panes it stays a card.
  const editorPaneAlone =
    requestedPaneView.expanded === 'editor' ||
    (requestedPaneView.panes.length === 1 && requestedPaneView.panes[0] === 'editor');
  const chrome = resolveShellChrome({
    sidebarUserCollapsed: sidebarCollapsed,
    panelOpen: false,
    manualChat,
    diffTabActive: editorPaneAlone && diffTabActive,
  });
  const chatVisible = chrome.chatVisible;

  /**
   * Decision 209 (§4, §5): one fit for the whole center row — the panes'
   * arrangement (stacked into one column, or a drawer over the chat, on a
   * narrow window), the allocator's widths, and whether the column right of
   * the conversation fits: a docked side chat, else the session rail (open
   * panes are squeezed to their floor for it first). One column of panes, or
   * two: each count keeps its own area width.
   */
  // Decision 209 ruling 4: the side chat stays open on its own conversation
  // whichever one (or the home page) the main window shows.
  const sideChatWantsDock = sideChatOpen && sideChatForm === 'dock';
  const railWanted = sessionRailShown && activeSessionId !== null;
  const fitInput = {
    base: {
      shellWidth,
      sidebarWidth,
      sidebarCollapsed: chrome.sidebarCollapsed,
      chatVisible,
      panelVisible: false,
      panelWidth: 0,
    },
    view: requestedPaneView,
    focus: paneFocus,
    paneWidths: { 1: paneAreaWidth, 2: paneAreaSplitWidth },
  };
  let fit = fitShell({
    ...fitInput,
    slot: sideChatWantsDock ? DOCK_SLOT : railWanted ? RAIL_SLOT : null,
  });
  // A docked side chat with no room floats (layout 5f), leaving the slot to the rail.
  const sideChatDocked = sideChatWantsDock && fit.slotFits;
  let railFits = !sideChatWantsDock && fit.slotFits;
  if (sideChatWantsDock && !sideChatDocked && railWanted) {
    fit = fitShell({ ...fitInput, slot: RAIL_SLOT });
    railFits = fit.slotFits;
  }
  const slotOnScreen = sideChatDocked ? DOCK_SLOT : railFits ? RAIL_SLOT : null;
  const paneView = fit.view;
  const visiblePanes = paneView.panes;
  const paneColumns = paneView.columns === 2 ? 2 : 1;
  const allocationInput = fit.input;
  const allocation = fit.allocation;
  /**
   * While the slot holds its place by squeezing the panes, a drag cannot widen
   * them past the point where it would have to leave (what you drag is what
   * stays; hiding the rail gives the room back).
   */
  const paneDragLimit =
    slotOnScreen && paneView.columns > 0 && !allocation.editorOverlay
      ? Math.max(
          paneAreaMinWidth(paneColumns),
          allocation.centerWidth - slotOnScreen.width - slotOnScreen.minChat
        )
      : null;

  const togglePaneOnScreen = useCallback(
    (kind: PaneKind) => togglePane(kind, visiblePanes),
    [togglePane, visiblePanes]
  );

  // A08: global shell shortcuts (Ctrl/Cmd+B/1-5, layout 5d's Ctrl/Cmd+\\).
  // Only live while this component is mounted, i.e. only for the new shell.
  // Decision 209: the panes ON SCREEN, after narrowing.
  useShellShortcuts({ paneView });

  const terminalVisible = visiblePanes.includes('terminal');
  const terminalState = deriveTerminalButtonState({
    available: terminalCwd !== null,
    alive: terminalAlive,
    visible: terminalVisible,
  });
  const toggleTerminal = useCallback(() => {
    if (!terminalCwd) return;
    if (terminalVisible) {
      closePane('terminal');
      return;
    }
    useColumnTerminalStore.getState().show(terminalCwd);
    openPane('terminal');
  }, [terminalCwd, terminalVisible, closePane, openPane]);

  /**
   * Where the empty pane area waits: the width it would have if a pane
   * opened. A parked terminal keeps a real box (no FitAddon collapse to two
   * columns), at the width it will show at, so opening does not resize it.
   */
  const parkedPaneWidth =
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
  const paneDragLimitRef = useRef(paneDragLimit);
  paneDragLimitRef.current = paneDragLimit;

  const paintSidebarDrag = useCallback(
    (nextSidebarWidth: number) => {
      paintAllocation(
        resolveShellAllocation({ ...allocationInputRef.current, sidebarWidth: nextSidebarWidth })
      );
    },
    [paintAllocation]
  );
  // Decision 209 §5: the sidebar's drag stops where a narrow window stops the
  // dock (`resolveSidebarWidth`), so what the drag commits is what shows.
  const clampSidebarDrag = useCallback(
    (candidate: number) =>
      resolveShellAllocation({
        ...allocationInputRef.current,
        sidebarWidth: clampSidebarWidth(candidate),
      }).sidebarWidth,
    []
  );
  const paintPanelDrag = useCallback(
    (nextPanelWidth: number) => {
      paintAllocation(
        resolveShellAllocation({ ...allocationInputRef.current, editorWidth: nextPanelWidth })
      );
    },
    [paintAllocation]
  );
  const clampPanelDrag = useCallback((candidate: number) => {
    const width = resolveShellAllocation({
      ...allocationInputRef.current,
      editorWidth: candidate,
    }).editorWidth;
    const limit = paneDragLimitRef.current;
    return limit === null ? width : Math.min(width, limit);
  }, []);

  // A08 §06-4: the override was scoped to the open file, so closing it clears
  // it. Guarded on the current value so this only writes on the closing edge.
  useEffect(() => {
    if (!editorOpen && manualChat !== null) {
      clearManualOverrides();
    }
  }, [editorOpen, manualChat, clearManualOverrides]);

  /**
   * Layout 5e (ruling L5): the session rail sits inside the chat column, right
   * of the conversation. Derived per render from the user's choice and the
   * fit above — never stored (F10). Decision 209 §4: it stays beside open
   * panes, and hides only when the conversation would get too narrow.
   */
  /**
   * Layout 5f / decision 209 §3: the side chat is a window of its own, or
   * docks right of the chat in the rail's place (the rail yields). Like the
   * rail, derived per render: docked but too narrow, it lies over the chat.
   */
  const sideChatPlacement = resolveSideChatPlacement({
    open: sideChatOpen,
    form: sideChatForm,
    dockFits: sideChatDocked,
  });
  const sessionRail = resolveSessionRailVisibility({
    userShown: sessionRailShown,
    sessionOpen: activeSessionId !== null,
    sideChatDocked: sideChatPlacement === 'dock',
    fits: railFits,
  });
  const sessionRailLabel = t(sessionRailToggleLabel(sessionRail));
  const sessionRailMenuDisabled = !sessionRailToggleEnabled(sessionRail);
  const sessionRailMenu = useMemo(
    () => ({
      visible: sessionRail.visible,
      label: sessionRailLabel,
      disabled: sessionRailMenuDisabled,
      onToggle: toggleSessionRail,
    }),
    [sessionRail.visible, sessionRailLabel, sessionRailMenuDisabled, toggleSessionRail]
  );

  const isMac = window.electronAPI?.env?.platform === 'darwin';

  const commitPaneAreaWidth = useCallback(
    (width: number) => setPaneAreaWidth(paneColumns, width),
    [setPaneAreaWidth, paneColumns]
  );

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
        onOpenSearch={() => workspaceSearch.openSearch('chat')}
        dockWidth={allocation.sidebarWidth}
        sidebarWidth={sidebarWidth}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        onCommitWidth={setSidebarWidth}
        clampWidth={clampSidebarDrag}
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
              AND the panes under it, as in the reference. */}
          <SessionBar
            sidebarCollapsed={sidebarCollapsed}
            onExpandSidebar={toggleSidebar}
            review={reviewTotals}
            openPanes={visiblePanes}
            onTogglePane={togglePaneOnScreen}
            onOpenPane={openPane}
            terminalState={terminalState}
            onToggleTerminal={toggleTerminal}
            sessionRailToggle={
              activeSessionId ? (
                <SessionRailToggle visibility={sessionRail} onToggle={toggleSessionRail} />
              ) : undefined
            }
            sideChatToggle={
              activeSessionId ? (
                <SideChatToggle
                  open={sideChatOpen}
                  onToggle={() => toggleSideChat(activeSessionId)}
                  isMac={isMac}
                />
              ) : undefined
            }
            sessionRail={sessionRailMenu}
            sideChat={
              activeSessionId
                ? {
                    open: sideChatOpen,
                    label: `${t('Side chat')} (${sideChatShortcutLabel(isMac)})`,
                    onToggle: () => toggleSideChat(activeSessionId),
                  }
                : undefined
            }
            // Decision 209 §5: the bar spans the center row.
            barWidth={shellWidth === null ? null : allocation.centerWidth}
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
                  no conversation is open; ChatWorkspace keeps the composer.
                  Layout 5e: the session rail rides at the column's right
                  edge, and the composer hides what the rail shows. */}
              <div className="flex min-h-0 min-w-0 flex-1">
                {/* Layout 5f: always this wrapper, so a docked side chat with
                    no room lies over the conversation alone and opening it
                    never remounts ChatWorkspace. */}
                <div className="relative flex min-h-0 min-w-0 flex-1">
                  <SessionRailPresenceContext.Provider value={sessionRail.visible}>
                    <ChatWorkspace
                      className="min-w-0 flex-1"
                      onAddRepository={onAddRepository}
                      home={<HomeView />}
                    />
                  </SessionRailPresenceContext.Provider>
                  {sideChatPlacement === 'dock-over' && <SideChat placement="dock-over" />}
                </div>
                {sessionRail.visible && activeSessionId && (
                  <SessionRail
                    sessionId={activeSessionId}
                    reviewEntries={reviewAvailable ? reviewEntries : null}
                    onOpenPane={openPane}
                    onRevealChange={revealChange}
                  />
                )}
                {sideChatPlacement === 'dock' && <SideChat placement="dock" />}
                {/* Decision 209 §3: drawn into its own window through a portal. */}
                {sideChatPlacement === 'window' && <SideChatWindow />}
              </div>
            </div>
            {/*
              Layout 5d: the pane cards. Always mounted — with nothing open
              the area parks out of the row (see PaneArea) so running shells
              and the file-intent consumer survive. An expanded pane overlays
              THIS row (not the shell): the sidebar and title bar stay reachable.
            */}
            <PaneArea
              view={paneView}
              overlay={allocation.editorOverlay}
              splits={paneSplits}
              actions={paneActions}
              parkedWidth={parkedPaneWidth}
              resize={{
                width: allocation.editorWidth,
                clamp: clampPanelDrag,
                onCommit: commitPaneAreaWidth,
                onDragFrame: paintPanelDrag,
                onResizingChange: setPanelResizing,
              }}
              editorOpen={editorOpen}
              fileIntentPending={fileIntentPending}
              review={
                reviewAvailable ? { sessionId: activeSessionId, entries: reviewEntries } : null
              }
              branch={activeBranch}
              sessionId={activeSessionId}
              hasColumnTerminals={hasColumnTerminals}
              terminalKey={terminalKey}
              onSearch={workspaceSearch.openSearch}
            />
          </div>
        </div>
      </div>

      {workspaceSearch.request && (
        <GlobalSearchDialog
          key={workspaceSearch.request.rootPath ?? ''}
          open
          onOpenChange={(open) => {
            if (!open) workspaceSearch.closeSearch();
          }}
          rootPath={workspaceSearch.request.rootPath}
          initialMode={workspaceSearch.request.mode}
          onOpenFile={workspaceSearch.onOpenFile}
          onOpenChat={workspaceSearch.onOpenChat}
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
