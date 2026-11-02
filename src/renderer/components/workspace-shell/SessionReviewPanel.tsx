/**
 * Layout 5d: the diff pane (the reference's diff pane, adapted). The card
 * draws the one header; this view puts its context there — 「本次对话 |
 * 工作区 → branch」 (user, 2026-10-23: the working tree is the pane's second
 * view, `WorkspaceChangesList`) — and, in 「本次对话」, lists
 * the files the conversation's file tools changed: `›`, icon, name, faint
 * directory, `+A −D`, each expanding to its diffs.
 *
 * The timeline's change card (`changeFocus`, layout 5c) opens this pane and
 * names a change; the pane expands that change's file and scrolls to it.
 */
import { getDisplayPath } from '@shared/utils/path';
import { ArrowRight, ChevronRight, FileCode } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffLayoutToggle } from '@/components/chat/DiffLayout';
import { loadOlderHistoryPage } from '@/components/chat/historyPageRequest';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Ident } from '@/components/ui/ident';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useElementWidth } from '@/hooks/useElementWidth';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import {
  type DiffLayout,
  diffTooNarrowToSplit,
  effectiveDiffLayout,
  useDiffLayoutStore,
} from '@/stores/diffLayout';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { PaneHeaderPortal } from './panes/paneSlots';
import { ReviewDiff } from './ReviewDiff';
import type { SessionReviewEntry } from './sessionReview';
import {
  fileForChangeFocus,
  groupReviewByFile,
  type SessionReviewFile,
  shortenDir,
} from './sessionReviewFiles';
import { reviewEntryRows } from './sessionReviewPatch';
import { WorkspaceChangesList } from './WorkspaceChangesList';

interface SessionReviewPanelProps {
  sessionId: string | null;
  entries: readonly SessionReviewEntry[];
  /** A file's diff opened in the editor; the shell shows the editor pane. */
  onOpenDiff: () => void;
  /** The header menu's 「未提交的改动」: the Git pane. */
  onOpenGit?: () => void;
  /** The conversation's branch, for the header's `→ branch`. */
  branch?: string | null;
}

export function SessionReviewPanel({
  sessionId,
  entries,
  onOpenDiff,
  onOpenGit,
  branch = null,
}: SessionReviewPanelProps) {
  const { t } = useI18n();
  const pagination = useChatSessionsStore((state) =>
    sessionId ? state.historyPagination?.[sessionId] : undefined
  );
  const [view, setView] = useState<'chat' | 'workspace'>('chat');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const files = useMemo(() => groupReviewByFile(entries), [entries]);
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const additions = entries.reduce((sum, entry) => sum + entry.added, 0);
  const deletions = entries.reduce((sum, entry) => sum + entry.removed, 0);
  const incomplete = entries.some((entry) => entry.unavailable || entry.preview);

  // Layout 5c/5d: the change card names a change; expand its file and bring
  // it into view. Keyed on `seq` so a second click on the same card re-reveals.
  const changeFocus = useShellLayoutStore((state) => state.changeFocus);
  const handledSeq = useRef(0);
  useEffect(() => {
    if (!changeFocus || changeFocus.seq === handledSeq.current) return;
    const file = fileForChangeFocus(files, changeFocus);
    if (!file) return;
    handledSeq.current = changeFocus.seq;
    setOpenPaths((current) => (current.has(file.path) ? current : new Set(current).add(file.path)));
    setFocusedPath(file.path);
    requestAnimationFrame(() => {
      const row = [
        ...(listRef.current?.querySelectorAll<HTMLElement>('[data-review-file]') ?? []),
      ].find((element) => element.dataset.reviewFile === file.path);
      row?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [changeFocus, files]);

  const loadOlder = async () => {
    if (!sessionId || !pagination?.hasMore || loading) return;
    setLoading(true);
    setError('');
    try {
      await loadOlderHistoryPage({
        sessionId,
        offset: pagination.nextOffset,
        limit: 80,
        // T102: a session with no worker pages off its file. Read at click
        // time rather than subscribed — see `MessageTimeline`'s note.
        hostBound: useChatSessionsStore.getState().hostBoundSessionIds.includes(sessionId),
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  return (
    <section
      // Layout 5d: the pane card draws the frame and the one header.
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t('Session review')}
    >
      <PaneHeaderPortal slot="context">
        {/* User, 2026-10-23 (preview part 2, option 2): two views of one
            pane — the file tools' record, or the whole working tree. */}
        <div className="flex min-w-0 items-center gap-1">
          <ToggleGroup
            size="sm"
            value={[view]}
            onValueChange={(value) => {
              const next = (value as string[])[0];
              if (next === 'chat' || next === 'workspace') setView(next);
            }}
            aria-label={t('Which changes')}
          >
            <ToggleGroupItem value="chat">{t('This conversation')}</ToggleGroupItem>
            <ToggleGroupItem value="workspace">{t('Working tree')}</ToggleGroupItem>
          </ToggleGroup>
          {branch && (
            <>
              <ArrowRight aria-hidden className="size-3.5 shrink-0 text-foreground-faint" />
              <Ident className="min-w-0 truncate text-ui text-muted-foreground">{branch}</Ident>
            </>
          )}
        </div>
      </PaneHeaderPortal>
      {view === 'workspace' ? (
        <WorkspaceChangesList onOpenDiff={onOpenDiff} onOpenGit={onOpenGit} />
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 text-small text-foreground-faint tabular-nums">
            <span className="min-w-0 flex-1 truncate">
              {t('Recorded {{count}} changes', { count: entries.length })}
            </span>
            <span
              title={
                incomplete
                  ? t('Counts include previews; unavailable diffs are excluded.')
                  : undefined
              }
            >
              <span className="text-success">+{additions}</span>{' '}
              <span className="text-destructive">−{deletions}</span>
              {incomplete ? ' *' : ''}
            </span>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
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
              <p role="alert" className="mb-2 break-words text-small text-destructive">
                {error}
              </p>
            )}
            {!files.length && (
              <p className="px-1.5 py-4 text-small text-muted-foreground">
                {t('No file changes recorded in this conversation yet.')}
              </p>
            )}
            {files.map((file) => (
              <ReviewFile
                key={file.path}
                file={file}
                open={openPaths.has(file.path)}
                focused={focusedPath === file.path}
                onOpenChange={(open) =>
                  setOpenPaths((current) => {
                    const next = new Set(current);
                    if (open) next.add(file.path);
                    else next.delete(file.path);
                    return next;
                  })
                }
                onOpenDiff={onOpenDiff}
              />
            ))}
            {/* P1-7e e6 (problem 42, decision 145): `text-small`, the smallest size
            the design system lets CJK sit at. */}
            <p className="px-1.5 pt-3 text-small text-foreground-faint">
              {/* Decision 144: DSH's file tools are `edit` and `write` (the list is
              `sessionReview.ts`'s). */}
              {t(
                'Changes made by the file tools (edit, write) in this conversation. Changes from shell commands or other editors are under Working tree.'
              )}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function ReviewFile({
  file,
  open,
  focused,
  onOpenChange,
  onOpenDiff,
}: {
  file: SessionReviewFile;
  open: boolean;
  focused: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenDiff: () => void;
}) {
  const { t } = useI18n();
  const latest = file.entries.at(-1) as SessionReviewEntry;
  // PiLab R2 (FR-07.3): the shared 「上下 / 并排」 choice, unified while the
  // pane is too narrow to split.
  const layout = useDiffLayoutStore((state) => state.layout);
  const [bodyRef, bodyWidth] = useElementWidth<HTMLDivElement>();
  const shownLayout = effectiveDiffLayout(layout, bodyWidth);
  // User, 2026-11-02: the button opens the file in the editor, not a diff — the
  // change itself is already shown right here, and a git diff of the working
  // tree is not this session's change (it may be blank once staged/committed).
  const openFile = () => {
    useFileOpenIntentStore.getState().requestFileOpen({ path: latest.path, source: 'review' });
    // Explicitly ask for the editor pane even when this file was already
    // active: WorkspaceShell's active-path effect cannot observe that
    // repeated click.
    onOpenDiff();
  };
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="scroll-mt-1"
      data-review-file={file.path}
    >
      <div
        className={cn(
          'group/file flex h-7 min-w-0 items-center gap-1 rounded-sm pr-0.5',
          focused && 'bg-fill-ghost-selected'
        )}
      >
        <CollapsibleTrigger
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm pl-1 text-ui hover:bg-fill-ghost-hover focus-ring"
          title={getDisplayPath(file.path)}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
              open && 'rotate-90'
            )}
          />
          <FileCode
            aria-hidden
            className={cn(
              'size-3.5 shrink-0',
              file.created ? 'text-success' : 'text-muted-foreground'
            )}
          />
          <Ident className="min-w-0 shrink truncate text-left text-foreground">{file.name}</Ident>
          {file.dir && (
            <Ident className="min-w-0 flex-1 truncate text-left text-small text-foreground-faint">
              {shortenDir(getDisplayPath(file.dir))}
            </Ident>
          )}
          {!file.dir && <span className="flex-1" />}
          {!file.unavailable && (
            <span className="shrink-0 pr-1 text-small tabular-nums">
              <span className="text-success">+{file.added}</span>{' '}
              <span className="text-destructive">−{file.removed}</span>
            </span>
          )}
        </CollapsibleTrigger>
        {open && !file.unavailable && <DiffLayoutToggle narrow={diffTooNarrowToSplit(bodyWidth)} />}
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
        {/* User, 2026-10-23: a small step in, not the 20px it was. */}
        <div ref={bodyRef} className="flex flex-col gap-1.5 py-1 pl-2">
          {file.entries.map((entry) => (
            <ReviewEntry key={entry.id} entry={entry} layout={shownLayout} />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ReviewEntry({ entry, layout }: { entry: SessionReviewEntry; layout: DiffLayout }) {
  const { t } = useI18n();
  const rows = useMemo(() => reviewEntryRows(entry), [entry]);
  const unavailable =
    entry.unavailable === 'too-large'
      ? 'Diff exceeds the preview limit.'
      : entry.unavailable === 'binary'
        ? 'Binary content has no text diff.'
        : 'Previous content could not be read; no diff is available.';
  return (
    <div data-review-entry={entry.id}>
      {entry.preview && (
        // Decision 145: a Chinese sentence, so `text-small` rather than 10px.
        <p className="px-2 py-1 text-small text-muted-foreground">
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
        <p className="px-2 py-2 text-small text-muted-foreground">{t(unavailable)}</p>
      ) : rows.length ? (
        <ReviewDiff rows={rows} layout={layout} />
      ) : (
        <p className="px-2 py-2 text-small text-muted-foreground">{t('No text differences.')}</p>
      )}
    </div>
  );
}
