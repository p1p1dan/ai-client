import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestUserAgentSettings,
  resolveMainRequestUserAgent,
  watchRequestUserAgent,
} from '../requestUserAgentSetting';

/**
 * dsh-rebase decision 171 (GitHub issue #7): Main's read of the request
 * User-Agent setting, what Main's own provider requests send, and the watch
 * that rebuilds the model plan when the User-Agent changes — through the real
 * settings IPC module, the way a renderer save reaches Main.
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

describe('requestUserAgentSettings', () => {
  it('reports nothing for an install that never chose, so the plan applies its default', () => {
    expect(requestUserAgentSettings(values({}))).toEqual({});
  });

  it('carries a known mode and any custom text through; the plan checks the text', () => {
    expect(
      requestUserAgentSettings(
        values({ requestUserAgentMode: 'custom', requestUserAgentCustom: 'a\tb' })
      )
    ).toEqual({ userAgentMode: 'custom', userAgentCustom: 'a\tb' });
    expect(requestUserAgentSettings(values({ requestUserAgentMode: 'engine' }))).toEqual({
      userAgentMode: 'engine',
    });
  });

  it('drops a mode it does not know and a custom value that is not text', () => {
    expect(
      requestUserAgentSettings(
        values({ requestUserAgentMode: 'Custom', requestUserAgentCustom: 7 })
      )
    ).toEqual({});
  });
});

describe('resolveMainRequestUserAgent', () => {
  it("is the plan's value, or nothing in engine mode (Electron's own then goes out)", () => {
    expect(resolveMainRequestUserAgent('1.1.0', values({})).userAgent).toBe(
      'claude-cli-pilab/1.1.0'
    );
    expect(
      resolveMainRequestUserAgent(
        '1.1.0',
        values({ requestUserAgentMode: 'custom', requestUserAgentCustom: ' gw/2 ' })
      ).userAgent
    ).toBe('gw/2');
    expect(
      resolveMainRequestUserAgent(
        '1.1.0',
        values({ requestUserAgentMode: 'custom', requestUserAgentCustom: '' })
      ).userAgent
    ).toBe('claude-cli-pilab/1.1.0');
    expect(
      resolveMainRequestUserAgent('1.1.0', values({ requestUserAgentMode: 'engine' })).userAgent
    ).toBeUndefined();
  });
});

describe('watchRequestUserAgent', () => {
  function harness(initial: Record<string, unknown>) {
    const store = { ...initial };
    let fire: () => void = () => undefined;
    const rebuild = vi.fn();
    const log = vi.fn();
    const stop = watchRequestUserAgent({
      onSettingsWrite: (listener) => {
        fire = listener;
        return () => {
          fire = () => undefined;
        };
      },
      rebuild,
      appVersion: () => '1.1.0',
      read: () => store,
      log,
    });
    return { store, write: () => fire(), rebuild, log, stop };
  }

  it('rebuilds once per different User-Agent and ignores every other save', () => {
    const h = harness({});
    h.store.theme = 'dark';
    h.write();
    expect(h.rebuild).not.toHaveBeenCalled();
    h.store.requestUserAgentMode = 'engine';
    h.write();
    h.write();
    expect(h.rebuild).toHaveBeenCalledTimes(1);
    h.store.requestUserAgentMode = 'custom';
    h.store.requestUserAgentCustom = 'gw/2';
    h.write();
    expect(h.rebuild).toHaveBeenCalledTimes(2);
    h.store.requestUserAgentMode = 'default';
    h.write();
    expect(h.rebuild).toHaveBeenCalledTimes(3);
    expect(h.log.mock.calls.map(([first]) => first)).toEqual([
      '[dsh-plan] user agent changed to the engine default; new plan',
      '[dsh-plan] user agent changed to gw/2; new plan',
      '[dsh-plan] user agent changed to claude-cli-pilab/1.1.0; new plan',
    ]);
  });

  it('does not rebuild for a choice that resolves to the same value', () => {
    const h = harness({});
    // Custom with nothing (or something unusable) typed yet: still the default.
    h.store.requestUserAgentMode = 'custom';
    h.write();
    h.store.requestUserAgentCustom = 'a\tb';
    h.write();
    // Default stated explicitly; a custom text kept while it is not used.
    h.store.requestUserAgentMode = 'default';
    h.store.requestUserAgentCustom = 'gw/2';
    h.write();
    expect(h.rebuild).not.toHaveBeenCalled();
  });

  it('logs a failed rebuild instead of throwing into the settings save', () => {
    const h = harness({});
    h.rebuild.mockImplementation(() => {
      throw new Error('no catalog');
    });
    h.store.requestUserAgentMode = 'engine';
    expect(() => h.write()).not.toThrow();
    expect(h.log).toHaveBeenCalledWith(
      '[dsh-plan] the model plan could not be rebuilt after the change',
      expect.any(Error)
    );
  });

  it('stops listening when asked', () => {
    const h = harness({});
    h.stop();
    h.store.requestUserAgentMode = 'engine';
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
    homeDir = mkdtempSync(join(tmpdir(), 'aiclient-ua-settings-'));
    process.env.HOME = homeDir;
    state.userDataPath = join(homeDir, 'appdata', 'jyw-ai-client');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(homeDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('rebuilds as soon as the save is queued, reading the new value', async () => {
    vi.useFakeTimers();
    const settings = await import('../../../ipc/settings');
    settings.registerSettingsHandlers();
    const watch = await import('../requestUserAgentSetting');
    const seen: Array<string | undefined> = [];
    const rebuild = vi.fn(() => seen.push(watch.resolveMainRequestUserAgent('1.1.0').userAgent));
    const stop = watch.watchRequestUserAgent({
      onSettingsWrite: settings.onRendererSettingsWrite,
      rebuild,
      appVersion: () => '1.1.0',
    });
    const write = handlers.get(IPC_CHANNELS.SETTINGS_WRITE);
    if (!write) throw new Error('settings handlers not registered');
    const save = (state: Record<string, unknown>) =>
      write({}, { 'aiclient-settings': { state, version: 0 } });
    try {
      await save({ theme: 'dark', requestUserAgentMode: 'default' });
      expect(rebuild).not.toHaveBeenCalled();
      await save({
        theme: 'dark',
        requestUserAgentMode: 'custom',
        requestUserAgentCustom: 'pilab-gw/2',
      });
      // No timer has run: the 500 ms debounce has not written the file yet.
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(['pilab-gw/2']);
      await save({
        theme: 'light',
        requestUserAgentMode: 'custom',
        requestUserAgentCustom: 'pilab-gw/2',
      });
      expect(rebuild).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600);
    } finally {
      stop();
    }
  });
});

describe('wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (...parts: string[]) => readFileSync(join(here, '..', ...parts), 'utf8');

  it('Main installs the watch with the host model source, and reads the setting into the plan', () => {
    const source = read('dshHostModelSource.ts');
    expect(source).toContain('watchRequestUserAgent({');
    expect(source).toContain('appVersion: () => app.getVersion(),');
    expect(read('..', 'piModelConfig', 'index.ts')).toContain('...requestUserAgentSettings(),');
  });

  it("the model list sends the plan's User-Agent", () => {
    expect(read('..', 'userProviders', 'index.ts')).toContain(
      'userAgent: () => resolveMainRequestUserAgent(app.getVersion()).userAgent,'
    );
  });
});
