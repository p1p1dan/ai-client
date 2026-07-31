/**
 * T-22 (D19), A06 honesty: the empty state for a context surface that has no
 * view wired yet. Names the task that will supply real content instead of
 * showing a mock list/tree — that is the exact pattern this replaces (the
 * deleted legacy right dock's "Mock dock content").
 */
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { useI18n } from '@/i18n';
import { SURFACE_ICON_MAP } from './ContextPanelRail';
import type { ContextSurfaceDescriptor } from './surfaceRegistry';

interface SurfacePlaceholderProps {
  surface: ContextSurfaceDescriptor;
}

export function SurfacePlaceholder({ surface }: SurfacePlaceholderProps) {
  const { t } = useI18n();
  const Icon = SURFACE_ICON_MAP[surface.icon];

  return (
    <Empty className="h-full gap-3 border-0 p-2 md:p-2">
      <EmptyMedia variant="icon">
        <Icon className="h-4.5 w-4.5" />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle className="text-sm">{t(surface.labelKey)}</EmptyTitle>
        <EmptyDescription className="text-meta">
          {surface.pendingTask
            ? t('Not connected yet — {{task}} will wire this surface.', {
                task: surface.pendingTask,
              })
            : t('This surface has no view registered.')}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
