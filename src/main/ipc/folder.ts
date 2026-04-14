import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';

function isGitRepoRoot(folderPath: string): boolean {
  const resolved = path.resolve(folderPath);
  try {
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  return existsSync(path.join(resolved, '.git'));
}

export function registerFolderHandlers(): void {
  ipcMain.handle('folder:checkType', async (_, folderPath: string) => {
    return isGitRepoRoot(folderPath);
  });
}

