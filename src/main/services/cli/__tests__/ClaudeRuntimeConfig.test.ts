import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disableClaudeAutoUpdates, mergeClaudeEnvSettings } from '../ClaudeRuntimeConfig';

describe('ClaudeRuntimeConfig', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), 'claude-runtime-cfg-'));
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(homeDir, { recursive: true, force: true });
  });

  function settingsPath(): string {
    return path.join(homeDir, '.claude', 'settings.json');
  }

  function readSettings(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath(), 'utf-8')) as Record<string, unknown>;
  }

  describe('disableClaudeAutoUpdates', () => {
    it('creates settings.json when missing and writes autoUpdates:false', () => {
      disableClaudeAutoUpdates();
      expect(readSettings()).toEqual({ autoUpdates: false });
    });

    it('preserves existing keys (including env) and only flips autoUpdates', () => {
      writeFileSync(
        settingsPath(),
        JSON.stringify({
          env: { ANTHROPIC_BASE_URL: 'https://example.com' },
          theme: 'dark',
        }),
        'utf-8'
      );
      disableClaudeAutoUpdates();
      expect(readSettings()).toEqual({
        env: { ANTHROPIC_BASE_URL: 'https://example.com' },
        theme: 'dark',
        autoUpdates: false,
      });
    });

    it('is idempotent when autoUpdates is already false', () => {
      disableClaudeAutoUpdates();
      const before = readFileSync(settingsPath(), 'utf-8');
      disableClaudeAutoUpdates();
      const after = readFileSync(settingsPath(), 'utf-8');
      expect(after).toBe(before);
    });
  });

  describe('mergeClaudeEnvSettings', () => {
    it('writes new env vars under the env key', () => {
      mergeClaudeEnvSettings({
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        ANTHROPIC_AUTH_TOKEN: 'sk-test',
      });
      expect(readSettings()).toEqual({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_AUTH_TOKEN: 'sk-test',
        },
      });
    });

    it('merges into an existing env without dropping unrelated keys', () => {
      mergeClaudeEnvSettings({ ANTHROPIC_BASE_URL: 'https://api.example.com' });
      mergeClaudeEnvSettings({ ANTHROPIC_AUTH_TOKEN: 'sk-new' });
      expect(readSettings()).toEqual({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_AUTH_TOKEN: 'sk-new',
        },
      });
    });

    it('null value removes the matching env entry', () => {
      mergeClaudeEnvSettings({ ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_AUTH_TOKEN: 'sk' });
      mergeClaudeEnvSettings({ ANTHROPIC_AUTH_TOKEN: null });
      expect(readSettings()).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://x' } });
    });

    it('keeps top-level user-customised keys intact', () => {
      mergeClaudeEnvSettings({ ANTHROPIC_BASE_URL: 'https://x' });
      const current = readSettings();
      writeFileSync(
        settingsPath(),
        JSON.stringify({ ...current, theme: 'dark', mcpServers: { foo: {} } }),
        'utf-8'
      );
      mergeClaudeEnvSettings({ ANTHROPIC_AUTH_TOKEN: 'sk' });
      const next = readSettings();
      expect(next.theme).toBe('dark');
      expect(next.mcpServers).toEqual({ foo: {} });
      expect((next.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe('sk');
    });
  });
});
