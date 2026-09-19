/**
 * T094 root cause 3: a start that arrives while a stop is still unwinding used
 * to be answered "already watching" and then have its entry deleted by that
 * very stop, leaving the directory with NO watcher.
 *
 * React StrictMode produces exactly this sequence in dev — the file-tree effect
 * mounts, unmounts and remounts in one flush, so `watchStart(A)`,
 * `watchStop(A)`, `watchStart(A)` all land back to back. The bug was invisible
 * because every call resolved successfully.
 *
 * `FileWatcher` is stubbed rather than `@parcel/watcher`: the real class pulls
 * the native addon in through `createRequire`, which vitest's module mocking
 * does not intercept. The stub also hands the test the start/stop promises, so
 * the race can be driven deterministically instead of with sleeps.
 */

import { IPC_CHANNELS } from '@shared/types';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const { handlers, instances } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  instances: [] as Array<{
    dirPath: string;
    callback: (type: string, path: string) => void;
    startCalls: number;
    stopCalls: number;
    resolveStart: () => void;
    resolveStop: () => void;
  }>,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { fromWebContents: () => null, fromId: () => null },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  shell: { showItemInFolder: () => undefined },
}));

vi.mock('../../services/files/FileWatcher', () => {
  class FileWatcher {
    startCalls = 0;
    stopCalls = 0;
    resolveStart: () => void = () => undefined;
    resolveStop: () => void = () => undefined;

    constructor(
      public dirPath: string,
      public callback: (type: string, path: string) => void
    ) {
      instances.push(this as never);
    }

    start(): Promise<void> {
      this.startCalls += 1;
      return new Promise<void>((resolve) => {
        this.resolveStart = resolve;
      });
    }

    stop(): Promise<void> {
      this.stopCalls += 1;
      return new Promise<void>((resolve) => {
        this.resolveStop = resolve;
      });
    }
  }
  return { FileWatcher };
});

import { registerFileHandlers } from '../files';

/** A WebContents stand-in: only the members the file handlers actually touch. */
function makeSender(id: number) {
  return {
    id,
    isDestroyed: () => false,
    once: () => undefined,
    send: vi.fn(),
  };
}

/**
 * Yield until `condition` holds, so the assertion is on a settled state.
 * The budget has to clear the handlers' own 100 ms event-coalescing delay.
 */
async function until(condition: () => boolean, label: string) {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, i === 0 ? 0 : 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeAll(() => {
  registerFileHandlers();
});

describe('file watcher start/stop races', () => {
  it('re-subscribes on start → stop → start for the same directory', async () => {
    const start = handlers.get(IPC_CHANNELS.FILE_WATCH_START) as Handler;
    const stop = handlers.get(IPC_CHANNELS.FILE_WATCH_STOP) as Handler;
    const sender = makeSender(11);
    const dir = '/repo/strict-mode';
    const before = instances.length;

    const first = start({ sender }, dir);
    await until(() => instances.length === before + 1, 'first watcher constructed');
    instances[before].resolveStart();
    await first;

    // stop and the remount's start land in the same flush, stop first.
    const stopping = stop({ sender }, dir);
    const second = start({ sender }, dir);

    // No new watcher yet: the restart must be blocked on the stop, not
    // answered as a no-op by the `watchers.has(key)` guard.
    await until(() => instances[before].stopCalls === 1, 'stop reached the watcher');
    expect(instances.length).toBe(before + 1);

    instances[before].resolveStop();
    await stopping;

    await until(() => instances.length === before + 2, 'second watcher constructed');
    instances[before + 1].resolveStart();
    await second;

    expect(instances[before].stopCalls).toBe(1);
    expect(instances[before + 1].dirPath).toBe(dir);
    expect(instances[before + 1].startCalls).toBe(1);

    // And the surviving watcher is the live one: stopping now reaches it.
    const finalStop = stop({ sender }, dir);
    await until(() => instances[before + 1].stopCalls === 1, 'second watcher stopped');
    instances[before + 1].resolveStop();
    await finalStop;
  });

  it('keeps delivering change events after a stop-then-start cycle', async () => {
    const start = handlers.get(IPC_CHANNELS.FILE_WATCH_START) as Handler;
    const stop = handlers.get(IPC_CHANNELS.FILE_WATCH_STOP) as Handler;
    const sender = makeSender(12);
    const dir = '/repo/live-after-restart';
    const before = instances.length;

    const first = start({ sender }, dir);
    await until(() => instances.length === before + 1, 'first watcher constructed');
    instances[before].resolveStart();
    await first;

    const stopping = stop({ sender }, dir);
    const second = start({ sender }, dir);
    await until(() => instances[before].stopCalls === 1, 'stop reached the watcher');
    instances[before].resolveStop();
    await stopping;
    await until(() => instances.length === before + 2, 'second watcher constructed');
    instances[before + 1].resolveStart();
    await second;

    // The observable symptom of the bug was "edits stop showing up". Assert the
    // channel end-to-end rather than the bookkeeping alone.
    instances[before + 1].callback('update', `${dir}/changed.ts`);
    await until(() => sender.send.mock.calls.length > 0, 'change event flushed');

    expect(sender.send).toHaveBeenCalledWith(IPC_CHANNELS.FILE_CHANGE, {
      type: 'update',
      path: `${dir}/changed.ts`,
    });
  });
});
