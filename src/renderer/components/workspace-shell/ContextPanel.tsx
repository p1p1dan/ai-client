/**
 * T-22 (D19): the right-column panel shell — left-edge drag handle, header
 * (surface icon + name + expand/restore + close) and body (surface view or
 * honest empty state). Always mounted; "closed" is width 0 + `inert`, not an
 * unmount, so surface state never resets on toggle.
 *
 * Batch 3 adds: `availableWidth`-driven width resolution, the drag handle,
 * and the `expanded` promoted overlay (absolute over Main, not Rail/Sidebar —
 * Rail sits outside the measured Main+Panel row this panel lives in).
 *
 * S0 (T-12~15 prerequisite) adds two things and changes nothing else: the body
 * is a multi-mount stack driven by `deriveMountedSurfaceIds` (a 'keep-alive'
 * view stays mounted once activated, hidden but laid out, so T-15's pty
 * survives a surface switch), and Escape is narrowed so a surface can hold it
 * (`SURFACE_ESCAPE_HOLD_ATTR`). Header, width memory, expanded overlay and the
 * drag handle are untouched.
 */

import { Maximize2, Minimize2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { derivePanelTabs } from './panelTabsModel';
import { ShellResizeHandle } from './ShellResizeHandle';
import { SurfacePlaceholder } from './SurfacePlaceholder';
import {
  CONTEXT_PANEL_MIN_WIDTH,
  clampContextPanelWidth,
  deriveMountedSurfaceIds,
  resolveContentColumnWidth,
  resolveContextPanelWidth,
  resolveDockedPanelBudget,
  SURFACE_ESCAPE_HOLD_ATTR,
  seedVisitedSurfaceIds,
  shouldCloseOnEscape,
} from './shellLayoutModel';
import { type ContextSurfaceId, getSurface } from './surfaceRegistry';
import { SURFACE_VIEWS } from './surfaceViews';
import { useGitChangeCount } from './useGitChangeCount';

interface ContextPanelProps {
  /** Measured Main+Panel row width; null before the first measurement. */
  availableWidth: number | null;
  /**
   * T-32 S4: composed visibility, NOT `activeSurfaceId !== null`. That flag is
   * the user's intent; the level ladder can hide the panel at L1 without
   * touching it, so re-deriving visibility here would ignore the ladder and
   * fork the layout (spec §5, R1). WorkspaceShell computes it once.
   */
  visible: boolean;
  /**
   * m6 (user round 2): the largest width the DOCKED panel may take, so it can
   * never eat chat's floor. Deliberately not applied to `expanded` — that is
   * an overlay and must cover the whole row; capping it left a strip of the
   * reflowing chat column showing beside it («放大后没有覆盖中右全部画幅»).
   */
  maxDockedWidth?: number | null;
}

export function ContextPanel({ availableWidth, maxDockedWidth, visible }: ContextPanelProps) {
  const { t } = useI18n();
  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const lastSurfaceId = useShellLayoutStore((state) => state.lastSurfaceId);
  const panelWidth = useShellLayoutStore((state) => state.panelWidth);
  const expanded = useShellLayoutStore((state) => state.expanded);
  const closeSurface = useShellLayoutStore((state) => state.closeSurface);
  const selectSurface = useShellLayoutStore((state) => state.selectSurface);
  const toggleExpanded = useShellLayoutStore((state) => state.toggleExpanded);
  const setPanelWidth = useShellLayoutStore((state) => state.setPanelWidth);

  const railOrder = useShellLayoutStore((state) => state.railOrder);
  const changedFilesCount = useGitChangeCount();
  const tabs = derivePanelTabs(railOrder, { changedFilesCount });

  const isOpen = visible;
  // Content stays mounted across close/open (batch 3 correction): deriving the
  // rendered surface from activeSurfaceId alone unmounted the content column
  // during the close transition and after close, defeating "always mounted"
  // for anything with cross-toggle state (e.g. T-15's terminal). The outer
  // container already hides/disables it via `inert` + pointer-events-none +
  // width 0 when closed, so falling back to lastSurfaceId here is safe.
  const contentSurfaceId = activeSurfaceId ?? lastSurfaceId;
  const descriptor = contentSurfaceId ? getSurface(contentSurfaceId) : undefined;
  // Round-10 ②: one budget for the render AND the drag handle below. They used
  // to differ (render capped, drag not), which is how a drag could commit a
  // width that then walked the level ladder until the panel disappeared.
  const widthBudget = resolveDockedPanelBudget({ expanded, availableWidth, maxDockedWidth });
  const width = resolveContextPanelWidth({
    // null collapses the panel to width 0 — the ladder hiding it must look
    // exactly like the user closing it, transition included.
    surfaceId: visible ? activeSurfaceId : null,
    manualWidth: panelWidth,
    // Expanded takes the full row; docked is capped by the content floor.
    availableWidth: widthBudget,
    expanded,
  });

  const panelRef = useRef<HTMLDivElement>(null);
  const [panelResizing, setPanelResizing] = useState(false);

  // Review fix: while closing, `width` is already 0, so sizing the inner
  // column from it would reflow the content to the 380px floor on the very
  // frame the 250ms collapse starts. Remember the last open width and keep
  // the inner column at it through the close transition and while closed
  // (F-b: keep-alive views must never measure a 0px box — see the stack below).
  const lastOpenContentWidthRef = useRef(CONTEXT_PANEL_MIN_WIDTH);
  const contentWidth = resolveContentColumnWidth({
    width,
    lastOpenWidth: lastOpenContentWidthRef.current,
  });
  if (width > 0) {
    lastOpenContentWidthRef.current = contentWidth;
  }

  // Visited set for `deriveMountedSurfaceIds`. A ref written during render
  // rather than state: the mount list must be correct in the SAME render that
  // activates a surface (state would mount it one commit late), and the write
  // is idempotent, so a StrictMode double-render is a no-op.
  //
  // m14: seeded (not `[]`) so a persisted `{activeSurfaceId: null,
  // lastSurfaceId: 'terminal'}` restore does not skip its keep-alive surface's
  // first activation — see `seedVisitedSurfaceIds` for why the render-time
  // write below cannot reach it on that first render.
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

  const contentRegistration = contentSurfaceId ? SURFACE_VIEWS[contentSurfaceId] : undefined;

  return (
    <div
      ref={panelRef}
      data-resizing={panelResizing || undefined}
      className={cn(
        'overflow-hidden border-l transition-[width] duration-[250ms] data-[resizing]:transition-none',
        // m3 (user round 1, screenshot): `bg-card/30` is a fine tint for a
        // DOCKED column sitting on the app background — but the expanded state
        // is an overlay laid over chat and the editor, and at 30% opacity the
        // composer and the open file showed straight through it. An overlay
        // has to be opaque; the docked tint stays as it was.
        expanded
          ? 'absolute inset-y-0 right-0 z-20 bg-background'
          : 'relative h-full shrink-0 bg-card/30',
        !isOpen && 'pointer-events-none'
      )}
      style={{ width }}
      inert={!isOpen}
      // Panel-scoped Escape (batch 3 correction): a document-level capture
      // listener closed the panel on ANY Escape press, e.g. dismissing the
      // Composer's mention popup. Scoping to onKeyDownCapture on the panel
      // root means only Escape while focus is inside the panel closes it —
      // matches the reference panel-scoped semantics (ContextPanel.tsx:2437-2445).
      //
      // S0 narrows it further (F-c/R1): capture phase still runs BEFORE the
      // surface, so vim/less inside a terminal and Monaco's find/suggest never
      // saw their own Escape. A subtree marked `data-surface-holds-escape`
      // opts out — the panel then neither closes nor stops propagation, so the
      // key reaches the surface untouched.
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
        // Fixed px content width: the outer container animates width on
        // open/close/resize, but the inner column must not reflow mid-transition —
        // including the close transition, which keeps the last open width.
        <div className="flex h-full flex-col" style={{ width: contentWidth }}>
          {/*
            T-32 (D27): A08's tab strip replaces the single-surface header —
            h-9, the tabs splitting the width evenly, actions pinned right
            (a08:1259-1265). `expanded` is NOT part of A08 but is an existing
            capability the §7 comparison never superseded, so it stays in the
            action slot next to close.
          */}
          <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1" role="tablist">
            {tabs.map((tab) => {
              const selected = tab.id === contentSurfaceId;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={t(tab.descriptionKey)}
                  className={cn(
                    'relative flex h-7 min-w-0 flex-1 items-center justify-center rounded-sm px-1 text-meta transition-colors',
                    // Same mutual-exclusion reason as the rail (see
                    // ContextPanelRail): `hover:bg-hover` (0,2,0) would outrank
                    // a plain `bg-selection` (0,1,0) and erase the active tab.
                    selected
                      ? 'bg-selection font-medium text-primary'
                      : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                  )}
                  onClick={() => selectSurface(tab.id)}
                >
                  <span className="min-w-0 truncate">{t(tab.labelKey)}</span>
                  {tab.showDot && (
                    <span
                      aria-hidden="true"
                      className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-info"
                    />
                  )}
                </button>
              );
            })}
            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-6 w-6 shrink-0"
                aria-label={t(expanded ? 'Restore panel' : 'Expand panel')}
                onClick={toggleExpanded}
              >
                {expanded ? (
                  <Minimize2 className="h-3.5 w-3.5" />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-6 w-6 shrink-0"
                aria-label={t('Close panel')}
                onClick={closeSurface}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          {/*
            Multi-mount stack (S0). Every mounted view is an `absolute inset-0`
            layer over the same box; only the current surface is shown. One
            header above, one visible layer here — the stack changes lifetimes,
            not looks.

            Hidden layers use `invisible pointer-events-none` + `inert`, NEVER
            `display: none`, `hidden` or a conditional unmount. This is load
            bearing, not cosmetic: `visibility: hidden` keeps the layout box, so
            a hidden layer still measures the panel's real content width, while
            a display-hidden box measures 0×0. xterm's `FitAddon` runs off a
            ResizeObserver and `useXterm` has no zero-width guard, so a 0px
            measurement is forwarded to the pty as `cols: 2` and permanently
            mangles the wrapping of whatever is running in it. Same technique as
            the legacy shell's terminal tab (`layout/MainContent.tsx:577-590`).
            The `width > 0` floor above (F-b) is the other half of the same
            guarantee: it keeps this box ≥380px even while the panel is closed.

            `isolate`: the layers' z-0/z-10 must not compete with the drag
            handle's z-10 in the panel root's stacking context.
          */}
          <div className="relative isolate min-h-0 flex-1">
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
            {!contentRegistration && (
              <div className="absolute inset-0">
                <SurfacePlaceholder surface={descriptor} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Promoted overlay covers Main only; no handle while expanded (decision 7). */}
      {visible && activeSurfaceId && !expanded && (
        <ShellResizeHandle
          side="left"
          ariaLabel={t('Resize context panel')}
          width={width}
          targetRef={panelRef}
          // Round-10 ②: `widthBudget`, NOT the raw `availableWidth`. Dragging
          // now stops at the largest width the panel may actually occupy, so
          // the edge follows the pointer exactly and the committed value can
          // never be one the ladder would react to by hiding the panel.
          clamp={(candidate) => clampContextPanelWidth(candidate, widthBudget)}
          onCommit={(next) => setPanelWidth(next, widthBudget)}
          onResizingChange={setPanelResizing}
        />
      )}
    </div>
  );
}
