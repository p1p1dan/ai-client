import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupClaudeMd, readClaudeMd, writeClaudeMd } from '../PromptsManager';

describe('PromptsManager (D47 S2a §1 — CLAUDE_CONFIG_DIR-aware path, plain text stays outside managedFileWriter)', () => {
  let homeDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'prompts-manager-'));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it('legacy path is ~/.claude/CLAUDE.md when CLAUDE_CONFIG_DIR is unset', () => {
    expect(writeClaudeMd('hello')).toBe(true);
    expect(existsSync(path.join(homeDir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(readClaudeMd()).toBe('hello');
  });

  it('follows CLAUDE_CONFIG_DIR when set (managed redirect)', () => {
    const managedDir = mkdtempSync(path.join(os.tmpdir(), 'prompts-manager-managed-'));
    process.env.CLAUDE_CONFIG_DIR = managedDir;
    try {
      expect(writeClaudeMd('managed content')).toBe(true);
      expect(existsSync(path.join(managedDir, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(homeDir, '.claude', 'CLAUDE.md'))).toBe(false);
    } finally {
      rmSync(managedDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    "CLAUDE.md stays 0644 (world-readable) — NOT routed through managedFileWriter's 0600 chmod",
    () => {
      writeClaudeMd('hello');
      const mode = statSync(path.join(homeDir, '.claude', 'CLAUDE.md')).mode & 0o777;
      expect(mode).toBe(0o644);
    }
  );

  it('backupClaudeMd writes into <configDir>/backups, following CLAUDE_CONFIG_DIR too', () => {
    const managedDir = mkdtempSync(path.join(os.tmpdir(), 'prompts-manager-managed-backup-'));
    process.env.CLAUDE_CONFIG_DIR = managedDir;
    try {
      mkdirSync(managedDir, { recursive: true });
      writeClaudeMd('v1');
      const backupPath = backupClaudeMd();
      expect(backupPath).not.toBeNull();
      expect(backupPath?.startsWith(path.join(managedDir, 'backups'))).toBe(true);
    } finally {
      rmSync(managedDir, { recursive: true, force: true });
    }
  });
});
