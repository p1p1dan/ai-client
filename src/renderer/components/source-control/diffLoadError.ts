import type { TFunction } from '@/i18n';
import { unwrapIpcErrorMessage } from '@/lib/ipcError';

/**
 * Decision 162: the reason line `DiffViewer` shows under 「无法加载差异」.
 *
 * A blob the main process could not read used to come back empty, so a large
 * file's diff showed it as deleted or newly added. It now fails, naming two
 * cases by code (`git/encoding.ts`): those are said in the UI language; any
 * other failure is shown as the main process said it. `null` without an error.
 */
export function describeDiffLoadError(error: unknown, t: TFunction): string | null {
  if (error === null || error === undefined) return null;
  const reason = unwrapIpcErrorMessage(error);
  if (reason.startsWith('GIT_BLOB_TOO_LARGE:')) {
    return t('This file is too large to show a diff (over {{size}}).', { size: '32 MB' });
  }
  if (reason.startsWith('GIT_BLOB_READ_TIMEOUT:')) {
    return t('Reading this file from Git timed out.');
  }
  return reason || null;
}
