import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheControlOnToolsSettings,
  watchCacheControlOnTools,
} from '../cacheControlOnToolsSetting';

/**
 * GW-16 temporary switch (dsh-rebase decisions 149 rule 19, 159): Main's read
 * of the renderer-owned setting, and the watch that rebuilds the model plan
 * when it flips — through the real settings IPC module, the way a renderer
 * save reaches Main (`stores/settings/storage.ts` writes the whole object).
 */

const state = { userDataPath: '' };
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
    on: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const values = (record: Record<string, unknown>) => () => record;

describe('cacheControlOnToolsSettings', () => {
  it('reports nothing for an install that never chose, so the plan applies its default', () => {
    expect(cacheControlOnToolsSettings(values({}))).toEqual({});
  });

  it('carries a stored boolean through', () => {
    expect(cacheControlOnToolsSettings(values({ experimentalCacheControlOnTools: true }))).toEqual({
      cacheControlOnTools: true,
    });
    expect(cacheControlOnToolsSettings(values({ experimentalCacheControlOnTools: false }))).toEqual(
      { cacheControlOnTools: false }
    );
  });

  it('drops anything that is not a boolean', () => {
    for (const value of ['true', 1, null, {}]) {
      expect(
        cacheControlOnToolsSettings(values({ experimentalCacheControlOnTools: value }))
      ).toEqual({});
    }
  });
});

describe('watchCacheControlOnTools', () => {
  function harness(initial: Record<string, unknown>) {
    const store = { ...initial };
    let fire: () => void = () => undefined;
    const rebuild = vi.fn();
    const log = vi.fn();
    const stop = watchCacheControlOnTools({
      onSettingsWrite: (listener) => {
        fire = listener;
        return () => {
          fire = () => undefined;
        };
      },
      rebuild,
      read: () => store,
      log,
    });
    return { store, write: () => fire(), rebuild, log, stop };
  }

  it('rebuilds the plan once per flip and ignores every other save', () => {
    const h = harness({});
    h.store.theme = 'dark';
    h.write();
    expect(h.rebuild).not.toHaveBeenCalled();
    h.store.experimentalCacheControlOnTools = true;
    h.write();
    h.write();
    expect(h.rebuild).toHaveBeenCalledTimes(1);
    h.store.experimentalCacheControlOnTools = false;
    h.write();
    expect(h.rebuild).toHaveBeenCalledTimes(2);
    expect(h.log.mock.calls.map(([first]) => first)).toEqual([
      '[dsh-plan] cache_control on tools switched on; new plan',
      '[dsh-plan] cache_control on tools switched off; new plan',
    ]);
  });

  it('treats absent and false as the same mode', () => {
    const h = harness({});
    h.store.experimentalCacheControlOnTools = false;
    h.write();
    expect(h.rebuild).not.toHaveBeenCalled();
  });

  it('logs a failed rebuild instead of throwing into the settings save', () => {
    const h = harness({ experimentalCacheControlOnTools: true });
    h.rebuild.mockImplementation(() => {
      throw new Error('no catalog');
    });
    h.store.experimentalCacheControlOnTools = false;
    expect(() => h.write()).not.toThrow();
    expect(h.log).toHaveBeenCalledWith(
      '[dsh-plan] the model plan could not be rebuilt after the switch',
      expect.any(Error)
    );
  });

  it('stops listening when asked', () => {
    const h = harness({});
    h.stop();
    h.store.experimentalCacheControlOnTools = true;
    h.write();
    expect(h.rebuild).not.toHaveBeenCalled();
  });
});

describe('a renderer save reaches the watch through the settings IPC', () => {
  let homeDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    homeDir = mkdtempSync(join(tmpdir(), 'aiclient-gw16-settings-'));
    process.env.HOME = homeDir;
    state.userDataPath = join(homeDir, 'appdata', 'jyw-ai-client');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(homeDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('rebuilds as soon as the save is queued, before it reaches the disk', async () => {
    vi.useFakeTimers();
    const settings = await import('../../../ipc/settings');
    settings.registerSettingsHandlers();
    const watch = await import('../cacheControlOnToolsSetting');
    const seen: Array<boolean | undefined> = [];
    const rebuild = vi.fn(() => seen.push(watch.cacheControlOnToolsSettings().cacheControlOnTools));
    const stop = watch.watchCacheControlOnTools({
      onSettingsWrite: settings.onRendererSettingsWrite,
      rebuild,
    });
    const write = handlers.get(IPC_CHANNELS.SETTINGS_WRITE);
    if (!write) throw new Error('settings handlers not registered');
    const save = (state: Record<string, unknown>) =>
      write({}, { 'aiclient-settings': { state, version: 0 } });
    try {
      await save({ theme: 'dark', experimentalCacheControlOnTools: false });
      expect(rebuild).not.toHaveBeenCalled();
      await save({ theme: 'dark', experimentalCacheControlOnTools: true });
      // No timer has run: the 500 ms debounce has not written the file yet.
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([true]);
      await save({ theme: 'light', experimentalCacheControlOnTools: true });
      expect(rebuild).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
    } finally {
      stop();
    }
  });
});

describe('wiring', () => {
  it('Main installs the watch with the host model source, and reads the setting into the plan', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', 'dshHostModelSource.ts'), 'utf8');
    expect(source).toContain('onSettingsWrite: onRendererSettingsWrite,');
    expect(source).toContain('rebuild: () => resolveDshModelPlan(),');
    const plan = readFileSync(join(here, '..', '..', 'piModelConfig', 'index.ts'), 'utf8');
    expect(plan).toContain('...cacheControlOnToolsSettings(),');
  });
});
