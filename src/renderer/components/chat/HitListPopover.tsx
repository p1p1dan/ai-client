import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from '@/components/ui/preview-card';
import type { FileLinkTarget } from './toolCard';
import { parseHitList } from './toolHits';

/**
 * T-05 batch 4 (A07 F②, `.ct-pop`/`.ct-hit` :916-953): hover-triggered hit
 * list for Grep/Glob rows. `toolHits.parseHitList` (batch 1) is the only
 * judgment call — a `null` result means the raw tool output could not be
 * trusted, and this component steps out of the way entirely so the row
 * falls back to its existing click-to-expand output body (A07 :2460's
 * downgrade allowance, one row at a time).
 */

interface HitListPopoverProps {
  source: string;
  /**
   * Trigger content — the already-styled `.ct-a` arg node. A single element,
   * not free-form nodes: it IS the trigger (see `render` below), so the
   * positioner measures this very box.
   */
  children: React.ReactElement<Record<string, unknown>>;
  onOpenFile: (target: FileLinkTarget) => void;
}

export function HitListPopover({ source, children, onOpenFile }: HitListPopoverProps) {
  const hitList = parseHitList(source);
  if (!hitList) return <>{children}</>;

  return (
    <PreviewCard>
      {/* The arg node IS the trigger — no wrapper. A `display: contents`
          wrapper kept the row's flex layout intact but had no box of its own
          (`getClientRects()` is empty), so the positioner measured an empty
          rect and pinned the popup to the viewport's top-left corner. Same
          shape as `BreadcrumbTreeMenu`'s `MenuTrigger`. */}
      <PreviewCardTrigger render={children} />
      <PreviewCardPopup className="w-140 max-h-72 flex-col overflow-auto rounded-md p-1 text-wrap before:hidden">
        {hitList.hits.map((hit) => (
          <button
            key={hit.path}
            type="button"
            className="flex h-7 w-full shrink-0 items-center gap-2 rounded-sm px-2 text-left hover:bg-hover"
            onClick={() => onOpenFile({ path: hit.path, line: hit.line })}
          >
            <span className="shrink-0 font-mono text-code text-foreground">{hit.name}</span>
            {hit.dir && (
              <span className="min-w-0 truncate font-mono text-code text-muted-foreground">
                {hit.dir}
              </span>
            )}
          </button>
        ))}
      </PreviewCardPopup>
    </PreviewCard>
  );
}
