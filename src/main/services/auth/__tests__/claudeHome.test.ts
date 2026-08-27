import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureWorkspaceTrusted,
  generateClaudeJson,
  getEffectiveClaudeJsonPath,
} from '../claudeHome';
import { resetManagedFileWriterQueuesForTests } from '../managedFileWriter';

describe('claudeHome — the two Claude Code JSON files this app touches', () => {
  describe('getEffectiveClaudeJsonPath (D60)', () => {
    const original = process.env.CLAUDE_CONFIG_DIR;
    afterEach(() => {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = original;
    });

    it('defaults to the TOP-LEVEL ~/.claude.json, not ~/.claude/.claude.json', () => {
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(getEffectiveClaudeJsonPath()).toBe(path.join(os.homedir(), '.claude.json'));
    });

    it('follows a CLAUDE_CONFIG_DIR the USER set (we no longer set it ourselves)', () => {
      process.env.CLAUDE_CONFIG_DIR = '/tmp/user-chosen-config';
      expect(getEffectiveClaudeJsonPath()).toBe(
        path.join('/tmp/user-chosen-config', '.claude.json')
      );
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
