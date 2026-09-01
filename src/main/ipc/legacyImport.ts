import { IPC_CHANNELS, isLegacyImportBatchRequest, isLegacyImportPathSegment } from '@shared/types';
import { ipcMain } from 'electron';
import { legacyImportService } from '../services/legacyImport/LegacyImportService';

export function registerLegacyImportHandlers(): void {
  void legacyImportService.reconcile().catch((error) => {
    console.warn('[legacy-import] Startup reconciliation failed:', error);
  });
  ipcMain.handle(IPC_CHANNELS.LEGACY_IMPORT_LIST_PROJECTS, async () => {
    return legacyImportService.listProjects();
  });

  ipcMain.handle(IPC_CHANNELS.LEGACY_IMPORT_LIST_SESSIONS, async (_event, projectId) => {
    if (!isLegacyImportPathSegment(projectId)) {
      throw new Error('Invalid legacy import project id');
    }
    return legacyImportService.listSessions(projectId);
  });

  ipcMain.handle(IPC_CHANNELS.LEGACY_IMPORT_BATCH, async (_event, request) => {
    if (!isLegacyImportBatchRequest(request)) {
      throw new Error('Invalid legacy import batch request');
    }
    return legacyImportService.importBatch(request.sources);
  });
}
