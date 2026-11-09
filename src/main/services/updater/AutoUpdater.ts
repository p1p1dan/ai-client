import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import type { ProxySettings } from '@shared/types';
import { UPDATE_DOWNLOAD_STALLED, type UpdateStatus } from '@shared/types/updater';
import type { BrowserWindow } from 'electron';
import electronUpdater, {
  type CancellationToken,
  type UpdateCheckResult,
  type UpdateInfo,
} from 'electron-updater';
import {
  applyDirectUpdaterProxy,
  applyProxy,
  isProxyConnectionError,
  registerUpdaterSession,
} from '../proxy/ProxyConfig';

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
 * A download that receives nothing for this long is cancelled (decision 213).
 * builder-util-runtime arms its request timeout on the `socket` event, which
 * Electron's `net` requests never emit, so a stalled transfer would otherwise
 * hang for the rest of the session with every check queued behind it.
 * `UPDATE_DOWNLOAD_STALLED` names the same five minutes.
 */
export const DOWNLOAD_STALL_MS = 5 * 60 * 1000;
/** How often the stall watchdog looks at a running download. */
export const DOWNLOAD_WATCH_INTERVAL_MS = 30 * 1000;
/**
 * How long 「立即重启」 waits for the check it runs first (decision 213). When
 * the check fails or takes longer, the downloaded update installs as before.
 */
export const PRE_INSTALL_CHECK_MS = 10_000;

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

/**
 * Bytes in electron-updater's pending-download folder: the watchdog's second
 * sign of life, since a response without `content-length` emits no progress
 * events at all. The folder comes from an internal field; if a later release
 * moves it, this returns null and the watchdog goes by progress events alone.
 */
async function pendingDownloadBytes(): Promise<number | null> {
  const helper = (
    autoUpdater as unknown as {
      downloadedUpdateHelper?: { cacheDirForPendingUpdate?: unknown } | null;
    }
  ).downloadedUpdateHelper;
  const dir = helper?.cacheDirForPendingUpdate;
  if (typeof dir !== 'string') return null;
  try {
    let total = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile()) total += (await stat(join(dir, entry.name))).size;
    }
    return total;
  } catch {
    return null;
  }
}

export interface AutoUpdaterServiceOptions {
  /**
   * Stops what holds files of the install directory open. The DSH host loads
   * `koffi.node` and `conpty.node` in place, so NSIS cannot overwrite them
   * while it runs (dsh-rebase decision 025 rule 4).
   */
  stopBeforeInstall?: () => Promise<void>;
  stopBeforeInstallTimeoutMs?: number;
  /** Size of the download so far, for the stall watchdog; null when unknown. */
  downloadedBytes?: () => Promise<number | null>;
}

type ReleaseInfo = NonNullable<UpdateStatus['info']>;

function updateInfo(info: UpdateInfo): ReleaseInfo {
  return {
    version: info.version,
    ...(typeof info.releaseNotes === 'string' ? { releaseNotes: info.releaseNotes } : {}),
  };
}

function versionParts(version: string): { core: number[]; pre: string[] } {
  const [withoutBuild = ''] = version.trim().replace(/^v/i, '').split('+');
  const [release = '', ...tag] = withoutBuild.split('-');
  const pre = tag.join('-');
  return {
    core: release.split('.').map((part) => Number.parseInt(part, 10) || 0),
    pre: pre ? pre.split('.') : [],
  };
}

/**
 * Semver precedence of two versions, > 0 when `a` is newer. The feed offers
 * stable tags only (`allowPrerelease` is pinned off), but this build may be a
 * `-test.N` one, so prerelease identifiers are ordered as semver orders them.
 */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A release outranks its own prereleases.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pNumeric = /^\d+$/.test(p);
    const qNumeric = /^\d+$/.test(q);
    if (pNumeric && qNumeric) return Number(p) - Number(q);
    if (pNumeric !== qNumeric) return pNumeric ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

interface ActiveDownload {
  readonly token: CancellationToken;
  readonly info: ReleaseInfo | undefined;
  /** When a progress event last arrived or the bytes on disk last changed. */
  lastProgressAt: number;
  lastBytes: number | null;
  stalled: boolean;
}

export class AutoUpdaterService {
  private mainWindow: BrowserWindow | null = null;
  private status: UpdateStatus = { status: 'idle' };
  /**
   * The downloaded update while it is still the newest release the feed has
   * offered (decision 213). A newer release or a withdrawal clears it, and
   * only this one may be installed.
   */
  private ready: ReleaseInfo | null = null;
  /** The release the last check offered, which `downloadUpdate` fetches. */
  private offered: ReleaseInfo | null = null;
  private download: ActiveDownload | null = null;
  private autoUpdateEnabled = true;
  private _isQuittingForUpdate = false;
  private checkIntervalId: NodeJS.Timeout | null = null;
  private initialCheckId: NodeJS.Timeout | null = null;
  private watchdogId: NodeJS.Timeout | null = null;
  private lastCheckTime = 0;
  /** Set while a direct retry after a proxy failure is in flight (issue #10). */
  private proxyRetryAt: string | null = null;
  private checkPromise: Promise<void> | null = null;
  private downloadPromise: Promise<void> | null = null;
  private installPromise: Promise<void> | null = null;
  private removeListeners: (() => void) | null = null;
  private readonly stopBeforeInstall: () => Promise<void>;
  private readonly stopBeforeInstallTimeoutMs: number;
  private readonly downloadedBytes: () => Promise<number | null>;

  constructor(options: AutoUpdaterServiceOptions = {}) {
    this.stopBeforeInstall = options.stopBeforeInstall ?? stopChatEngine;
    this.stopBeforeInstallTimeoutMs =
      options.stopBeforeInstallTimeoutMs ?? STOP_ENGINE_BEFORE_INSTALL_MS;
    this.downloadedBytes = options.downloadedBytes ?? pendingDownloadBytes;
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
    // A failed differential rebuild (cached installer from a test build, or one
    // the encrypted-machine driver rewrote) falls back to a full download after
    // its progress already hit 100%, so users saw the download run twice.
    autoUpdater.disableDifferentialDownload = true;
    // Decision 213: this service starts every download (`afterCheck`). Checks
    // keep running once an update is ready, and electron-updater's in-session
    // cache test compares the whole UpdateInfo, release notes included, so its
    // own auto-download would fetch the ready installer again after any edit
    // to the release. Only a release newer than the ready one is downloaded.
    autoUpdater.autoDownload = false;
    registerUpdaterSession(autoUpdater.netSession);
    if (proxySettings) {
      void applyProxy(proxySettings).catch((error) =>
        console.error('Failed to seed proxy settings:', error)
      );
    }
    if (is.dev) autoUpdater.logger = console;

    const checking = () => {
      // While an update is ready, the reminder keeps showing it during checks.
      if (this._isQuittingForUpdate || this.ready) return;
      this.sendStatus({ status: 'checking' });
    };
    const available = (info: UpdateInfo) => {
      if (this._isQuittingForUpdate) return;
      const offered = updateInfo(info);
      this.offered = offered;
      if (this.ready) {
        // The ready release again, or an older one from a stale feed: keep it.
        if (compareVersions(offered.version, this.ready.version) <= 0) return;
        this.dropReady();
      }
      this.sendStatus({ status: 'available', info: offered });
    };
    const notAvailable = (info: UpdateInfo) => {
      if (this._isQuittingForUpdate) return;
      this.offered = null;
      // Nothing is newer than this build any more, so a ready update was
      // withdrawn: it must not install on quit either.
      this.dropReady();
      this.sendStatus({ status: 'not-available', info: updateInfo(info) });
    };
    const progress = (value: NonNullable<UpdateStatus['progress']>) => {
      const download = this.download;
      if (download) download.lastProgressAt = Date.now();
      this.sendStatus({
        status: 'downloading',
        info: download?.info ?? this.status.info,
        progress: {
          percent: value.percent,
          bytesPerSecond: value.bytesPerSecond,
          total: value.total,
          transferred: value.transferred,
        },
      });
    };
    const downloaded = (info: UpdateInfo) => {
      this.ready = updateInfo(info);
      this.syncAutoInstall();
      this.sendStatus({ status: 'downloaded', info: this.ready });
    };
    const failed = (error: Error) => this.handleFailure(error);
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
    // Decision 213: checks go on after a download as well, so a release that
    // ships meanwhile replaces the ready one instead of waiting for a restart.
    this.checkIntervalId = setInterval(() => void this.checkForUpdates(), CHECK_INTERVAL_MS);
    this.initialCheckId = setTimeout(() => {
      this.initialCheckId = null;
      void this.checkForUpdates();
    }, 3000);
    if (this.download) this.startWatchdog();
  }

  private stopChecks(): void {
    if (this.checkIntervalId) clearInterval(this.checkIntervalId);
    if (this.initialCheckId) clearTimeout(this.initialCheckId);
    this.checkIntervalId = null;
    this.initialCheckId = null;
  }

  cleanup(): void {
    this.stopChecks();
    this.stopWatchdog();
    this.removeListeners?.();
    this.removeListeners = null;
    this.mainWindow = null;
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  private sendStatus(status: UpdateStatus): void {
    this.status = status;
    if (this.mainWindow && !this.mainWindow.isDestroyed())
      this.mainWindow.webContents.send('updater:status', status);
  }

  async checkForUpdates(): Promise<void> {
    // A running download holds checks back; the stall watchdog bounds how long.
    if (this.download || this._isQuittingForUpdate) return;
    if (this.checkPromise) return this.checkPromise;
    this.lastCheckTime = Date.now();
    this.checkPromise = autoUpdater
      .checkForUpdates()
      .then((result) => {
        // A check that came back at all means the proxy question is settled.
        this.proxyRetryAt = null;
        this.afterCheck(result);
      })
      .catch((error: unknown) =>
        // Same path as the `error` event (issue #10): `checkForUpdates`
        // rejects as well as emitting, and only one of the two may decide to
        // retry.
        this.handleFailure(error instanceof Error ? error : new Error(String(error)))
      )
      .finally(() => {
        this.checkPromise = null;
      });
    return this.checkPromise;
  }

  /**
   * Starts the download a check calls for (decision 213): automatic updates
   * are on and the release is newer than any ready one. `available` has
   * already cleared `ready` when the offer supersedes it.
   */
  private afterCheck(result: UpdateCheckResult | null): void {
    if (result?.isUpdateAvailable && this.autoUpdateEnabled && !this.ready)
      void this.downloadUpdate();
  }

  /**
   * Issue #10: one direct retry when the failure says the configured proxy is
   * unreachable, then the real error.
   *
   * The updater check runs either through the system proxy (the in-app switch
   * off, or 「更新也走代理」 unchecked) or through ours. In both cases a proxy that
   * the setting still names but that is no longer running produces
   * `ERR_PROXY_CONNECTION_FAILED` and no request at all — a dead end for the
   * user, whose only visible symptom is a red 「检查失败」 and no way to know a
   * direct attempt would have worked.
   *
   * Only the check takes this path. Download and install are started by an
   * explicit button press on a version the check already proved reachable, so
   * re-plumbing the session under them would be a surprise, not a rescue.
   * `proxyRetryAt` is cleared before the retry and set only on failure, so a
   * proxy that stays broken costs one retry per check, not one per check plus
   * one per error event.
   */
  private async handleFailure(error: Error): Promise<void> {
    if (this.proxyRetryAt === null && isProxyConnectionError(error)) {
      this.proxyRetryAt = error.message;
      try {
        await applyDirectUpdaterProxy();
        this.afterCheck(await autoUpdater.checkForUpdates());
        return;
      } catch (retryError) {
        console.warn('[updater] the direct retry after a proxy failure also failed:', retryError);
      }
    }
    const message = this.proxyRetryAt === null ? error.message : `${error.message} (proxy)`;
    this.proxyRetryAt = null;
    this.reportError(message);
  }

  /**
   * A failure never replaces an update that is ready (decision 213): a check
   * that could not reach the feed says nothing against the installer.
   */
  private reportError(message: string): void {
    if (this.ready) {
      console.warn('[updater] update check failed; the downloaded update stays ready:', message);
      return;
    }
    this.sendStatus({
      status: 'error',
      info: this.download?.info ?? this.status.info,
      error: message,
    });
  }

  async downloadUpdate(): Promise<void> {
    if (this.ready || this._isQuittingForUpdate) return;
    if (this.downloadPromise) return this.downloadPromise;
    const download: ActiveDownload = {
      token: new electronUpdater.CancellationToken(),
      info: this.offered ?? this.status.info,
      lastProgressAt: Date.now(),
      lastBytes: null,
      stalled: false,
    };
    this.download = download;
    this.sendStatus({ status: 'downloading', info: download.info });
    this.startWatchdog();
    this.downloadPromise = autoUpdater
      .downloadUpdate(download.token)
      .then(() => {})
      .catch((error: unknown) => {
        this.reportError(
          download.stalled
            ? UPDATE_DOWNLOAD_STALLED
            : error instanceof Error
              ? error.message
              : String(error)
        );
      })
      .finally(() => {
        this.stopWatchdog();
        if (this.download === download) this.download = null;
        this.downloadPromise = null;
      });
    return this.downloadPromise;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogId = setInterval(() => void this.watchDownload(), DOWNLOAD_WATCH_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogId) clearInterval(this.watchdogId);
    this.watchdogId = null;
  }

  /**
   * Cancels the running download once neither a progress event nor a change
   * in the bytes on disk has been seen for `DOWNLOAD_STALL_MS` (decision 213).
   * The cancel rejects the download promise, which reports the stall with a
   * retry and lets checks run again.
   */
  private async watchDownload(): Promise<void> {
    const download = this.download;
    if (!download || download.stalled) return;
    const bytes = await this.downloadedBytes().catch(() => null);
    if (this.download !== download || download.stalled) return;
    const now = Date.now();
    if (bytes !== null) {
      if (download.lastBytes !== null && bytes !== download.lastBytes)
        download.lastProgressAt = now;
      download.lastBytes = bytes;
    }
    if (now - download.lastProgressAt < DOWNLOAD_STALL_MS) return;
    download.stalled = true;
    console.warn(
      `[updater] the download made no progress for ${DOWNLOAD_STALL_MS / 60_000} min; cancelling it`
    );
    download.token.cancel();
  }

  /**
   * Checks for a newer release, then stops the chat engine and installs
   * (decisions 025 rule 4 and 213). Once per download; never rejects, since
   * the IPC caller does not await it.
   */
  quitAndInstall(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    this.installPromise ??= this.checkThenInstall();
    return this.installPromise;
  }

  private async checkThenInstall(): Promise<void> {
    const version = this.ready?.version;
    await this.checkWithin(PRE_INSTALL_CHECK_MS);
    if (this.ready?.version !== version) {
      // A newer release (or a withdrawal) superseded this one meanwhile; the
      // reminder now shows that release instead.
      this.installPromise = null;
      return;
    }
    await this.stopThenInstall();
  }

  /** Waits for a check at most `ms`; the check itself runs on. */
  private async checkWithin(ms: number): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    await Promise.race([
      this.checkForUpdates(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private async stopThenInstall(): Promise<void> {
    // From here on, late check results are ignored and no download may start:
    // a newer download would empty the cache folder the installer runs from.
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
    return this.ready !== null;
  }
  isQuittingForUpdate(): boolean {
    return this._isQuittingForUpdate;
  }

  setAutoUpdateEnabled(enabled: boolean): void {
    this.autoUpdateEnabled = enabled;
    this.syncAutoInstall();
  }

  /**
   * Install-on-quit covers only an update that is ready (decision 213). While
   * a newer release is known but not downloaded yet, the superseded installer
   * may still sit in the cache, and quitting must not install it.
   */
  private syncAutoInstall(): void {
    autoUpdater.autoInstallOnAppQuit = this.autoUpdateEnabled && this.ready !== null;
  }

  private dropReady(): void {
    if (!this.ready) return;
    this.ready = null;
    this.syncAutoInstall();
  }
}

export const autoUpdaterService = new AutoUpdaterService();
