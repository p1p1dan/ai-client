import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeSdkEngineEnabled } from '../claudeSdkEngineSetting';

/**
 * Route B, S-1 (decision 1): Main's read of the renderer-owned switch
 * `claudeSdkEngineEnabled` — on unless the user turned it off — and the same
 * read through the real settings IPC, the way a renderer save reaches Main.
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

// A developer-mode setting (S-6 feedback 10): the reads below run with
// developer mode on; the gate itself has its own block.
const values = (record: Record<string, unknown>) => () => ({
  developerModeEnabled: true,
  ...record,
});

describe('claudeSdkEngineEnabled', () => {
  it('is on for an install that never chose', () => {
    expect(claudeSdkEngineEnabled(values({}))).toBe(true);
  });

  it('carries a stored boolean through', () => {
    expect(claudeSdkEngineEnabled(values({ claudeSdkEngineEnabled: false }))).toBe(false);
    expect(claudeSdkEngineEnabled(values({ claudeSdkEngineEnabled: true }))).toBe(true);
  });

  it('reads anything that is not a boolean as the default', () => {
    for (const value of ['false', 0, null, {}]) {
      expect(claudeSdkEngineEnabled(values({ claudeSdkEngineEnabled: value }))).toBe(true);
    }
  });
});

describe('developer mode (S-6 feedback 10)', () => {
  it('reads a stored "off" as the default while developer mode is off, and as stored once it is on', () => {
    for (const developerModeEnabled of [false, undefined, 'true']) {
      expect(
        claudeSdkEngineEnabled(() => ({ developerModeEnabled, claudeSdkEngineEnabled: false })),
        String(developerModeEnabled)
      ).toBe(true);
    }
    expect(
      claudeSdkEngineEnabled(() => ({ developerModeEnabled: true, claudeSdkEngineEnabled: false }))
    ).toBe(false);
  });
});

describe('a renderer save reaches the read through the settings IPC', () => {
  let homeDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
    handlers.clear();
    homeDir = mkdtempSync(join(tmpdir(), 'aiclient-claude-sdk-setting-'));
    process.env.HOME = homeDir;
    state.userDataPath = join(homeDir, 'appdata', 'jyw-ai-client');
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(homeDir, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('turns off as soon as the save is queued, and on again', async () => {
    vi.useFakeTimers();
    const settings = await import('../../../ipc/settings');
    settings.registerSettingsHandlers();
    const setting = await import('../claudeSdkEngineSetting');
    const write = handlers.get(IPC_CHANNELS.SETTINGS_WRITE);
    if (!write) throw new Error('settings handlers not registered');
    const save = (saved: Record<string, unknown>) =>
      write(
        {},
        { 'aiclient-settings': { state: { developerModeEnabled: true, ...saved }, version: 0 } }
      );
    expect(setting.claudeSdkEngineEnabled()).toBe(true);
    await save({ theme: 'dark', claudeSdkEngineEnabled: false });
    expect(setting.claudeSdkEngineEnabled()).toBe(false);
    await save({ theme: 'dark', claudeSdkEngineEnabled: true });
    expect(setting.claudeSdkEngineEnabled()).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
  });
});
