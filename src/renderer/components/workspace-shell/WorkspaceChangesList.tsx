/**
 * User, 2026-10-23 (preview `docs/design/2026-10-23-session-changes-preview.html`,
 * part 2, option 2): the 「改动」 pane's 「工作区」 view — every uncommitted
 * change in the conversation's working tree (`git status`), whatever made it:
 * the file tools, a shell command, another editor. The 「本次对话」 view stays
 * the per-call record of the file tools; Git cannot say which conversation
 * made a change, which is why the two are separate views and not one list.
 *
 * Read-only: a row opens its diff in the editor (the Git pane's own
 * `openDiffTab` target); staging and committing stay in the Git pane, linked
 * from the footer.
 */
import type { FileChange } from '@shared/types/git';
import { getDisplayPath } from '@shared/utils/path';
import { useMemo } from 'react';
import { GIT_STATUS_TONE } from '@/components/source-control/gitStatusTone';
import { Ident } from '@/components/ui/ident';
import { useFileChanges } from '@/hooks/useSourceControl';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useEditorStore } from '@/stores/editor';
import { shortenDir } from './sessionReviewFiles';
import { describeGitReadError, partitionFileChanges } from './surfaces/gitSurfaceModel';
import { useWorkspaceRootPath } from './useWorkspaceRootPath';

function splitPath(path: string): { name: string; dir: string } {
  const index = path.lastIndexOf('/');
  return index < 0
    ? { name: path, dir: '' }
    : { name: path.slice(index + 1), dir: path.slice(0, index) };
}

export function WorkspaceChangesList({
  onOpenDiff,
  onOpenGit,
}: {
  onOpenDiff: () => void;
  onOpenGit?: () => void;
}) {
  const { t } = useI18n();
  const workdir = useWorkspaceRootPath();
  const query = useFileChanges(workdir);
  const { staged, unstaged, truncated } = useMemo(
    () => partitionFileChanges(query.data),
    [query.data]
  );
  const files = [...staged, ...unstaged];
  const error = describeGitReadError(query.error);

  const open = (file: FileChange) => {
    useEditorStore
      .getState()
      .openDiffTab({ kind: 'workdir', path: file.path, staged: file.staged, status: file.status });
    onOpenDiff();
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-3">
      {error ? (
        <p role="alert" className="px-1.5 py-4 break-words text-small text-destructive">
          {error}
        </p>
      ) : !workdir || (query.data && files.length === 0) ? (
        <p className="px-1.5 py-4 text-small text-muted-foreground">
          {t('No uncommitted changes in the working tree.')}
        </p>
      ) : null}
      {files.map((file) => {
        const { name, dir } = splitPath(file.path);
        return (
          <button
            key={`${file.staged ? 's' : 'u'}:${file.path}`}
            type="button"
            data-workspace-change={file.path}
            className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-ui hover:bg-fill-ghost-hover focus-ring"
            title={getDisplayPath(file.path)}
            onClick={() => open(file)}
          >
            <span
              className={cn('w-3.5 shrink-0 font-mono text-code', GIT_STATUS_TONE[file.status])}
            >
              {file.status}
            </span>
            <Ident className="min-w-0 shrink truncate text-foreground">{name}</Ident>
            {dir ? (
              <Ident className="min-w-0 flex-1 truncate text-small text-foreground-faint">
                {shortenDir(getDisplayPath(dir))}
              </Ident>
            ) : (
              <span className="flex-1" />
            )}
            {file.staged && (
              <span className="shrink-0 text-small text-foreground-faint">{t('Staged')}</span>
            )}
          </button>
        );
      })}
      {truncated && (
        <p className="px-1.5 pt-2 text-small text-foreground-faint">
          {t('Only the first changes are listed.')}
        </p>
      )}
      <p className="px-1.5 pt-3 text-small text-foreground-faint">
        {t('Uncommitted changes in the working tree (git status), whatever made them.')}
        {onOpenGit && (
          <>
            {' '}
            <button
              type="button"
              className="rounded-xs underline underline-offset-2 hover:text-foreground focus-ring"
              onClick={onOpenGit}
            >
              {t('Stage and commit in Git')}
            </button>
          </>
        )}
      </p>
    </div>
  );
}
