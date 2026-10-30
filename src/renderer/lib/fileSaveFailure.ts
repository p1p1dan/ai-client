/**
 * What the user sees when an editor save is refused.
 *
 * Main refuses a write whose baseline no longer matches the disk
 * (`FILE_CONTENT_CONFLICT`, #10). Every save entry point reports it through
 * here so none of them fails silently, and the editor ones also raise the
 * external-change banner, whose Reload / Keep Mine are the two ways out.
 */

import type { Translate } from '@shared/i18n';
import { FILE_CONTENT_CONFLICT } from '@shared/types/file';
import { toastManager } from '@/components/ui/toast';
import { useEditorStore } from '@/stores/editor';
import { unwrapIpcErrorMessage } from './ipcError';

export function isFileContentConflict(error: unknown): boolean {
  return unwrapIpcErrorMessage(error).startsWith(FILE_CONTENT_CONFLICT);
}

/** `withBannerHint`: the surface shows the external-change banner (the text editor, not Diff). */
export function describeFileSaveFailure(
  error: unknown,
  t: Translate,
  { withBannerHint = false }: { withBannerHint?: boolean } = {}
): string {
  if (!isFileContentConflict(error)) return unwrapIpcErrorMessage(error);
  const reason = t(
    'The file was changed outside the editor after you opened it, so nothing was written.'
  );
  return withBannerHint
    ? `${reason} ${t('Choose Reload to take the version on disk, or Keep Mine and save again to overwrite it.')}`
    : reason;
}

/** Show the disk text a refused save ran into through the editor's external-change banner. */
export async function flagConflictingDiskContent(path: string): Promise<void> {
  try {
    const { content, isBinary } = await window.electronAPI.file.read(path);
    if (isBinary) return;
    const store = useEditorStore.getState();
    if (store.tabs.some((tab) => tab.path === path)) store.markExternalChange(path, content);
  } catch {
    // Gone or unreadable: the toast already reports the failed save.
  }
}

/**
 * Toast for a refused or failed text-editor save; a conflict also raises the
 * banner. While the banner already asks about this file, a further conflict
 * (auto-save fires on every pause in typing) adds no second toast.
 */
export function reportEditorSaveFailure(path: string, error: unknown, t: Translate): void {
  const conflict = isFileContentConflict(error);
  const bannerShown = useEditorStore
    .getState()
    .tabs.some((tab) => tab.path === path && tab.hasExternalChange);
  if (conflict && bannerShown) return;
  toastManager.add({
    type: 'error',
    title: t('Save failed'),
    description: describeFileSaveFailure(error, t, { withBannerHint: true }),
  });
  if (conflict) void flagConflictingDiskContent(path);
}
