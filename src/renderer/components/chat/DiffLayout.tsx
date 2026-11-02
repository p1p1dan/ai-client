/**
 * PiLab R2 (FR-07.3; user, 2026-11-02, preview
 * `docs/design/2026-11-02-diff-layout-toggle-preview.html`): the 「上下 / 并排」
 * switch every diff header carries, and the split body the review pane and a
 * tool row's diff render with it. The choice lives in `useDiffLayoutStore`.
 */
import { ChevronsUpDown, Columns2, Rows2 } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useDiffLayoutStore } from '@/stores/diffLayout';
import type { ToolDiffLineRow } from './toolDiff';
import type { SplitDiffItem } from './toolDiffView';

/** Icon-only items, small enough for a 28px file row or a 32px diff header. */
const ITEM_CLASS = 'h-6 min-w-6 sm:h-6 sm:min-w-6';

/**
 * Two icon toggles. `narrow`: the diff is too narrow to split right now, so
 * 「并排」 is disabled and, when it is the user's choice, a note says why the
 * diff is stacked — the choice itself is kept.
 */
export function DiffLayoutToggle({ narrow = false }: { narrow?: boolean }) {
  const { t } = useI18n();
  const layout = useDiffLayoutStore((state) => state.layout);
  const setLayout = useDiffLayoutStore((state) => state.setLayout);
  const shown = narrow ? 'unified' : layout;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {narrow && layout === 'split' && (
        <span className="text-2xs text-foreground-faint">{t('Too narrow, stacked for now')}</span>
      )}
      <ToggleGroup
        size="sm"
        value={[shown]}
        onValueChange={(value) => {
          const next = (value as string[])[0];
          if (next === 'unified' || next === 'split') setLayout(next);
        }}
        aria-label={t('Diff layout')}
      >
        <ToggleGroupItem
          value="unified"
          className={ITEM_CLASS}
          aria-label={t('Stacked')}
          title={t('Stacked')}
        >
          <Rows2 className="size-3.5" aria-hidden />
        </ToggleGroupItem>
        <ToggleGroupItem
          value="split"
          className={ITEM_CLASS}
          aria-label={t('Side by side')}
          title={t('Side by side')}
          disabled={narrow}
        >
          <Columns2 className="size-3.5" aria-hidden />
        </ToggleGroupItem>
      </ToggleGroup>
    </span>
  );
}

function SplitSide({
  row,
  side,
  numbered,
}: {
  row: ToolDiffLineRow | undefined;
  side: 'old' | 'new';
  numbered: boolean;
}) {
  const changed = row && row.kind !== 'same';
  return (
    <div
      data-split-side={side}
      className={cn(
        'flex min-w-0',
        side === 'new' && 'border-border-soft border-l',
        changed && side === 'old' && 'bg-destructive/12',
        changed && side === 'new' && 'bg-success/12'
      )}
    >
      {numbered && (
        <span className="w-8 shrink-0 select-none pr-1.5 text-right text-foreground-faint tabular-nums">
          {(side === 'old' ? row?.oldLine : row?.newLine) ?? ''}
        </span>
      )}
      <span
        className={cn(
          'w-4 shrink-0 select-none text-center',
          side === 'old' ? 'text-destructive' : 'text-success'
        )}
      >
        {changed ? (side === 'old' ? '−' : '+') : ''}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 select-text whitespace-pre-wrap break-all pr-2',
          changed ? 'text-foreground' : 'text-muted-foreground/70'
        )}
      >
        {row?.text ?? ''}
      </span>
    </div>
  );
}

/** A split diff body: folds and gaps across both sides, each line a two-column pair. */
export function SplitDiffBody({
  items,
  numbered,
  onOpenFold,
  insetClass,
}: {
  items: readonly SplitDiffItem[];
  numbered: boolean;
  onOpenFold: (key: string) => void;
  /** Horizontal padding of the fold and gap rows, matching the unified body's. */
  insetClass: string;
}) {
  const { t } = useI18n();
  return (
    <>
      {items.map((item) => {
        if (item.kind === 'fold') {
          return (
            <button
              key={item.key}
              type="button"
              data-slot="diff-fold"
              className={cn(
                'flex w-full items-center gap-2 py-0.5 text-left font-sans text-small text-muted-foreground transition-colors duration-150 hover:bg-fill-ghost-hover hover:text-foreground focus-ring',
                insetClass
              )}
              onClick={() => onOpenFold(item.key)}
            >
              <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
              {t('{{count}} unchanged lines', { count: item.count })}
            </button>
          );
        }
        if (item.kind === 'gap') {
          return (
            <div
              key={item.key}
              data-slot="diff-gap"
              className={cn('select-none text-foreground-faint', insetClass)}
              aria-hidden
            >
              ⋯
            </div>
          );
        }
        return (
          <div key={item.key} data-diff-pair="" className="grid grid-cols-2">
            <SplitSide row={item.left} side="old" numbered={numbered} />
            <SplitSide row={item.right} side="new" numbered={numbered} />
          </div>
        );
      })}
    </>
  );
}
