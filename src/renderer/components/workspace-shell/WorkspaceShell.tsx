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
import type { Repository } from '@/App/constants';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';
import { usePresentationSwitch } from '@/components/chat/usePresentationSwitch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { isDiffTabActive } from '@/stores/diffTabTarget';
import { useEditorStore } from '@/stores/editor';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSessionTabsStore } from '@/stores/sessionTabs';
import { useSettingsStore } from '@/stores/settings';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { EditorColumn } from './center/EditorColumn';
import {
  chatWidthToEditorRatio,
  deriveEditorOpen,
  resolveShellAllocation,
  resolveShellChrome,
  type ShellAllocation,
} from './centerLayoutModel';
import { LeftDock } from './LeftDock';
import { SessionTabs } from './SessionTabs';
import { ShellResizeHandle } from './ShellResizeHandle';
import { useEditorWorktreeSync } from './useEditorWorktreeSync';
import { useShellShortcuts } from './useShellShortcuts';
import { useSyncChatWorkspaceTree } from './useSyncChatWorkspaceTree';

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
 *   right  — `EditorColumn`, and nothing else
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

  const centerRowRef = useRef<HTMLDivElement>(null);
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const [centerResizing, setCenterResizing] = useState(false);

  const temporaryWorkspaceEnabled = useSettingsStore((state) => state.temporaryWorkspaceEnabled);
  // D07: one instance, two consumers — `SessionTabs` renders the switch, the
  // chat column renders the terminal it switches to. Creating it in both would
  // give one terminal two ids.
  const presentation = usePresentationSwitch();
  const presentationMode = presentation.presentationMode;
  useSyncChatWorkspaceTree({
    repositories,
    selectedRepoPath,
    temporaryWorkspaceEnabled,
  });

  // A08: global shell shortcuts (Ctrl/Cmd+B/1-5). Only live while this
  // component is mounted, i.e. only for the new shell.
  useShellShortcuts();

  // m7: per-workspace editor tab isolation. Must live somewhere ALWAYS mounted
  // — see the hook for the deadlock that put it here.
  useEditorWorktreeSync();

  /**
   * D08 (U15-c): the ONE place `activeSessionId` becomes an open tab.
   *
   * Deliberately an effect on the active id rather than a call inside every
   * activation path: sessions are activated from at least four places (the dock
   * list, the tab strip, `createChatSessionOnWorkspace`, a fork), and adding an
   * `openSession()` to each is how one of them ends up forgotten and produces a
   * chat with no tab. Mirroring the outcome covers all of them, including any
   * added later.
   */
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const knownSessionIds = useChatSessionsStore((state) => state.sessions);
  const openSession = useSessionTabsStore((state) => state.openSession);
  const pruneSessions = useSessionTabsStore((state) => state.pruneSessions);
  useEffect(() => {
    openSession(activeSessionId);
  }, [activeSessionId, openSession]);
  useEffect(() => {
    // Archived/closed sessions leave the list; their tabs must go with them, or
    // the strip renders a tab whose session cannot be resolved.
    pruneSessions(knownSessionIds.map((session) => session.id));
  }, [knownSessionIds, pruneSessions]);

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

  // U03-a (D02): TUI is the layout at its limit — dock + one full-bleed
  // terminal. The editor column collapses so the terminal owns everything right
  // of the dock. `presentationMode` stays in settings (untouched, so D19's
  // single-writer TUI handover is intact); this only suppresses the right
  // column while it is 'tui'.
  const isTui = presentationMode === 'tui';

  // D08: `sidebarUserCollapsed` is now derived, not stored — a collapsed dock
  // IS "no surface active". `panelOpen: false` retires the allocator's panel
  // term (see this component's doc note).
  const dockCollapsed = activeSurfaceId === null;
  const chrome = resolveShellChrome({
    sidebarUserCollapsed: dockCollapsed,
    panelOpen: false,
    manualChat,
    diffTabActive: !isTui && diffTabActive,
  });
  const chatVisible = isTui ? true : chrome.chatVisible;
  // TUI shows neither the editor nor a pending file intent's hidden column, so
  // the terminal (in the chat column) gets the whole center row.
  const editorAllocated = !isTui && editorOpen;

  const allocationInput = {
    shellWidth,
    sidebarWidth,
    sidebarCollapsed: chrome.sidebarCollapsed,
    chatVisible,
    editorOpen: editorAllocated,
    editorRatio,
    panelVisible: false,
    panelWidth: 0,
  };
  const allocation = resolveShellAllocation(allocationInput);

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
                // `hidden`, not an unmount: ChatWorkspace owns scroll position
                // and in-flight composer state.
                chatVisible ? 'flex' : 'hidden'
              )}
              style={chatVisible ? { width: 'var(--shell-chat-w)' } : undefined}
            >
              {/*
                D08: the center column's bar is the session tab strip, and it
                sits INSIDE the chat column rather than above chat ║ editor.
                The right column has its own file-tab bar, so a bar spanning
                both would put two bars on one column — the exact 「臃肿」 D07
                spent a round removing.
              */}
              <SessionTabs presentation={presentation} />
              <ChatWorkspace
                className="min-w-0 flex-1"
                onAddRepository={onAddRepository}
                presentation={presentation}
              />
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
            {!isTui && (editorOpen || fileIntentPending) && (
              <div
                className={cn(
                  editorOpen && expanded && 'absolute inset-0 z-20 bg-background',
                  editorOpen && !expanded && 'min-w-0 shrink-0',
                  !editorOpen && 'hidden'
                )}
                style={editorOpen && !expanded ? { width: 'var(--shell-editor-w)' } : undefined}
              >
                <EditorColumn expanded={expanded} onToggleExpanded={toggleExpanded} />
              </div>
            )}
          </div>
        </div>
      </div>

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
