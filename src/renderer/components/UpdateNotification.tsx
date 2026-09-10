import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '@/i18n';
import { useUpdaterStatus } from '@/stores/updater';
import { Button } from './ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from './ui/dialog';

export function UpdateNotification() {
  const { t } = useI18n();
  const status = useUpdaterStatus();
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const phase = status?.status;
  const version = status?.info?.version;
  useEffect(() => {
    if (phase === 'downloaded' && version) setOpen(true);
  }, [phase, version]);
  // A failed check (offline, unreachable feed) stays on the settings page; the
  // reminder only carries errors for a version already found.
  if (!status?.info || !['available', 'downloading', 'downloaded', 'error'].includes(status.status))
    return null;

  const downloaded = status.status === 'downloaded';
  const downloading = status.status === 'downloading';
  const failed = status.status === 'error';
  const title = t(
    downloaded
      ? 'Update ready'
      : downloading
        ? 'Downloading update'
        : failed
          ? 'Update failed'
          : 'New version available'
  );
  const act = async () => {
    setActionError('');
    try {
      if (downloaded) await window.electronAPI.updater.quitAndInstall();
      else await window.electronAPI.updater.downloadUpdate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <>
      <div
        role="status"
        className="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-2 rounded-lg border bg-background px-3 py-2 shadow-lg"
      >
        {downloading ? (
          <Download className="size-4 shrink-0 text-primary" />
        ) : (
          <RefreshCw className="size-4 shrink-0 text-primary" />
        )}
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 text-meta tabular-nums"
          onClick={() => setOpen(true)}
        >
          {title}
          {version ? ` · v${version}` : ''}
          {status.progress ? ` · ${Math.floor(status.progress.percent)}%` : ''}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {downloaded
                ? t('Version {{version}} has been downloaded. Restart now to install?', {
                    version: version ?? '',
                  })
                : downloading
                  ? t('The update is downloading. You can continue working.')
                  : failed
                    ? t('The update could not be completed. You can retry.')
                    : t(
                        'Version {{version}} is available. Do you want to download and update now?',
                        { version: version ?? '' }
                      )}
            </DialogDescription>
          </DialogHeader>
          {downloading && status.progress && (
            <div className="text-meta tabular-nums">{Math.floor(status.progress.percent)}%</div>
          )}
          {(actionError || status.error) && (
            <p role="alert" className="break-words text-meta text-destructive">
              {actionError || status.error}
            </p>
          )}
          {status.info?.releaseNotes && (
            <div className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-meta text-muted-foreground">
              {status.info.releaseNotes}
            </div>
          )}
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('Later')}
            </Button>
            {!downloading && (
              <Button onClick={() => void act()}>
                {t(downloaded ? 'Restart now' : failed ? 'Retry' : 'Download update')}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
