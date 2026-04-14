import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('electron', () => ({
  net: {
    fetch: fetchMock,
  },
  app: {
    on: vi.fn(),
    getPath: vi.fn(() => tmpdir()),
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../cli/CliDetector', () => ({
  cliDetector: {
    detectOne: vi.fn(),
  },
}));

describe('OnboardingService', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  let tempHome: string;

  beforeEach(() => {
    tempHome = join(
      tmpdir(),
      `enso-onboarding-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CLAUDE_CONFIG_DIR = join(tempHome, '.claude');
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.CLAUDE_CONFIG_DIR;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('saves onboarding state without modifying local Claude/Codex config files', async () => {
    const settingsPath = join(tempHome, '.ensoai', 'settings.json');
    mkdirSync(join(tempHome, '.ensoai'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          'enso-settings': {
            state: {
              language: 'zh',
            },
          },
        },
        null,
        2
      )
    );

    const claudeDir = join(tempHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const claudeSettingsPath = join(claudeDir, 'settings.json');
    writeFileSync(
      claudeSettingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [{ command: 'echo stop' }],
          },
          permissions: {
            allow: ['Read'],
            deny: [],
          },
          env: {
            ANTHROPIC_BASE_URL: 'https://old.example.com/v1',
            ANTHROPIC_AUTH_TOKEN: 'old-token',
          },
        },
        null,
        2
      )
    );

    const codexDir = join(tempHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexConfigPath = join(codexDir, 'config.toml');
    const codexAuthPath = join(codexDir, 'auth.json');
    writeFileSync(codexConfigPath, 'model_provider = "old"\n');
    writeFileSync(codexAuthPath, JSON.stringify({ OPENAI_API_KEY: 'old-key' }, null, 2));

    const originalClaudeSettings = readFileSync(claudeSettingsPath, 'utf-8');
    const originalCodexConfig = readFileSync(codexConfigPath, 'utf-8');
    const originalCodexAuth = readFileSync(codexAuthPath, 'utf-8');

    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          user: { id: 1, name: 'Test User' },
          apiKey: 'unused-top-level-key',
          config: {
            claude: {
              baseUrl: 'https://crs.pipidan.qzz.io/v1',
              authToken: 'claude-token',
            },
            codex: {
              baseUrl: 'https://crs.pipidan.qzz.io/v1',
              apiKey: 'codex-key',
            },
          },
        },
      }),
    });

    const { readSettings } = await import('../../../ipc/settings');
    const { onboardingService } = await import('../OnboardingService');
    const { getLiveCredentials } = await import('../credentialStore');

    expect(readSettings()).toEqual({
      'enso-settings': {
        state: {
          language: 'zh',
        },
      },
    });

    const result = await onboardingService.register(
      'user@jcdz.cc',
      'https://cch-jyw.pipidan.qzz.io',
      'secret'
    );

    expect(result.ok).toBe(true);
    expect(readSettings()).toMatchObject({
      'enso-settings': {
        state: {
          language: 'zh',
        },
      },
      onboarding: {
        registered: true,
        email: 'user@jcdz.cc',
        serverUrl: 'https://cch-jyw.pipidan.qzz.io',
      },
    });
    expect(onboardingService.checkRegistration()).toMatchObject({
      registered: true,
      email: 'user@jcdz.cc',
    });

    expect(getLiveCredentials()).toEqual({
      claudeAuthToken: 'claude-token',
      claudeBaseUrl: 'https://cch-jyw.pipidan.qzz.io',
      codexApiKey: 'codex-key',
      codexBaseUrl: 'https://cch-jyw.pipidan.qzz.io/v1',
    });

    // No local CLI config mutation.
    expect(readFileSync(claudeSettingsPath, 'utf-8')).toBe(originalClaudeSettings);
    expect(existsSync(join(claudeDir, 'backups'))).toBe(false);

    expect(readFileSync(codexConfigPath, 'utf-8')).toBe(originalCodexConfig);
    expect(readFileSync(codexAuthPath, 'utf-8')).toBe(originalCodexAuth);
    expect(existsSync(join(codexDir, 'backups'))).toBe(false);
  });

  it('fetchLiveCredentials returns null when not registered', async () => {
    const { onboardingService } = await import('../OnboardingService');
    const creds = await onboardingService.fetchLiveCredentials('user@jcdz.cc');
    expect(creds).toBeNull();
  });

  it('fetchLiveCredentials returns credentials when registered', async () => {
    const settingsPath = join(tempHome, '.ensoai', 'settings.json');
    mkdirSync(join(tempHome, '.ensoai'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          onboarding: {
            registered: true,
            email: 'user@jcdz.cc',
            serverUrl: 'https://cch-jyw.pipidan.qzz.io',
            registeredAt: new Date().toISOString(),
          },
        },
        null,
        2
      )
    );

    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          user: { id: 1, name: 'Test User' },
          apiKey: 'unused-top-level-key',
          config: {
            claude: {
              baseUrl: 'https://crs.pipidan.qzz.io/v1',
              authToken: 'claude-token',
            },
            codex: {
              baseUrl: 'https://crs.pipidan.qzz.io/v1',
              apiKey: 'codex-key',
            },
          },
        },
      }),
    });

    const { onboardingService } = await import('../OnboardingService');

    const creds = await onboardingService.fetchLiveCredentials('user@jcdz.cc');
    expect(creds).toEqual({
      claudeAuthToken: 'claude-token',
      claudeBaseUrl: 'https://cch-jyw.pipidan.qzz.io',
      codexApiKey: 'codex-key',
      codexBaseUrl: 'https://cch-jyw.pipidan.qzz.io/v1',
    });
  });
});
