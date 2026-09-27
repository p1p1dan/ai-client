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

/**
 * How long an install waits for the chat engine to stop (dsh-rebase decision
 * 025 rule 4). A graceful host stop takes 3.5 s at worst before SIGKILL; past
 * this the install goes ahead and app quit's own cleanup is the second guard.
 */
export const STOP_ENGINE_BEFORE_INSTALL_MS = 5_000;

/**
 * Chat sessions first, then the shared DSH host they run on, as app quit does
 * (`ipc/workerManager.ts`). The host stop is awaited on its own: the manager's
 * lifecycle queue may be busy with a slow open, and the host must be gone
 * either way.
 */
async function stopChatEngine(): Promise<void> {
  const [{ workerManager }, { dshHostSupervisor }] = await Promise.all([
    import('../agent-host/WorkerManager'),
    import('../agent-host/DshHostSupervisor'),
  ]);
  void workerManager.disposeAll('app-shutdown').catch((error: unknown) => {
    console.warn('[updater] chat sessions did not all close before the install:', error);
  });
  await dshHostSupervisor.shutdown('app-quit');
}

export interface AutoUpdaterServiceOptions {
  /**
   * Stops what holds files of the install directory open. The DSH host loads
   * `koffi.node` and `conpty.node` in place, so NSIS cannot overwrite them
   * while it runs (dsh-rebase decision 025 rule 4).
   */
  stopBeforeInstall?: () => Promise<void>;
  stopBeforeInstallTimeoutMs?: number;
}

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
  private installPromise: Promise<void> | null = null;
  private removeListeners: (() => void) | null = null;
  private readonly stopBeforeInstall: () => Promise<void>;
  private readonly stopBeforeInstallTimeoutMs: number;

  constructor(options: AutoUpdaterServiceOptions = {}) {
    this.stopBeforeInstall = options.stopBeforeInstall ?? stopChatEngine;
    this.stopBeforeInstallTimeoutMs =
      options.stopBeforeInstallTimeoutMs ?? STOP_ENGINE_BEFORE_INSTALL_MS;
  }

  init(
    window: BrowserWindow,
    autoUpdateEnabled = true,
    proxySettings?: ProxySettings | null
  ): void {
    this.cleanup();
    this.mainWindow = window;
    // Pin the STABLE channel regardless of what this build's own version looks
    // like. electron-updater derives `allowPrerelease` from
    // `hasPrereleaseComponents(currentVersion)` (AppUpdater.js:218), so a
    // `1.0.0-test.20` build turns it ON and then walks the releases feed
    // looking for a tag whose PRERELEASE COMPONENT matches its own ("test"):
    //
    //   const currentChannel = semver.prerelease(currentVersion)?.[0]  // "test"
    //   const isNextPreRelease = hrefChannel && hrefChannel === currentChannel
    //
    // No published tag is spelled `*-test.*`, so `tag` stays null and the
    // provider throws ERR_UPDATER_NO_PUBLISHED_VERSIONS — 「No published
    // versions on GitHub」 — even though v1.0.1 is published and marked latest.
    // Every 1.0.0-test.* tester package hit exactly this, which is why none of
    // them ever saw 1.0.1.
    //
    // This is the ONLY lever that reaches testers already in the field: the
    // app checks for updates, so the channel decision has to be made here, in
    // a build they install. Release-side workarounds do not exist — tagging a
    // `v1.0.0-test.21` would satisfy `isNextPreRelease` for them, but it would
    // also have to carry a `latest.yml`, and that release would then be served
    // to every stable install as the newest stable version.
    //
    // Forcing it also removes the silent downgrade hazard the option carries
    // on purpose: with `allowPrerelease` true the updater is permitted to move
    // a test build onto any stable tag, `allowDowngrade` and all. Stable
    // installs (0.3.4, 1.0.1) already resolve this way; this makes the test
    // builds agree with them instead of diverging.
    autoUpdater.allowPrerelease = false;
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

  /**
   * Stops the chat engine, then quits and installs (decision 025 rule 4). Once
   * per download; never rejects, since the IPC caller does not await it.
   */
  quitAndInstall(): Promise<void> {
    if (!this.isUpdateDownloaded()) return Promise.resolve();
    this.installPromise ??= this.stopThenInstall();
    return this.installPromise;
  }

  private async stopThenInstall(): Promise<void> {
    this._isQuittingForUpdate = true;
    let timer: NodeJS.Timeout | null = null;
    const stopped = await Promise.race([
      this.stopBeforeInstall().then(
        () => true,
        (error: unknown) => {
          console.warn('[updater] stopping the chat engine before the install failed:', error);
          return true;
        }
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.stopBeforeInstallTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!stopped) {
      console.warn(
        `[updater] the chat engine did not stop within ${this.stopBeforeInstallTimeoutMs}ms; installing anyway`
      );
    }
    try {
      autoUpdater.quitAndInstall();
    } catch (error) {
      this.installPromise = null;
      this._isQuittingForUpdate = false;
      console.error('[updater] quitAndInstall failed:', error);
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
