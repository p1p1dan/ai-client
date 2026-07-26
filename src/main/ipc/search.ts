import type { ContentSearchParams, FileSearchPage, FileSearchParams } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { isRemoteVirtualPath } from '../services/remote/RemotePath';
import { remoteRepositoryBackend } from '../services/remote/RemoteRepositoryBackend';
import { searchService } from '../services/search/SearchService';

export function registerSearchHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SEARCH_FILES, async (_, params: FileSearchParams) => {
    if (isRemoteVirtualPath(params.rootPath)) {
      // The remote helper is a separately-deployed script that still returns a
      // bare array (and no directory entries) — wrap it here so the IPC contract
      // is uniform without requiring a remote redeploy. `total` degrades to the
      // page length, i.e. "no truncation known", which is the honest answer.
      const items = await remoteRepositoryBackend.searchFiles(
        params.rootPath,
        params.query,
        params.maxResults
      );
      return { items, total: items.length, truncated: false } satisfies FileSearchPage;
    }
    return searchService.searchFiles(params);
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_CONTENT, async (_, params: ContentSearchParams) => {
    if (isRemoteVirtualPath(params.rootPath)) {
      return remoteRepositoryBackend.searchContent(params);
    }
    const results = await searchService.searchContent(params);
    return results;
  });
}
