import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetManagedFileWriterQueuesForTests } from '../../auth/managedFileWriter';
import { disableClaudeAutoUpdates } from '../ClaudeRuntimeConfig';

describe('ClaudeRuntimeConfig', () => {
  let homeDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'claude-runtime-cfg-'));
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    // D47 S2a §1: the settings path now follows CLAUDE_CONFIG_DIR — every
    // test must start from a clean, explicitly-unset env so a leaked value
    // from another test file can't redirect these writes.
    delete process.env.CLAUDE_CONFIG_DIR;
    resetManagedFileWriterQueuesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(homeDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
  });

  function settingsPath(): string {
    return path.join(homeDir, '.claude', 'settings.json');
  }

  function readSettings(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
  }

  describe('disableClaudeAutoUpdates', () => {
    it('creates settings.json when missing and writes autoUpdates:false', async () => {
      await disableClaudeAutoUpdates();
      expect(readSettings()).toEqual({ autoUpdates: false });
    });

    it('preserves existing keys (including env) and only flips autoUpdates', async () => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        settingsPath(),
        JSON.stringify({
          env: { ANTHROPIC_BASE_URL: 'https://example.com' },
          theme: 'dark',
        }),
        'utf-8'
      );
      await disableClaudeAutoUpdates();
      expect(readSettings()).toEqual({
        env: { ANTHROPIC_BASE_URL: 'https://example.com' },
        theme: 'dark',
        autoUpdates: false,
      });
    });

    it('is idempotent when autoUpdates is already false', async () => {
      await disableClaudeAutoUpdates();
      const before = readFileSync(settingsPath(), 'utf-8');
      await disableClaudeAutoUpdates();
      const after = readFileSync(settingsPath(), 'utf-8');
      expect(after).toBe(before);
    });

    it('follows CLAUDE_CONFIG_DIR when set (managed redirect, D47 S2a §1)', async () => {
      const managedDir = mkdtempSync(path.join(os.tmpdir(), 'claude-runtime-cfg-managed-'));
      process.env.CLAUDE_CONFIG_DIR = managedDir;
      try {
        await disableClaudeAutoUpdates();
        const managedSettings = JSON.parse(
          readFileSync(path.join(managedDir, 'settings.json'), 'utf-8')
        );
        expect(managedSettings).toEqual({ autoUpdates: false });
        // The legacy ~/.claude/settings.json must be untouched.
        const { existsSync } = await import('node:fs');
        expect(existsSync(settingsPath())).toBe(false);
      } finally {
        rmSync(managedDir, { recursive: true, force: true });
      }
    });
  });
});
