import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D13 — Main could not see the base directory the user picked in Settings
 * ("保存位置" / `defaultTemporaryPath`).
 *
 * `readSettings()` hands back the settings FILE, and that file's top level
 * holds only the keys Main owns (`credentialMode`, `onboarding`, the two pi
 * opt-in keys). Everything the Settings page owns sits one level down, under
 * `aiclient-settings.state`, because the renderer persists through zustand's
 * `persist` middleware. Both directory services read the key off the TOP level,
 * so both got `undefined` on every machine, and both silently fell back to the
 * default `~/JYWAI/temporary`.
 *
 * The renderer, reading its own store, had the real value and passed it to
 * `temp:workspace:*` explicitly — so the 2026-09-17 dev-box pass saw temp
 * workspaces move to the new directory while temp CHATS stayed in the old one
 * (`evidence/batch-e-devbox-2026-09-17/dev-B/dev-02-t3-after-gui-change.txt`).
 *
 * These cases are written against the real file shape, taken from that machine:
 * two top-level keys, everything else nested. A fix that only makes one of the
 * two services agree with the renderer would leave the two directory kinds
 * disagreeing again, so every case asserts on BOTH.
 */

const electronState = { userDataPath: '' };
const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? electronState.userDataPath : tmpdir())),
    on: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
  },
}));

// `TempWorkspaceService` only reaches git when it recreates a directory; these
// cases never get that far, but the import is on its graph.
vi.mock('../../git/GitService', () => ({
  GitService: class {
    init = vi.fn(async () => undefined);
  },
}));

let homeDir: string;
const sandboxHome = process.env.HOME;

beforeEach(() => {
  vi.resetModules();
  ipcHandlers.clear();
  homeDir = mkdtempSync(join(tmpdir(), 'aiclient-temp-path-'));
  process.env.HOME = homeDir;
  electronState.userDataPath = join(homeDir, 'appdata', 'jyw-ai-client');
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  // Back to the per-process sandbox from `setup/hermeticHome.ts`, never the
  // developer's real home.
  if (sandboxHome === undefined) delete process.env.HOME;
  else process.env.HOME = sandboxHome;
});

/** settings.json exactly as it is on disk: Main's keys on top, the rest nested. */
function settingsFile(defaultTemporaryPath: string): Record<string, unknown> {
  return {
    credentialMode: 'managed',
    'aiclient-settings': {
      state: { language: 'zh', theme: 'dark', defaultTemporaryPath },
      version: 0,
    },
  };
}

async function load() {
  const settings = await import('../../../ipc/settings');
  const scratch = await import('../ScratchWorkspaceService');
  const temp = await import('../TempWorkspaceService');
  return { settings, scratch, temp };
}

describe('the temp base path the user picked in Settings, as Main sees it', () => {
  it('comes from `aiclient-settings.state`, which is where the file keeps it', async () => {
    const configured = join(homeDir, 'JYWAI', 'temporary-dev2-new');
    const { settings, scratch, temp } = await load();
    settings.writeSettingsNow(settingsFile(configured));

    // The shape this case exists to pin down. If a future settings layout
    // promotes the key back to the top level, this is the line that says so.
    const file = settings.readSettings() ?? {};
    expect(Object.keys(file).sort()).toEqual(['aiclient-settings', 'credentialMode']);
    expect(file.defaultTemporaryPath).toBeUndefined();

    expect(settings.readStringSetting(settings.TEMPORARY_PATH_SETTING_KEY)).toBe(configured);
    expect(new scratch.ScratchWorkspaceService().rootPath()).toBe(
      join(configured, scratch.SCRATCH_ROOT_DIR)
    );
    expect(temp.isTempWorkspacePath(join(configured, '20260917-101500'))).toBe(true);
  });

  it('moves BOTH directory kinds when the setting changes mid-run', async () => {
    // F2-a: the two readers must not disagree about one setting. Note the old
    // root is the DEFAULT one, so the first half of this case passes even with
    // the defect — it is the second half that separates them.
    const oldRoot = join(homeDir, 'JYWAI', 'temporary');
    const newRoot = join(homeDir, 'JYWAI', 'temporary-dev2-new');
    const { settings, scratch, temp } = await load();
    settings.writeSettingsNow(settingsFile(oldRoot));

    const service = new scratch.ScratchWorkspaceService();
    expect(service.rootPath()).toBe(join(oldRoot, scratch.SCRATCH_ROOT_DIR));
    expect(temp.isTempWorkspacePath(join(oldRoot, 'ws'))).toBe(true);

    settings.writeSettingsNow(settingsFile(newRoot));

    expect(service.rootPath()).toBe(join(newRoot, scratch.SCRATCH_ROOT_DIR));
    expect(temp.isTempWorkspacePath(join(newRoot, 'ws'))).toBe(true);
    expect(temp.isTempWorkspacePath(join(oldRoot, 'ws'))).toBe(false);
  });

  it('sees a renderer save that is still queued, before it reaches the disk', async () => {
    // `readSettings()` has a second branch: the renderer's not-yet-flushed
    // payload, overlaid with the Main-owned keys. It carries the same nested
    // shape, and the 500 ms debounce is exactly the window in which the user
    // starts the chat that allocates a scratch directory.
    vi.useFakeTimers();
    try {
      const onDisk = join(homeDir, 'JYWAI', 'temporary');
      const justPicked = join(homeDir, 'JYWAI', 'temporary-picked');
      const { settings, scratch, temp } = await load();
      settings.writeSettingsNow(settingsFile(onDisk));
      settings.registerSettingsHandlers();

      const write = ipcHandlers.get(IPC_CHANNELS.SETTINGS_WRITE);
      if (!write) throw new Error('settings handlers not registered');
      await write({}, settingsFile(justPicked));

      expect(new scratch.ScratchWorkspaceService().rootPath()).toBe(
        join(justPicked, scratch.SCRATCH_ROOT_DIR)
      );
      expect(temp.isTempWorkspacePath(join(justPicked, 'ws'))).toBe(true);

      await vi.advanceTimersByTimeAsync(600);
      expect(new scratch.ScratchWorkspaceService().rootPath()).toBe(
        join(justPicked, scratch.SCRATCH_ROOT_DIR)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the default root when the user has not picked one', async () => {
    const { settings, scratch, temp } = await load();
    settings.writeSettingsNow(settingsFile(''));

    const fallback = join(homeDir, 'JYWAI', 'temporary');
    expect(new scratch.ScratchWorkspaceService().rootPath()).toBe(
      join(fallback, scratch.SCRATCH_ROOT_DIR)
    );
    expect(temp.isTempWorkspacePath(join(fallback, 'ws'))).toBe(true);
  });

  it('falls back to the default root when the nested state is missing entirely', async () => {
    // First run, or a settings.json the renderer has never written to.
    const { settings, scratch, temp } = await load();
    settings.writeSettingsNow({ credentialMode: 'managed' });

    const fallback = join(homeDir, 'JYWAI', 'temporary');
    expect(settings.readStringSetting(settings.TEMPORARY_PATH_SETTING_KEY)).toBe('');
    expect(new scratch.ScratchWorkspaceService().rootPath()).toBe(
      join(fallback, scratch.SCRATCH_ROOT_DIR)
    );
    expect(temp.isTempWorkspacePath(join(fallback, 'ws'))).toBe(true);
  });
});
