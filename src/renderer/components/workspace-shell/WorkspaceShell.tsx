import { type Ref, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Repository } from '@/App/constants';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useEditorStore } from '@/stores/editor';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { ContextPanel } from './ContextPanel';
import { ContextPanelRail } from './ContextPanelRail';
import { EditorColumn } from './center/EditorColumn';
import {
  chatWidthToEditorRatio,
  deriveChatVisible,
  deriveEditorOpen,
  derivePanelVisible,
  resolveChatColumnWidth,
  resolveShellLevel,
} from './centerLayoutModel';
import { LeftNav } from './LeftNav';
import { MainHeader } from './MainHeader';
import { ShellResizeHandle } from './ShellResizeHandle';
import { clampSidebarWidth, deriveRailVisible, SIDEBAR_COLLAPSED_WIDTH } from './shellLayoutModel';
import { useShellShortcuts } from './useShellShortcuts';
import { useSyncChatWorkspaceTree } from './useSyncChatWorkspaceTree';

interface WorkspaceShellProps {
  onOpenSettings?: () => void;
  repositories?: Repository[];
  selectedRepoPath?: string | null;
  /** T-24: opens the shared AddRepositoryDialog mounted in App. */
  onAddRepository?: () => void;
  /**
   * T-24: drop zone for `useFileDragDrop`. Legacy binds this ref to its
   * repository sidebar; in the new shell the whole shell body is the target,
   * otherwise folder drops are swallowed with no feedback at all.
   */
  dropZoneRef?: Ref<HTMLDivElement>;
  fileDragOver?: boolean;
}

export function WorkspaceShell({
  onOpenSettings,
  repositories = [],
  selectedRepoPath = null,
  onAddRepository,
  dropZoneRef,
  fileDragOver = false,
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

  const editorRatio = useShellLayoutStore((state) => state.editorRatio);
  const setEditorRatio = useShellLayoutStore((state) => state.setEditorRatio);

  const manualPanel = useShellLayoutStore((state) => state.manualPanel);
  const manualChat = useShellLayoutStore((state) => state.manualChat);
  const setManualChat = useShellLayoutStore((state) => state.setManualChat);
  const clearManualOverrides = useShellLayoutStore((state) => state.clearManualOverrides);

  // T-32: a file being open is what makes the center row two columns.
  const editorOpen = deriveEditorOpen(useEditorStore((state) => state.tabs).length);

  const centerRowRef = useRef<HTMLDivElement>(null);
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const [centerWidth, setCenterWidth] = useState<number | null>(null);
  const [centerResizing, setCenterResizing] = useState(false);

  // Measured separately from `contentRowRef`: that one is chat+editor+panel
  // (the panel's width budget), this one is chat+editor (the grip's budget).
  // Deriving one from the other would need the panel's animated width, which
  // is exactly the mid-transition value the T-22 batch-3 fix avoids reading.
  useLayoutEffect(() => {
    const el = centerRowRef.current;
    if (!el) {
      return;
    }
    setCenterWidth(el.clientWidth || null);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setCenterWidth(width > 0 ? width : null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const chatWidth = resolveChatColumnWidth({ centerWidth: centerWidth ?? 0, editorRatio });

  useSyncChatWorkspaceTree({
    repositories,
    selectedRepoPath,
  });

  // A08: global shell shortcuts (Ctrl/Cmd+J/1-4/`/B). Only live while this
  // component is mounted, i.e. only for the new shell.
  useShellShortcuts();

  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarResizing, setSidebarResizing] = useState(false);

  // Sole measurement point for the Main+ContextPanel row (decision 9): feeds
  // `availableWidth` into ContextPanel's fraction/clamp math.
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

  // T-32 S4: `activeSurfaceId !== null` is INTENT ("the user wants the panel"),
  // which the ladder must never write — otherwise widening the window could
  // not restore what it auto-collapsed. Visibility is composed here, once, and
  // handed down; no other component re-derives it (spec §5, R1).
  const level = resolveShellLevel({ contentWidth: availableWidth, editorOpen });
  const panelVisible = derivePanelVisible({
    level,
    editorOpen,
    panelOpen: activeSurfaceId !== null,
    manualPanel,
  });
  const chatVisible = deriveChatVisible({ level, editorOpen, manualChat });
  const railVisible = deriveRailVisible({ panelVisible });

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
      ref={dropZoneRef}
      className="relative flex h-full min-h-0 w-full flex-1 overflow-hidden bg-background"
    >
      {/* Left column: width + data-resizing live on this wrapper; LeftNav only writes w-full. */}
      <div
        ref={sidebarRef}
        data-resizing={sidebarResizing || undefined}
        className="relative flex h-full shrink-0 transition-[width] duration-[250ms] data-[resizing]:transition-none"
        style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth }}
      >
        <LeftNav
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebarCollapsed}
          onOpenSettings={onOpenSettings}
          onAddRepository={onAddRepository}
        />
        {!sidebarCollapsed && (
          <ShellResizeHandle
            side="right"
            ariaLabel={t('Resize sidebar')}
            width={sidebarWidth}
            targetRef={sidebarRef}
            clamp={clampSidebarWidth}
            onCommit={setSidebarWidth}
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
          <div ref={contentRowRef} className="relative flex min-w-0 flex-1 overflow-hidden">
            {/*
              T-32: chat ║ editor (a08:1208-1241). With no file open the editor
              column returns null and chat keeps `flex-1`, so the shell is
              byte-for-byte the pre-T-32 layout until something is opened.
            */}
            <div ref={centerRowRef} className="relative flex min-w-0 flex-1 overflow-hidden">
              <div
                ref={chatColumnRef}
                data-resizing={centerResizing || undefined}
                className={cn(
                  'relative min-w-0 flex-col',
                  // `hidden`, not an unmount: ChatWorkspace owns scroll position
                  // and in-flight composer state that must survive an L2 dip.
                  chatVisible ? 'flex' : 'hidden',
                  editorOpen ? 'shrink-0' : 'flex-1'
                )}
                style={editorOpen && chatVisible ? { width: chatWidth } : undefined}
              >
                <ChatWorkspace className="min-w-0 flex-1" onAddRepository={onAddRepository} />
                {editorOpen && chatVisible && (
                  <ShellResizeHandle
                    side="right"
                    ariaLabel={t('Resize chat column')}
                    width={chatWidth}
                    targetRef={chatColumnRef}
                    clamp={(candidate) =>
                      resolveChatColumnWidth({
                        centerWidth: centerWidth ?? 0,
                        editorRatio: chatWidthToEditorRatio({
                          chatWidth: candidate,
                          centerWidth: centerWidth ?? 0,
                        }),
                      })
                    }
                    onCommit={(next) =>
                      setEditorRatio(
                        chatWidthToEditorRatio({ chatWidth: next, centerWidth: centerWidth ?? 0 })
                      )
                    }
                    onResizingChange={setCenterResizing}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <EditorColumn
                  chatVisible={chatVisible}
                  onHideChat={() => setManualChat(!chatVisible)}
                />
              </div>
            </div>
            <ContextPanel availableWidth={availableWidth} visible={panelVisible} />
          </div>
          {/* A08「展开时右缘无图标」: the rail is the collapsed-state switcher only. */}
          {railVisible && <ContextPanelRail />}
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
