import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// app.getPath('home') is the last-resort fallback in getSharedRoot(); back it with
// an env var so the mock stays hoist-safe and controllable per test.
vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEST_ELECTRON_HOME ?? '' },
}));

import {
  clearSharedStateCache,
  getSharedStatePaths,
  readSharedSettings,
  writeSharedSettings,
} from '../SharedSessionState';

describe('SharedSessionState 持久化', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalAppHome = process.env.TEST_ELECTRON_HOME;

  let tempHome: string;

  function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  beforeEach(() => {
    tempHome = join(tmpdir(), `aiclient-sss-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.TEST_ELECTRON_HOME;
    clearSharedStateCache();
  });

  afterEach(() => {
    clearSharedStateCache();
    restoreEnv('HOME', originalHome);
    restoreEnv('USERPROFILE', originalUserProfile);
    restoreEnv('TEST_ELECTRON_HOME', originalAppHome);
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe('路径解析(环境相关)', () => {
    it('HOME 优先:root = <HOME>/.aiclient,settings.json 在其下', () => {
      const paths = getSharedStatePaths();
      expect(paths.root).toBe(join(tempHome, '.aiclient'));
      expect(paths.settingsPath).toBe(join(tempHome, '.aiclient', 'settings.json'));
    });

    it('HOME 缺失时回退 USERPROFILE', () => {
      delete process.env.HOME;
      const upHome = join(tmpdir(), `aiclient-up-${Math.random().toString(16).slice(2)}`);
      process.env.USERPROFILE = upHome;
      expect(getSharedStatePaths().root).toBe(join(upHome, '.aiclient'));
    });

    it('HOME 与 USERPROFILE 皆缺失时回退 app.getPath(home)', () => {
      delete process.env.HOME;
      delete process.env.USERPROFILE;
      const appHome = join(tmpdir(), `aiclient-app-${Math.random().toString(16).slice(2)}`);
      process.env.TEST_ELECTRON_HOME = appHome;
      expect(getSharedStatePaths().root).toBe(join(appHome, '.aiclient'));
    });
  });

  describe('原子写', () => {
    it('写后 settings.json 内容正确且不残留 .tmp 文件', () => {
      const { settingsPath } = getSharedStatePaths();
      writeSharedSettings({ theme: 'dark', fontSize: 14 });
      expect(existsSync(settingsPath)).toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({
        theme: 'dark',
        fontSize: 14,
      });
      expect(existsSync(`${settingsPath}.tmp`)).toBe(false);
    });

    it('清缓存后能从磁盘 round-trip 读回(非仅内存缓存)', () => {
      writeSharedSettings({ a: 1 });
      clearSharedStateCache();
      expect(readSharedSettings()).toEqual({ a: 1 });
    });
  });

  describe('读健壮性', () => {
    it('settings.json 缺失时返回 {} 而非抛错', () => {
      expect(readSharedSettings()).toEqual({});
    });

    it('settings.json 内容损坏时返回 {} 而非抛错', () => {
      const { root, settingsPath } = getSharedStatePaths();
      mkdirSync(root, { recursive: true });
      writeFileSync(settingsPath, '{ not valid json', 'utf-8');
      clearSharedStateCache();
      expect(readSharedSettings()).toEqual({});
    });
  });
});
