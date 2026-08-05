/**
 * T-32 (D27): the panel's tab strip and the rail render the same list of
 * surfaces — A08 shows a `git | files | context` tab strip inside the panel
 * (a08:1259-1262) and a rail carrying the same icons while the panel is
 * collapsed (a08:1520-1529). Two components reading the registry separately is
 * how those two lists drift apart; both call this instead.
 *
 * Pure so vitest (node env, `.ts` only) can cover it — `sidebarTree.ts` pattern.
 */
import {
  type ContextSurfaceId,
  railSurfaces,
  type SurfaceIconName,
  shouldShowActivityDot,
} from './surfaceRegistry';

export interface PanelTab {
  id: ContextSurfaceId;
  icon: SurfaceIconName;
  /** English source string = i18n key (see src/shared/i18n.ts). */
  labelKey: string;
  descriptionKey: string;
  /** A08's git-only 6px dot; the tab strip and the rail must agree on it. */
  showDot: boolean;
}

export interface PanelTabSignals {
  changedFilesCount: number;
}

/**
 * Rail-visible surfaces in `order`, each stamped with its activity dot.
 * `order` is the persisted `railOrder`; `railSurfaces` already drops
 * registry-only and content-less surfaces and re-appends anything missing.
 */
export function derivePanelTabs(order: readonly string[], signals: PanelTabSignals): PanelTab[] {
  return railSurfaces(order).map((surface) => ({
    id: surface.id,
    icon: surface.icon,
    labelKey: surface.labelKey,
    descriptionKey: surface.descriptionKey,
    showDot: shouldShowActivityDot(surface.id, signals),
  }));
}
