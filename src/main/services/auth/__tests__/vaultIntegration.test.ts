import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultCrypto } from '../CredentialVault';

/**
 * D47 S1 §3 test groups 1g and 5, plus mutation target ④ — these need a REAL
 * `OnboardingService.verifyAndRegister()` run (fake `net.fetch`, real
 * filesystem under `mkdtemp`) to compare vault bytes against legacy files and
 * to capture console output. Kept in `services/auth/__tests__` per the S1
 * spec's test-location rule (§3 header), even though it drives
 * `OnboardingService` — the alternative (duplicating this in
 * `onboarding/__tests__`) would violate that rule instead.
 */

const fetchMock = vi.fn();
const state = { userDataPath: '/unused-default-userdata' };

vi.mock('electron', () => ({
  net: { fetch: fetchMock },
  app: {
    on: vi.fn(),
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
    setPath: vi.fn((name: string, value: string) => {
      if (name === 'userData') state.userDataPath = value;
    }),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  ipcMain: { handle: vi.fn() },
}));

function fakeCrypto(): VaultCrypto {
  return {
    available: () => true,
    encrypt: (plainText) => plainText,
    decrypt: (cipherText) => cipherText,
  };
}

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalManagedCredentials = process.env.AICLIENT_MANAGED_CREDENTIALS;

let tempHome: string;
let userDataDir: string;

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  tempHome = mkdtempSync(join(tmpdir(), 'aiclient-vault-integration-home-'));
  userDataDir = mkdtempSync(join(tmpdir(), 'aiclient-vault-integration-userdata-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  vi.stubGlobal('__ONBOARDING_SERVICE_URL__', 'https://onboarding-test.example.com');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalManagedCredentials === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  else process.env.AICLIENT_MANAGED_CREDENTIALS = originalManagedCredentials;
});

function successFetchResponse(token: string) {
  return {
    json: async () => ({
      ok: true,
      data: {
        user: { id: 7, name: 'Byte Check' },
        apiKey: token,
        config: {
          claude: { baseUrl: 'https://cch-test.example.com/v1', authToken: token },
          codex: { baseUrl: 'https://cch-test.example.com/v1', apiKey: token },
        },
      },
    }),
  };
}

describe('vault payload ↔ managed-home generator outputs (§3-1g, re-anchored D47 S6 §3)', () => {
  it('vault claude/codex baseUrls + claude authToken feed generateClaudeSettings()/generateManagedCodexConfigToml() to reproduce the exact managed-home content the runtime regenerate step writes', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const token = 'claude-secret-token-abc';
    fetchMock.mockResolvedValue(successFetchResponse(token));

    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', userDataDir);
    authIndex.getCredentialVault().promoteCrypto(fakeCrypto());

    const { onboardingService } = await import('../../onboarding/OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

    // Stop-dual-write (D47 S6 §2): flag-on never writes ~/.claude or
    // ~/.codex anymore, so there is no independent legacy-file writer left
    // to diff the vault against (the old S1-era version of this test read
    // those files back off disk). Re-anchored instead to re-derive the
    // managed-home outputs from the vault's own saved fields through the
    // SAME pure generators `managedClaudeHomeStartup.ts`/`codexHome.ts`'s
    // regenerate step calls, and check the result against the fixture's
    // known literal values — still an independent-path parity proof (vault
    // write path vs. generator function), just without a legacy write step
    // in between.
    const { generateClaudeSettings } = await import('../claudeHome');
    const { generateManagedCodexConfigToml } = await import('@shared/codexManagedConfig');

    const readResult = authIndex.getCredentialVault().read();
    expect(readResult.status).toBe('ok');
    if (readResult.status !== 'ok') return;
    const { payload } = readResult.doc;

    expect(payload.claude.baseUrl).toBe('https://cch-test.example.com/v1');
    expect(payload.claude.authToken).toBe(token);
    expect(payload.codex.baseUrl).toBe('https://cch-test.example.com/v1');
    expect(payload.codex.apiKey).toBe(token); // same-key doctrine (D47 S6 §1 point 2)

    const claudeSettings = generateClaudeSettings({
      baseUrl: payload.claude.baseUrl,
      authToken: payload.claude.authToken,
    });
    expect(claudeSettings.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://cch-test.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: token,
    });

    const codexToml = generateManagedCodexConfigToml({ baseUrl: payload.codex.baseUrl });
    expect(codexToml).toContain('base_url = "https://cch-test.example.com/v1"');
  });
});

describe('end-to-end token leak guarantee (§3-5a)', () => {
  it('a full verifyAndRegister run never prints the real token, not even its first 6 characters', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const token = 'sk-ant-SENTINEL9f3c1a7b2e';
    fetchMock.mockResolvedValue(successFetchResponse(token));

    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
      logs.push(
        args
          .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)))
          .join(' ')
      );
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);

    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', userDataDir);
    authIndex.getCredentialVault().promoteCrypto(fakeCrypto());

    const { onboardingService } = await import('../../onboarding/OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

    const combined = logs.join('\n');
    expect(combined).not.toContain(token);
    expect(combined).not.toContain(token.slice(0, 6));
  });

  it('flag off — a full verifyAndRegister run STILL never prints the real token (D47 S6 §3-1g re-anchor note: pins the OTHER half of this guarantee — the flag-on arm above alone cannot catch a mutation that only breaks flag-off logging)', async () => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    const token = 'sk-ant-SENTINEL-FLAGOFF-4b8e1c';
    fetchMock.mockResolvedValue(successFetchResponse(token));

    const logs: string[] = [];
    const capture = (...args: unknown[]) => {
      logs.push(
        args
          .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)))
          .join(' ')
      );
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);

    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', userDataDir);
    // Deliberately NOT promoting crypto: flag off never reaches vault.save.

    const { onboardingService } = await import('../../onboarding/OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

    const combined = logs.join('\n');
    expect(combined).not.toContain(token);
    expect(combined).not.toContain(token.slice(0, 6));
    expect(authIndex.getCredentialVault().read()).toEqual({ status: 'absent' });
  });
});

describe('flag off — no vault footprint (§3-5b)', () => {
  it('a full login with the flag off never creates <userData>/credentials', async () => {
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    fetchMock.mockResolvedValue(successFetchResponse('claude-secret-token-flagoff'));

    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', userDataDir);
    // Deliberately NOT promoting crypto: flag off means OnboardingService
    // must never even reach a vault.save call.

    const { onboardingService } = await import('../../onboarding/OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

    expect(existsSync(join(userDataDir, 'credentials'))).toBe(false);
    expect(authIndex.getCredentialVault().read()).toEqual({ status: 'absent' });
  });
});

describe('vault failure is a shadow write, never a verifyAndRegister rejection (§2.7, mutation target ④)', () => {
  it('resolves ok:true even when the vault crypto adapter throws on encrypt', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    fetchMock.mockResolvedValue(successFetchResponse('claude-secret-token-vaultfail'));

    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', userDataDir);
    authIndex.getCredentialVault().promoteCrypto({
      available: () => true,
      encrypt: () => {
        throw new Error('boom: simulated vault encrypt failure');
      },
      decrypt: () => {
        throw new Error('unused');
      },
    });

    const { onboardingService } = await import('../../onboarding/OnboardingService');
    await expect(
      onboardingService.verifyAndRegister('user@jcdz.cc', '123456')
    ).resolves.toMatchObject({ ok: true });
  });
});
