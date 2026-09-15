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
 * row (see `DockTitle`), and why H/18 S4 moved the collapse toggle onto the
 * rail: it is the half of the dock that is always there to click.
 */

import type { TempWorkspaceItem } from '@shared/types';
import { Blocks, PanelLeftClose, PanelLeftOpen, Settings } from 'lucide-react';
import { type Ref, useRef, useState } from 'react';
import type { Repository } from '@/App/constants';
import { Badge } from '@/components/ui/badge';
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
import { useShellLayoutStore } from '@/stores/shellLayout';
import { LeftNav } from './LeftNav';
import { derivePanelTabs, type PanelTab } from './panelTabsModel';
import { ShellResizeHandle } from './ShellResizeHandle';
import { SurfacePlaceholder } from './SurfacePlaceholder';
import { deriveSessionCapabilities } from './sessionCapabilityModel';
import {
  clampSidebarWidth,
  DOCK_RAIL_WIDTH,
  deriveMountedSurfaceIds,
  ESCAPE_OWNING_POPUP_SELECTOR,
  SURFACE_ESCAPE_HOLD_ATTR,
  seedVisitedSurfaceIds,
  shouldCloseOnEscape,
} from './shellLayoutModel';
import { SURFACE_ICON_MAP } from './surfaceIcons';
import { type ContextSurfaceId, getSurface } from './surfaceRegistry';
import { SURFACE_VIEWS, type SurfaceViewProps } from './surfaceViews';
import { UserFooterPill } from './UserFooterPill';
import { useGitChangeCount } from './useGitChangeCount';
import { useSessionCapabilities } from './useSessionCapabilities';

interface LeftDockProps {
  /** Allocated TOTAL dock width (rail + panel), straight from the allocator. */
  dockWidth: number;
  /** Committed dock width, for the drag handle's starting value. */
  sidebarWidth: number;
  onCommitWidth: (width: number) => void;
  onDragFrame?: (width: number) => void;
  onResizingChange?: (resizing: boolean) => void;
  onOpenSettings?: () => void;
  onSearch?: SurfaceViewProps['onSearch'];
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
  onSearch,
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
  // S4 (H/18): the rail's collapse control TOGGLES, where the title row's used
  // to only close. On the rail it has to — the rail outlives the panel, so a
  // button that could only close would be dead half the time it is on screen.
  // Same action Ctrl+B runs (`useShellShortcuts` → `toggle-dock`), so the two
  // cannot drift into meaning different things.
  const toggleDock = useShellLayoutStore((state) => state.toggleContextPanel);

  const changedFilesCount = useGitChangeCount();
  const tabs = derivePanelTabs(railOrder, { changedFilesCount });

  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);

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
        className="flex h-full shrink-0 flex-col items-center gap-0.5 border-r bg-card pb-2"
        style={{ width: DOCK_RAIL_WIDTH }}
      >
        {/* U27: the rail starts BELOW the title row, not at the window's top
            edge. Every other column in this shell opens with an `h-9` bar (the
            panel's own `DockTitle`, the center's `SessionBar`, the editor's tab
            strip), so a rail running the full height put its first icon on a
            line of its own and nothing else lined up with it.

            A spacer of the same `h-9` rather than a padding value: it is the
            title row's height that this has to track, and reading it from the
            same token is what keeps the two in step if that row ever changes.
            The rail's old `pt-1` is dropped — with the spacer it would push the
            icons 4px below the content they are meant to align with. */}
        <div aria-hidden className="h-9 shrink-0" />
        {tabs.map((tab) => (
          <RailButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeSurfaceId}
            onSelect={() => selectSurface(tab.id)}
          />
        ))}
        <div className="flex-1" />
        {/* S4: the panel's collapse control lives here now, not on the title
            row it used to share with the section name. The rail is the part
            that never goes away, so this is the only place the button can sit
            and still be there to bring the panel BACK. The icon states which
            way it will go. */}
        <RailIconButton
          label={`${isOpen ? t('Collapse sidebar') : t('Expand sidebar')} (Ctrl+B)`}
          icon={isOpen ? PanelLeftClose : PanelLeftOpen}
          onClick={toggleDock}
        />
        <RailIconButton
          label={t('Capabilities')}
          icon={Blocks}
          onClick={() => setCapabilitiesOpen(true)}
        />
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
          // Queried on the document, not on the target's ancestors: a popup is
          // portaled out of this panel, so `closest` can never find it.
          const popupOpen = !!document.querySelector(ESCAPE_OWNING_POPUP_SELECTOR);
          if (!shouldCloseOnEscape({ key: event.key, isOpen, holdsEscape, popupOpen })) {
            return;
          }
          closeSurface();
          event.stopPropagation();
        }}
      >
        {descriptor && (
          <>
            <DockTitle labelKey={descriptor.labelKey} />
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
                    <SurfaceView surfaceId={id} onSearch={onSearch} />
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

      <CapabilitiesDialog open={capabilitiesOpen} onOpenChange={setCapabilitiesOpen} />
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
 *
 * S4 (H/18) took the collapse button off this row and put it on the rail. The
 * row is gone the moment the panel closes, so the button that closed it went
 * with it and only Ctrl+B could bring it back.
 */
function DockTitle({ labelKey }: { labelKey: string }) {
  const { t } = useI18n();
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <span className="min-w-0 flex-1 truncate text-meta font-semibold tracking-[0.02em]">
        {t(labelKey)}
      </span>
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
 * T026 — what the active chat's own runtime brought up, with its entry point.
 *
 * This used to be U04's pi extension inventory. P6-5 retired the engine that
 * loaded pi extensions, which left the panel reporting "0 plugins" for every
 * session while the MCP servers, skills and sub-agents the session really had
 * went unmentioned (cutover-03). It now projects those instead, straight off
 * the bootstrap result — and says where installed pi extensions DO apply, which
 * is the built-in terminal.
 *
 * `null` (nobody reported) still reads differently from `0` (reported none):
 * see `sessionCapabilityModel`.
 */
function CapabilitiesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const { capabilities } = useSessionCapabilities(activeSessionId);
  const view = deriveSessionCapabilities(capabilities);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Blocks className="h-4 w-4" />
            {t('Capabilities')}
          </DialogTitle>
          <DialogDescription>
            {/* Per session because every one of these is resolved from the
                session's own working directory and settings — an app-wide list
                would be wrong for any second workspace. */}
            {t('MCP servers, skills and sub-agents this chat brought up.')}
          </DialogDescription>
        </DialogHeader>
        {!view.reported ? (
          // Not "nothing": nothing has been asked yet, because this chat has no
          // running worker to have brought anything up.
          <p className="px-1 py-2 text-meta text-muted-foreground">
            {t('Send a message to start this chat and see what it brings up.')}
          </p>
        ) : (
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            <CapabilityRow
              label={t('MCP servers')}
              value={
                view.mcp
                  ? view.mcp.badge
                  : view.mcpServers
                    ? t('No MCP servers configured')
                    : t('Not reported')
              }
            />
            {view.mcpServers?.map((server) => (
              <div key={server.name} className="flex flex-col px-2 py-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ui">{server.name}</span>
                  {server.ok ? (
                    <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                      {t('{{count}} tools', { count: server.toolCount })}
                    </span>
                  ) : (
                    <Badge variant="error" size="sm" className="shrink-0">
                      {t('Failed')}
                    </Badge>
                  )}
                </div>
                {server.error && (
                  <span className="truncate text-meta text-muted-foreground" title={server.error}>
                    {server.error}
                  </span>
                )}
              </div>
            ))}
            <CapabilityRow
              label={t('Skills')}
              value={view.skills === null ? t('Not reported') : String(view.skills)}
            />
            <CapabilityRow
              label={t('Prompt templates')}
              value={
                view.promptTemplates === null ? t('Not reported') : String(view.promptTemplates)
              }
            />
            <CapabilityRow
              label={t('Sub-agents')}
              value={view.subagents === null ? t('Not reported') : String(view.subagents)}
            />
            {/* cutover-03: the sentence that stops someone reinstalling a pi
                extension because this panel never names it. */}
            <p className="px-2 pt-2 text-meta text-muted-foreground">
              {t('Pi extensions you install are loaded only by the built-in terminal.')}
            </p>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function CapabilityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-7 items-center gap-2 rounded-md bg-muted px-2">
      <span className="shrink-0 text-meta text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-ui tabular-nums">{value}</span>
    </div>
  );
}
