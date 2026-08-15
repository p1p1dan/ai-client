import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

describe('vault vs. legacy files — same login, same bytes (§3-1g)', () => {
  it('vault claude/codex/cch baseUrls equal the legacy files byte-for-byte', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    fetchMock.mockResolvedValue(successFetchResponse('claude-secret-token-abc'));

    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', userDataDir);
    authIndex.getCredentialVault().promoteCrypto(fakeCrypto());

    const { onboardingService } = await import('../../onboarding/OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

    const claudeSettings = JSON.parse(
      readFileSync(join(tempHome, '.claude', 'settings.json'), 'utf-8')
    ) as { env: { ANTHROPIC_BASE_URL: string } };
    const codexConfig = readFileSync(join(tempHome, '.codex', 'config.toml'), 'utf-8');
    const codexBaseUrlMatch = codexConfig.match(/base_url = "([^"]+)"/);
    const aiclientSettings = JSON.parse(
      readFileSync(join(tempHome, '.aiclient', 'settings.json'), 'utf-8')
    ) as { onboarding: { serverUrl: string } };

    const readResult = authIndex.getCredentialVault().read();
    expect(readResult.status).toBe('ok');
    if (readResult.status === 'ok') {
      expect(readResult.doc.payload.claude.baseUrl).toBe(claudeSettings.env.ANTHROPIC_BASE_URL);
      expect(readResult.doc.payload.codex.baseUrl).toBe(codexBaseUrlMatch?.[1]);
      expect(readResult.doc.payload.cchBaseUrl).toBe(aiclientSettings.onboarding.serverUrl);
    }
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
