import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * claude-plugins plan: the user layer Main's own CLI commands and every SDK host share.
 * The state root is a temp dir; the real `~/.pilab` is never touched.
 */

const root = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '',
    getVersion: () => '0.0.0-test',
    getPath: () => '',
  },
}));
vi.mock('../../appStatePaths', () => ({ getAppStateRoot: () => root.dir }));

import { CLAUDE_SDK_HOME_DIR_NAME, claudeSdkConfigDir } from '../claudeSdkEngine';

root.dir = mkdtempSync(path.join(tmpdir(), 'cp-config-dir-'));
afterAll(() => rmSync(root.dir, { recursive: true, force: true }));

describe('claudeSdkConfigDir', () => {
  it('is <state root>/claude, created on first use', () => {
    const dir = claudeSdkConfigDir();
    expect(dir).toBe(path.join(root.dir, CLAUDE_SDK_HOME_DIR_NAME));
    expect(existsSync(dir)).toBe(true);
    expect(claudeSdkConfigDir()).toBe(dir);
  });
});
