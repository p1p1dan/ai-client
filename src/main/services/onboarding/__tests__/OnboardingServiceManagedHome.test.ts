import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D47 S2a §1 / S3b §2 / S5 §3 — OnboardingService's managed-home regenerate
 * branches: claude-home (login: credentials-object regenerate; logout:
 * deterministic no-credential regenerate) and its codex-home counterpart
 * (login: writes `config.toml`; logout: `config.toml` bytes untouched, stale
 * `auth.json` deleted) — plus the D47 S3b I5 epoch barrier (login awaits Host
 * shutdown before `verifyAndRegister` returns).
 *
 * D47 S5 §3 I9 restructure: `logout()`'s vault-clear/regenerate/shutdown
 * chain moved OUT to `main/ipc/onboarding.ts`'s `performLogoutSequence()`
 * (own test file: `main/ipc/__tests__/onboardingLogoutSequence.test.ts`).
 * This file's logout-side tests now drive `regenerateManagedHomesForLogout()`
 * directly (now public, no `awaitPendingLogoutRegenerate()` needed — that
 * pairing is retired) and confirm the LEGACY half (`logout()`) no longer
 * touches the managed homes or the Host at all.
 *
 * Separate file from `OnboardingService.test.ts` because these cases need
 * `AICLIENT_MANAGED_CREDENTIALS=1` and a per-test isolated userData dir —
 * every existing (flag-off) OnboardingService test must stay unaffected by
 * this file's setup (verified separately: that suite passes unchanged with
 * this file's imports untouched).
 */

const fetchMock = vi.fn();
const shutdownMock = vi.fn().mockResolvedValue(undefined);

vi.mock('electron', () => ({
  net: { fetch: fetchMock },
  app: {
    on: vi.fn(),
    getPath: vi.fn(() => globalThis.__testUserDataDir as string),
  },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../cli/CliDetector', () => ({
  cliDetector: { detectOne: vi.fn() },
}));

vi.mock('../../cli/AgentInstaller', () => ({
  AgentInstaller: vi.fn().mockImplementation(() => ({
    checkPrerequisites: vi.fn(),
  })),
}));

// Dynamic-import target inside OnboardingService — mocked so this test file
// never pulls in the real AgentHostManager dependency graph.
vi.mock('../../agent-host/AgentHostManager', () => ({
  agentHostManager: { shutdown: shutdownMock },
}));

declare global {
  // eslint-disable-next-line no-var
  var __testUserDataDir: string;
}

describe('OnboardingService managed-home regenerate (D47 S2a §1 claude-home / S3b §2 codex-home)', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;

  let tempHome: string;
  let userDataDir: string;

  beforeEach(() => {
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    tempHome = join(tmpdir(), `aiclient-onboarding-managed-home-${nonce}`);
    userDataDir = join(tmpdir(), `aiclient-onboarding-managed-userdata-${nonce}`);
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(userDataDir, { recursive: true });
    globalThis.__testUserDataDir = userDataDir;

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';

    fetchMock.mockReset();
    shutdownMock.mockClear();
    shutdownMock.mockResolvedValue(undefined);
    vi.stubGlobal('__ONBOARDING_SERVICE_URL__', 'https://onboarding-test.example.com');
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
  });

  function settingsPath(): string {
    return join(userDataDir, 'claude-home', 'settings.json');
  }
  function codexConfigPath(): string {
    return join(userDataDir, 'codex-home', 'config.toml');
  }
  function codexAuthPath(): string {
    return join(userDataDir, 'codex-home', 'auth.json');
  }
  function codexSidecarPath(): string {
    return join(userDataDir, 'codex-home', '.aiclient-generated');
  }

  function mockRegisterResponse(): void {
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          user: { id: 1, name: 'Test User' },
          config: {
            claude: { baseUrl: 'https://cch-test.example.com/v1', authToken: 'claude-token' },
            codex: { baseUrl: 'https://cch-test.example.com/v1', apiKey: 'codex-key' },
          },
        },
      }),
    });
  }

  it('login (flag on) regenerates managed settings.json + codex-home/config.toml from the credentials object, and AWAITS host shutdown before returning (D47 S3b I5 epoch barrier)', async () => {
    mockRegisterResponse();

    const { onboardingService } = await import('../OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

    // No extra microtask tick needed — the I5 barrier means shutdown() has
    // already resolved by the time verifyAndRegister's own promise settled.
    expect(shutdownMock).toHaveBeenCalledTimes(1);

    const managed = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as {
      env: Record<string, string>;
      autoUpdates: boolean;
      skipWebFetchPreflight: boolean;
    };
    expect(managed.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://cch-test.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'claude-token',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(managed.autoUpdates).toBe(false);
    expect(managed.skipWebFetchPreflight).toBe(true);

    const { generateManagedCodexConfigToml } = await import('@shared/codexManagedConfig');
    expect(readFileSync(codexConfigPath(), 'utf-8')).toBe(
      generateManagedCodexConfigToml({ baseUrl: 'https://cch-test.example.com/v1' })
    );
    const sidecar = JSON.parse(readFileSync(codexSidecarPath(), 'utf-8'));
    expect(sidecar).toMatchObject({ mode: 'managed', source: 'login' });
  });

  it('login: shutdown() is fully settled BEFORE verifyAndRegister resolves, not merely "eventually called" (I5 ordering, not just presence)', async () => {
    mockRegisterResponse();
    let shutdownSettled = false;
    shutdownMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      shutdownSettled = true;
    });

    const { onboardingService } = await import('../OnboardingService');
    await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');

    expect(shutdownSettled).toBe(true);
  });

  it('login: deletes a stale codex-home/auth.json copy', async () => {
    mockRegisterResponse();
    mkdirSync(join(userDataDir, 'codex-home'), { recursive: true });
    writeFileSync(codexAuthPath(), JSON.stringify({ OPENAI_API_KEY: 'stale' }), 'utf-8');

    const { onboardingService } = await import('../OnboardingService');
    await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');

    expect(existsSync(codexAuthPath())).toBe(false);
  });

  it('regenerateManagedHomesForLogout() (flag on) regenerates managed settings.json to an empty env, leaves codex-home/config.toml bytes untouched, deletes stale auth.json — and does NOT itself shut down the host (D47 S5 §3 I9: shutdown moved OUT to performLogoutSequence checkpoint ③)', async () => {
    mkdirSync(join(userDataDir, 'claude-home'), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://old', ANTHROPIC_AUTH_TOKEN: 'old-token' },
        hooks: { Stop: ['keep-me'] },
      }),
      'utf-8'
    );
    mkdirSync(join(userDataDir, 'codex-home'), { recursive: true });
    const { generateManagedCodexConfigToml } = await import('@shared/codexManagedConfig');
    const existingCodexBytes = generateManagedCodexConfigToml({
      baseUrl: 'https://old-codex.example/v1',
    });
    writeFileSync(codexConfigPath(), existingCodexBytes, 'utf-8');
    writeFileSync(codexAuthPath(), JSON.stringify({ OPENAI_API_KEY: 'stale' }), 'utf-8');

    const { onboardingService } = await import('../OnboardingService');
    await onboardingService.regenerateManagedHomesForLogout();

    const managed = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as {
      env: Record<string, string>;
      hooks?: unknown;
    };
    expect(managed.env).toEqual({});
    expect(managed.hooks).toEqual({ Stop: ['keep-me'] });
    // I9 restructure: this method no longer shuts down the host itself —
    // `performLogoutSequence()` (main/ipc/onboarding.ts) does that BEFORE
    // calling this, as its own checkpoint ③. Covered end-to-end in
    // `main/ipc/__tests__/onboardingLogoutSequence.test.ts`.
    expect(shutdownMock).not.toHaveBeenCalled();

    // codex-home: config.toml bytes stay exactly as they were (B-track B1
    // logout contract — "config 保留"); the stale auth.json copy is gone.
    expect(readFileSync(codexConfigPath(), 'utf-8')).toBe(existingCodexBytes);
    expect(existsSync(codexAuthPath())).toBe(false);
  });

  it("logout() (legacy-only half) no longer touches the managed claude-home OR codex-home directories at all — that is performLogoutSequence()'s job now", async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    mockRegisterResponse();

    const { onboardingService } = await import('../OnboardingService');
    await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    onboardingService.logout();

    expect(existsSync(join(userDataDir, 'claude-home'))).toBe(false);
    expect(existsSync(join(userDataDir, 'codex-home'))).toBe(false);
    expect(shutdownMock).not.toHaveBeenCalled();
  });
});
