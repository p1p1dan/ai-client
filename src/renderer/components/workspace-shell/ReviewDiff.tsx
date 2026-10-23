/**
 * User, 2026-10-23 (preview `docs/design/2026-10-23-session-changes-preview.html`,
 * part 1): a change in the 「改动」 pane, drawn the way the timeline draws a
 * diff (`ToolRows`' diff body, `buildDiffView`) but sized for a narrow pane:
 *
 *  - ONE number column (the new line, the old one on a deleted row), and only
 *    when the diff has numbers at all — argument previews have none, and the
 *    two always-empty 40px columns were most of the blank on the left;
 *  - the 「+/−」 in its own narrow column rather than inside the text;
 *  - long lines wrap instead of scrolling sideways;
 *  - unchanged runs fold to 「N 行未改动」, opened in place by a click.
 *
 * A single hairline on the left instead of a framed box: the pane card is the
 * one frame (design system v2, 「框只包一层」).
 */
import { ChevronsUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ToolDiffLineRow } from '@/components/chat/toolDiff';
import { buildDiffView, diffHasLineNumbers } from '@/components/chat/toolDiffView';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export function ReviewDiff({ rows }: { rows: readonly ToolDiffLineRow[] }) {
  const { t } = useI18n();
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(() => buildDiffView(rows, openFolds), [rows, openFolds]);
  const numbered = diffHasLineNumbers(rows);
  return (
    <div
      data-slot="review-diff"
      className="max-h-96 overflow-auto border-border-soft border-l font-mono text-code leading-[1.55]"
    >
      {items.map((item) => {
        if (item.kind === 'fold') {
          return (
            <button
              key={item.key}
              type="button"
              data-slot="diff-fold"
              className="flex w-full items-center gap-2 px-2 py-0.5 text-left font-sans text-small text-muted-foreground transition-colors duration-150 hover:bg-fill-ghost-hover hover:text-foreground focus-ring"
              onClick={() => setOpenFolds((previous) => new Set(previous).add(item.key))}
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
              className="select-none px-2 text-foreground-faint"
              aria-hidden
            >
              ⋯
            </div>
          );
        }
        const { row } = item;
        return (
          <div
            key={item.key}
            data-diff-line={row.kind}
            className={cn(
              'flex',
              row.kind === 'add' && 'bg-success/12',
              row.kind === 'del' && 'bg-destructive/12'
            )}
          >
            {numbered && (
              <span
                data-line-number=""
                className="w-8 shrink-0 select-none pr-1.5 text-right text-foreground-faint tabular-nums"
              >
                {row.kind === 'del' ? (row.oldLine ?? '') : (row.newLine ?? row.oldLine ?? '')}
              </span>
            )}
            <span
              className={cn(
                'w-4 shrink-0 select-none text-center',
                row.kind === 'add' && 'text-success',
                row.kind === 'del' && 'text-destructive'
              )}
            >
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 select-text whitespace-pre-wrap break-all pr-2',
                row.kind === 'same' ? 'text-muted-foreground/70' : 'text-foreground'
              )}
            >
              {row.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
