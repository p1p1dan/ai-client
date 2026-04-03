import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    tempHome = join(tmpdir(), `enso-onboarding-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

  it('keeps settings cache in sync and writes normalized Claude/Codex configs with backups', async () => {
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
    writeFileSync(
      join(claudeDir, 'settings.json'),
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
    writeFileSync(join(codexDir, 'config.toml'), 'model_provider = "old"\n');
    writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'old-key' }, null, 2));

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

    const claudeSettings = JSON.parse(
      readFileSync(join(claudeDir, 'settings.json'), 'utf-8')
    ) as {
      hooks?: Record<string, unknown>;
      permissions?: Record<string, unknown>;
      env?: Record<string, string>;
    };
    expect(claudeSettings.hooks).toEqual({
      Stop: [{ command: 'echo stop' }],
    });
    expect(claudeSettings.permissions).toEqual({
      allow: ['Read'],
      deny: [],
    });
    expect(claudeSettings.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://crs.pipidan.qzz.io/v1',
      ANTHROPIC_AUTH_TOKEN: 'claude-token',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });

    const claudeBackupsDir = join(claudeDir, 'backups');
    expect(existsSync(claudeBackupsDir)).toBe(true);
    expect(readAnyBackupContaining(claudeBackupsDir, 'old-token')).toBe(true);

    const codexConfig = readFileSync(join(codexDir, 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('model_provider = "cch"');
    expect(codexConfig).toContain('model = "gpt-5.2"');
    expect(codexConfig).toContain('base_url = "https://crs.pipidan.qzz.io/v1"');
    expect(codexConfig).toContain('wire_api = "responses"');

    const codexAuth = JSON.parse(readFileSync(join(codexDir, 'auth.json'), 'utf-8')) as {
      OPENAI_API_KEY: string;
    };
    expect(codexAuth).toEqual({
      OPENAI_API_KEY: 'codex-key',
    });
    expect(existsSync(join(codexDir, 'env.json'))).toBe(false);

    const codexBackupsDir = join(codexDir, 'backups');
    expect(existsSync(codexBackupsDir)).toBe(true);
    expect(readAnyBackupContaining(codexBackupsDir, 'model_provider = "old"')).toBe(true);
  });

  it('returns an error when post-write config validation fails', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          user: { id: 2, name: 'Broken User' },
          apiKey: 'unused-top-level-key',
          config: {
            claude: {
              baseUrl: 'https://crs.pipidan.qzz.io/v1',
              authToken: '',
            },
            codex: {
              baseUrl: 'https://crs.pipidan.qzz.io/v1',
              apiKey: '',
            },
          },
        },
      }),
    });

    const { onboardingService } = await import('../OnboardingService');

    const result = await onboardingService.register(
      'broken@jcdz.cc',
      'https://cch-jyw.pipidan.qzz.io',
      'secret'
    );

    expect(result).toEqual({
      ok: false,
      error: 'Local Claude/Codex configuration validation failed',
    });
  });
});

function readAnyBackupContaining(dirPath: string, expectedFragment: string): boolean {
  return readdirSync(dirPath).some((fileName) =>
    readFileSync(join(dirPath, fileName), 'utf-8').includes(expectedFragment)
  );
}
