/**
 * T-22 (D19): the right-column panel shell — left-edge drag handle, header
 * (surface icon + name + expand/restore + close) and body (surface view or
 * honest empty state). Always mounted; "closed" is width 0 + `inert`, not an
 * unmount, so surface state never resets on toggle.
 *
 * Batch 3 adds: `availableWidth`-driven width resolution, the drag handle,
 * and the `expanded` promoted overlay (absolute over Main, not Rail/Sidebar —
 * Rail sits outside the measured Main+Panel row this panel lives in).
 */

import { Maximize2, Minimize2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { SURFACE_ICON_MAP } from './ContextPanelRail';
import { ShellResizeHandle } from './ShellResizeHandle';
import { SurfacePlaceholder } from './SurfacePlaceholder';
import {
  CONTEXT_PANEL_MIN_WIDTH,
  clampContextPanelWidth,
  resolveContextPanelWidth,
} from './shellLayoutModel';
import { getSurface } from './surfaceRegistry';
import { SURFACE_VIEWS } from './surfaceViews';

interface ContextPanelProps {
  /** Measured Main+Panel row width; null before the first measurement. */
  availableWidth: number | null;
}

export function ContextPanel({ availableWidth }: ContextPanelProps) {
  const { t } = useI18n();
  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const lastSurfaceId = useShellLayoutStore((state) => state.lastSurfaceId);
  const widthBySurface = useShellLayoutStore((state) => state.widthBySurface);
  const expanded = useShellLayoutStore((state) => state.expanded);
  const closeSurface = useShellLayoutStore((state) => state.closeSurface);
  const toggleExpanded = useShellLayoutStore((state) => state.toggleExpanded);
  const setSurfaceWidth = useShellLayoutStore((state) => state.setSurfaceWidth);

  const isOpen = activeSurfaceId !== null;
  // Content stays mounted across close/open (batch 3 correction): deriving the
  // rendered surface from activeSurfaceId alone unmounted the content column
  // during the close transition and after close, defeating "always mounted"
  // for anything with cross-toggle state (e.g. T-15's terminal). The outer
  // container already hides/disables it via `inert` + pointer-events-none +
  // width 0 when closed, so falling back to lastSurfaceId here is safe.
  const contentSurfaceId = activeSurfaceId ?? lastSurfaceId;
  const descriptor = contentSurfaceId ? getSurface(contentSurfaceId) : undefined;
  const width = resolveContextPanelWidth({
    surfaceId: activeSurfaceId,
    manualWidth: activeSurfaceId ? widthBySurface[activeSurfaceId] : null,
    availableWidth,
    expanded,
  });

  const panelRef = useRef<HTMLDivElement>(null);
  const [panelResizing, setPanelResizing] = useState(false);

  // Review fix: while closing, `width` is already 0, so sizing the inner
  // column from it would reflow the content to the 380px floor on the very
  // frame the 250ms collapse starts. Remember the last open width and keep
  // the inner column at it through the close transition and while closed.
  const lastOpenContentWidthRef = useRef(CONTEXT_PANEL_MIN_WIDTH);
  if (width > 0) {
    lastOpenContentWidthRef.current = Math.max(width, CONTEXT_PANEL_MIN_WIDTH);
  }

  const Icon = descriptor ? SURFACE_ICON_MAP[descriptor.icon] : null;
  const SurfaceView = descriptor ? SURFACE_VIEWS[descriptor.id] : undefined;

  return (
    <div
      ref={panelRef}
      data-resizing={panelResizing || undefined}
      className={cn(
        'overflow-hidden border-l bg-card/30 transition-[width] duration-[250ms] data-[resizing]:transition-none',
        expanded ? 'absolute inset-y-0 right-0 z-20' : 'relative h-full shrink-0',
        !isOpen && 'pointer-events-none'
      )}
      style={{ width }}
      inert={!isOpen}
      // Panel-scoped Escape (batch 3 correction): a document-level capture
      // listener closed the panel on ANY Escape press, e.g. dismissing the
      // Composer's mention popup. Scoping to onKeyDownCapture on the panel
      // root means only Escape while focus is inside the panel closes it —
      // matches the reference panel-scoped semantics (ContextPanel.tsx:2437-2445).
      onKeyDownCapture={(event) => {
        if (isOpen && event.key === 'Escape') {
          closeSurface();
          event.stopPropagation();
        }
      }}
    >
      {descriptor && (
        // Fixed px content width: the outer container animates width on
        // open/close/resize, but the inner column must not reflow mid-transition —
        // including the close transition, which keeps the last open width.
        <div
          className="flex h-full flex-col"
          style={{
            width:
              width > 0
                ? Math.max(width, CONTEXT_PANEL_MIN_WIDTH)
                : lastOpenContentWidthRef.current,
          }}
        >
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
            {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {t(descriptor.labelKey)}
            </p>
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
          <div className="min-h-0 flex-1">
            {SurfaceView ? (
              <SurfaceView surfaceId={descriptor.id} />
            ) : (
              <SurfacePlaceholder surface={descriptor} />
            )}
          </div>
        </div>
      )}

      {/* Promoted overlay covers Main only; no handle while expanded (decision 7). */}
      {activeSurfaceId && !expanded && (
        <ShellResizeHandle
          side="left"
          ariaLabel={t('Resize context panel')}
          width={width}
          targetRef={panelRef}
          clamp={(candidate) => clampContextPanelWidth(candidate, availableWidth)}
          onCommit={(next) => setSurfaceWidth(activeSurfaceId, next, availableWidth)}
          onResizingChange={setPanelResizing}
        />
      )}
    </div>
  );
}
