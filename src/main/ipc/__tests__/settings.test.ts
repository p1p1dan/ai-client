import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEST_ELECTRON_HOME ?? '' },
  ipcMain: { handle: vi.fn() },
}));
vi.mock('../claudeProvider', () => ({ toggleClaudeProviderWatcher: vi.fn() }));

import { clearSharedStateCache, getSharedStatePaths } from '../../services/SharedSessionState';
import { writeSettingsNow } from '../settings';

describe('settings 原子写失败处理', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  let tempDir: string;

  function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `aiclient-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(tempDir, { recursive: true });
    process.env.USERPROFILE = tempDir;
    clearSharedStateCache();
  });

  afterEach(() => {
    clearSharedStateCache();
    restoreEnv('HOME', originalHome);
    restoreEnv('USERPROFILE', originalUserProfile);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('落盘成功时 writeSettingsNow 返回 true 且写出 settings.json', () => {
    process.env.HOME = tempDir;
    const { settingsPath } = getSharedStatePaths();
    expect(writeSettingsNow({ ok: true })).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('落盘失败(HOME 指向文件致 ensureDir 抛)时 writeSettingsNow 返回 false 且不抛', () => {
    // getSharedRoot() -> <blocker>/.aiclient; mkdirSync 在文件下建目录抛 ENOTDIR
    const blocker = join(tempDir, 'blocker');
    writeFileSync(blocker, 'i am a file, not a dir', 'utf-8');
    process.env.HOME = blocker;
    expect(writeSettingsNow({ x: 1 })).toBe(false);
  });
});
