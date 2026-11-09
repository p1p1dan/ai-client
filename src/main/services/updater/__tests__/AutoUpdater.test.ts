import { EventEmitter } from 'node:events';
import { UPDATE_DOWNLOAD_STALLED } from '@shared/types/updater';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  /** The part of builder-util-runtime's CancellationToken the service uses. */
  class FakeCancellationToken {
    cancelled = false;
    private readonly handlers: Array<() => void> = [];
    cancel(): void {
      this.cancelled = true;
      for (const handler of this.handlers.splice(0)) handler();
    }
    onCancel(handler: () => void): void {
      if (this.cancelled) handler();
      else this.handlers.push(handler);
    }
  }
  return {
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    applyDirectUpdaterProxy: vi.fn(),
    isProxyConnectionError: vi.fn((error: unknown) =>
      /ERR_(PROXY|SOCKS)_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/i.test(
        error instanceof Error ? error.message : String(error ?? '')
      )
    ),
    CancellationToken: FakeCancellationToken,
  };
});
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('../../proxy/ProxyConfig', () => ({
  applyProxy: vi.fn(),
  registerUpdaterSession: vi.fn(),
  applyDirectUpdaterProxy: mocks.applyDirectUpdaterProxy,
  isProxyConnectionError: mocks.isProxyConnectionError,
}));
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: {
      autoUpdater: Object.assign(new EventEmitter(), {
        checkForUpdates: mocks.check,
        downloadUpdate: mocks.download,
        quitAndInstall: mocks.install,
        autoDownload: true,
        autoInstallOnAppQuit: false,
        allowPrerelease: true,
      }),
      CancellationToken: mocks.CancellationToken,
    },
  };
});

import electronUpdater from 'electron-updater';
import {
  AutoUpdaterService,
  compareVersions,
  DOWNLOAD_STALL_MS,
  DOWNLOAD_WATCH_INTERVAL_MS,
  PRE_INSTALL_CHECK_MS,
  STOP_ENGINE_BEFORE_INSTALL_MS,
} from '../AutoUpdater';

type FakeToken = InstanceType<typeof mocks.CancellationToken>;

const updater = electronUpdater.autoUpdater;
let service: AutoUpdaterService;
let stopEngine: ReturnType<typeof vi.fn<() => Promise<void>>>;
let window: EventEmitter & {
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: () => boolean;
};
beforeEach(() => {
  vi.useFakeTimers();
  mocks.check.mockReset().mockResolvedValue(null);
  mocks.download.mockReset().mockResolvedValue([]);
  mocks.install.mockReset();
  mocks.applyDirectUpdaterProxy.mockReset().mockResolvedValue(undefined);
  window = Object.assign(new EventEmitter(), {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
  });
  stopEngine = vi.fn(async () => undefined);
  service = new AutoUpdaterService({ stopBeforeInstall: stopEngine });
});
afterEach(() => {
  service.cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function release(version: string) {
  return { version, files: [], path: '', sha512: '', releaseDate: '' };
}

let feedVersion = '';

/** Every check from now on offers `version`, as the GitHub feed would. */
function offer(version: string): void {
  feedVersion = version;
  mocks.check.mockImplementation(async () => {
    updater.emit('checking-for-update');
    updater.emit('update-available', release(version));
    return { isUpdateAvailable: true, updateInfo: release(version), versionInfo: release(version) };
  });
}

/** Downloads finish at once with the version the feed offers at that moment. */
function serveDownloads(): void {
  mocks.download.mockImplementation(async () => {
    const version = feedVersion;
    updater.emit('update-downloaded', { ...release(version), downloadedFile: `/tmp/${version}` });
    return [`/tmp/${version}`];
  });
}

/** A download that never progresses and rejects only when cancelled. */
function stallDownloads(): FakeToken[] {
  const tokens: FakeToken[] = [];
  mocks.download.mockImplementation(
    (token: FakeToken) =>
      new Promise((_resolve, reject) => {
        tokens.push(token);
        token.onCancel(() => reject(new Error('cancelled')));
      })
  );
  return tokens;
}

/** Automatic updates on, release `version` downloaded by the startup check. */
async function readyWith(version: string): Promise<void> {
  service.init(window as unknown as BrowserWindow, true);
  offer(version);
  serveDownloads();
  await vi.advanceTimersByTimeAsync(3000);
  expect(service.getStatus()).toMatchObject({ status: 'downloaded', info: { version } });
}

describe('update reminders', () => {
  it('checks at startup and on focus with automatic download disabled', async () => {
    service.init(window as unknown as BrowserWindow, false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(updater.autoDownload).toBe(false);
    // The mock starts at `true` (what electron-updater derives for a
    // `1.0.0-test.*` build), so this passing proves `init` actively pins the
    // stable channel rather than inheriting it. Without the pin, a test build
    // walks the feed looking for a `-test.*` tag, finds none, and reports
    // 「No published versions on GitHub」 while v1.0.1 sits published.
    expect(updater.allowPrerelease).toBe(false);
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    window.emit('focus');
    await Promise.resolve();
    expect(mocks.check).toHaveBeenCalledTimes(2);
    service.setAutoUpdateEnabled(true);
    service.setAutoUpdateEnabled(false);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(mocks.check.mock.calls.length).toBeGreaterThan(2);
  });
  it('exposes download failures and allows retry', async () => {
    service.init(window as unknown as BrowserWindow, false);
    updater.emit('update-available', release('2'));
    mocks.download.mockRejectedValueOnce(new Error('offline'));
    await service.downloadUpdate();
    expect(service.getStatus()).toMatchObject({
      status: 'error',
      error: 'offline',
      info: { version: '2' },
    });
    await service.downloadUpdate();
    expect(mocks.download).toHaveBeenCalledTimes(2);
  });
  it('deduplicates checks and removes timers/listeners on cleanup', async () => {
    service.init(window as unknown as BrowserWindow, false);
    let finish!: () => void;
    mocks.check.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const first = service.checkForUpdates();
    const second = service.checkForUpdates();
    expect(mocks.check).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    service.cleanup();
    expect(window.listenerCount('focus')).toBe(0);
    expect(updater.listenerCount('update-available')).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(mocks.check).toHaveBeenCalledOnce();
  });
});

/**
 * Decision 213. Until 1.2.2 the service stopped checking once an update was
 * downloaded, so 1.0.4 clients that had fetched 1.2.1 kept offering it after
 * 1.2.2 shipped, installed it on quit, and needed a second update.
 */
describe('a downloaded update keeps being checked (decision 213)', () => {
  it('keeps the interval, focus and manual checks; the same release stays ready', async () => {
    await readyWith('2.0.0');
    expect(updater.autoInstallOnAppQuit).toBe(true);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    window.emit('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.check).toHaveBeenCalledTimes(3);
    await service.checkForUpdates();
    expect(mocks.check).toHaveBeenCalledTimes(4);
    // electron-updater never downloads on its own, and the ready release is
    // not fetched again: its in-session cache test would miss after any edit
    // to the release notes.
    expect(updater.autoDownload).toBe(false);
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(service.getStatus()).toMatchObject({ status: 'downloaded', info: { version: '2.0.0' } });
    // The reminder keeps showing the ready release while a check runs.
    const statuses = window.webContents.send.mock.calls.map(([, status]) => status.status);
    expect(statuses.slice(statuses.indexOf('downloaded'))).not.toContain('checking');
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('downloads a newer release and never installs the superseded one meanwhile', async () => {
    await readyWith('2.0.0');
    offer('2.1.0');
    let finish!: () => void;
    mocks.download.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => {
            updater.emit('update-downloaded', {
              ...release('2.1.0'),
              downloadedFile: '/tmp/2.1.0',
            });
            resolve(['/tmp/2.1.0']);
          };
        })
    );
    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({
      status: 'downloading',
      info: { version: '2.1.0' },
    });
    expect(service.isUpdateDownloaded()).toBe(false);
    // electron-updater empties its cache folder when the newer download starts
    // and would otherwise install whatever installer it still points at.
    expect(updater.autoInstallOnAppQuit).toBe(false);
    await service.quitAndInstall();
    expect(stopEngine).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getStatus()).toMatchObject({ status: 'downloaded', info: { version: '2.1.0' } });
    expect(updater.autoInstallOnAppQuit).toBe(true);
    await service.quitAndInstall();
    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it('keeps the ready release on a stale feed and on a failed check', async () => {
    await readyWith('2.0.0');
    offer('1.9.0');
    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({ status: 'downloaded', info: { version: '2.0.0' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.check.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({ status: 'downloaded', info: { version: '2.0.0' } });
    expect(warn).toHaveBeenCalled();
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('with automatic updates off, offers the newer release instead of downloading it', async () => {
    service.init(window as unknown as BrowserWindow, false);
    offer('2.0.0');
    serveDownloads();
    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({ status: 'available', info: { version: '2.0.0' } });
    expect(mocks.download).not.toHaveBeenCalled();
    await service.downloadUpdate();
    expect(service.getStatus()).toMatchObject({ status: 'downloaded', info: { version: '2.0.0' } });
    expect(updater.autoInstallOnAppQuit).toBe(false);
    offer('2.1.0');
    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({ status: 'available', info: { version: '2.1.0' } });
    expect(service.isUpdateDownloaded()).toBe(false);
    expect(mocks.download).toHaveBeenCalledOnce();
  });

  it('drops a ready release the feed withdrew', async () => {
    await readyWith('2.0.0');
    mocks.check.mockImplementation(async () => {
      updater.emit('update-not-available', release('1.0.0'));
      return {
        isUpdateAvailable: false,
        updateInfo: release('1.0.0'),
        versionInfo: release('1.0.0'),
      };
    });
    await service.checkForUpdates();
    expect(service.getStatus().status).toBe('not-available');
    expect(service.isUpdateDownloaded()).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    await service.quitAndInstall();
    expect(mocks.install).not.toHaveBeenCalled();
  });
});

describe('Restart now checks for a newer release first (decision 213)', () => {
  it('does not install a release that a newer one superseded', async () => {
    await readyWith('2.0.0');
    offer('2.1.0');
    stallDownloads();
    await service.quitAndInstall();
    expect(stopEngine).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(service.isQuittingForUpdate()).toBe(false);
    expect(service.getStatus()).toMatchObject({
      status: 'downloading',
      info: { version: '2.1.0' },
    });
  });

  it('installs the ready release when the check takes too long, and ignores what it says later', async () => {
    await readyWith('2.0.0');
    let answer!: () => void;
    mocks.check.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => {
            updater.emit('update-available', release('2.1.0'));
            resolve({ isUpdateAvailable: true, updateInfo: release('2.1.0') });
          };
        })
    );
    const installing = service.quitAndInstall();
    await vi.advanceTimersByTimeAsync(PRE_INSTALL_CHECK_MS - 1);
    expect(stopEngine).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await installing;
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledOnce();
    // A newer download now would empty the folder the installer runs from.
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.download).toHaveBeenCalledOnce();
    expect(service.getStatus()).toMatchObject({ status: 'downloaded', info: { version: '2.0.0' } });
  });

  it('installs the ready release when the check fails', async () => {
    await readyWith('2.0.0');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.check.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await service.quitAndInstall();
    expect(mocks.install).toHaveBeenCalledOnce();
  });
});

describe('a download that makes no progress is cancelled (decision 213)', () => {
  it('reports the stall with a retry and lets checks run again', async () => {
    service.init(window as unknown as BrowserWindow, true);
    offer('2.0.0');
    const tokens = stallDownloads();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.getStatus()).toMatchObject({
      status: 'downloading',
      info: { version: '2.0.0' },
    });
    // Checks wait for the running download, which used to hang forever.
    await service.checkForUpdates();
    expect(mocks.check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - DOWNLOAD_WATCH_INTERVAL_MS);
    expect(tokens[0].cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * DOWNLOAD_WATCH_INTERVAL_MS);
    expect(tokens[0].cancelled).toBe(true);
    expect(service.getStatus()).toMatchObject({
      status: 'error',
      error: UPDATE_DOWNLOAD_STALLED,
      info: { version: '2.0.0' },
    });
    await service.checkForUpdates();
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.download).toHaveBeenCalledTimes(2);
    expect(UPDATE_DOWNLOAD_STALLED).toContain(`${DOWNLOAD_STALL_MS / 60_000} minutes`);
  });

  it('counts progress events as life', async () => {
    service.init(window as unknown as BrowserWindow, false);
    updater.emit('update-available', release('2.0.0'));
    const tokens = stallDownloads();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    void service.downloadUpdate();
    for (let minute = 0; minute < 10; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      updater.emit('download-progress', {
        percent: minute * 10,
        bytesPerSecond: 1,
        total: 100,
        transferred: minute * 10,
        delta: 10,
      });
    }
    expect(tokens[0].cancelled).toBe(false);
    expect(service.getStatus()).toMatchObject({
      status: 'downloading',
      info: { version: '2.0.0' },
      progress: { percent: 90 },
    });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS + DOWNLOAD_WATCH_INTERVAL_MS);
    expect(tokens[0].cancelled).toBe(true);
  });

  it('counts growth on disk as life when no progress events come', async () => {
    let bytes = 0;
    service = new AutoUpdaterService({
      stopBeforeInstall: stopEngine,
      downloadedBytes: async () => bytes,
    });
    service.init(window as unknown as BrowserWindow, false);
    updater.emit('update-available', release('2.0.0'));
    const tokens = stallDownloads();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    void service.downloadUpdate();
    for (let tick = 0; tick < 20; tick++) {
      bytes += 1024;
      await vi.advanceTimersByTimeAsync(DOWNLOAD_WATCH_INTERVAL_MS);
    }
    expect(tokens[0].cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS + DOWNLOAD_WATCH_INTERVAL_MS);
    expect(tokens[0].cancelled).toBe(true);
  });
});

/** dsh-rebase P1-3d (decision 025 rule 4): the DSH host holds native addons of the install dir. */
describe('install waits for the chat engine to stop', () => {
  function downloaded(): void {
    service.init(window as unknown as BrowserWindow, false);
    updater.emit('update-downloaded', { ...release('2.0.0'), downloadedFile: '/tmp/update' });
  }

  it('does nothing before a download', async () => {
    await service.quitAndInstall();
    expect(stopEngine).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    expect(service.isQuittingForUpdate()).toBe(false);
  });

  it('installs only once the engine has stopped, and only once when asked twice', async () => {
    downloaded();
    let stopped!: () => void;
    stopEngine.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          stopped = resolve;
        })
    );
    const first = service.quitAndInstall();
    const second = service.quitAndInstall();
    // The check that runs first (decision 213) comes back empty here.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(service.isQuittingForUpdate()).toBe(true);
    await vi.advanceTimersByTimeAsync(STOP_ENGINE_BEFORE_INSTALL_MS - 1);
    expect(mocks.install).not.toHaveBeenCalled();
    stopped();
    await Promise.all([first, second]);
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it('installs anyway after 5 s, or when the stop fails, and never rejects', async () => {
    expect(STOP_ENGINE_BEFORE_INSTALL_MS).toBe(5_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    downloaded();
    stopEngine.mockImplementation(() => new Promise<void>(() => {}));
    const hanging = service.quitAndInstall();
    await vi.advanceTimersByTimeAsync(STOP_ENGINE_BEFORE_INSTALL_MS);
    await hanging;
    expect(mocks.install).toHaveBeenCalledOnce();

    const failing = new AutoUpdaterService({
      stopBeforeInstall: async () => {
        throw new Error('host would not stop');
      },
    });
    failing.init(window as unknown as BrowserWindow, false);
    updater.emit('update-downloaded', { ...release('2.0.0'), downloadedFile: '/tmp/update' });
    mocks.install.mockImplementationOnce(() => {
      throw new Error('installer missing');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(failing.quitAndInstall()).resolves.toBeUndefined();
    expect(mocks.install).toHaveBeenCalledTimes(2);
    // A failed install leaves the app running and able to try again.
    expect(failing.isQuittingForUpdate()).toBe(false);
    failing.cleanup();
    warn.mockRestore();
  });
});

/**
 * Issue #10: 「检查失败 net::ERR_PROXY_CONNECTION_FAILED」. The check follows the
 * system proxy unless 「更新也走代理」 is on, so a proxy that the OS still names
 * but which is no longer running turns every automatic check into a dead end.
 */
describe('a check that failed on the proxy takes one direct retry (issue #10)', () => {
  it('retries direct, and reports the result instead of the proxy error', async () => {
    service.init(window as unknown as BrowserWindow, false);
    mocks.check
      .mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
      .mockResolvedValueOnce(null);
    await service.checkForUpdates();
    expect(mocks.applyDirectUpdaterProxy).toHaveBeenCalledOnce();
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(service.getStatus().status).toBe('idle');
  });

  it('downloads what the direct retry found when automatic updates are on', async () => {
    service.init(window as unknown as BrowserWindow, true);
    offer('2.0.0');
    serveDownloads();
    mocks.check.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'));
    await service.checkForUpdates();
    expect(mocks.applyDirectUpdaterProxy).toHaveBeenCalledOnce();
    expect(service.getStatus()).toMatchObject({ status: 'downloaded', info: { version: '2.0.0' } });
  });

  it('reports the failure when the direct retry fails too, and does not retry again', async () => {
    service.init(window as unknown as BrowserWindow, false);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.check.mockRejectedValue(new Error('net::ERR_PROXY_CONNECTION_FAILED'));
    await service.checkForUpdates();
    expect(mocks.applyDirectUpdaterProxy).toHaveBeenCalledOnce();
    expect(service.getStatus().status).toBe('error');
    // The second check starts from the failure again; the retry already
    // happened once for it, so this is the retry's own error coming through.
    await service.checkForUpdates();
    expect(service.getStatus().status).toBe('error');
  });

  it('does not touch the session for an ordinary network failure', async () => {
    service.init(window as unknown as BrowserWindow, false);
    mocks.check.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'));
    await service.checkForUpdates();
    expect(mocks.applyDirectUpdaterProxy).not.toHaveBeenCalled();
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(service.getStatus()).toMatchObject({
      status: 'error',
      error: 'net::ERR_NAME_NOT_RESOLVED',
    });
  });
});

describe('compareVersions', () => {
  it('orders releases and prereleases as semver does', () => {
    expect(compareVersions('1.2.2', '1.2.1')).toBeGreaterThan(0);
    expect(compareVersions('1.2.1', '1.2.10')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.2', '1.2.2')).toBe(0);
    expect(compareVersions('1.2.2', '1.2.2-test.2')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3-test.2', '1.2.3-test.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha.beta', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0);
  });
});
