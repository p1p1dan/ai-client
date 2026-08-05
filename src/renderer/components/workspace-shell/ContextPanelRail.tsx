/**
 * T-22 (D19): the 44px context surface rail — one icon per rail-visible
 * surface (decision 6/10), single-select against `activeSurfaceId`.
 *
 * `SURFACE_ICON_MAP` is exported from here (not surfaceRegistry.ts, which
 * stays zero-lucide so it can be unit-tested in node) and reused by
 * `ContextPanel.tsx` / `SurfacePlaceholder.tsx` for the same surface icon.
 *
 * Drag-to-reorder is postponed; `setRailOrder` in the store is already wired
 * for it (decision 2/10), this component only reads `railOrder`.
 */
import {
  AppWindow,
  ArrowLeftRight,
  FileCode,
  FileText,
  Gauge,
  GitBranch,
  GitPullRequest,
  Globe,
  type LucideIcon,
  MessageSquare,
  SquareTerminal,
  StickyNote,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { derivePanelTabs } from './panelTabsModel';
import { RAIL_WIDTH } from './shellLayoutModel';
import type { SurfaceIconName } from './surfaceRegistry';
import { useGitChangeCount } from './useGitChangeCount';

export const SURFACE_ICON_MAP: Record<SurfaceIconName, LucideIcon> = {
  'file-code': FileCode,
  'git-branch': GitBranch,
  'git-pull-request': GitPullRequest,
  'arrow-left-right': ArrowLeftRight,
  'square-terminal': SquareTerminal,
  'file-text': FileText,
  'sticky-note': StickyNote,
  gauge: Gauge,
  globe: Globe,
  'app-window': AppWindow,
  'message-square': MessageSquare,
};

export function ContextPanelRail() {
  const { t } = useI18n();
  const railOrder = useShellLayoutStore((state) => state.railOrder);
  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const selectSurface = useShellLayoutStore((state) => state.selectSurface);
  const changedFilesCount = useGitChangeCount();

  // T-32: same source as the panel's tab strip (`derivePanelTabs`) so the two
  // lists — and their git-only dots — can never drift apart.
  const surfaces = derivePanelTabs(railOrder, { changedFilesCount });

  return (
    <nav
      aria-label={t('Context surfaces')}
      className="flex h-full shrink-0 flex-col items-center gap-1 border-l bg-background py-2"
      // RAIL_WIDTH is the single width authority (design-system 新壳布局档位).
      style={{ width: RAIL_WIDTH }}
    >
      {surfaces.map((surface) => {
        const Icon = SURFACE_ICON_MAP[surface.icon];
        const isActive = surface.id === activeSurfaceId;
        const showDot = surface.showDot;

        return (
          <Tooltip key={surface.id}>
            <TooltipTrigger
              delay={150}
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-pressed={isActive}
                  aria-label={t(surface.labelKey)}
                  className={cn(
                    'relative',
                    // --hover / --selection are mutually exclusive on purpose (see
                    // LeftNav.tsx:520-529): `hover:bg-hover` compiles to
                    // `.hover\:bg-hover:hover` (0,2,0) and would outrank a plain
                    // `.bg-selection` (0,1,0), erasing the active state on hover.
                    isActive
                      ? 'bg-selection text-primary'
                      : 'text-muted-foreground hover:bg-hover hover:text-foreground'
                  )}
                  onClick={() => selectSurface(surface.id)}
                />
              }
            >
              <Icon className="size-4.5" />
              {showDot && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-info"
                />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left" sideOffset={8}>
              <p className="font-medium">{t(surface.labelKey)}</p>
              <p className="text-muted-foreground">{t(surface.descriptionKey)}</p>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </nav>
  );
}
