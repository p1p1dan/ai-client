import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { isRemoteVirtualPath } from '@shared/utils/remotePath';

/**
 * T5 — which paths `file:openWithSystemViewer` may hand to `shell.openPath`.
 *
 * `shell.openPath` runs whatever the OS associates with the file, and for an
 * executable that means RUNNING it. The channel exists for one button — the
 * image / PDF preview's "Open with system viewer" when the in-app preview
 * cannot load the file — so it accepts exactly that: an existing regular file
 * whose own name AND whose resolved target both carry a preview extension.
 * Workspace containment is deliberately NOT required: the fallback exists for
 * files outside the workspace (the `local-file://` handler refuses those).
 *
 * The list mirrors `renderer/components/files/fileIcons.tsx`'s image
 * extensions plus PDF — the two preview components that render the button.
 */
export const SYSTEM_VIEWER_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.pdf',
]);

export interface SystemViewerTargetDeps {
  realpath: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isFile(): boolean }>;
}

const defaultDeps: SystemViewerTargetDeps = { realpath, stat };

function hasViewerExtension(path: string): boolean {
  return SYSTEM_VIEWER_EXTENSIONS.has(extname(path).toLowerCase());
}

/** The real path to open, or `null` when the request must be refused. */
export async function resolveSystemViewerTarget(
  filePath: unknown,
  deps: SystemViewerTargetDeps = defaultDeps
): Promise<string | null> {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    return null;
  }
  if (isRemoteVirtualPath(filePath) || !isAbsolute(filePath)) return null;
  if (!hasViewerExtension(filePath)) return null;

  let real: string;
  try {
    real = await deps.realpath(filePath);
  } catch {
    return null;
  }
  // A `photo.png` symlink pointing at a program must not launch the program.
  if (!hasViewerExtension(real)) return null;

  try {
    return (await deps.stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}
