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

/**
 * S0' (D60) — the precedence rule that REPLACES `CLAUDE_CONFIG_DIR`
 * redirection.
 *
 * Before D60 our credential could not lose to a user's settings.json, because
 * the redirect made ours the only settings.json in sight. Now both exist, and
 * this rule is the whole of what keeps a stale token in a user's file from
 * silently shadowing the account they logged into the app with. Every case
 * here is load-bearing in that specific sense.
 */
describe('loadClaudeSettingsEnv — managed credential precedence (D60)', () => {
  const saved = {
    authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    managedBaseUrl: process.env.AICLIENT_CLAUDE_BASE_URL,
    managedAuthToken: process.env.AICLIENT_CLAUDE_AUTH_TOKEN,
    disableTraffic: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  };

  let tmpDir: string;

  beforeEach(async () => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.AICLIENT_CLAUDE_BASE_URL;
    delete process.env.AICLIENT_CLAUDE_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    tmpDir = await mkdtemp(path.join(tmpdir(), 'claude-settings-managed-'));
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['ANTHROPIC_AUTH_TOKEN', saved.authToken],
      ['ANTHROPIC_API_KEY', saved.apiKey],
      ['ANTHROPIC_BASE_URL', saved.baseUrl],
      ['AICLIENT_CLAUDE_BASE_URL', saved.managedBaseUrl],
      ['AICLIENT_CLAUDE_AUTH_TOKEN', saved.managedAuthToken],
      ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', saved.disableTraffic],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeUserSettings(env: Record<string, string>): Promise<string> {
    const settingsPath = path.join(tmpDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ env }), 'utf8');
    return settingsPath;
  }

  it("the managed credential OVERRIDES a stale token in the user's own settings.json", async () => {
    process.env.AICLIENT_CLAUDE_BASE_URL = 'https://managed.example.com/v1';
    process.env.AICLIENT_CLAUDE_AUTH_TOKEN = 'managed-token';
    const settingsPath = await writeUserSettings({
      ANTHROPIC_BASE_URL: 'https://user-stale.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'user-stale-token',
    });

    const { env, diagnostics } = await loadClaudeSettingsEnv(settingsPath);

    expect(env.ANTHROPIC_BASE_URL).toBe('https://managed.example.com/v1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('managed-token');
    expect(diagnostics.credentialSource).toBe('managed');
  });

  it("falls back to the user's settings.json when there is no managed credential", async () => {
    const settingsPath = await writeUserSettings({
      ANTHROPIC_BASE_URL: 'https://user-own.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'user-own-token',
    });

    const { env, diagnostics } = await loadClaudeSettingsEnv(settingsPath);

    expect(env.ANTHROPIC_BASE_URL).toBe('https://user-own.example.com/v1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('user-own-token');
    expect(diagnostics.credentialSource).toBe('settings');
  });

  it('a HALF managed credential is ignored entirely — never paired with the other half from the user file', async () => {
    // Falsifies "just take whichever half is present": our base URL combined
    // with their token is a cross-account request, worse than either source
    // used whole.
    process.env.AICLIENT_CLAUDE_BASE_URL = 'https://managed.example.com/v1';
    const settingsPath = await writeUserSettings({
      ANTHROPIC_BASE_URL: 'https://user-own.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'user-own-token',
    });

    const { env, diagnostics } = await loadClaudeSettingsEnv(settingsPath);

    expect(env.ANTHROPIC_BASE_URL).toBe('https://user-own.example.com/v1');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('user-own-token');
    expect(diagnostics.credentialSource).toBe('settings');
  });

  it('the managed credential drops a stale ANTHROPIC_API_KEY that would otherwise race the token', async () => {
    process.env.AICLIENT_CLAUDE_BASE_URL = 'https://managed.example.com/v1';
    process.env.AICLIENT_CLAUDE_AUTH_TOKEN = 'managed-token';
    const settingsPath = await writeUserSettings({ ANTHROPIC_API_KEY: 'user-stale-api-key' });

    const { env } = await loadClaudeSettingsEnv(settingsPath);

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('managed-token');
  });

  it('applies even when the user has NO settings.json at all (the common first-run case)', async () => {
    process.env.AICLIENT_CLAUDE_BASE_URL = 'https://managed.example.com/v1';
    process.env.AICLIENT_CLAUDE_AUTH_TOKEN = 'managed-token';

    const { env, diagnostics } = await loadClaudeSettingsEnv(
      path.join(tmpDir, 'does-not-exist.json')
    );

    expect(diagnostics.loaded).toBe(false);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('managed-token');
    expect(diagnostics.credentialSource).toBe('managed');
  });

  it('carries our own posture key as env, since there is no managed settings.json to write it into', async () => {
    process.env.AICLIENT_CLAUDE_BASE_URL = 'https://managed.example.com/v1';
    process.env.AICLIENT_CLAUDE_AUTH_TOKEN = 'managed-token';

    const { env } = await loadClaudeSettingsEnv(path.join(tmpDir, 'does-not-exist.json'));

    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('does NOT set the posture key when there is no managed credential (flag-off stays byte-identical)', async () => {
    const settingsPath = await writeUserSettings({ ANTHROPIC_AUTH_TOKEN: 'user-own-token' });

    const { env } = await loadClaudeSettingsEnv(settingsPath);

    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
  });
});
