/**
 * Layout 5c (ui-cohesion §6, ruling L3): the ONE card a turn that edited files
 * shows — 「改了 N 个文件 +A −D」 over the first file name(s), and a chevron.
 * A click opens the right work panel on its changes tab and asks it to show
 * the turn's first file (`revealChange`). The per-call diffs stay where they
 * were, inside the folded process group's edit rows.
 */
import { getDisplayPathBasename } from '@shared/utils/path';
import { ChevronRight, FileDiff } from 'lucide-react';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import { useRevealChange } from '@/stores/shellLayout';
import { turnChangeCardClass } from './chatTimelineLayout';
import { type TurnChangeSummary, turnChangeNamedFiles } from './turnChanges';

export function TurnChangeCard({ summary }: { summary: TurnChangeSummary }) {
  const { t } = useI18n();
  const revealChange = useRevealChange();
  const first = summary.files[0];
  if (!first) return null;
  const count = summary.files.length;
  const { paths, more } = turnChangeNamedFiles(summary);
  const names = paths.map((path) => getDisplayPathBasename(path)).join(' · ');
  return (
    <button
      type="button"
      className={turnChangeCardClass()}
      data-slot="turn-change-card"
      title={t('Show in the changes panel')}
      onClick={() => revealChange({ entryId: first.firstEntryId, path: first.path })}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-fill-neutral text-muted-foreground">
        <FileDiff className="size-3.5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5 text-ui text-foreground">
          <span className="min-w-0 truncate">
            {count === 1 ? t('Changed 1 file') : t('Changed {{count}} files', { count })}
          </span>
          <span className="shrink-0 tabular-nums">
            <span className="text-success">+{summary.added}</span>{' '}
            <span className="text-destructive">−{summary.removed}</span>
          </span>
        </span>
        <Ident className="min-w-0 truncate text-small text-muted-foreground">
          {more > 0 ? t('{{names}} and {{count}} more', { names, count: more }) : names}
        </Ident>
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-foreground-faint" aria-hidden />
    </button>
  );
}
