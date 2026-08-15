import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `globalThis.__testUserDataDir` (not a local closure variable) mirrors
// `OnboardingServiceManagedHome.test.ts`'s convention for the same reason:
// `vi.mock` factories are hoisted above ordinary top-level bindings, so a
// plain `let` captured by the factory would be read before `beforeEach` has
// a chance to assign it.
declare global {
  // eslint-disable-next-line no-var
  var __testUserDataDir: string;
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => globalThis.__testUserDataDir),
  },
}));

import {
  resetManagedFileWriterQueuesForTests,
  writeSettingsFile,
} from '../../auth/managedFileWriter';
import { ensureStopHook } from '../ClaudeHookManager';

/**
 * D47 S2 §1/§3-1: `ClaudeHookManager`'s settings.json write paths were moved
 * off ad-hoc `fs.readFileSync`/`fs.writeFileSync` pairs and onto
 * `managedFileWriter.writeSettingsFile`'s per-path serialized queue, so a
 * hook writer and the claudeHome generator (or any other managed-settings
 * writer) can no longer race each other into a lost update. This suite
 * exercises the REAL `ensureStopHook()` production function concurrently
 * with a generator-style env write against the same settings.json path —
 * not a synthetic mutator — to prove the integration point, not just the
 * primitive (the primitive's own race coverage lives in
 * `managedFileWriter.test.ts`).
 */
describe('ClaudeHookManager settings.json write path (D47 S2 §1/§3-1 concurrent interleave)', () => {
  let configDir: string;
  let originalClaudeConfigDir: string | undefined;

  let userDataDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(os.tmpdir(), 'claude-hook-manager-'));
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'claude-hook-manager-userdata-'));
    globalThis.__testUserDataDir = userDataDir;
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    resetManagedFileWriterQueuesForTests();
  });

  afterEach(() => {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    rmSync(configDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  });

  function settingsPath(): string {
    return path.join(configDir, 'settings.json');
  }

  it(
    'barrier interleave: a generator-style env write racing the real ensureStopHook() ' +
      'against the same settings.json — both the managed env sentinel and the hooks ' +
      'sentinel survive (spec §3-1 required shape)',
    async () => {
      // `isClaudeInstalled()` requires the config dir to already exist.
      mkdirSync(configDir, { recursive: true });
      writeFileSync(settingsPath(), JSON.stringify({}), 'utf-8');

      // Barrier: both async callers register their continuation on the same
      // promise and are released in the same microtask tick, so from the
      // caller's perspective the generator write and the hook write start
      // "at the same time" — same starting line the generator/hook-writer
      // race in the D47 S2 spec (§3-1) describes. The per-path queue inside
      // `writeSettingsFile` (which `ensureStopHook` now goes through) is
      // what has to resolve the race correctly, not accidental ordering.
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });

      const generatorWrite = (async () => {
        await barrier;
        return writeSettingsFile(settingsPath(), (current) => ({
          ...current,
          env: { ANTHROPIC_AUTH_TOKEN: 'sentinel-env' },
        }));
      })();

      const hookWrite = (async () => {
        await barrier;
        return ensureStopHook();
      })();

      release();
      await Promise.all([generatorWrite, hookWrite]);

      const final = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as {
        env?: { ANTHROPIC_AUTH_TOKEN?: string };
        hooks?: { Stop?: Array<{ hooks: Array<{ command?: string }> }> };
      };

      // Managed env sentinel survived the hook writer's merge.
      expect(final.env?.ANTHROPIC_AUTH_TOKEN).toBe('sentinel-env');

      // Hooks sentinel (aiclient-hook Stop entry) survived the generator's merge.
      const hasStopHook = final.hooks?.Stop?.some((group) =>
        group.hooks.some((hook) => hook.command?.includes('aiclient-hook'))
      );
      expect(hasStopHook).toBe(true);
    }
  );

  it('ensureStopHook preserves foreign keys already in settings.json (no clobber of unrelated writers)', async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ statusLine: { type: 'sentinel-statusline' }, theme: 'dark' }),
      'utf-8'
    );

    const ok = await ensureStopHook();
    expect(ok).toBe(true);

    const final = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as {
      statusLine?: { type?: string };
      theme?: string;
    };
    expect(final.statusLine).toEqual({ type: 'sentinel-statusline' });
    expect(final.theme).toBe('dark');
  });
});
