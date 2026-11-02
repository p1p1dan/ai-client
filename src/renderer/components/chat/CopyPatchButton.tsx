import { formatPatch, type PatchFile, rowsHaveLineNumbers } from '@shared/diffPatch';
import { useI18n } from '@/i18n';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { CopyIconButton } from './CopyIconButton';

/**
 * PiLab R2 (07.9): 「复制补丁」 on a diff's head — the timeline's edit rows, the
 * review pane's files, the diff tab and the approval card. The patch is built
 * on click, and covers every row, folded or not. Rows without line numbers (an
 * argument preview) still copy, as bare `@@` hunks, and the label says such a
 * patch cannot be applied as is.
 */
export function CopyPatchButton({ files }: { files: readonly PatchFile[] }) {
  const { t } = useI18n();
  const numbered = files.every((file) => rowsHaveLineNumbers(file.rows));
  return (
    <CopyIconButton
      text={() => formatPatch(files)}
      label={t(numbered ? 'Copy patch' : 'Copy patch (no line numbers; cannot be applied as is)')}
      copiedLabel={t('Copied')}
    />
  );
}

/** The folder a session works in, which a patch's paths are made relative to. */
export function useSessionWorkspacePath(sessionId: string | undefined): string | null {
  return useChatSessionsStore((state) => {
    if (!sessionId) return null;
    const session = state.sessions.find((item) => item.id === sessionId);
    return state.workspaces.find((item) => item.id === session?.workspaceId)?.path ?? null;
  });
}
