import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { RailCard } from './RailCard';
import { type ChangesCardView, formatLineCount } from './sessionRailModel';

/**
 * Layout 5e: what the session changed. The header's `+A −D` opens the changes
 * pane (the reference: 「click the line counts … to open the diff view」); a
 * file row opens it at that file; 「提交改动」 opens the git pane, where the
 * commit box is. Not drawn while nothing changed.
 */
export function ChangesCard({
  view,
  onOpenChanges,
  onRevealFile,
  onCommit,
}: {
  view: ChangesCardView;
  onOpenChanges: () => void;
  onRevealFile: (target: { entryId: string; path: string }) => void;
  onCommit: () => void;
}) {
  const { t } = useI18n();
  return (
    <RailCard
      id="changes"
      title={t('Session changes')}
      summary={
        <button
          type="button"
          onClick={onOpenChanges}
          aria-label={`${t('Show in the changes panel')} +${view.added} −${view.removed}`}
          className="flex h-6 items-center gap-1.5 rounded-sm px-1 tabular-nums transition-colors hover:bg-fill-ghost-hover"
          data-rail-changes-open=""
        >
          <span className="text-success">+{formatLineCount(view.added)}</span>
          <span className="text-destructive">−{formatLineCount(view.removed)}</span>
        </button>
      }
    >
      <ul className="flex flex-col">
        {view.files.map((file) => (
          <li key={file.entryId} className="-mx-1">
            <button
              type="button"
              onClick={() => onRevealFile({ entryId: file.entryId, path: file.path })}
              title={file.path}
              className="flex h-6 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left transition-colors hover:bg-fill-ghost-hover"
            >
              <span className="min-w-0 shrink truncate">{file.name}</span>
              {file.dir && (
                <span className="min-w-0 flex-1 truncate text-foreground-faint">{file.dir}</span>
              )}
              <span className="ml-auto shrink-0 text-foreground-faint tabular-nums">
                +{file.added} −{file.removed}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-foreground-faint tabular-nums">
          {view.more > 0 ? t('{{count}} more files', { count: view.more }) : ''}
        </span>
        <Button type="button" variant="ghost" size="xs" onClick={onCommit}>
          {t('Commit changes')}
        </Button>
      </div>
    </RailCard>
  );
}
