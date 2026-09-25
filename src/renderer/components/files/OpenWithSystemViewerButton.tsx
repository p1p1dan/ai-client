import { isRemoteVirtualPath } from '@shared/utils/remotePath';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { toastManager } from '@/components/ui/toast';
import { useI18n } from '@/i18n';

/**
 * T5 — the image / PDF preview's way out when the in-app preview cannot load
 * the file. The usual cause is a path outside the open workspace: the
 * `local-file://` handler only serves registered roots, and a file the agent
 * read from the Desktop is not in one. The OS viewer has no such limit.
 *
 * Main decides what may be opened (`resolveSystemViewerTarget`); a refusal or
 * an OS failure comes back as a toast, never an exception.
 */
export function OpenWithSystemViewerButton({ path }: { path: string }) {
  const { t } = useI18n();
  const [opening, setOpening] = useState(false);

  // A remote file has no local copy for the OS to open.
  if (isRemoteVirtualPath(path)) return null;

  const handleClick = async () => {
    setOpening(true);
    try {
      const result = await window.electronAPI.file.openWithSystemViewer(path);
      if (!result.ok) {
        toastManager.add({
          type: 'error',
          title: t('Could not open the file with the system viewer.'),
        });
      }
    } catch {
      toastManager.add({
        type: 'error',
        title: t('Could not open the file with the system viewer.'),
      });
    } finally {
      setOpening(false);
    }
  };

  return (
    <Button variant="outline" size="sm" disabled={opening} onClick={() => void handleClick()}>
      <ExternalLink />
      {t('Open with system viewer')}
    </Button>
  );
}
