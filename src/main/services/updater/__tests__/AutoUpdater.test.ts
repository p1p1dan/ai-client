import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ check: vi.fn(), download: vi.fn(), install: vi.fn() }));
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('../../proxy/ProxyConfig', () => ({
  applyProxy: vi.fn(),
  registerUpdaterSession: vi.fn(),
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
      }),
    },
  };
});

import electronUpdater from 'electron-updater';
import { AutoUpdaterService } from '../AutoUpdater';

let service: AutoUpdaterService;
let window: EventEmitter & {
  webContents: { send: ReturnType<typeof vi.fn> };
  isDestroyed: () => boolean;
};
beforeEach(() => {
  vi.useFakeTimers();
  mocks.check.mockReset().mockResolvedValue(null);
  mocks.download.mockReset().mockResolvedValue([]);
  mocks.install.mockReset();
  window = Object.assign(new EventEmitter(), {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
  });
  service = new AutoUpdaterService();
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
    service.quitAndInstall();
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
