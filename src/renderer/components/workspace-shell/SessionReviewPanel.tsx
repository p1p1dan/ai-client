/**
 * Layout 5d: the diff pane (the reference's diff pane, adapted). The card
 * draws the one header; this view puts its context there — 「本次对话 →
 * branch ▾」, the ▾ offering the Git pane's uncommitted changes — and lists
 * the files the conversation's file tools changed: `›`, icon, name, faint
 * directory, `+A −D`, each expanding to its diffs.
 *
 * The timeline's change card (`changeFocus`, layout 5c) opens this pane and
 * names a change; the pane expands that change's file and scrolls to it.
 */
import { getDisplayPath } from '@shared/utils/path';
import { ArrowRight, Check, ChevronDown, ChevronRight, FileCode, GitBranch } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadOlderHistoryPage } from '@/components/chat/historyPageRequest';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Ident } from '@/components/ui/ident';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useEditorStore } from '@/stores/editor';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { PaneHeaderPortal } from './panes/paneSlots';
import type { SessionReviewEntry } from './sessionReview';
import { sessionReviewDiffTarget } from './sessionReviewDiffTarget';
import {
  fileForChangeFocus,
  groupReviewByFile,
  type SessionReviewFile,
  shortenDir,
} from './sessionReviewFiles';
import { reviewPatchLines } from './sessionReviewPatch';
import { readWorkspaceRootPath } from './useWorkspaceRootPath';

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
        <Menu>
          <MenuTrigger
            className="flex h-7 min-w-0 items-center gap-1 rounded-sm px-1.5 text-ui text-foreground hover:bg-fill-ghost-hover"
            aria-label={t('Which changes')}
          >
            <span className="shrink-0">{t('This conversation')}</span>
            {branch && (
              <>
                <ArrowRight aria-hidden className="size-3.5 shrink-0 text-foreground-faint" />
                <Ident className="min-w-0 truncate">{branch}</Ident>
              </>
            )}
            <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem>
              <Check />
              {t("This conversation's changes")}
            </MenuItem>
            {onOpenGit && (
              <MenuItem onClick={onOpenGit}>
                <GitBranch />
                {t('Uncommitted changes (Git)')}
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      </PaneHeaderPortal>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 text-small text-foreground-faint tabular-nums">
        <span className="min-w-0 flex-1 truncate">
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
            'Changes made by the file tools (edit, write) in this conversation. Shell commands and external edits are not tracked.'
          )}
        </p>
      </div>
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
  const openFile = () => {
    const workspacePath = readWorkspaceRootPath();
    if (!workspacePath) {
      toastManager.add({ type: 'info', title: t('Select a Workspace to browse files') });
      return;
    }
    const target = sessionReviewDiffTarget(latest, workspacePath);
    if (!target) {
      toastManager.add({
        type: 'error',
        title: t('Could not open "{{path}}" — the path is outside the workspace.', {
          path: latest.path,
        }),
      });
      return;
    }
    useEditorStore.getState().openDiffTab(target);
    // Explicitly ask for the editor pane even when this exact diff tab was
    // already active: WorkspaceShell's active-path effect cannot observe that
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
        <div className="flex flex-col gap-1.5 py-1 pl-5">
          {file.entries.map((entry) => (
            <ReviewEntry key={entry.id} entry={entry} />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ReviewEntry({ entry }: { entry: SessionReviewEntry }) {
  const { t } = useI18n();
  const lines = reviewPatchLines(
    entry.patch ??
      entry.preview?.rows
        .map((row) => `${row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}${row.text}`)
        .join('\n') ??
      ''
  );
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
      ) : lines.length ? (
        <div className="max-h-96 overflow-auto rounded-lg border border-border-soft bg-surface-1 font-mono text-code leading-relaxed">
          {lines.map((line, index) => (
            <div
              key={`${index}-${line.kind}`}
              data-diff-line={line.kind}
              className={cn(
                'flex min-w-fit whitespace-pre px-2',
                line.kind === 'add' && 'bg-success/12',
                line.kind === 'del' && 'bg-destructive/12',
                line.text.startsWith('@@') && 'bg-fill-neutral text-muted-foreground'
              )}
            >
              <span
                data-line-number="old"
                className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums"
              >
                {line.oldLine}
              </span>
              <span
                data-line-number="new"
                className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums"
              >
                {line.newLine}
              </span>
              <span>
                {line.text.startsWith('\\ No newline') ? t('No newline at end of file') : line.text}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-2 py-2 text-small text-muted-foreground">{t('No text differences.')}</p>
      )}
    </div>
  );
}
