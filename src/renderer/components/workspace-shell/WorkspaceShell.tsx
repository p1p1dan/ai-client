import { type Ref, useLayoutEffect, useRef, useState } from 'react';
import type { Repository } from '@/App/constants';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';
import { useI18n } from '@/i18n';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { ContextPanel } from './ContextPanel';
import { ContextPanelRail } from './ContextPanelRail';
import { LeftNav } from './LeftNav';
import { MainHeader } from './MainHeader';
import { ShellResizeHandle } from './ShellResizeHandle';
import { clampSidebarWidth, SIDEBAR_COLLAPSED_WIDTH } from './shellLayoutModel';
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

  useSyncChatWorkspaceTree({
    repositories,
    selectedRepoPath,
  });

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

      {/* Measured row: Main + ContextPanel only (not Sidebar/Rail) — fraction's denominator. */}
      <div ref={contentRowRef} className="relative flex min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <MainHeader
            contextPanelOpen={activeSurfaceId !== null}
            onToggleContextPanel={toggleContextPanel}
            readingWidthMode={readingWidthMode}
            onToggleReadingWidth={toggleReadingWidthMode}
          />
          <ChatWorkspace className="min-w-0 flex-1" onAddRepository={onAddRepository} />
        </div>
        <ContextPanel availableWidth={availableWidth} />
      </div>

      <ContextPanelRail />

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
