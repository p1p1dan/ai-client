import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_SYNC_FOCUS_MIN_INTERVAL_MS,
  CATALOG_SYNC_INTERVAL_MS,
  CatalogSyncScheduler,
} from '../syncScheduler';

/**
 * Issue #11: 「模型列表只在启动时同步一次」. The sync at boot was the only one
 * there ever was, so a long-running install kept day-one's list forever.
 */
let window: EventEmitter;
let sync: ReturnType<typeof vi.fn<() => Promise<void>>>;
let now: number;
let scheduler: CatalogSyncScheduler;

beforeEach(() => {
  vi.useFakeTimers();
  window = new EventEmitter();
  sync = vi.fn(async () => undefined);
  now = 1_700_000_000_000;
  scheduler = new CatalogSyncScheduler({ sync, now: () => now });
});
afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
});

describe('the catalog sync schedule', () => {
  it('syncs on every interval tick', async () => {
    scheduler.start(window as unknown as BrowserWindow);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CATALOG_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CATALOG_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('syncs when the window regains focus, but not more often than the focus floor', async () => {
    scheduler.start(window as unknown as BrowserWindow);
    window.emit('focus');
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledOnce();

    // Alt-tabbing within the floor is not news.
    now += 60 * 1000;
    window.emit('focus');
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledOnce();

    now += CATALOG_SYNC_FOCUS_MIN_INTERVAL_MS;
    window.emit('focus');
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does not stack a second run on top of a slow one, and reports the failure', async () => {
    const slow = vi.fn();
    let finish!: () => void;
    sync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          slow();
        })
    );
    scheduler.start(window as unknown as BrowserWindow);
    const first = scheduler.run();
    const second = scheduler.run();
    expect(slow).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
  });

  it('reports a rejected sync instead of taking the process down', async () => {
    const onError = vi.fn();
    const failing = new CatalogSyncScheduler({
      sync: vi.fn(async () => {
        throw new Error('offline');
      }),
      onError,
      now: () => now,
    });
    failing.start(window as unknown as BrowserWindow);
    await failing.run();
    expect(onError).toHaveBeenCalledOnce();
    failing.stop();
  });

  it('stops cleanly: no timers, no focus listener', async () => {
    scheduler.start(window as unknown as BrowserWindow);
    scheduler.stop();
    expect(window.listenerCount('focus')).toBe(0);
    await vi.advanceTimersByTimeAsync(CATALOG_SYNC_INTERVAL_MS * 3);
    expect(sync).not.toHaveBeenCalled();
  });

  it('starting twice does not double the schedule', async () => {
    scheduler.start(window as unknown as BrowserWindow);
    scheduler.start(window as unknown as BrowserWindow);
    await vi.advanceTimersByTimeAsync(CATALOG_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledOnce();
  });
});
