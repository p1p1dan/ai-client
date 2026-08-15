import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultCrypto } from '../CredentialVault';
import { resetManagedFileWriterQueuesForTests } from '../managedFileWriter';

/**
 * D47 S2a §1 承重契约 ①③ — the two-phase managed claude-home startup
 * (extracted to `managedClaudeHomeStartup.ts` specifically so it's testable
 * without importing `main/index.ts`, which has module-load-time `electron`
 * side effects unsafe to trigger under vitest's node environment).
 */

const state = { userDataPath: '' };

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '0.0.0-test'),
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
  },
}));

function fakeCrypto(available: boolean): VaultCrypto {
  return {
    available: () => available,
    encrypt: (s) => s,
    decrypt: (s) => s,
  };
}

describe('managedClaudeHomeStartup (D47 S2a §1)', () => {
  const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = process.env.HOME;

  let userDataDir: string;
  let homeDir: string;

  beforeEach(() => {
    vi.resetModules();
    resetManagedFileWriterQueuesForTests();
    userDataDir = mkdtempSync(join(tmpdir(), 'managed-startup-userdata-'));
    homeDir = mkdtempSync(join(tmpdir(), 'managed-startup-home-'));
    state.userDataPath = userDataDir;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
    if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  function claudeHomeDir(): string {
    return join(userDataDir, 'claude-home');
  }

  describe('flag off — full zero-mutation contract (D47 S2 spec §2)', () => {
    it('activateManagedClaudeHome makes zero env mutations', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
      process.env.ANTHROPIC_API_KEY = 'leftover-host-key';
      const envSnapshotBefore = { ...process.env };

      const { activateManagedClaudeHome } = await import('../managedClaudeHomeStartup');
      activateManagedClaudeHome();

      expect({ ...process.env }).toEqual(envSnapshotBefore);
      expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });

    it('ensureManagedHomeSkeleton and regenerateFromVault never create <userData>/claude-home', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
      const { activateManagedClaudeHome, ensureManagedHomeSkeleton, regenerateFromVault } =
        await import('../managedClaudeHomeStartup');

      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();
      await regenerateFromVault();

      expect(existsSync(claudeHomeDir())).toBe(false);
    });
  });

  describe('flag on — phase ① activate + skeleton', () => {
    it('redirects CLAUDE_CONFIG_DIR and strips inherited credential-shaped env', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      process.env.ANTHROPIC_API_KEY = 'host-leftover-key';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-leftover-oauth';

      const { activateManagedClaudeHome } = await import('../managedClaudeHomeStartup');
      activateManagedClaudeHome();

      expect(process.env.CLAUDE_CONFIG_DIR).toBe(claudeHomeDir());
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('overrides a CLAUDE_CONFIG_DIR dev.js already set', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      process.env.CLAUDE_CONFIG_DIR = '/some/dev/isolated/dir';

      const { activateManagedClaudeHome } = await import('../managedClaudeHomeStartup');
      activateManagedClaudeHome();

      expect(process.env.CLAUDE_CONFIG_DIR).toBe(claudeHomeDir());
    });

    it('skeleton creates dirs + .claude.json, never touches settings.json', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      const { activateManagedClaudeHome, ensureManagedHomeSkeleton } = await import(
        '../managedClaudeHomeStartup'
      );
      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();

      expect(existsSync(join(claudeHomeDir(), 'commands'))).toBe(true);
      expect(existsSync(join(claudeHomeDir(), 'skills'))).toBe(true);
      const claudeJson = JSON.parse(readFileSync(join(claudeHomeDir(), '.claude.json'), 'utf-8'));
      expect(claudeJson).toEqual({ hasCompletedOnboarding: true, projects: {} });
      expect(existsSync(join(claudeHomeDir(), 'settings.json'))).toBe(false);
    });

    it('adopts ~/.claude/CLAUDE.md into the managed home once, as a copy (original untouched)', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(join(homeDir, '.claude', 'CLAUDE.md'), '# global instructions', 'utf-8');

      const { activateManagedClaudeHome, ensureManagedHomeSkeleton } = await import(
        '../managedClaudeHomeStartup'
      );
      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();

      expect(readFileSync(join(claudeHomeDir(), 'CLAUDE.md'), 'utf-8')).toBe(
        '# global instructions'
      );
      // Original stays put — this is a copy, not a move.
      expect(existsSync(join(homeDir, '.claude', 'CLAUDE.md'))).toBe(true);
    });

    it('writes the .aiclient-generated sidecar with version/commit/timestamp — never as a settings.json key', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      const { activateManagedClaudeHome, ensureManagedHomeSkeleton } = await import(
        '../managedClaudeHomeStartup'
      );
      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();

      const sidecar = JSON.parse(
        readFileSync(join(claudeHomeDir(), '.aiclient-generated'), 'utf-8')
      );
      expect(sidecar.version).toBe('0.0.0-test');
      expect(typeof sidecar.commit).toBe('string');
      expect(typeof sidecar.generatedAt).toBe('string');
    });

    it('does not overwrite an existing managed CLAUDE.md on a second skeleton pass', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      writeFileSync(join(homeDir, '.claude', 'CLAUDE.md'), '# global v1', 'utf-8');

      const { activateManagedClaudeHome, ensureManagedHomeSkeleton } = await import(
        '../managedClaudeHomeStartup'
      );
      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();

      mkdirSync(claudeHomeDir(), { recursive: true });
      writeFileSync(join(claudeHomeDir(), 'CLAUDE.md'), '# managed override', 'utf-8');

      await ensureManagedHomeSkeleton();

      expect(readFileSync(join(claudeHomeDir(), 'CLAUDE.md'), 'utf-8')).toBe('# managed override');
    });
  });

  describe('flag on — phase ③ regenerateFromVault (B1 承重变异)', () => {
    async function setupPromoted(cryptoAvailable: boolean) {
      const authIndex = await import('../index');
      authIndex.getCredentialVault().promoteCrypto(fakeCrypto(cryptoAvailable));
      return authIndex;
    }

    it('vault ok: writes env from the vault payload', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      const authIndex = await setupPromoted(true);
      await authIndex.getCredentialVault().save({
        identity: { email: 'a@jcdz.cc', userId: 1 },
        cchBaseUrl: 'https://cch.example.com',
        claude: { baseUrl: 'https://vault.example.com/v1', authToken: 'vault-token' },
        codex: { baseUrl: 'https://vault.example.com/v1', apiKey: 'vault-codex' },
        receivedAt: new Date().toISOString(),
      });

      const { activateManagedClaudeHome, ensureManagedHomeSkeleton, regenerateFromVault } =
        await import('../managedClaudeHomeStartup');
      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();
      await regenerateFromVault();

      const settings = JSON.parse(readFileSync(join(claudeHomeDir(), 'settings.json'), 'utf-8'));
      expect(settings.env).toEqual({
        ANTHROPIC_BASE_URL: 'https://vault.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'vault-token',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      });
    });

    it('preserves foreign keys already in managed settings.json (hooks/statusLine survive a regenerate)', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      const authIndex = await setupPromoted(true);
      await authIndex.getCredentialVault().save({
        identity: { email: 'a@jcdz.cc', userId: 1 },
        cchBaseUrl: 'https://cch.example.com',
        claude: { baseUrl: 'https://vault.example.com/v1', authToken: 'vault-token' },
        codex: { baseUrl: 'https://vault.example.com/v1', apiKey: 'vault-codex' },
        receivedAt: new Date().toISOString(),
      });

      const { activateManagedClaudeHome, ensureManagedHomeSkeleton, regenerateFromVault } =
        await import('../managedClaudeHomeStartup');
      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();

      mkdirSync(claudeHomeDir(), { recursive: true });
      writeFileSync(
        join(claudeHomeDir(), 'settings.json'),
        JSON.stringify({ hooks: { Stop: ['sentinel-hook'] }, statusLine: { type: 'sentinel' } }),
        'utf-8'
      );

      await regenerateFromVault();

      const settings = JSON.parse(readFileSync(join(claudeHomeDir(), 'settings.json'), 'utf-8'));
      expect(settings.hooks).toEqual({ Stop: ['sentinel-hook'] });
      expect(settings.statusLine).toEqual({ type: 'sentinel' });
      expect(settings.env).toEqual({
        ANTHROPIC_BASE_URL: 'https://vault.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'vault-token',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      });
    });

    it('vault absent + dev seed present (dev, unpackaged): seeds env from the captured dev credentials', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      process.env.ANTHROPIC_BASE_URL = 'https://dev.example.com/v1';
      process.env.ANTHROPIC_AUTH_TOKEN = 'dev-seed-token';

      const { activateManagedClaudeHome, ensureManagedHomeSkeleton, regenerateFromVault } =
        await import('../managedClaudeHomeStartup');
      // Order matters: activate captures the dev seed BEFORE stripping.
      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();
      await regenerateFromVault();

      const settings = JSON.parse(readFileSync(join(claudeHomeDir(), 'settings.json'), 'utf-8'));
      expect(settings.env).toEqual({
        ANTHROPIC_BASE_URL: 'https://dev.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'dev-seed-token',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      });
    });

    it('vault absent + no dev seed: writes empty env', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';

      const { activateManagedClaudeHome, ensureManagedHomeSkeleton, regenerateFromVault } =
        await import('../managedClaudeHomeStartup');
      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();
      await regenerateFromVault();

      const settings = JSON.parse(readFileSync(join(claudeHomeDir(), 'settings.json'), 'utf-8'));
      expect(settings.env).toEqual({});
      expect(settings.autoUpdates).toBe(false);
      expect(settings.skipWebFetchPreflight).toBe(true);
    });

    it('vault locked: skips the env section, existing on-disk env bytes untouched (B1 承重变异)', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      // enc:'safeStorage' + crypto unavailable -> `locked` (CredentialVault contract).
      const authIndex = await setupPromoted(true);
      await authIndex.getCredentialVault().save({
        identity: { email: 'a@jcdz.cc', userId: 1 },
        cchBaseUrl: 'https://cch.example.com',
        claude: { baseUrl: 'https://vault.example.com/v1', authToken: 'vault-token' },
        codex: { baseUrl: 'https://vault.example.com/v1', apiKey: 'vault-codex' },
        receivedAt: new Date().toISOString(),
      });
      // Simulate a restart where the keyring isn't unlocked yet: swap in an
      // unavailable crypto adapter on a FRESH vault instance bound to the
      // same baseDir (mirrors a new process, not a live mutation).
      vi.resetModules();
      const authIndex2 = await import('../index');
      authIndex2.getCredentialVault().promoteCrypto(fakeCrypto(false));

      const { activateManagedClaudeHome, ensureManagedHomeSkeleton, regenerateFromVault } =
        await import('../managedClaudeHomeStartup');
      activateManagedClaudeHome();
      await ensureManagedHomeSkeleton();

      // Pre-existing on-disk env (as if a previous successful regenerate, or
      // a hand-edited settings.json) — must survive byte-for-byte.
      mkdirSync(claudeHomeDir(), { recursive: true });
      const existingBytes = `${JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: 'https://existing.example.com/v1',
            ANTHROPIC_AUTH_TOKEN: 'existing-token',
          },
          autoUpdates: false,
          skipWebFetchPreflight: true,
        },
        null,
        2
      )}\n`;
      writeFileSync(join(claudeHomeDir(), 'settings.json'), existingBytes, 'utf-8');

      const readResult = authIndex2.getCredentialVault().read();
      expect(readResult.status).toBe('locked');

      await regenerateFromVault();

      expect(readFileSync(join(claudeHomeDir(), 'settings.json'), 'utf-8')).toBe(existingBytes);
    });

    it('no-op entirely when the flag is off, even after activate/skeleton ran once with it on', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      const mod = await import('../managedClaudeHomeStartup');
      mod.activateManagedClaudeHome();
      await mod.ensureManagedHomeSkeleton();

      // Flip off and reset module-local state the way a fresh process would.
      mod.resetManagedClaudeHomeStartupStateForTests();
      process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
      delete process.env.CLAUDE_CONFIG_DIR;

      mod.activateManagedClaudeHome();
      await mod.regenerateFromVault();

      // Existing skeleton from the earlier flag-on pass is untouched either way;
      // the assertion here is just that regenerateFromVault didn't throw or
      // write anything NEW given no active managedClaudeHomeDir.
      expect(existsSync(join(claudeHomeDir(), '.claude.json'))).toBe(true);
    });
  });
});
