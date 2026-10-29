/**
 * Layout 5a (ui-cohesion §6, ruling L1): the sidebar — the chat list, and
 * nothing to switch it with.
 *
 * D08 made this the left dock: a 44px icon rail plus a panel that switched
 * five surfaces (chat list, git, files, context, run). The rail is gone. The
 * chat list is the sidebar's only content; git / files / context / run are
 * tabs of the work panel on the right (`PaneArea.tsx`). The rail's other
 * entries moved too:
 *   - Home → the chat list's own 「新对话」, which opens the home page;
 *   - collapse → this column's top row (and Ctrl+B); while collapsed, the
 *     title bar offers the expand button;
 *   - Settings → a small button at the end of the account row (the Capabilities
 *     button, a skill count, was removed: user 2026-10-29).
 *
 * Layout 5b: the top row is the screenshot's — collapse, then back / forward
 * over the conversations visited in this run (Alt+Left / Alt+Right,
 * `sidebar/useVisitHistory.ts`). The screenshot's leftmost app menu has no
 * counterpart here (the window menu is the title bar's), so it is left out.
 *
 * Collapsed means width 0: the column animates closed and turns inert. The
 * content keeps its committed width while the outer edge moves, so the list
 * is clipped by the animation instead of reflowing through it.
 */

import type { TempWorkspaceItem } from '@shared/types';
import { ArrowLeft, ArrowRight, PanelLeftClose, Settings } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { Repository } from '@/App/constants';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { LeftNav, type SidebarSearchEntry } from './LeftNav';
import { ShellResizeHandle } from './ShellResizeHandle';
import { clampSidebarWidth } from './shellLayoutModel';
import { keybindingLabel } from './sidebar/keybindingLabel';
import { useVisitHistory } from './sidebar/useVisitHistory';
import { UserFooterPill } from './UserFooterPill';
import { useWorkspaceRootPath } from './useWorkspaceRootPath';

interface LeftDockProps {
  /** Allocated sidebar width, straight from the allocator (0 while collapsed). */
  dockWidth: number;
  /** Committed sidebar width: the drag baseline and the content's width. */
  sidebarWidth: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCommitWidth: (width: number) => void;
  onDragFrame?: (width: number) => void;
  onResizingChange?: (resizing: boolean) => void;
  onOpenSettings?: () => void;
  /** Everything below is forwarded straight to the chat list (`LeftNav`). */
  repositories?: Repository[];
  onAddRepository?: () => void;
  onRemoveRepository?: (repoPath: string) => void;
  tempWorkspaces?: TempWorkspaceItem[];
  onRequestTempDelete?: (id: string) => void;
  /** Layout 5b: the nav's 「搜索」 — the shell's `useWorkspaceSearch().openSearch`. */
  onOpenSearch?: () => void;
}

/** The roving-tabindex stop of the chat list, else its first item. */
const CHAT_LIST_FOCUS_SELECTOR = '[data-sidebar-nav-key][tabindex="0"]';
const CHAT_LIST_FIRST_SELECTOR = '[data-sidebar-nav-key]';

export function LeftDock({
  dockWidth,
  sidebarWidth,
  collapsed,
  onToggleCollapsed,
  onCommitWidth,
  onDragFrame,
  onResizingChange,
  onOpenSettings,
  repositories = [],
  onAddRepository,
  onRemoveRepository,
  tempWorkspaces = [],
  onRequestTempDelete,
  onOpenSearch,
}: LeftDockProps) {
  const { t } = useI18n();
  const visits = useVisitHistory();
  // The global search runs over a workspace's files: with none (a home page
  // with no repository picked) the entry is disabled rather than inert.
  const searchRoot = useWorkspaceRootPath();
  const searchBinding = useSettingsStore((state) => state.searchKeybindings.searchFiles);
  const search: SidebarSearchEntry | undefined = onOpenSearch
    ? {
        onOpen: onOpenSearch,
        enabled: searchRoot !== null,
        shortcut: keybindingLabel(searchBinding, window.electronAPI.env.platform),
      }
    : undefined;
  const dockRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

  // Ctrl/Cmd+1 (`focusChatList`): the store has already expanded the column
  // in the same update, so by this effect it is no longer inert.
  const chatListFocusSeq = useShellLayoutStore((state) => state.chatListFocusSeq);
  const seenFocusSeq = useRef(chatListFocusSeq);
  useEffect(() => {
    if (chatListFocusSeq === seenFocusSeq.current) return;
    seenFocusSeq.current = chatListFocusSeq;
    const root = dockRef.current;
    const target =
      root?.querySelector<HTMLElement>(CHAT_LIST_FOCUS_SELECTOR) ??
      root?.querySelector<HTMLElement>(CHAT_LIST_FIRST_SELECTOR);
    target?.focus();
  }, [chatListFocusSeq]);

  // Round-13 (user report 14 — the white strip on the right edge): the column
  // reads the SAME CSS variable the center columns read, so a drag (which
  // repaints by writing `--shell-sidebar-w` on the shell root alone) moves
  // both sides of the boundary in one paint. The px fallback keeps
  // standalone mounts (tests) on the prop.
  const dockWidthVar = `var(--shell-sidebar-w, ${dockWidth}px)`;

  return (
    <div
      ref={dockRef}
      // Round-13: the same width transition the center row has, so a
      // collapse/expand animates both edges of the boundary in lockstep.
      className={cn(
        'relative h-full shrink-0 overflow-hidden bg-surface-0',
        'transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none'
      )}
      style={{ width: dockWidthVar }}
      inert={collapsed}
      aria-hidden={collapsed ? true : undefined}
      data-sidebar-collapsed={collapsed || undefined}
    >
      <nav
        aria-label={t('Primary navigation')}
        className="flex h-full min-w-0 flex-col border-r border-border-soft"
        // The committed width, not the animating one; during a drag the
        // painted variable instead, so the list follows the pointer.
        style={{ width: resizing ? '100%' : `${sidebarWidth}px` }}
      >
        {/* The window's top line with SessionBar (h-9): collapse, back,
            forward; the empty rest drags the frameless window. */}
        <div className="flex h-9 shrink-0 items-center gap-0.5 px-2 drag-region select-none">
          <SidebarIconButton
            label={`${t('Collapse sidebar')} (Ctrl+B)`}
            onClick={onToggleCollapsed}
          >
            <PanelLeftClose className="size-4" />
          </SidebarIconButton>
          <SidebarIconButton
            label={`${t('Go back')} (Alt+←)`}
            onClick={visits.goBack}
            disabled={!visits.canGoBack}
          >
            <ArrowLeft className="size-4" />
          </SidebarIconButton>
          <SidebarIconButton
            label={`${t('Go forward')} (Alt+→)`}
            onClick={visits.goForward}
            disabled={!visits.canGoForward}
          >
            <ArrowRight className="size-4" />
          </SidebarIconButton>
        </div>
        <div className="relative min-h-0 flex-1">
          <div className="absolute inset-0">
            <LeftNav
              repositories={repositories}
              onAddRepository={onAddRepository}
              onRemoveRepository={onRemoveRepository}
              tempWorkspaces={tempWorkspaces}
              onRequestTempDelete={onRequestTempDelete}
              search={search}
            />
          </div>
        </div>
        <UserFooterPill
          actions={
            <SidebarIconButton
              label={`${t('Settings')} (Ctrl+,)`}
              onClick={() => onOpenSettings?.()}
            >
              <Settings className="size-4" />
            </SidebarIconButton>
          }
        />
      </nav>

      {!collapsed && (
        <ShellResizeHandle
          side="right"
          ariaLabel={t('Resize sidebar')}
          width={sidebarWidth}
          targetRef={dockRef}
          clamp={clampSidebarWidth}
          onCommit={onCommitWidth}
          onDragFrame={onDragFrame}
          onResizingChange={(next) => {
            setResizing(next);
            onResizingChange?.(next);
          }}
        />
      )}
    </div>
  );
}

function SidebarIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top" sideOffset={6}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}
