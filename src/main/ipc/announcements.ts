import type { AnnouncementsResult } from '@shared/announcements';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { getAnnouncementService } from '../services/announcements';

function readIdList(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

/**
 * F09 — the three announcement channels.
 *
 * None of them rejects. An announcement failing is not an error the renderer
 * should have to handle with a `catch`: the result record already carries
 * `source: 'unavailable'` and a reason, and a rejected promise here would turn
 * "the message board is offline" into an unhandled rejection in the shell.
 */
export function registerAnnouncementHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.ANNOUNCEMENTS_GET,
    async (): Promise<AnnouncementsResult> => getAnnouncementService().snapshot()
  );

  ipcMain.handle(
    IPC_CHANNELS.ANNOUNCEMENTS_REFRESH,
    async (): Promise<AnnouncementsResult> => getAnnouncementService().refresh()
  );

  ipcMain.handle(
    IPC_CHANNELS.ANNOUNCEMENTS_MARK_READ,
    async (_event, payload: unknown): Promise<AnnouncementsResult> => {
      const service = getAnnouncementService();
      service.markRead(readIdList(payload));
      return service.snapshot();
    }
  );
}
