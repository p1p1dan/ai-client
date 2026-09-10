import { getDisplayPathBasename } from '@shared/utils/path';
import { ArrowLeftRight, ChevronRight, FileCode, Maximize2, Minimize2, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Ident } from '@/components/ui/ident';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import type { SessionReviewEntry } from './sessionReview';

interface SessionReviewPanelProps {
  sessionId: string | null;
  entries: readonly SessionReviewEntry[];
  onClose: () => void;
  onShowFiles: () => void;
  filesOpen: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}

export function SessionReviewPanel({
  sessionId,
  entries,
  onClose,
  onShowFiles,
  filesOpen,
  expanded,
  onToggleExpanded,
}: SessionReviewPanelProps) {
  const { t } = useI18n();
  const pagination = useChatSessionsStore((state) =>
    sessionId ? state.historyPagination?.[sessionId] : undefined
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const additions = entries.reduce((sum, entry) => sum + entry.added, 0);
  const deletions = entries.reduce((sum, entry) => sum + entry.removed, 0);
  const incomplete = entries.some((entry) => entry.unavailable || entry.preview);
  const loadOlder = async () => {
    if (!sessionId || !pagination?.hasMore || loading) return;
    setLoading(true);
    setError('');
    try {
      await window.electronAPI.chat.loadHistoryPage({
        sessionId,
        offset: pagination.nextOffset,
        limit: 80,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col border-l bg-background"
      aria-label={t('Session review')}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        <ArrowLeftRight className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{t('Session review')}</span>
        {filesOpen && (
          <Button
            variant="ghost"
            size="icon-xs"
            title={t('Files')}
            aria-label={t('Files')}
            onClick={onShowFiles}
          >
            <FileCode className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onToggleExpanded}
          title={t(expanded ? 'Restore panel' : 'Expand panel')}
          aria-label={t(expanded ? 'Restore panel' : 'Expand panel')}
        >
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          title={t('Close review')}
          aria-label={t('Close review')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2 px-3 py-2 text-meta tabular-nums">
        <span className="min-w-0 flex-1 text-muted-foreground">
          {t('Recorded {{count}} changes', { count: entries.length })}
        </span>
        <span
          title={
            incomplete ? t('Counts include previews; unavailable diffs are excluded.') : undefined
          }
        >
          <span className="text-success">+{additions}</span>{' '}
          <span className="text-destructive">−{deletions}</span>
          {incomplete ? ' *' : ''}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {pagination?.hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 w-full"
            disabled={loading}
            onClick={() => void loadOlder()}
          >
            {t(loading ? 'Loading...' : 'Load earlier changes')}
          </Button>
        )}
        {error && (
          <p role="alert" className="mb-2 break-words text-meta text-destructive">
            {error}
          </p>
        )}
        {!entries.length && (
          <p className="px-1 py-4 text-meta text-muted-foreground">
            {t('No file changes recorded in this conversation yet.')}
          </p>
        )}
        {entries.map((entry, index) => (
          <ReviewEntry
            key={entry.id}
            entry={entry}
            defaultOpen={index === entries.length - 1}
            onOpenFile={onShowFiles}
          />
        ))}
        <p className="px-1 pt-3 text-2xs text-muted-foreground">
          {t(
            'Changes recorded by Edit and Write in this conversation. Shell and external edits are not tracked.'
          )}
        </p>
      </div>
    </section>
  );
}

function ReviewEntry({
  entry,
  defaultOpen,
  onOpenFile,
}: {
  entry: SessionReviewEntry;
  defaultOpen: boolean;
  onOpenFile: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const marker = entry.status === 'added' ? 'A' : entry.status === 'modified' ? 'M' : '·';
  const lines =
    entry.patch !== undefined
      ? entry.patch.split('\n').filter(Boolean)
      : (entry.preview?.rows.map(
          (row) => `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`
        ) ?? []);
  const openFile = () => {
    useFileOpenIntentStore.getState().requestFileOpen({ path: entry.path, source: 'tool-row' });
    onOpenFile();
  };
  const unavailable =
    entry.unavailable === 'too-large'
      ? 'Diff exceeds the preview limit.'
      : entry.unavailable === 'binary'
        ? 'Binary content has no text diff.'
        : 'Previous content could not be read; no diff is available.';
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-2">
      <div className="flex h-7 min-w-0 items-center gap-1">
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm text-meta hover:bg-accent/50"
          title={entry.path}
        >
          <ChevronRight
            className={cn('size-3 shrink-0 transition-transform duration-150', open && 'rotate-90')}
          />
          <span
            className={cn(
              'shrink-0 text-2xs',
              marker === 'A' ? 'text-success' : 'text-muted-foreground'
            )}
            title={t(marker === 'A' ? 'Added' : marker === 'M' ? 'Modified' : 'Change')}
          >
            {marker}
          </span>
          <Ident className="min-w-0 flex-1 truncate text-left">
            {getDisplayPathBasename(entry.path)}
          </Ident>
          {!entry.unavailable && (
            <span className="shrink-0 tabular-nums">
              <span className="text-success">+{entry.added}</span>{' '}
              <span className="text-destructive">−{entry.removed}</span>
            </span>
          )}
        </CollapsibleTrigger>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={openFile}
          title={t('Open file')}
          aria-label={t('Open file')}
        >
          <FileCode className="size-3" />
        </Button>
      </div>
      <CollapsiblePanel>
        {entry.preview && (
          <p className="px-2 py-1 text-2xs text-muted-foreground">
            {t(
              entry.preview.source === 'sdk'
                ? 'Historical tool diff'
                : entry.preview.source === 'write-content'
                  ? 'Written content — previous content unavailable'
                  : 'Historical argument preview — full file diff unavailable'
            )}
          </p>
        )}
        {entry.unavailable ? (
          <p className="px-2 py-2 text-meta text-muted-foreground">{t(unavailable)}</p>
        ) : lines.length ? (
          <div className="max-h-96 overflow-auto rounded-md border bg-card font-mono text-code leading-relaxed">
            {lines.map((line, index) => (
              <div
                key={`${index}-${line[0]}`}
                className={cn(
                  'min-w-fit whitespace-pre px-2',
                  line.startsWith('+') && 'bg-success/10',
                  line.startsWith('-') && 'bg-destructive/10',
                  line.startsWith('@@') && 'bg-muted text-muted-foreground'
                )}
              >
                {line.startsWith('\\ No newline') ? t('No newline at end of file') : line}
              </div>
            ))}
          </div>
        ) : (
          <p className="px-2 py-2 text-meta text-muted-foreground">{t('No text differences.')}</p>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}
