import { stat } from 'node:fs/promises';
import { translate } from '@shared/i18n';
import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, dialog, ipcMain, Menu, MenuItem, type WebContents } from 'electron';
import {
  clearPickedAttachmentPaths,
  type PickedAttachmentGrant,
  registerPickedAttachmentPaths,
} from '../services/files/PickedAttachmentAccess';
import { getCurrentLocale } from '../services/i18n';

interface ContextMenuItem {
  label: string;
  id: string;
  type?: 'normal' | 'separator';
  disabled?: boolean;
}

interface OpenFileDialogOptions {
  filters?: Array<{ name: string; extensions: string[] }>;
}

/**
 * D4: owners whose picked-path grants are already wired to a destroy handler.
 *
 * Same shape as `files.ts`'s `ensureFileOwnerCleanup`, kept local because the
 * grants are ISSUED here — a permission and the teardown that revokes it
 * should not live in two different modules.
 */
const pickedPathOwners = new Set<number>();

function ensurePickedPathCleanup(sender: WebContents): void {
  const ownerId = sender.id;
  if (pickedPathOwners.has(ownerId)) return;

  pickedPathOwners.add(ownerId);
  // Round-5 S2: a reload (F5, a crash recovery, any navigation) keeps the same
  // WebContents id but throws away the renderer state that was going to spend
  // these grants. Anything still outstanding belongs to a page that no longer
  // exists, so it is revoked here rather than left for the TTL to reap.
  sender.on('did-start-navigation', () => {
    clearPickedAttachmentPaths(ownerId);
  });
  sender.once('destroyed', () => {
    pickedPathOwners.delete(ownerId);
    clearPickedAttachmentPaths(ownerId);
  });
}

/**
 * Fingerprint each picked path so the read can prove it got the same file.
 *
 * A path that cannot be stat'ed gets NO grant: the read would have nothing to
 * verify against, and a grant that verifies nothing is exactly the shape this
 * mechanism exists to avoid. Such a path is still returned to the renderer,
 * which will get an ordinary "could not read" skip line for it — silently
 * dropping a file the user picked would be worse than a truthful failure.
 *
 * Directories are deliberately NOT filtered out here: they carry a snapshot
 * like anything else, and the read refuses them with `not-a-file`, which is a
 * more honest sentence than the `not-allowed` an absent grant would produce.
 */
async function snapshotPickedPaths(paths: readonly string[]): Promise<PickedAttachmentGrant[]> {
  const grants: PickedAttachmentGrant[] = [];
  for (const filePath of paths) {
    try {
      const stats = await stat(filePath);
      grants.push({
        path: filePath,
        snapshot: {
          dev: stats.dev,
          ino: stats.ino,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        },
      });
    } catch {
      // No snapshot, no grant.
    }
  }
  return grants;
}

export function registerDialogHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_DIRECTORY, async (event) => {
    const window =
      BrowserWindow.fromWebContents(event.sender) ??
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows()[0];
    const t = (key: string) => translate(getCurrentLocale(), key);
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: t('Select folder'),
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle(
    IPC_CHANNELS.DIALOG_OPEN_FILE,
    async (event, options?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
      const window =
        BrowserWindow.fromWebContents(event.sender) ??
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows()[0];
      const t = (key: string) => translate(getCurrentLocale(), key);
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        title: t('Select file'),
        filters: options?.filters,
      });

      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }

      return result.filePaths[0];
    }
  );

  /**
   * D4: multi-select picker for Composer attachments.
   *
   * Deliberately a SECOND channel rather than an option on DIALOG_OPEN_FILE:
   * that one returns `string | null` and its existing caller
   * (`AppearanceSettings`) reads the value directly, so widening its return
   * type would be a silent breaking change for a feature that has nothing to
   * do with attachments.
   *
   * Cancel returns `[]` — never `null` — so the renderer's "no side effects on
   * cancel" path is a plain length check, and no grants are issued.
   */
  ipcMain.handle(
    IPC_CHANNELS.DIALOG_OPEN_FILES,
    async (event, options?: OpenFileDialogOptions): Promise<string[]> => {
      const window =
        BrowserWindow.fromWebContents(event.sender) ??
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows()[0];
      const t = (key: string) => translate(getCurrentLocale(), key);
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile', 'multiSelections'],
        title: t('Select files'),
        filters: options?.filters,
      });

      if (result.canceled || result.filePaths.length === 0) {
        return [];
      }

      // The grant is issued HERE, by the main process, off the dialog's own
      // result — the renderer never gets to nominate what it may read. It is
      // a grant for these FILES, not for these NAMES: the snapshot taken now
      // is what the read verifies its fd against.
      ensurePickedPathCleanup(event.sender);
      registerPickedAttachmentPaths(await snapshotPickedPaths(result.filePaths), event.sender.id);

      return result.filePaths;
    }
  );

  // Context Menu
  ipcMain.handle(IPC_CHANNELS.CONTEXT_MENU_SHOW, async (event, items: ContextMenuItem[]) => {
    return new Promise<string | null>((resolve) => {
      const menu = new Menu();

      for (const item of items) {
        if (item.type === 'separator') {
          menu.append(new MenuItem({ type: 'separator' }));
        } else {
          menu.append(
            new MenuItem({
              label: item.label,
              enabled: !item.disabled,
              click: () => resolve(item.id),
            })
          );
        }
      }

      menu.popup({
        window: BrowserWindow.fromWebContents(event.sender) ?? undefined,
        callback: () => resolve(null),
      });
    });
  });
}
