/**
 * D08 (U15-a): the left dock — a 44px icon rail plus the panel it switches.
 *
 * This is the heir of `ContextPanel.tsx`, which held the same three mechanisms
 * on the RIGHT side of the shell: a surface switcher, a multi-mount keep-alive
 * stack, and a resize handle. Under D08 the surfaces live here and the right
 * column keeps only files, so the mechanisms moved with the surfaces rather
 * than being rewritten:
 *
 *   - the tab strip became the vertical icon rail (VSCode's activity bar),
 *   - the mount stack is carried over verbatim, including the `visibility:
 *     hidden` rule its comment explains (a `display: none` layer measures 0×0
 *     and permanently mangles xterm's pty wrapping),
 *   - the drag handle moved to the panel's right edge.
 *
 * What is NEW: the rail is permanent. `sidebarCollapsed` now hides the PANEL,
 * not the column, so the five entries are always one click away — which is the
 * whole reason the prototype's rail is icon-only and the panel carries a title
 * row (see `DockTitle`).
 */

import type { TempWorkspaceItem } from '@shared/types';
import { Blocks, PanelLeftClose, Settings } from 'lucide-react';
import { type Ref, useRef, useState } from 'react';
import type { Repository } from '@/App/constants';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useExtensionUiDisplayStore } from '@/stores/extensionUiDisplay';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { LeftNav } from './LeftNav';
import { derivePanelTabs, type PanelTab } from './panelTabsModel';
import { derivePluginInventory } from './pluginInventoryModel';
import { ShellResizeHandle } from './ShellResizeHandle';
import { SurfacePlaceholder } from './SurfacePlaceholder';
import {
  clampSidebarWidth,
  DOCK_RAIL_WIDTH,
  deriveMountedSurfaceIds,
  SURFACE_ESCAPE_HOLD_ATTR,
  seedVisitedSurfaceIds,
  shouldCloseOnEscape,
} from './shellLayoutModel';
import { SURFACE_ICON_MAP } from './surfaceIcons';
import { type ContextSurfaceId, getSurface } from './surfaceRegistry';
import { SURFACE_VIEWS } from './surfaceViews';
import { UserFooterPill } from './UserFooterPill';
import { useGitChangeCount } from './useGitChangeCount';
import { useSessionExtensions } from './useSessionExtensions';

interface LeftDockProps {
  /** Allocated TOTAL dock width (rail + panel), straight from the allocator. */
  dockWidth: number;
  /** Committed dock width, for the drag handle's starting value. */
  sidebarWidth: number;
  onCommitWidth: (width: number) => void;
  onDragFrame?: (width: number) => void;
  onResizingChange?: (resizing: boolean) => void;
  onOpenSettings?: () => void;
  /** Everything below is forwarded straight to the `chat` surface (`LeftNav`). */
  repositories?: Repository[];
  onAddRepository?: () => void;
  onRemoveRepository?: (repoPath: string) => void;
  tempWorkspaces?: TempWorkspaceItem[];
  onRequestTempDelete?: (id: string) => void;
  dockRef?: Ref<HTMLDivElement>;
}

export function LeftDock({
  dockWidth,
  sidebarWidth,
  onCommitWidth,
  onDragFrame,
  onResizingChange,
  onOpenSettings,
  repositories = [],
  onAddRepository,
  onRemoveRepository,
  tempWorkspaces = [],
  onRequestTempDelete,
  dockRef,
}: LeftDockProps) {
  const { t } = useI18n();

  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const lastSurfaceId = useShellLayoutStore((state) => state.lastSurfaceId);
  const railOrder = useShellLayoutStore((state) => state.railOrder);
  const selectSurface = useShellLayoutStore((state) => state.selectSurface);
  const closeSurface = useShellLayoutStore((state) => state.closeSurface);

  const changedFilesCount = useGitChangeCount();
  const tabs = derivePanelTabs(railOrder, { changedFilesCount });

  const [pluginsOpen, setPluginsOpen] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const [panelResizing, setPanelResizing] = useState(false);

  // The rail is permanent, so the panel gets whatever the allocator granted the
  // dock minus the rail. Floored at 0: a collapsed dock is allocated exactly
  // `SIDEBAR_COLLAPSED_RESERVE` (= the rail), which would otherwise arithmetic
  // its way to a negative width.
  const panelWidth = Math.max(0, dockWidth - DOCK_RAIL_WIDTH);
  const isOpen = panelWidth > 0 && activeSurfaceId !== null;
  // Carried over from `ContextPanel`: content stays mounted across close/open,
  // so anything with cross-toggle state survives the collapse.
  const contentSurfaceId = activeSurfaceId ?? lastSurfaceId;
  const descriptor = contentSurfaceId ? getSurface(contentSurfaceId) : undefined;

  // Visited set for `deriveMountedSurfaceIds`. A ref written during render
  // rather than state: the mount list must be correct in the SAME render that
  // activates a surface (state would mount it one commit late), and the write
  // is idempotent, so a StrictMode double-render is a no-op.
  const visitedSurfaceIdsRef = useRef<ContextSurfaceId[]>(
    seedVisitedSurfaceIds(lastSurfaceId, SURFACE_VIEWS)
  );
  if (activeSurfaceId && !visitedSurfaceIdsRef.current.includes(activeSurfaceId)) {
    visitedSurfaceIdsRef.current = [...visitedSurfaceIdsRef.current, activeSurfaceId];
  }
  const mountedSurfaceIds = deriveMountedSurfaceIds({
    visited: visitedSurfaceIdsRef.current,
    activeSurfaceId,
    lastSurfaceId,
    registrations: SURFACE_VIEWS,
  });

  // D08: `chat` is the one surface the registry cannot carry. Every other view
  // takes `{ surfaceId }` and nothing else, but the session list needs the
  // repository list and four App-owned callbacks (add/remove repo, temp-delete,
  // settings), so the dock renders it directly instead of through
  // `SURFACE_VIEWS`. That is also why the placeholder branch below has to
  // exclude it — an unregistered surface would otherwise read as "not wired".
  const isChatSurface = contentSurfaceId === 'chat';
  const contentRegistration = contentSurfaceId ? SURFACE_VIEWS[contentSurfaceId] : undefined;

  return (
    <div
      ref={dockRef}
      className="relative flex h-full shrink-0 bg-card/40"
      style={{ width: dockWidth }}
    >
      <nav
        aria-label={t('Primary navigation')}
        className="flex h-full shrink-0 flex-col items-center gap-0.5 border-r bg-card pt-1 pb-2"
        style={{ width: DOCK_RAIL_WIDTH }}
      >
        {tabs.map((tab) => (
          <RailButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeSurfaceId}
            onSelect={() => selectSurface(tab.id)}
          />
        ))}
        <div className="flex-1" />
        <RailIconButton label={t('Plugins')} icon={Blocks} onClick={() => setPluginsOpen(true)} />
        <RailIconButton
          label={`${t('Settings')} (Ctrl+,)`}
          icon={Settings}
          onClick={() => onOpenSettings?.()}
        />
      </nav>

      <div
        ref={panelRef}
        data-resizing={panelResizing || undefined}
        className={cn(
          'relative flex h-full min-w-0 flex-col overflow-hidden border-r',
          'transition-[width] duration-[250ms] data-[resizing]:transition-none',
          !isOpen && 'pointer-events-none'
        )}
        style={{ width: panelWidth }}
        inert={!isOpen}
        // Panel-scoped Escape, carried over from `ContextPanel`: a subtree
        // marked `data-surface-holds-escape` (a terminal running vim, Monaco's
        // find widget) opts out, and the dock then neither closes nor stops
        // propagation, so the key reaches the surface untouched.
        onKeyDownCapture={(event) => {
          const target = event.target as HTMLElement | null;
          const holdsEscape = !!target?.closest?.(`[${SURFACE_ESCAPE_HOLD_ATTR}]`);
          if (!shouldCloseOnEscape({ key: event.key, isOpen, holdsEscape })) {
            return;
          }
          closeSurface();
          event.stopPropagation();
        }}
      >
        {descriptor && (
          <>
            <DockTitle labelKey={descriptor.labelKey} onCollapse={closeSurface} />
            <div className="relative isolate min-h-0 flex-1">
              {/*
                Multi-mount stack, carried over from `ContextPanel` unchanged.
                Hidden layers use `invisible pointer-events-none` + `inert`,
                NEVER `display: none`, `hidden` or a conditional unmount:
                `visibility: hidden` keeps the layout box, so a hidden layer
                still measures the panel's real width, while a display-hidden
                box measures 0×0 — and xterm's `FitAddon` runs off a
                ResizeObserver that `useXterm` does not zero-guard, so it
                forwards that measurement to the pty as `cols: 2` and
                permanently mangles the wrapping of whatever is running in it.
              */}
              {mountedSurfaceIds.map((id) => {
                const registration = SURFACE_VIEWS[id];
                if (!registration) {
                  return null;
                }
                const SurfaceView = registration.component;
                const visible = id === contentSurfaceId;
                return (
                  <div
                    key={id}
                    className={cn(
                      'absolute inset-0',
                      visible ? 'z-10' : 'invisible pointer-events-none z-0'
                    )}
                    inert={!visible}
                  >
                    <SurfaceView surfaceId={id} />
                  </div>
                );
              })}
              {isChatSurface && (
                <div className="absolute inset-0 z-10">
                  <LeftNav
                    repositories={repositories}
                    onAddRepository={onAddRepository}
                    onRemoveRepository={onRemoveRepository}
                    tempWorkspaces={tempWorkspaces}
                    onRequestTempDelete={onRequestTempDelete}
                  />
                </div>
              )}
              {!contentRegistration && !isChatSurface && (
                <div className="absolute inset-0">
                  <SurfacePlaceholder surface={descriptor} />
                </div>
              )}
            </div>
            <UserFooterPill />
          </>
        )}

        {isOpen && (
          <ShellResizeHandle
            side="right"
            ariaLabel={t('Resize sidebar')}
            width={sidebarWidth}
            targetRef={panelRef}
            clamp={clampSidebarWidth}
            onCommit={onCommitWidth}
            onDragFrame={onDragFrame}
            onResizingChange={(next) => {
              setPanelResizing(next);
              onResizingChange?.(next);
            }}
          />
        )}
      </div>

      <PluginsDialog open={pluginsOpen} onOpenChange={setPluginsOpen} />
    </div>
  );
}

/**
 * The panel's h-9 title row.
 *
 * Not decoration: the rail is icon-only (the user rejected labelled icons —
 * 「不行好丑」), so this row is the only place the current section names itself.
 * It is also what keeps the three columns' bars on one horizontal rule, which
 * D07 decision two established and D08 keeps.
 */
function DockTitle({ labelKey, onCollapse }: { labelKey: string; onCollapse: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <span className="min-w-0 flex-1 truncate text-meta font-semibold tracking-[0.02em]">
        {t(labelKey)}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="h-5 w-5 shrink-0"
        aria-label={t('Collapse sidebar')}
        title={`${t('Collapse sidebar')} (Ctrl+B)`}
        onClick={onCollapse}
      >
        <PanelLeftClose className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

interface RailButtonProps {
  tab: PanelTab;
  active: boolean;
  onSelect: () => void;
}

function RailButton({ tab, active, onSelect }: RailButtonProps) {
  const { t } = useI18n();
  const Icon = SURFACE_ICON_MAP[tab.icon];

  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <button
            type="button"
            aria-label={t(tab.labelKey)}
            aria-pressed={active}
            onClick={onSelect}
            className={cn(
              'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
              active
                ? 'bg-selection text-foreground'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground'
            )}
          />
        }
      >
        {/* The active marker is a left rule, VSCode's own idiom. It sits on the
            rail's edge rather than the button's so it reads as "this column is
            showing X", not "this button is pressed". */}
        {active && (
          <span
            aria-hidden
            className="absolute top-1.5 bottom-1.5 -left-1.5 w-0.5 rounded-full bg-primary"
          />
        )}
        <Icon className="h-4.5 w-4.5" />
        {tab.showDot && (
          <span aria-hidden className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-info" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="right" sideOffset={8}>
        <p className="font-medium">{t(tab.labelKey)}</p>
        <p className="text-muted-foreground">{t(tab.descriptionKey)}</p>
      </TooltipPopup>
    </Tooltip>
  );
}

function RailIconButton({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: typeof Blocks;
  onClick: () => void;
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
          />
        }
      >
        <Icon className="h-4.5 w-4.5" />
      </TooltipTrigger>
      <TooltipPopup side="right" sideOffset={8}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * U04's plugin inventory dialog, moved here with its entry point: the button
 * used to sit in `LeftNav`'s footer, which D08 replaced with the rail's bottom
 * group. The inventory itself is unchanged — still "what this session's worker
 * actually loaded" (D06), and `null` (nobody reported) still reads differently
 * from `[]` (reported, loaded nothing).
 */
function PluginsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const { extensions: sessionExtensions } = useSessionExtensions(activeSessionId);
  const extensionStatuses = useExtensionUiDisplayStore((state) => state.statuses);
  const inventory = derivePluginInventory({
    extensions: sessionExtensions,
    statuses: extensionStatuses,
    sessionId: activeSessionId,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Blocks className="h-4 w-4" />
            {t('Plugins')}
          </DialogTitle>
          <DialogDescription>
            {/* Says whose plugins these are. The list is per session because pi
                resolves project-scoped extensions from the session's cwd — an
                app-wide list would be wrong for any second workspace. */}
            {t('Extensions loaded for the active chat.')}
          </DialogDescription>
        </DialogHeader>
        {inventory.mcp && (
          <div className="flex h-7 items-center gap-2 rounded-md bg-muted px-2">
            <span className="shrink-0 text-meta text-muted-foreground">{t('MCP servers')}</span>
            <span className="min-w-0 flex-1 truncate text-right text-ui tabular-nums">
              {inventory.mcp.detail}
            </span>
          </div>
        )}
        <div className="flex max-h-80 flex-col overflow-y-auto">
          {!inventory.reported ? (
            // Not "no plugins": nothing has been asked yet, because this chat
            // has no running worker to have loaded any.
            <p className="px-1 py-2 text-meta text-muted-foreground">
              {t('Send a message to start this chat and see what it loads.')}
            </p>
          ) : inventory.plugins.length === 0 ? (
            <p className="px-1 py-2 text-meta text-muted-foreground">
              {t('This chat loaded no plugins.')}
            </p>
          ) : (
            inventory.plugins.map((plugin) => (
              <div key={plugin.path} className="flex flex-col px-1 py-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ui" title={plugin.path}>
                    {plugin.name}
                  </span>
                  {plugin.scope && (
                    <Badge variant="outline" size="sm" className="shrink-0">
                      {plugin.scope}
                    </Badge>
                  )}
                  {!plugin.ok && (
                    <Badge variant="error" size="sm" className="shrink-0">
                      {t('Failed')}
                    </Badge>
                  )}
                </div>
                <span className="truncate text-meta text-muted-foreground" title={plugin.path}>
                  {plugin.error ?? plugin.source ?? plugin.path}
                </span>
              </div>
            ))
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
