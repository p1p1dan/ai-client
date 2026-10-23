/**
 * A path row's two actions (copy, reveal in the file manager) and the lookup
 * of a chat's record on disk — shared by the Context panel's rows and the
 * session rail's environment card (user, 2026-10-23: the record's path shows
 * in 「环境」 too).
 */
import { Copy, FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';

export function CopyPathButton({ value }: { value: string }) {
  const { t } = useI18n();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      toastManager.add({
        title: t('Copied'),
        description: t('Path copied to clipboard'),
        type: 'success',
        timeout: 2000,
      });
    } catch {
      // Ignore clipboard errors — same as StatusLine's DirItem.
    }
  }, [value, t]);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="h-6 w-6 shrink-0"
      aria-label={t('Copy Path')}
      title={t('Copy Path')}
      onClick={() => void handleCopy()}
    >
      <Copy className="h-3.5 w-3.5" />
    </Button>
  );
}

/** S-6 feedback 7: shows a row's local path (the conversation record) in the file manager. */
export function RevealPathButton({ value }: { value: string }) {
  const { t } = useI18n();
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="h-6 w-6 shrink-0"
      aria-label={t('Reveal in Explorer')}
      title={t('Reveal in Explorer')}
      onClick={() => void window.electronAPI?.file.revealInFileManager(value).catch(() => {})}
    >
      <FolderOpen className="h-3.5 w-3.5" />
    </Button>
  );
}

/**
 * Route B S-6 feedback 7: where this chat's record is on disk, asked of Main from its
 * identity stub. Asked again when a turn settles: an Agent SDK chat's CLI writes its
 * transcript only once the first message has gone out.
 */
export function useTranscriptPath(
  runtimeIdentity: string | null | undefined,
  status: string | undefined
): string | null {
  const [found, setFound] = useState<{ stub: string; path: string | null } | null>(null);
  const settled = status !== 'running';
  useEffect(() => {
    if (!runtimeIdentity || !settled) return;
    let live = true;
    void window.electronAPI?.chat
      .locateTranscript(runtimeIdentity)
      .then((location) => {
        if (live) setFound({ stub: runtimeIdentity, path: location?.path ?? null });
      })
      .catch(() => {
        if (live) setFound({ stub: runtimeIdentity, path: null });
      });
    return () => {
      live = false;
    };
  }, [runtimeIdentity, settled]);
  return found && found.stub === runtimeIdentity ? found.path : null;
}
