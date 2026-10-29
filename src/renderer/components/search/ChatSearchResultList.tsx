/**
 * Chat search (stage 3): the 「对话」 tab's rows, as in the approved preview
 * (docs/design/2026-10-29-chat-search-preview.html, option A): chat icon,
 * title, repository chip and time on the first line; the first matching
 * message with its role below; 「还有 N 处」 when more of the chat matched.
 */
import type { ChatSearchProgress, ChatSearchSnippet } from '@shared/types';
import { MessageCircle } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { displaySessionTitle } from '@/components/chat/sessionIndex/sessionTitle';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useI18n } from '@/i18n';
import { formatRelativeAge, RELATIVE_AGE_NOW } from '@/lib/relativeTime';
import { cn } from '@/lib/utils';
import type { ChatSearchRow } from './useChatSearch';

const MARK_CLASS = 'rounded-sm bg-warning/30 px-0.5 text-inherit';

/** Every case-insensitive occurrence of `query` in `text`, marked. */
function HighlightQuery({ text, query }: { text: string; query: string }) {
  const needle = query.toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className={MARK_CLASS}>
        {text.slice(at, at + needle.length)}
      </mark>
    );
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return <>{parts}</>;
}

/** The snippet with Main's match range marked. */
function SnippetText({ snippet }: { snippet: ChatSearchSnippet }) {
  const start = Math.max(0, Math.min(snippet.text.length, snippet.matchStart));
  const end = Math.max(start, Math.min(snippet.text.length, start + snippet.matchLength));
  return (
    <>
      {snippet.text.slice(0, start)}
      {end > start && <mark className={MARK_CLASS}>{snippet.text.slice(start, end)}</mark>}
      {snippet.text.slice(end)}
    </>
  );
}

interface ChatSearchResultListProps {
  rows: readonly ChatSearchRow[];
  query: string;
  recent: boolean;
  indexing: ChatSearchProgress | null;
  loading: boolean;
  failed: boolean;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onOpen: (row: ChatSearchRow) => void;
}

export function ChatSearchResultList({
  rows,
  query,
  recent,
  indexing,
  loading,
  failed,
  selectedIndex,
  onSelect,
  onOpen,
}: ChatSearchResultListProps) {
  const { t } = useI18n();
  const selectedRef = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const needle = query.trim();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection moving is the trigger
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  const status = failed
    ? t('Chat search failed')
    : indexing
      ? t('Building the search index… {{done}} / {{total}}', {
          done: indexing.done,
          total: indexing.total,
        })
      : null;

  return (
    <ScrollArea className="h-full">
      <div className="px-2 pt-1.5 pb-2" role="listbox" aria-label={t('Chats')}>
        {status && (
          <div className="px-2 pt-1 pb-1 text-small text-foreground-faint" data-chat-search-status>
            {status}
          </div>
        )}
        {recent && rows.length > 0 && (
          <div className="px-2 pt-2 pb-1 text-small text-foreground-faint">{t('Recent chats')}</div>
        )}
        {rows.length === 0 && !loading && (
          <div className="py-10 text-center text-ui text-muted-foreground">
            {recent ? t('No chats yet') : failed ? null : t('No chats found')}
          </div>
        )}
        {rows.map((row, index) => {
          const selected = index === selectedIndex;
          const age = formatRelativeAge(row.updatedAt, now);
          const title = displaySessionTitle(row.title, t);
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the dialog
            <div
              key={row.sessionId}
              ref={selected ? selectedRef : undefined}
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              data-chat-search-row={row.sessionId}
              className={cn(
                'cursor-pointer rounded-sm px-2.5 py-2',
                selected ? 'bg-fill-ghost-selected' : 'hover:bg-fill-ghost-hover'
              )}
              onMouseEnter={() => onSelect(index)}
              onClick={() => onOpen(row)}
            >
              <div className="flex min-w-0 items-center gap-1.5 text-ui text-foreground">
                <MessageCircle className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {row.titleMatch ? <HighlightQuery text={title} query={needle} /> : title}
                </span>
                {row.repoName && (
                  <Badge variant="secondary" className="max-w-40 shrink-0">
                    <span className="truncate">{row.repoName}</span>
                  </Badge>
                )}
                <span className="shrink-0 text-small text-foreground-faint tabular-nums">
                  {age === RELATIVE_AGE_NOW ? t('Just now') : age}
                </span>
              </div>
              {row.snippet && (
                <div className="mt-0.5 line-clamp-2 break-words text-small text-muted-foreground">
                  <span className="text-foreground-faint">
                    {row.snippet.role === 'user' ? t('You:') : t('Assistant:')}
                  </span>
                  <SnippetText snippet={row.snippet} />
                </div>
              )}
              {row.hitCount > 1 && (
                <div className="mt-0.5 text-small text-foreground-faint">
                  {t('{{count}} more matches', { count: row.hitCount - 1 })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
