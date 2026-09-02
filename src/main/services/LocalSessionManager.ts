import {
  getSharedLocalStorageSnapshot,
  markLegacyLocalStorageMigrated,
  writeSharedLocalStorageSnapshot,
} from './SharedSessionState';

export class LocalSessionManager {
  getSessionState(): { localStorage: Record<string, string> } {
    return {
      localStorage: getSharedLocalStorageSnapshot(),
    };
  }

  syncLocalStorage(localStorage: Record<string, string>): void {
    writeSharedLocalStorageSnapshot(localStorage);
  }

  importLegacyLocalStorage(localStorage: Record<string, string>): void {
    writeSharedLocalStorageSnapshot(localStorage);
    markLegacyLocalStorageMigrated();
  }
}

export const localSessionManager = new LocalSessionManager();
