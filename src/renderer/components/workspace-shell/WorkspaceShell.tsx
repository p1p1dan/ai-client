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
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { isDiffTabActive } from '@/stores/diffTabTarget';
import { useEditorStore } from '@/stores/editor';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useSettingsStore } from '@/stores/settings';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { ContextPanel } from './ContextPanel';
import { EditorColumn } from './center/EditorColumn';
import {
  chatWidthToEditorRatio,
  deriveEditorOpen,
  maxPanelWidth,
  resolveShellAllocation,
  resolveShellChrome,
  type ShellAllocation,
} from './centerLayoutModel';
import { LeftNav } from './LeftNav';
import { MainHeader } from './MainHeader';
import { ShellResizeHandle } from './ShellResizeHandle';
import { CONTEXT_PANEL_DEFAULT_WIDTH, clampSidebarWidth } from './shellLayoutModel';
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
  /** Temp session items (App's `useTempWorkspaceStore`), threaded down to LeftNav
   * so it can map a Temp folder row to the item its delete button targets. */
  tempWorkspaces?: TempWorkspaceItem[];
  /** Opens the shared `TempWorkspaceDialogs` delete confirmation (App's
   * `useTempWorkspaceStore.openDelete`), same as the legacy shell's `onRequestTempDelete`. */
  onRequestTempDelete?: (id: string) => void;
}

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

  const sidebarCollapsed = useShellLayoutStore((state) => state.sidebarCollapsed);
  const sidebarWidth = useShellLayoutStore((state) => state.sidebarWidth);
  const toggleSidebarCollapsed = useShellLayoutStore((state) => state.toggleSidebarCollapsed);
  const setSidebarWidth = useShellLayoutStore((state) => state.setSidebarWidth);
  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const toggleContextPanel = useShellLayoutStore((state) => state.toggleContextPanel);
  const readingWidthMode = useShellLayoutStore((state) => state.readingWidthMode);
  const toggleReadingWidthMode = useShellLayoutStore((state) => state.toggleReadingWidthMode);

  const panelWidth = useShellLayoutStore((state) => state.panelWidth);
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
  // Primitive selector (boolean), same discipline as `editorOpen` above.
  const diffTabActive = useEditorStore((state) => isDiffTabActive(state.tabs, state.activeTabPath));
  // Round-10 ⑥: primitive selector — mounts the intent consumer (below) even
  // before any tab exists. See the EditorColumn wrapper comment.
  const fileIntentPending = useFileOpenIntentStore((state) => state.intent !== null);

  // Round-11: the center row's width is ALLOCATED, not measured — the
  // ResizeObserver that used to feed it is gone. It lagged a frame, and lagged
  // for the whole 250ms while the panel animated; that lag is what forced the
  // shrinkable `flexBasis` hack on the chat column and still let chat get
  // pushed into the panel (m-T32). Deriving the width from `shellWidth`
  // instead makes it correct in the same commit the panel opens.
  const centerRowRef = useRef<HTMLDivElement>(null);
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const [centerResizing, setCenterResizing] = useState(false);

  const temporaryWorkspaceEnabled = useSettingsStore((state) => state.temporaryWorkspaceEnabled);
  useSyncChatWorkspaceTree({
    repositories,
    selectedRepoPath,
    temporaryWorkspaceEnabled,
  });

  // A08: global shell shortcuts (Ctrl/Cmd+J/1-4/`/B). Only live while this
  // component is mounted, i.e. only for the new shell.
  useShellShortcuts();

  // m7: per-workspace editor tab isolation. Must live somewhere ALWAYS mounted
  // — see the hook for the deadlock that put it here.
  useEditorWorktreeSync();

  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  // Lifted out of ContextPanel: a panel drag re-lays every column, so the
  // transition kill-switch has to live on the shell root (see `data-resizing`).
  const [panelResizing, setPanelResizing] = useState(false);

  // The allocator budgets the WHOLE shell (the sidebar is one of the columns
  // it satisfies first), which `contentRowRef` deliberately excludes.
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

  // Sole measurement point for the Main+ContextPanel row (decision 9). Since
  // round-11 only two things need it: the EXPANDED panel overlay (which takes
  // the real row width) and the panel drag's clamp.
  const contentRowRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = contentRowRef.current;
    if (!el) {
      return;
    }
    // First frame's clientWidth can be 0 before layout settles; treat <= 0 as
    // "not measured yet" so the panel falls back to its fixed default width
    // instead of momentarily collapsing to 0 (risk §6.3).
    setAvailableWidth(el.clientWidth || null);

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setAvailableWidth(width > 0 ? width : null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Round-11 (user ruling 2026-08-05): visibility is the user's, verbatim —
  // no width, no threshold and no "intent" can flip a column any more. Both
  // the T-32 ladder and round-10's `ChromeIntent` are deleted; see
  // `centerLayoutModel.ts`'s OVERTURNED DESIGN note for why. This stays the
  // single derivation point (R1) and is handed down; nobody re-derives it.
  // D35 round 2 adds `diffTabActive` as the one deliberate exception — see
  // `resolveShellChrome`'s doc note on that field.
  const chrome = resolveShellChrome({
    sidebarUserCollapsed: sidebarCollapsed,
    panelOpen: activeSurfaceId !== null,
    manualChat,
    diffTabActive,
  });
  const { panelVisible, chatVisible } = chrome;

  // Widths come from one allocator so the columns cannot disagree about who
  // owns which pixel: sidebar and chat are satisfied first, and whatever does
  // not fit hangs off the right edge for the row's `overflow-clip` to cut.
  const allocationInput = {
    shellWidth,
    sidebarWidth,
    sidebarCollapsed: chrome.sidebarCollapsed,
    chatVisible,
    editorOpen,
    editorRatio,
    panelVisible,
    // D34: the fallback is the 380 DEFAULT, not the (now 250) MIN — "no
    // persisted panelWidth yet" must still land on A08's default, same as
    // `resolveContextPanelWidth`'s fallback in shellLayoutModel.ts.
    panelWidth: panelWidth ?? CONTEXT_PANEL_DEFAULT_WIDTH,
  };
  const allocation = resolveShellAllocation(allocationInput);

  /**
   * Round-12 (drag performance). Every column's width is published as a CSS
   * custom property on the shell root, and the columns read them
   * (`width: var(--shell-chat-w)`). React sets them on commit; a drag sets the
   * SAME properties directly on the root node, from the SAME pure model, so
   * the two paths cannot disagree and a drag costs zero React renders.
   *
   * Why variables rather than per-column refs: the allocator couples the
   * columns (widening the panel narrows the center row, which re-splits chat
   * and the editor). Painting that through refs means four `style.width`
   * writes on four nodes per frame; through variables it is one write target
   * and the browser propagates. It also keeps the drag correct by
   * construction — no column can be forgotten.
   */
  const shellVars = useMemo(
    () =>
      ({
        '--shell-sidebar-w': `${allocation.sidebarWidth}px`,
        '--shell-center-w': `${allocation.centerWidth}px`,
        '--shell-chat-w': `${allocation.chatWidth}px`,
        '--shell-editor-w': `${allocation.editorWidth}px`,
        '--shell-panel-w': `${allocation.panelWidth}px`,
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
    root.style.setProperty('--shell-panel-w', `${next.panelWidth}px`);
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
        resolveShellAllocation({ ...allocationInputRef.current, panelWidth: nextPanelWidth })
      );
    },
    [paintAllocation]
  );
  // Drag-only cap: past this, widening the panel moves nothing on screen
  // because chat/the editor have bottomed out — see `maxPanelWidth`.
  const panelWidthCap = maxPanelWidth({
    shellWidth,
    sidebarWidth: allocation.sidebarWidth,
    editorOpen,
    chatVisible,
  });

  // A08 §06-4: the overrides were scoped to the open file, so closing it
  // clears them. Guarded on the current values so this only writes on the
  // closing edge, not on every render with no file open.
  useEffect(() => {
    if (!editorOpen && (manualPanel !== null || manualChat !== null)) {
      clearManualOverrides();
    }
  }, [editorOpen, manualPanel, manualChat, clearManualOverrides]);

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
      data-resizing={sidebarResizing || panelResizing || centerResizing || undefined}
      // The columns read these; a drag rewrites them on this node alone.
      style={shellVars}
      className="group/shell relative flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background"
    >
      {/* Left column: width + data-resizing live on this wrapper; LeftNav only writes w-full. */}
      <div
        ref={sidebarRef}
        // Round-12: the transition is disabled from the SHELL ROOT's
        // `data-resizing`, not this node's own — a panel drag re-lays the
        // sidebar's neighbours too, and a column still animating while another
        // is being dragged is exactly the lag the user reported.
        className="relative flex h-full shrink-0 transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none"
        style={{ width: 'var(--shell-sidebar-w)' }}
      >
        <LeftNav
          collapsed={chrome.sidebarCollapsed}
          onToggleCollapsed={toggleSidebarCollapsed}
          onOpenSettings={onOpenSettings}
          onAddRepository={onAddRepository}
          onRemoveRepository={onRemoveRepository}
          repositories={repositories}
          tempWorkspaces={tempWorkspaces}
          onRequestTempDelete={onRequestTempDelete}
        />
        {!chrome.sidebarCollapsed && (
          <ShellResizeHandle
            side="right"
            ariaLabel={t('Resize sidebar')}
            width={sidebarWidth}
            targetRef={sidebarRef}
            clamp={clampSidebarWidth}
            onCommit={setSidebarWidth}
            onDragFrame={paintSidebarDrag}
            onResizingChange={setSidebarResizing}
          />
        )}
      </div>

      {/*
        T-32 (D27): everything right of the sidebar is one column now, so the
        header can span chat + panel + rail instead of sitting inside the chat
        column (A08「顶栏贯通中右」, a08:1078-1079). The measured row below it is
        unchanged — still Main + ContextPanel only, with the rail OUTSIDE it, so
        `availableWidth` keeps meaning "how wide the panel may get" and the
        fraction math from T-22 needs no adjustment.
      */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <MainHeader
          contextPanelOpen={panelVisible}
          onToggleContextPanel={toggleContextPanel}
          readingWidthMode={readingWidthMode}
          onToggleReadingWidth={toggleReadingWidthMode}
        />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/*
            Round-11: THE clip boundary. `overflow-clip`, not `overflow-hidden`
            — hidden is still a scroll container, so focusing something inside
            the clipped-off panel would scroll the whole row sideways and drag
            chat off screen. Clip cannot scroll at all, which is exactly the
            「无横向滚动条」 the ruling asks for. Every child below carries an
            explicit width and `shrink-0`: a child allowed to shrink would
            absorb the overflow instead of letting the edge cut it, which is
            the entire mechanism.
          */}
          <div ref={contentRowRef} className="relative flex min-w-0 flex-1 overflow-clip">
            {/*
              T-32: chat ║ editor (a08:1208-1241). With no file open the editor
              column returns null and chat keeps `flex-1`, so the shell is
              byte-for-byte the pre-T-32 layout until something is opened.
            */}
            <div
              ref={centerRowRef}
              className="relative flex shrink-0 overflow-clip transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none"
              style={{ width: 'var(--shell-center-w)' }}
            >
              <div
                ref={chatColumnRef}
                data-resizing={centerResizing || undefined}
                className={cn(
                  'relative min-w-0 shrink-0 flex-col',
                  // `hidden`, not an unmount: ChatWorkspace owns scroll
                  // position and in-flight composer state, and the editor's
                  // "hide chat" toggle is a round trip the user makes often.
                  chatVisible ? 'flex' : 'hidden'
                )}
                // Round-11: back to a hard width. The shrinkable `flexBasis`
                // this replaces existed only to survive the measurement lag
                // that m-T32 hit (「聊天页面和右侧页面的叠加」) — an allocated
                // width has no lag to survive, and shrinkability is now the
                // one thing that would break clipping: a chat column that can
                // give would absorb the overflow instead of letting the panel
                // run off the edge, which is precisely the squeeze the user
                // ruled out.
                style={chatVisible ? { width: 'var(--shell-chat-w)' } : undefined}
              >
                <ChatWorkspace className="min-w-0 flex-1" onAddRepository={onAddRepository} />
                {editorOpen && chatVisible && (
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
                m6 (user round 2): this wrapper used to render unconditionally.
                `EditorColumn` returns null with no file open, but the `flex-1`
                box around it still claimed half the center row — so chat was
                laid out at half width while LOOKING full width (the empty box
                has no background), squeezing the composer to ~355px and
                wrapping the target bar. No editor, no box.

                Round-10 inspection ⑥: m6's editorOpen-only mount recreated the
                deadlock its own m7 note warns about — EditorColumn is the ONLY
                fileOpenIntent consumer, so with zero tabs open a tool-row /
                mention-chip file click had no consumer at all and silently
                did nothing. A pending intent now mounts the column too, in a
                `hidden` wrapper (no layout claim — m6's actual complaint —
                and effects still run): the intent effect opens the tab,
                `editorOpen` flips, and the wrapper becomes the flex-1 box.
              */}
              {(editorOpen || fileIntentPending) && (
                <div
                  className={editorOpen ? 'min-w-0 shrink-0' : 'hidden'}
                  style={editorOpen ? { width: 'var(--shell-editor-w)' } : undefined}
                >
                  {/* D35: `EditorColumn`'s hide-chat head button retired —
                      see EditorColumn.tsx's `headerActions` doc note. */}
                  <EditorColumn />
                </div>
              )}
            </div>
            <ContextPanel
              availableWidth={availableWidth}
              maxDockedWidth={panelWidthCap}
              visible={panelVisible}
              allocatedWidth={allocation.panelWidth}
              onDragFrame={paintPanelDrag}
              onResizingChange={setPanelResizing}
            />
          </div>
          {/*
            D34 (overturns round-12's "rail is permanent"): the vertical
            switcher retired — its four icons moved into `MainHeader`, to the
            left of the collapse toggle. Nothing replaces it here; the row
            that used to reserve its 44px now goes straight to the panel/chat
            (see `centerLayoutModel.ts`'s `RAIL_RESERVE`).
          */}
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
