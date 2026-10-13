import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  applyDirectUpdaterProxy: vi.fn(),
  isProxyConnectionError: vi.fn((error: unknown) =>
    /ERR_(PROXY|SOCKS)_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/i.test(
      error instanceof Error ? error.message : String(error ?? '')
    )
  ),
}));
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
        autoDownload: false,
        autoInstallOnAppQuit: false,
        allowPrerelease: true,
      }),
    },
  };
});

import electronUpdater from 'electron-updater';
import { AutoUpdaterService, STOP_ENGINE_BEFORE_INSTALL_MS } from '../AutoUpdater';

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
  vi.useRealTimers();
});

describe('update reminders', () => {
  it('checks at startup and on focus with automatic download disabled', async () => {
    service.init(window as unknown as BrowserWindow, false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(electronUpdater.autoUpdater.autoDownload).toBe(false);
    // The mock starts at `true` (what electron-updater derives for a
    // `1.0.0-test.*` build), so this passing proves `init` actively pins the
    // stable channel rather than inheriting it. Without the pin, a test build
    // walks the feed looking for a `-test.*` tag, finds none, and reports
    // 「No published versions on GitHub」 while v1.0.1 sits published.
    expect(electronUpdater.autoUpdater.allowPrerelease).toBe(false);
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    window.emit('focus');
    await Promise.resolve();
    expect(mocks.check).toHaveBeenCalledTimes(2);
    service.setAutoUpdateEnabled(true);
    service.setAutoUpdateEnabled(false);
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(mocks.check.mock.calls.length).toBeGreaterThan(2);
  });
  it('keeps the downloaded snapshot and installs only on request', async () => {
    service.init(window as unknown as BrowserWindow, false);
    electronUpdater.autoUpdater.emit('update-available', {
      version: '2.0.0',
      files: [],
      path: '',
      sha512: '',
      releaseDate: '',
    });
    await service.downloadUpdate();
    electronUpdater.autoUpdater.emit('update-downloaded', {
      version: '2.0.0',
      releaseNotes: 'changes',
      files: [],
      path: '',
      sha512: '',
      releaseDate: '',
      downloadedFile: '/tmp/update',
    });
    expect(service.getStatus()).toMatchObject({ status: 'downloaded', info: { version: '2.0.0' } });
    electronUpdater.autoUpdater.emit('checking-for-update');
    await service.checkForUpdates();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(service.getStatus().status).toBe('downloaded');
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
    await service.quitAndInstall();
    expect(mocks.install).toHaveBeenCalledOnce();
  });
  it('exposes download failures and allows retry', async () => {
    service.init(window as unknown as BrowserWindow, false);
    electronUpdater.autoUpdater.emit('update-available', {
      version: '2',
      files: [],
      path: '',
      sha512: '',
      releaseDate: '',
    });
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
    expect(electronUpdater.autoUpdater.listenerCount('update-available')).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(mocks.check).toHaveBeenCalledOnce();
  });
});

/** dsh-rebase P1-3d (decision 025 rule 4): the DSH host holds native addons of the install dir. */
describe('install waits for the chat engine to stop', () => {
  function downloaded(): void {
    service.init(window as unknown as BrowserWindow, false);
    electronUpdater.autoUpdater.emit('update-downloaded', {
      version: '2.0.0',
      files: [],
      path: '',
      sha512: '',
      releaseDate: '',
      downloadedFile: '/tmp/update',
    });
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
    electronUpdater.autoUpdater.emit('update-downloaded', {
      version: '2.0.0',
      files: [],
      path: '',
      sha512: '',
      releaseDate: '',
      downloadedFile: '/tmp/update',
    });
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

  it('reports the failure when the direct retry fails too, and does not retry again', async () => {
    service.init(window as unknown as BrowserWindow, false);
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
