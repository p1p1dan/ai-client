import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultCrypto } from '../CredentialVault';
import { resetManagedFileWriterQueuesForTests } from '../managedFileWriter';

/**
 * The managed-credentials startup, after D60 removed the managed claude-home.
 *
 * The load-bearing assertions here are the NEGATIVE ones: that we do not set
 * `CLAUDE_CONFIG_DIR`, do not create a claude-home, and do not copy the user's
 * CLAUDE.md anywhere. Those three together are what gives the user their own
 * commands, skills, plugins and instructions back — a regression in any of
 * them is invisible in a passing positive test, which is why each has a case
 * of its own rather than being folded into one "no managed home" check.
 *
 * Lives in its own module (not `main/index.ts`) because that file has
 * module-load-time `electron` side effects unsafe to trigger under vitest's
 * node environment.
 */

const state = { userDataPath: '' };
const modelFetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      version: 1,
      providers: {
        pilab: {
          baseUrl: 'https://vault.example.com/v1',
          api: 'openai-responses',
          models: [{ id: 'gpt-5.6-sol' }],
        },
      },
    }),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '0.0.0-test'),
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
  },
  net: { fetch: modelFetchMock },
}));

function fakeCrypto(available: boolean): VaultCrypto {
  return {
    available: () => available,
    encrypt: (s) => s,
    decrypt: (s) => s,
  };
}

describe('managedCredentialsStartup (D60)', () => {
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
    modelFetchMock.mockClear();
    userDataDir = mkdtempSync(join(tmpdir(), 'managed-startup-userdata-'));
    homeDir = mkdtempSync(join(tmpdir(), 'managed-startup-home-'));
    state.userDataPath = userDataDir;
    process.env.HOME = homeDir;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    // Points `.claude.json` writes at the temp home instead of the real one.
    // `os.homedir()` does not follow `$HOME` on every platform, so the config
    // dir is what keeps this test off a developer's actual machine.
    process.env.CLAUDE_CONFIG_DIR = homeDir;
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
  function userClaudeJsonPath(): string {
    return join(homeDir, '.claude.json');
  }

  describe('flag off — full zero-mutation contract', () => {
    it('activateManagedCredentials makes zero env mutations', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
      process.env.ANTHROPIC_API_KEY = 'leftover-host-key';
      const envSnapshotBefore = { ...process.env };

      const { activateManagedCredentials } = await import('../managedCredentialsStartup');
      activateManagedCredentials();

      expect({ ...process.env }).toEqual(envSnapshotBefore);
    });

    it('writes nothing at all — no claude-home, no .claude.json', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
      const { activateManagedCredentials, ensureUserClaudeJsonOnboarded, regenerateFromVault } =
        await import('../managedCredentialsStartup');

      activateManagedCredentials();
      await ensureUserClaudeJsonOnboarded();
      await regenerateFromVault();

      expect(existsSync(claudeHomeDir())).toBe(false);
      expect(existsSync(userClaudeJsonPath())).toBe(false);
    });
  });

  describe('flag on — phase ①', () => {
    it('does NOT set CLAUDE_CONFIG_DIR (D60: the redirection is gone)', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      delete process.env.CLAUDE_CONFIG_DIR;

      const { activateManagedCredentials } = await import('../managedCredentialsStartup');
      activateManagedCredentials();

      expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });

    it('leaves a CLAUDE_CONFIG_DIR the USER set exactly as they set it', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      process.env.CLAUDE_CONFIG_DIR = '/tmp/user-chosen-config';

      const { activateManagedCredentials } = await import('../managedCredentialsStartup');
      activateManagedCredentials();

      expect(process.env.CLAUDE_CONFIG_DIR).toBe('/tmp/user-chosen-config');
    });

    it('strips credential-shaped env inherited from the shell', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      process.env.ANTHROPIC_API_KEY = 'leftover-host-key';
      process.env.ANTHROPIC_AUTH_TOKEN = 'leftover-host-token';

      const { activateManagedCredentials } = await import('../managedCredentialsStartup');
      activateManagedCredentials();

      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    it('never creates a managed claude-home directory', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      const { activateManagedCredentials, ensureUserClaudeJsonOnboarded } = await import(
        '../managedCredentialsStartup'
      );
      activateManagedCredentials();
      await ensureUserClaudeJsonOnboarded();

      expect(existsSync(claudeHomeDir())).toBe(false);
    });

    it("leaves the user's own CLAUDE.md alone — no copy anywhere", async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      const userClaudeMd = join(homeDir, '.claude', 'CLAUDE.md');
      writeFileSync(userClaudeMd, '# my global instructions', 'utf-8');

      const { activateManagedCredentials, ensureUserClaudeJsonOnboarded } = await import(
        '../managedCredentialsStartup'
      );
      activateManagedCredentials();
      await ensureUserClaudeJsonOnboarded();

      expect(readFileSync(userClaudeMd, 'utf-8')).toBe('# my global instructions');
      expect(existsSync(join(claudeHomeDir(), 'CLAUDE.md'))).toBe(false);
    });

    it("marks onboarding complete in the user's .claude.json", async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      const { activateManagedCredentials, ensureUserClaudeJsonOnboarded } = await import(
        '../managedCredentialsStartup'
      );
      activateManagedCredentials();
      await ensureUserClaudeJsonOnboarded();

      const doc = JSON.parse(readFileSync(userClaudeJsonPath(), 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(doc.hasCompletedOnboarding).toBe(true);
    });

    it('MERGES into an existing .claude.json — every key the user already had survives, and theirs wins', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      writeFileSync(
        userClaudeJsonPath(),
        JSON.stringify({
          hasCompletedOnboarding: false,
          mcpServers: { mine: { command: 'my-server' } },
          projects: { '/repo/a': { hasTrustDialogAccepted: true } },
        }),
        'utf-8'
      );

      const { activateManagedCredentials, ensureUserClaudeJsonOnboarded } = await import(
        '../managedCredentialsStartup'
      );
      activateManagedCredentials();
      await ensureUserClaudeJsonOnboarded();

      const doc = JSON.parse(readFileSync(userClaudeJsonPath(), 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(doc.mcpServers).toEqual({ mine: { command: 'my-server' } });
      expect(doc.projects).toEqual({ '/repo/a': { hasTrustDialogAccepted: true } });
      // Their explicit `false` wins over our default `true`: this file is
      // theirs, and we only fill in what is missing.
      expect(doc.hasCompletedOnboarding).toBe(false);
    });
  });

  describe('flag on — phase ③ no longer writes any Claude file', () => {
    async function setupPromoted(cryptoAvailable: boolean) {
      const authIndex = await import('../index');
      authIndex.getCredentialVault().promoteCrypto(fakeCrypto(cryptoAvailable));
      return authIndex;
    }

    it('vault ok: no settings.json is written anywhere — the credential travels as env instead', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      const authIndex = await setupPromoted(true);
      await authIndex.getCredentialVault().save({
        identity: { email: 'a@jcdz.cc', userId: 1 },
        cchBaseUrl: 'https://cch.example.com',
        claude: { baseUrl: 'https://vault.example.com/v1', authToken: 'vault-token' },
        codex: { baseUrl: 'https://vault.example.com/v1', apiKey: 'vault-codex' },
        receivedAt: new Date().toISOString(),
      });

      const { activateManagedCredentials, ensureUserClaudeJsonOnboarded, regenerateFromVault } =
        await import('../managedCredentialsStartup');
      activateManagedCredentials();
      await ensureUserClaudeJsonOnboarded();
      await regenerateFromVault();

      expect(existsSync(join(claudeHomeDir(), 'settings.json'))).toBe(false);
      expect(existsSync(join(homeDir, '.claude', 'settings.json'))).toBe(false);
    });

    it("never writes the user's own settings.json, even when they already have one", async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      mkdirSync(join(homeDir, '.claude'), { recursive: true });
      const userSettings = join(homeDir, '.claude', 'settings.json');
      const originalBytes = JSON.stringify({ hooks: { mine: true }, statusLine: 'custom' });
      writeFileSync(userSettings, originalBytes, 'utf-8');

      const authIndex = await setupPromoted(true);
      await authIndex.getCredentialVault().save({
        identity: { email: 'a@jcdz.cc', userId: 1 },
        cchBaseUrl: 'https://cch.example.com',
        claude: { baseUrl: 'https://vault.example.com/v1', authToken: 'vault-token' },
        codex: { baseUrl: 'https://vault.example.com/v1', apiKey: 'vault-codex' },
        receivedAt: new Date().toISOString(),
      });

      const { activateManagedCredentials, regenerateFromVault } = await import(
        '../managedCredentialsStartup'
      );
      activateManagedCredentials();
      await regenerateFromVault();

      expect(readFileSync(userSettings, 'utf-8')).toBe(originalBytes);
    });
  });

  /**
   * S0' (D60) replaced this whole describe block.
   *
   * What stood here: phase ③ materialised `<userData>/codex-home` — generating
   * `config.toml` from the vault, preserving its bytes on a `locked` vault,
   * declining to write one when the vault was absent, and deleting a stale
   * `auth.json` on every pass. Four tests, all about a directory.
   *
   * There is no directory. Codex reads the user's own `~/.codex`, and the
   * provider table is assembled as `-c` overrides at spawn time from
   * `AICLIENT_CODEX_BASE_URL`/`AICLIENT_CODEX_API_KEY`. So the property worth
   * pinning inverted: phase ③ must now write NOTHING.
   */
  describe("flag on — phase ③ writes nothing (S0'/D60)", () => {
    function codexHomeDir(): string {
      return join(userDataDir, 'codex-home');
    }

    async function runPhaseThree(): Promise<void> {
      const { activateManagedCredentials, ensureUserClaudeJsonOnboarded, regenerateFromVault } =
        await import('../managedCredentialsStartup');
      activateManagedCredentials();
      await ensureUserClaudeJsonOnboarded();
      await regenerateFromVault();
    }

    it('creates no codex-home, even with a fully populated vault', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      const authIndex = await import('../index');
      authIndex.getCredentialVault().promoteCrypto(fakeCrypto(true));
      await authIndex.getCredentialVault().save({
        identity: { email: 'a@jcdz.cc', userId: 1 },
        cchBaseUrl: 'https://cch.example.com',
        claude: { baseUrl: 'https://vault.example.com/v1', authToken: 'vault-token' },
        codex: { baseUrl: 'https://vault-codex.example.com/v1', apiKey: 'vault-codex-key' },
        receivedAt: new Date().toISOString(),
      });

      await runPhaseThree();

      expect(existsSync(codexHomeDir())).toBe(false);
    });

    /**
     * The negative control that would catch a regeneration quietly coming back:
     * a directory that already exists must not gain a `config.toml` either.
     */
    it('leaves an existing codex-home directory untouched', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      mkdirSync(codexHomeDir(), { recursive: true });

      await runPhaseThree();

      expect(readdirSync(codexHomeDir())).toEqual([]);
    });

    /**
     * A leftover from a pre-S0' install. Phase ③ used to delete it on every
     * pass; it no longer touches the directory at all, so the file survives.
     * Harmless — nothing reads that path any more — but asserted rather than
     * assumed, because "we stopped deleting it" is exactly the kind of change
     * that should be visible in a test rather than discovered on a machine.
     */
    it('does not delete a stale auth.json left by an older build', async () => {
      process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
      mkdirSync(codexHomeDir(), { recursive: true });
      const staleAuthPath = join(codexHomeDir(), 'auth.json');
      writeFileSync(staleAuthPath, JSON.stringify({ OPENAI_API_KEY: 'stale' }), 'utf-8');

      await runPhaseThree();

      expect(existsSync(staleAuthPath)).toBe(true);
    });
  });
});
