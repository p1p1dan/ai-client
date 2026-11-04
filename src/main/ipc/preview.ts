/**
 * Decision 209 §2: the session rail's Outputs card opens a web page the
 * conversation created in the app's preview window — the one
 * `browser_preview` uses (`PreviewWindowManager`: its own window, sandboxed,
 * no preload, reloading by itself when the file changes).
 *
 * The renderer names the file, so the channel takes only what the card needs:
 * an absolute local path to an existing `.html` / `.htm` file, checked again
 * after symlinks are resolved. Anything else is refused before a window opens.
 */
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { IPC_CHANNELS, type PreviewOpenHtmlResult } from '@shared/types';
import { isRemoteVirtualPath } from '@shared/utils/remotePath';
import { ipcMain } from 'electron';
import { previewWindowManager } from '../services/preview/PreviewWindowManager';

/** An absolute local path ending in `.html` / `.htm` (any case). */
export function isPreviewableHtmlPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  if (!isAbsolute(value) || isRemoteVirtualPath(value)) return false;
  const extension = extname(value).toLowerCase();
  return extension === '.html' || extension === '.htm';
}

export async function openHtmlPreview(
  value: unknown,
  show: (path: string) => Promise<void> = (path) => previewWindowManager.show({ path, focus: true })
): Promise<PreviewOpenHtmlResult> {
  if (!isPreviewableHtmlPath(value)) return { ok: false, reason: 'not-html' };
  let path: string;
  try {
    path = await realpath(value);
    if (!(await stat(path)).isFile()) return { ok: false, reason: 'missing' };
  } catch {
    return { ok: false, reason: 'missing' };
  }
  // A link named `page.html` must not open whatever it points at.
  if (!isPreviewableHtmlPath(path)) return { ok: false, reason: 'not-html' };
  try {
    await show(path);
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      reason: 'failed',
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function registerPreviewHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PREVIEW_OPEN_HTML, (_event, path: unknown) => openHtmlPreview(path));
}
