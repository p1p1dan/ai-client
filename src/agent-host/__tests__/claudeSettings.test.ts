import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadClaudeSettingsEnv } from '../claudeSettings.ts';

/**
 * `loadClaudeSettingsEnv` merges settings.json's `env` block onto a COPY of
 * `process.env` (see claudeSettings.ts). On a real dev machine
 * `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` may already be set, which would
 * make settings.json's own env block not the sole source of truth for a given
 * case — capture and clear both before each test, restore after, mirroring
 * claudeRuntimeOptions.test.ts's TTFT watchdog describe (lines 551-560).
 */
describe('loadClaudeSettingsEnv — authTokenType precedence', () => {
  const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const savedApiKey = process.env.ANTHROPIC_API_KEY;

  let tmpDir: string;

  beforeEach(async () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    tmpDir = await mkdtemp(path.join(tmpdir(), 'claude-settings-test-'));
  });

  afterEach(async () => {
    if (savedAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSettings(env: Record<string, string>): Promise<string> {
    const settingsPath = path.join(tmpDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ env }), 'utf8');
    return settingsPath;
  }

  it('ANTHROPIC_AUTH_TOKEN only -> hasAuthToken=true, hasApiKey=false, authTokenType=ANTHROPIC_AUTH_TOKEN', async () => {
    const settingsPath = await writeSettings({ ANTHROPIC_AUTH_TOKEN: 'tok-secret' });
    const { diagnostics } = await loadClaudeSettingsEnv(settingsPath);
    expect(diagnostics.hasAuthToken).toBe(true);
    expect(diagnostics.hasApiKey).toBe(false);
    expect(diagnostics.authTokenType).toBe('ANTHROPIC_AUTH_TOKEN');
  });

  it('ANTHROPIC_API_KEY only -> hasAuthToken=false, hasApiKey=true, authTokenType=ANTHROPIC_API_KEY', async () => {
    const settingsPath = await writeSettings({ ANTHROPIC_API_KEY: 'key-secret' });
    const { diagnostics } = await loadClaudeSettingsEnv(settingsPath);
    expect(diagnostics.hasAuthToken).toBe(false);
    expect(diagnostics.hasApiKey).toBe(true);
    expect(diagnostics.authTokenType).toBe('ANTHROPIC_API_KEY');
  });

  it('both present -> AUTH_TOKEN wins precedence AND hasApiKey reflects the deletion, not just the pick', async () => {
    const settingsPath = await writeSettings({
      ANTHROPIC_AUTH_TOKEN: 'tok-secret',
      ANTHROPIC_API_KEY: 'stale-key-secret',
    });
    const { diagnostics } = await loadClaudeSettingsEnv(settingsPath);
    expect(diagnostics.authTokenType).toBe('ANTHROPIC_AUTH_TOKEN');
    // The existing code path `delete`s env.ANTHROPIC_API_KEY when both are
    // present (claudeSettings.ts) — confirm the diagnostic reflects that
    // deletion, not merely a precedence pick that leaves hasApiKey=true.
    expect(diagnostics.hasApiKey).toBe(false);
  });

  it('neither present -> authTokenType=none', async () => {
    const settingsPath = await writeSettings({});
    const { diagnostics } = await loadClaudeSettingsEnv(settingsPath);
    expect(diagnostics.hasAuthToken).toBe(false);
    expect(diagnostics.hasApiKey).toBe(false);
    expect(diagnostics.authTokenType).toBe('none');
  });

  it('both present -> the returned env itself (not just diagnostics) reflects precedence', async () => {
    const settingsPath = await writeSettings({
      ANTHROPIC_AUTH_TOKEN: 'tok-secret',
      ANTHROPIC_API_KEY: 'stale-key-secret',
    });
    const { env } = await loadClaudeSettingsEnv(settingsPath);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok-secret');
  });

  it('missing/unparseable settings.json -> loaded=false, error set, authTokenType=none (env cleared)', async () => {
    const nonexistentPath = path.join(tmpDir, 'does-not-exist.json');
    const { diagnostics } = await loadClaudeSettingsEnv(nonexistentPath);
    expect(diagnostics.loaded).toBe(false);
    expect(diagnostics.error).toBeTruthy();
    expect(diagnostics.authTokenType).toBe('none');
  });
});
