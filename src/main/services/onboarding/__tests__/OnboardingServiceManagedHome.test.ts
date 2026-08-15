import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D47 S2a §1 — OnboardingService's managed-claude-home regenerate branches
 * (login: credentials-object regenerate; logout: deterministic no-credential
 * regenerate). Separate file from `OnboardingService.test.ts` because these
 * cases need `AICLIENT_MANAGED_CREDENTIALS=1` and a per-test isolated
 * userData dir — every existing (flag-off) OnboardingService test must stay
 * unaffected by this file's setup (verified separately: that suite passes
 * unchanged with this file's imports untouched).
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

describe('OnboardingService managed claude-home regenerate (D47 S2a §1)', () => {
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

  it('login (flag on) regenerates managed settings.json from the credentials object and shuts down the host', async () => {
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

    const { onboardingService } = await import('../OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

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

    // Give the fire-and-forget shutdown() microtask a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('logout (flag on) regenerates managed settings.json to an empty env without reading the vault, and shuts down the host', async () => {
    mkdirSync(join(userDataDir, 'claude-home'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://old', ANTHROPIC_AUTH_TOKEN: 'old-token' },
        hooks: { Stop: ['keep-me'] },
      }),
      'utf-8'
    );

    const { onboardingService } = await import('../OnboardingService');
    const ok = onboardingService.logout();
    expect(ok).toBe(true);

    // logout() is synchronous but the managed-home regenerate is
    // fire-and-forget — give it a turn before asserting on disk state.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const managed = JSON.parse(readFileSync(settingsPath(), 'utf-8')) as {
      env: Record<string, string>;
      hooks?: unknown;
    };
    expect(managed.env).toEqual({});
    expect(managed.hooks).toEqual({ Stop: ['keep-me'] });
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('flag off: neither login nor logout touch the managed claude-home directory', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';

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

    const { onboardingService } = await import('../OnboardingService');
    await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    onboardingService.logout();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const { existsSync } = await import('node:fs');
    expect(existsSync(join(userDataDir, 'claude-home'))).toBe(false);
    expect(shutdownMock).not.toHaveBeenCalled();
  });
});
