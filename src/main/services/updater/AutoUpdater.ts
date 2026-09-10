import { is } from '@electron-toolkit/utils';
import type { ProxySettings } from '@shared/types';
import type { UpdateStatus } from '@shared/types/updater';
import type { BrowserWindow } from 'electron';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import { applyProxy, registerUpdaterSession } from '../proxy/ProxyConfig';

export type { UpdateStatus } from '@shared/types/updater';

const { autoUpdater } = electronUpdater;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MIN_FOCUS_CHECK_INTERVAL_MS = 30 * 60 * 1000;

function updateInfo(info: UpdateInfo): NonNullable<UpdateStatus['info']> {
  return {
    version: info.version,
    ...(typeof info.releaseNotes === 'string' ? { releaseNotes: info.releaseNotes } : {}),
  };
}

export class AutoUpdaterService {
  private mainWindow: BrowserWindow | null = null;
  private status: UpdateStatus = { status: 'idle' };
  private _isQuittingForUpdate = false;
  private checkIntervalId: NodeJS.Timeout | null = null;
  private initialCheckId: NodeJS.Timeout | null = null;
  private lastCheckTime = 0;
  private checkPromise: Promise<void> | null = null;
  private downloadPromise: Promise<void> | null = null;
  private removeListeners: (() => void) | null = null;

  init(
    window: BrowserWindow,
    autoUpdateEnabled = true,
    proxySettings?: ProxySettings | null
  ): void {
    this.cleanup();
    this.mainWindow = window;
    registerUpdaterSession(autoUpdater.netSession);
    if (proxySettings) {
      void applyProxy(proxySettings).catch((error) =>
        console.error('Failed to seed proxy settings:', error)
      );
    }
    if (is.dev) autoUpdater.logger = console;

    const checking = () => this.sendStatus({ status: 'checking' });
    const available = (info: UpdateInfo) =>
      this.sendStatus({ status: 'available', info: updateInfo(info) });
    const notAvailable = (info: UpdateInfo) =>
      this.sendStatus({ status: 'not-available', info: updateInfo(info) });
    const progress = (value: NonNullable<UpdateStatus['progress']>) =>
      this.sendStatus({
        status: 'downloading',
        info: this.status.info,
        progress: {
          percent: value.percent,
          bytesPerSecond: value.bytesPerSecond,
          total: value.total,
          transferred: value.transferred,
        },
      });
    const downloaded = (info: UpdateInfo) => {
      this.stopChecks();
      this.sendStatus({ status: 'downloaded', info: updateInfo(info) });
    };
    const failed = (error: Error) =>
      this.sendStatus({ status: 'error', info: this.status.info, error: error.message });
    const focus = () => {
      if (Date.now() - this.lastCheckTime >= MIN_FOCUS_CHECK_INTERVAL_MS)
        void this.checkForUpdates();
    };
    autoUpdater.on('checking-for-update', checking);
    autoUpdater.on('update-available', available);
    autoUpdater.on('update-not-available', notAvailable);
    autoUpdater.on('download-progress', progress);
    autoUpdater.on('update-downloaded', downloaded);
    autoUpdater.on('error', failed);
    window.on('focus', focus);
    this.removeListeners = () => {
      autoUpdater.off('checking-for-update', checking);
      autoUpdater.off('update-available', available);
      autoUpdater.off('update-not-available', notAvailable);
      autoUpdater.off('download-progress', progress);
      autoUpdater.off('update-downloaded', downloaded);
      autoUpdater.off('error', failed);
      window.off('focus', focus);
    };
    this.setAutoUpdateEnabled(autoUpdateEnabled);
    if (!this.isUpdateDownloaded()) {
      this.checkIntervalId = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
      this.initialCheckId = setTimeout(() => {
        this.initialCheckId = null;
        void this.checkForUpdates();
      }, 3000);
    }
  }

  private stopChecks(): void {
    if (this.checkIntervalId) clearInterval(this.checkIntervalId);
    if (this.initialCheckId) clearTimeout(this.initialCheckId);
    this.checkIntervalId = null;
    this.initialCheckId = null;
  }

  cleanup(): void {
    this.stopChecks();
    this.removeListeners?.();
    this.removeListeners = null;
    this.mainWindow = null;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  private sendStatus(status: UpdateStatus): void {
    if (this.isUpdateDownloaded() && status.status !== 'downloaded') return;
    this.status = status;
    if (this.mainWindow && !this.mainWindow.isDestroyed())
      this.mainWindow.webContents.send('updater:status', status);
  }

  async checkForUpdates(): Promise<void> {
    if (this.isUpdateDownloaded() || this.status.status === 'downloading') return;
    if (this.checkPromise) return this.checkPromise;
    this.lastCheckTime = Date.now();
    this.checkPromise = autoUpdater
      .checkForUpdates()
      .then(() => {})
      .catch((error: unknown) => {
        this.sendStatus({
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.checkPromise = null;
      });
    return this.checkPromise;
  }

  async downloadUpdate(): Promise<void> {
    if (this.isUpdateDownloaded() || this.status.status === 'downloading') return;
    if (this.downloadPromise) return this.downloadPromise;
    this.sendStatus({ status: 'downloading', info: this.status.info });
    this.downloadPromise = autoUpdater
      .downloadUpdate()
      .then(() => {})
      .catch((error: unknown) => {
        this.sendStatus({
          status: 'error',
          info: this.status.info,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.downloadPromise = null;
      });
    return this.downloadPromise;
  }

  quitAndInstall(): void {
    if (this.isUpdateDownloaded()) {
      this._isQuittingForUpdate = true;
      autoUpdater.quitAndInstall();
    }
  }

  isUpdateDownloaded(): boolean {
    return this.status.status === 'downloaded';
  }
  isQuittingForUpdate(): boolean {
    return this._isQuittingForUpdate;
  }

  setAutoUpdateEnabled(enabled: boolean): void {
    autoUpdater.autoDownload = enabled;
    autoUpdater.autoInstallOnAppQuit = enabled;
  }
}

export const autoUpdaterService = new AutoUpdaterService();
