import type { TempWorkspaceItem } from '@shared/types';
import {
  type ComponentProps,
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
import { ErrorBoundary } from '@/components/ErrorBoundary';
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
import { EditorColumn } from './center/EditorColumn';
import { TerminalColumn } from './center/TerminalColumn';
import {
  chatWidthToEditorRatio,
  deriveEditorOpen,
  REVIEW_MIN_WIDTH,
  resolveShellAllocation,
  resolveShellChrome,
  type ShellAllocation,
} from './centerLayoutModel';
import { LeftDock } from './LeftDock';
import { deriveTerminalButtonState, resolveRightColumnOccupant } from './rightColumnModel';
import { SessionBar } from './SessionBar';
import { SessionReviewPanel } from './SessionReviewPanel';
import { ShellResizeHandle } from './ShellResizeHandle';
import { deriveSessionReview, type SessionReviewEntry } from './sessionReview';
import { resolveTerminalWorkspace } from './surfaces/terminalWorkspace';
import { useCapacityReclaimNotice } from './useCapacityReclaimNotice';
import { useEditorWorktreeSync } from './useEditorWorktreeSync';
import { useShellShortcuts } from './useShellShortcuts';
import { useSyncChatWorkspaceTree } from './useSyncChatWorkspaceTree';
import { useWorkspaceSearch } from './useWorkspaceSearch';

const NO_REVIEW_ENTRIES: SessionReviewEntry[] = [];

/**
 * T4: the editor column behind its own error boundary, so a file view that
 * throws while rendering takes down this column instead of the whole window
 * (the 2026-09-24 field crash reached the root card from an image preview).
 *
 * The boundary retries by itself when the active tab or the tab count
 * changes — the fallback covers the tab bar, so picking another file in the
 * tree (or closing the failed tab from anywhere else) has to be enough to
 * bring the column back. Subscribed here, not in the shell, so a tab switch
 * does not re-render the whole shell.
 */
function GuardedEditorColumn(props: ComponentProps<typeof EditorColumn>) {
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const tabCount = useEditorStore((state) => state.tabs.length);
  return (
    <ErrorBoundary
      scope="editor-column"
      className="h-full min-h-0"
      resetKey={`${tabCount}:${activeTabPath ?? ''}`}
    >
      <EditorColumn {...props} />
    </ErrorBoundary>
  );
}

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
  /** Temp session items (App's `useTempWorkspaceStore`), threaded down to the dock's
   * chat surface so it can map a Temp folder row to the item its delete button targets. */
  tempWorkspaces?: TempWorkspaceItem[];
  /** Opens the shared `TempWorkspaceDialogs` delete confirmation (App's
   * `useTempWorkspaceStore.openDelete`), same as the legacy shell's `onRequestTempDelete`. */
  onRequestTempDelete?: (id: string) => void;
}

/**
 * D08: three columns, new division of labour.
 *
 *   left   — `LeftDock`: icon rail + the surface panel (chat/git/files/context/run)
 *   center — session tabs + `ChatWorkspace`
 *   right  — `EditorColumn`; the session review and (dsh-rebase P1-11) the
 *            folder's shell terminal take the same place, one at a time
 *
 * The allocator is UNCHANGED. It always budgeted sidebar → chat → editor →
 * panel; D08 simply retires the panel term (the surfaces moved into the
 * sidebar), so the shell passes `panelVisible: false` and the same three
 * remaining columns divide the row exactly as before. That is why this rework
 * touches no width math: the column that disappeared is the one the allocator
 * satisfied last.
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
  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const expanded = useShellLayoutStore((state) => state.expanded);
  const toggleExpanded = useShellLayoutStore((state) => state.toggleExpanded);

  const editorRatio = useShellLayoutStore((state) => state.editorRatio);
  const setEditorRatio = useShellLayoutStore((state) => state.setEditorRatio);

  const manualPanel = useShellLayoutStore((state) => state.manualPanel);
  // D35: `manualChat` itself stays (it also gates the "close all tabs snaps
  // chat back to full width" reset below) — only `setManualChat`'s UI caller
  // (the retired "Chat column" head button) is gone, so nothing sets it to
  // `false` any more and `chatVisible` reads `true` by default.
  const manualChat = useShellLayoutStore((state) => state.manualChat);
  const clearManualOverrides = useShellLayoutStore((state) => state.clearManualOverrides);

  // T-32: a file being open is what makes the center row two columns.
  const editorOpen = deriveEditorOpen(useEditorStore((state) => state.tabs).length);
  // D35 round 2 (2026-08-14): a diff tab, while ACTIVE, takes the whole
  // center column — see `resolveShellChrome`'s `diffTabActive` doc note.
  const diffTabActive = useEditorStore((state) => isDiffTabActive(state.tabs, state.activeTabPath));
  // Round-10 ⑥: primitive selector — mounts the intent consumer (below) even
  // before any tab exists. See the EditorColumn wrapper comment.
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
  const [reviewRequested, setReviewRequested] = useState(false);
  const reviewOpen = showSessionReview && reviewRequested && activeSessionId !== null;
  const closeReview = useCallback(() => setReviewRequested(false), []);

  /**
   * dsh-rebase P1-11 (decisions 109, 126, 128): the conversation's folder, and
   * its shell in the right column. The folder is the same chain the dock's
   * terminal surface uses (`resolveTerminalWorkspace`: session → workspace →
   * non-empty path); an unbound chat's scratch directory is not one, and
   * nothing falls back to the home directory (decision 126 rule 2).
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
  const terminalFront = useColumnTerminalStore((state) =>
    terminalKey ? state.terminals[terminalKey]?.front === true : false
  );
  const hasColumnTerminals = useColumnTerminalStore(
    (state) => Object.keys(state.terminals).length > 0
  );
  const hideTerminal = useCallback(() => {
    if (terminalKey) useColumnTerminalStore.getState().hide(terminalKey);
  }, [terminalKey]);
  // The review's Files button means the files, not whatever sits under the review.
  const showFiles = useCallback(() => {
    closeReview();
    hideTerminal();
  }, [closeReview, hideTerminal]);
  // The expand overlay is shared with the editor; dismissing an expanded
  // review must not hand a full-bleed overlay to the files underneath.
  const dismissReview = useCallback(() => {
    if (expanded) toggleExpanded();
    closeReview();
  }, [expanded, toggleExpanded, closeReview]);
  const toggleReview = useCallback(() => setReviewRequested((open) => !open), []);
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
    // Opening a file puts the files on top: the review closes, and the
    // terminal steps behind them with its shell still running.
    if (
      fileIntentPending ||
      previousEditor.current.revealSeq !== revealSeq ||
      (previousEditor.current.worktreePath === editorWorktreePath &&
        previousEditor.current.path !== activeEditorPath)
    ) {
      closeReview();
      hideTerminal();
    }
    previousEditor.current = {
      worktreePath: editorWorktreePath,
      path: activeEditorPath,
      revealSeq,
    };
  }, [
    fileIntentPending,
    activeEditorPath,
    editorWorktreePath,
    revealSeq,
    closeReview,
    hideTerminal,
  ]);

  // A workspace being deleted takes its column shells with it, through the
  // same hook the dock's terminal panel answers (`closeTerminalSessions`).
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

  const centerRowRef = useRef<HTMLDivElement>(null);
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const [centerResizing, setCenterResizing] = useState(false);

  const temporaryWorkspaceEnabled = useSettingsStore((state) => state.temporaryWorkspaceEnabled);
  useSyncChatWorkspaceTree({
    repositories,
    selectedRepoPath,
    temporaryWorkspaceEnabled,
  });

  // A08: global shell shortcuts (Ctrl/Cmd+B/1-5). Only live while this
  // component is mounted, i.e. only for the new shell.
  useShellShortcuts();
  const workspaceSearch = useWorkspaceSearch();

  // m7: per-workspace editor tab isolation. Must live somewhere ALWAYS mounted
  // — see the hook for the deadlock that put it here.
  useEditorWorktreeSync();

  // D12: one sentence when the pool reclaims an idle conversation.
  useCapacityReclaimNotice();

  // D12 (U24): the open-tab mirror and its pruning effect went with the tab
  // strip. `activeSessionId` is the whole answer to "what is the center column
  // showing" again, so there is no second list to keep in step with it — which
  // is what the mirror effect and `pruneSessions` existed to do.

  const dockRef = useRef<HTMLDivElement>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);

  // The allocator budgets the WHOLE shell (the dock is one of the columns it
  // satisfies first), which `contentRowRef` deliberately excludes.
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

  // D08: `sidebarUserCollapsed` is now derived, not stored — a collapsed dock
  // IS "no surface active". `panelOpen: false` retires the allocator's panel
  // term (see this component's doc note).
  const dockCollapsed = activeSurfaceId === null;
  /**
   * dsh-rebase P1-11 (decision 128): one occupant at a time — the review on
   * top, then the terminal when it is in front, then the files. Whatever is
   * under the one showing stays as it was, so closing it restores the rest.
   */
  const rightOccupant = resolveRightColumnOccupant({ reviewOpen, terminalFront, editorOpen });
  const terminalVisible = rightOccupant === 'terminal';
  const editorCovered = rightOccupant === 'review' || rightOccupant === 'terminal';
  const terminalState = deriveTerminalButtonState({
    available: terminalCwd !== null,
    alive: terminalAlive,
    visible: terminalVisible,
  });
  const toggleTerminal = useCallback(() => {
    if (!terminalCwd) return;
    if (terminalVisible) {
      hideTerminal();
      return;
    }
    useColumnTerminalStore.getState().show(terminalCwd);
    closeReview();
    // The expand overlay belongs to the files and the review; the terminal
    // opens at the column's width.
    if (expanded) toggleExpanded();
  }, [terminalCwd, terminalVisible, hideTerminal, closeReview, expanded, toggleExpanded]);

  const chrome = resolveShellChrome({
    sidebarUserCollapsed: dockCollapsed,
    panelOpen: false,
    manualChat,
    diffTabActive: !editorCovered && diffTabActive,
  });
  const chatVisible = chrome.chatVisible;
  /**
   * D13 (U26): the editor column is allocated whenever a file, the session
   * review or (dsh-rebase P1-11) the folder's terminal is open. The chat
   * column gets the whole center row otherwise, because `editorOpen` is keyed
   * off `tabs.length`. (The pi TUI that shared the chat column went with
   * dsh-rebase P1-11, decision 127.)
   */
  const editorAllocated = editorOpen || reviewOpen || terminalVisible;

  const allocationInput = {
    shellWidth,
    sidebarWidth,
    sidebarCollapsed: chrome.sidebarCollapsed,
    chatVisible,
    editorOpen: editorAllocated,
    editorMinWidth: reviewOpen ? REVIEW_MIN_WIDTH : undefined,
    editorRatio,
    panelVisible: false,
    panelWidth: 0,
  };
  const allocation = resolveShellAllocation(allocationInput);
  /**
   * Where a running column shell waits while it is not the one showing: the
   * width the column has, or would have if something opened in it. A hidden
   * terminal keeps a real box (no FitAddon collapse to two columns), and the
   * same width as when it was last seen, so coming back does not resize it.
   * The terminal itself uses the editor's floor (`EDITOR_MIN_WIDTH`), so
   * switching between the files and the terminal never moves the grip.
   */
  const parkedTerminalWidth =
    allocation.editorWidth > 0
      ? allocation.editorWidth
      : resolveShellAllocation({
          ...allocationInput,
          editorOpen: true,
          editorMinWidth: undefined,
        }).editorWidth;

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

  // A08 §06-4: the overrides were scoped to the open file, so closing it
  // clears them. Guarded on the current values so this only writes on the
  // closing edge, not on every render with no file open.
  useEffect(() => {
    if (!editorOpen && (manualPanel !== null || manualChat !== null)) {
      clearManualOverrides();
    }
  }, [editorOpen, manualPanel, manualChat, clearManualOverrides]);

  // D08: the expand overlay belongs to the editor now. Leaving `expanded` true
  // with no file open would restore a full-bleed overlay over chat the next
  // time one is opened.
  useEffect(() => {
    if (expanded && !editorAllocated) {
      toggleExpanded();
    }
  }, [expanded, editorAllocated, toggleExpanded]);

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
      data-resizing={sidebarResizing || centerResizing || undefined}
      // The columns read these; a drag rewrites them on this node alone.
      style={shellVars}
      className="group/shell relative flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background"
    >
      <LeftDock
        dockRef={dockRef}
        dockWidth={allocation.sidebarWidth}
        sidebarWidth={sidebarWidth}
        onCommitWidth={setSidebarWidth}
        onDragFrame={paintSidebarDrag}
        onResizingChange={setSidebarResizing}
        onOpenSettings={onOpenSettings}
        onSearch={workspaceSearch.openSearch}
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
          ref={centerRowRef}
          className="relative flex shrink-0 flex-col overflow-clip transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none"
          style={{ width: 'var(--shell-center-w)' }}
        >
          <div className="relative flex min-h-0 flex-1">
            <div
              ref={chatColumnRef}
              data-resizing={centerResizing || undefined}
              className={cn(
                'relative min-w-0 shrink-0 flex-col',
                // Round-13: animates with the center row, so a dock collapse/
                // expand never leaves chat+editor narrower than (a white gap
                // inside) or wider than (a clipped) the animating center row.
                // `group-data-[resizing]` kills it during any drag, where the
                // painted variables must apply per frame, not eased.
                'transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none',
                // `hidden`, not an unmount: ChatWorkspace owns scroll position
                // and in-flight composer state.
                chatVisible ? 'flex' : 'hidden'
              )}
              style={chatVisible ? { width: 'var(--shell-chat-w)' } : undefined}
            >
              {/*
                D12: one bar for the one conversation on screen, still INSIDE
                the chat column rather than above chat ║ editor. The right
                column has its own file-tab bar, so a bar spanning both would
                put two bars on one column — the exact 「臃肿」 D07 spent a
                round removing.
              */}
              <SessionBar
                reviewOpen={reviewOpen}
                reviewCount={reviewEntries.length}
                onToggleReview={showSessionReview ? toggleReview : undefined}
                terminalState={terminalState}
                onToggleTerminal={toggleTerminal}
              />
              <ChatWorkspace className="min-w-0 flex-1" onAddRepository={onAddRepository} />
              {editorAllocated && chatVisible && (
                <ShellResizeHandle
                  side="right"
                  ariaLabel={t('Resize chat column')}
                  width={allocation.chatWidth}
                  targetRef={chatColumnRef}
                  clamp={(candidate) =>
                    resolveShellAllocation({
                      ...allocationInput,
                      editorRatio: chatWidthToEditorRatio({
                        chatWidth: candidate,
                        centerWidth: allocation.centerWidth,
                      }),
                    }).chatWidth
                  }
                  onCommit={(next) =>
                    setEditorRatio(
                      chatWidthToEditorRatio({
                        chatWidth: next,
                        centerWidth: allocation.centerWidth,
                      })
                    )
                  }
                  onDragFrame={(next) =>
                    paintAllocation(
                      resolveShellAllocation({
                        ...allocationInputRef.current,
                        editorRatio: chatWidthToEditorRatio({
                          chatWidth: next,
                          centerWidth: allocation.centerWidth,
                        }),
                      })
                    )
                  }
                  onResizingChange={setCenterResizing}
                />
              )}
            </div>
            {/*
              m6 (user round 2): no editor, no box — a `flex-1` wrapper around a
              null column still claimed half the center row while LOOKING empty.

              Round-10 ⑥: a PENDING file intent mounts the column too, in a
              `hidden` wrapper (no layout claim, effects still run), because
              `EditorColumn` is the only `fileOpenIntent` consumer — without it
              a tool-row file click with zero tabs open had no consumer at all.

              D08: when `expanded`, the column is promoted to an overlay that
              covers the center row. Absolute over THIS row (not the shell), so
              the dock stays reachable — the same boundary `ContextPanel`'s
              overlay used.
            */}
            {(editorOpen || fileIntentPending) && (
              <div
                className={cn(
                  'transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none',
                  editorOpen && !editorCovered && expanded && 'absolute inset-0 z-20 bg-background',
                  editorOpen && !editorCovered && !expanded && 'min-w-0 shrink-0',
                  (!editorOpen || editorCovered) && 'hidden'
                )}
                style={editorOpen && !expanded ? { width: 'var(--shell-editor-w)' } : undefined}
              >
                <GuardedEditorColumn expanded={expanded} onToggleExpanded={toggleExpanded} />
              </div>
            )}
            {reviewOpen && (
              <div
                className={cn(
                  'transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none',
                  expanded ? 'absolute inset-0 z-20 bg-background' : 'min-w-0 shrink-0'
                )}
                style={!expanded ? { width: 'var(--shell-editor-w)' } : undefined}
              >
                <SessionReviewPanel
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  entries={reviewEntries}
                  onClose={dismissReview}
                  onShowFiles={showFiles}
                  filesOpen={editorOpen}
                  expanded={expanded}
                  onToggleExpanded={toggleExpanded}
                />
              </div>
            )}
            {/*
              dsh-rebase P1-11 (decisions 109, 126, 128): the folder's shell,
              the column's third occupant, at the editor's width. Mounted while
              ANY column shell runs, not only while one shows: unmounting a
              shell ends it. Out of sight it is lifted out of the row
              (`absolute`) and made invisible, but keeps a real box —
              `display: none` would collapse xterm to two columns.
            */}
            {hasColumnTerminals && (
              <div
                className={cn(
                  'transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none',
                  terminalVisible
                    ? 'min-w-0 shrink-0'
                    : 'pointer-events-none invisible absolute inset-y-0 right-0'
                )}
                style={{
                  width: terminalVisible ? 'var(--shell-editor-w)' : `${parkedTerminalWidth}px`,
                }}
                inert={!terminalVisible}
                aria-hidden={terminalVisible ? undefined : true}
              >
                <TerminalColumn
                  currentKey={terminalKey}
                  visible={terminalVisible}
                  filesOpen={editorOpen}
                  onShowFiles={hideTerminal}
                />
              </div>
            )}
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
          <span className="rounded-md bg-card px-3 py-1.5 text-sm text-foreground shadow-sm">
            {t('Add Repository')}
          </span>
        </div>
      )}
    </div>
  );
}
