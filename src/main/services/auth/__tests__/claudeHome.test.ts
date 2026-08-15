import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureWorkspaceTrusted,
  generateClaudeJson,
  generateClaudeSettings,
  getManagedClaudeHomeDir,
} from '../claudeHome';
import { resetManagedFileWriterQueuesForTests } from '../managedFileWriter';

describe('claudeHome (D47 S2a §1/§2 pure generators)', () => {
  describe('getManagedClaudeHomeDir', () => {
    it('joins userData with claude-home', () => {
      expect(getManagedClaudeHomeDir('/tmp/userData')).toBe(
        path.join('/tmp/userData', 'claude-home')
      );
    });
  });

  describe('generateClaudeSettings', () => {
    it('produces the 3-key env + autoUpdates:false + skipWebFetchPreflight:true patch when credentials are present', () => {
      const patch = generateClaudeSettings({
        baseUrl: 'https://api.example.com',
        authToken: 'sk-test',
      });
      expect(patch).toEqual({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.example.com',
          ANTHROPIC_AUTH_TOKEN: 'sk-test',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        autoUpdates: false,
        skipWebFetchPreflight: true,
      });
    });

    it('produces an empty env when credentials are null (no-credential absent case)', () => {
      const patch = generateClaudeSettings(null);
      expect(patch).toEqual({
        env: {},
        autoUpdates: false,
        skipWebFetchPreflight: true,
      });
    });

    it('is deterministic / pure (same input -> deep-equal output, no shared references)', () => {
      const credentials = { baseUrl: 'https://x', authToken: 'sk-1' };
      const a = generateClaudeSettings(credentials);
      const b = generateClaudeSettings(credentials);
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(a.env).not.toBe(b.env);
    });
  });

  describe('generateClaudeJson', () => {
    it('returns the minimal fresh skeleton', () => {
      expect(generateClaudeJson()).toEqual({ hasCompletedOnboarding: true, projects: {} });
    });
  });

  describe('ensureWorkspaceTrusted', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'claude-home-trust-'));
      resetManagedFileWriterQueuesForTests();
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function claudeJsonPath(): string {
      return path.join(dir, '.claude.json');
    }

    function readJson(): Record<string, unknown> {
      return JSON.parse(readFileSync(claudeJsonPath(), 'utf-8')) as Record<string, unknown>;
    }

    it('creates a fresh .claude.json with the workspace trusted when absent', async () => {
      await ensureWorkspaceTrusted(claudeJsonPath(), '/repo/a');
      expect(readJson()).toEqual({
        hasCompletedOnboarding: true,
        projects: {
          '/repo/a': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
        },
      });
    });

    it('preserves other trusted workspaces and foreign top-level keys', async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        claudeJsonPath(),
        JSON.stringify({
          hasCompletedOnboarding: true,
          someForeignKey: 'keep-me',
          projects: { '/repo/other': { hasTrustDialogAccepted: true } },
        }),
        'utf-8'
      );

      await ensureWorkspaceTrusted(claudeJsonPath(), '/repo/a');

      const doc = readJson();
      expect(doc.someForeignKey).toBe('keep-me');
      expect(doc.projects).toEqual({
        '/repo/other': { hasTrustDialogAccepted: true },
        '/repo/a': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      });
    });

    it('is idempotent — calling twice for the same workspace converges to the same state', async () => {
      await ensureWorkspaceTrusted(claudeJsonPath(), '/repo/a');
      const first = readJson();
      await ensureWorkspaceTrusted(claudeJsonPath(), '/repo/a');
      const second = readJson();
      expect(second).toEqual(first);
    });

    it('two different workspaces both end up trusted (no lost update across two calls)', async () => {
      await Promise.all([
        ensureWorkspaceTrusted(claudeJsonPath(), '/repo/a'),
        ensureWorkspaceTrusted(claudeJsonPath(), '/repo/b'),
      ]);
      const doc = readJson();
      expect(Object.keys(doc.projects as Record<string, unknown>).sort()).toEqual([
        '/repo/a',
        '/repo/b',
      ]);
    });

    it('recovers from a corrupt .claude.json by rebuilding the minimal shape plus the trust entry', async () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(claudeJsonPath(), 'not json at all', 'utf-8');

      await ensureWorkspaceTrusted(claudeJsonPath(), '/repo/a');

      expect(readJson()).toEqual({
        hasCompletedOnboarding: true,
        projects: {
          '/repo/a': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
        },
      });
    });
  });
});
