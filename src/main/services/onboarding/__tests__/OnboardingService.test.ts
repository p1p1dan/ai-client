import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const checkPrerequisitesMock = vi.fn();

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

vi.mock('../../cli/AgentInstaller', () => ({
  AgentInstaller: vi.fn().mockImplementation(() => ({
    checkPrerequisites: checkPrerequisitesMock,
  })),
}));

describe('OnboardingService', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  let tempHome: string;

  beforeEach(() => {
    tempHome = join(
      tmpdir(),
      `aiclient-onboarding-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    fetchMock.mockReset();
    checkPrerequisitesMock.mockReset();
    vi.stubGlobal('__ONBOARDING_SERVICE_URL__', 'https://onboarding-test.example.com');
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
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

  it('persists credentials to CLI config files and preserves existing settings', async () => {
    const settingsPath = join(tempHome, '.aiclient', 'settings.json');
    mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          'aiclient-settings': {
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
            SOME_EXISTING_ENV: 'keep-me',
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
    writeFileSync(
      codexConfigPath,
      '# user comments top\nmodel = "user-custom-model"\nmodel_provider = "old"\n\n[profiles.custom]\nname = "my-profile"\nextra = 42\n'
    );
    writeFileSync(
      codexAuthPath,
      JSON.stringify({ OPENAI_API_KEY: 'old-key', OPENAI_ORG: 'org1' }, null, 2)
    );

    const claudeJsonPath = join(tempHome, '.claude.json');
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({ mcpServers: { test: { command: 'node' } } }, null, 2)
    );

    const originalClaudeSettings = readFileSync(claudeSettingsPath, 'utf-8');
    const originalCodexConfig = readFileSync(codexConfigPath, 'utf-8');
    const originalCodexAuth = readFileSync(codexAuthPath, 'utf-8');
    const originalClaudeJson = readFileSync(claudeJsonPath, 'utf-8');

    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          user: { id: 1, name: 'Test User' },
          apiKey: 'unused-top-level-key',
          config: {
            claude: {
              baseUrl: 'https://cch-test.example.com/v1',
              authToken: 'claude-token',
            },
            codex: {
              baseUrl: 'https://cch-test.example.com/v1',
              apiKey: 'codex-key',
            },
          },
        },
      }),
    });

    const { readSettings } = await import('../../../ipc/settings');
    const { onboardingService } = await import('../OnboardingService');

    expect(readSettings()).toEqual({
      'aiclient-settings': {
        state: {
          language: 'zh',
        },
      },
    });

    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://onboarding-test.example.com/api/onboarding/verify-and-register',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@jcdz.cc', code: '123456' }),
      }
    );
    expect(readSettings()).toMatchObject({
      'aiclient-settings': {
        state: {
          language: 'zh',
        },
      },
      onboarding: {
        registered: true,
        email: 'user@jcdz.cc',
        serverUrl: 'https://cch-test.example.com',
      },
    });
    expect(onboardingService.checkRegistration()).toMatchObject({
      registered: true,
      email: 'user@jcdz.cc',
    });

    expect(existsSync(`${claudeSettingsPath}.bak`)).toBe(true);
    expect(readFileSync(`${claudeSettingsPath}.bak`, 'utf-8')).toBe(originalClaudeSettings);

    const updatedClaudeSettings = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8')) as {
      env?: Record<string, unknown>;
      hooks?: unknown;
      permissions?: unknown;
      skipWebFetchPreflight?: unknown;
    };
    expect(updatedClaudeSettings.hooks).toEqual({ Stop: [{ command: 'echo stop' }] });
    expect(updatedClaudeSettings.permissions).toEqual({ allow: ['Read'], deny: [] });
    expect(updatedClaudeSettings.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://cch-test.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'claude-token',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      SOME_EXISTING_ENV: 'keep-me',
    });
    expect(updatedClaudeSettings.skipWebFetchPreflight).toBe(true);

    expect(existsSync(`${codexConfigPath}.bak`)).toBe(true);
    expect(readFileSync(`${codexConfigPath}.bak`, 'utf-8')).toBe(originalCodexConfig);
    expect(existsSync(`${codexAuthPath}.bak`)).toBe(true);
    expect(readFileSync(`${codexAuthPath}.bak`, 'utf-8')).toBe(originalCodexAuth);

    const updatedCodexConfig = readFileSync(codexConfigPath, 'utf-8');
    expect(updatedCodexConfig).toMatch(/# user comments top/);
    expect(updatedCodexConfig).toMatch(/model = "user-custom-model"/);
    expect(updatedCodexConfig).toMatch(/model_provider = "jyw"/);
    expect(updatedCodexConfig).not.toMatch(/model_provider = "old"/);
    expect(updatedCodexConfig).toMatch(/\[profiles\.custom\]/);
    expect(updatedCodexConfig).toMatch(/name = "my-profile"/);
    expect(updatedCodexConfig).toMatch(/extra = 42/);
    expect(updatedCodexConfig).toMatch(/\[model_providers\.jyw\]/);
    expect(updatedCodexConfig).toMatch(/base_url = "https:\/\/cch-test\.example\.com\/v1"/);
    expect(updatedCodexConfig).toMatch(/wire_api = "responses"/);
    expect(JSON.parse(readFileSync(codexAuthPath, 'utf-8'))).toEqual({
      OPENAI_API_KEY: 'codex-key',
      OPENAI_ORG: 'org1',
    });

    const updatedClaudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(updatedClaudeJson).toMatchObject({
      mcpServers: { test: { command: 'node' } },
      hasCompletedOnboarding: true,
    });
    expect(readFileSync(claudeJsonPath, 'utf-8')).not.toBe(originalClaudeJson);
  });

  it('logout removes local CLI credentials', async () => {
    const { onboardingService } = await import('../OnboardingService');

    mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
    writeFileSync(
      join(tempHome, '.aiclient', 'settings.json'),
      JSON.stringify({ onboarding: { registered: true } })
    );

    const claudeSettingsPath = join(tempHome, '.claude', 'settings.json');
    mkdirSync(join(tempHome, '.claude'), { recursive: true });
    writeFileSync(
      claudeSettingsPath,
      JSON.stringify(
        {
          env: {
            ANTHROPIC_BASE_URL: 'https://cch.example.com',
            ANTHROPIC_AUTH_TOKEN: 'token',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            KEEP: 'x',
          },
        },
        null,
        2
      )
    );

    mkdirSync(join(tempHome, '.codex'), { recursive: true });
    writeFileSync(join(tempHome, '.codex', 'config.toml'), 'model_provider = "jyw"\n');
    writeFileSync(
      join(tempHome, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'k' }, null, 2)
    );

    expect(onboardingService.logout()).toBe(true);

    const updatedClaudeSettings = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8')) as {
      env?: Record<string, unknown>;
    };
    expect(updatedClaudeSettings.env).toEqual({ KEEP: 'x' });
    expect(existsSync(join(tempHome, '.codex', 'config.toml'))).toBe(false);
    expect(existsSync(join(tempHome, '.codex', 'auth.json'))).toBe(false);
  });

  it('sendCode posts to /api/onboarding/send-code and returns server response', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: { expiresInSec: 900, resendAfterSec: 30 },
      }),
    });

    const { onboardingService } = await import('../OnboardingService');
    const result = await onboardingService.sendCode('User@JCDZ.CC');

    expect(result).toEqual({
      ok: true,
      data: { expiresInSec: 900, resendAfterSec: 30 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://onboarding-test.example.com/api/onboarding/send-code',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@jcdz.cc' }),
      }
    );
  });

  it('sendCode rejects email with disallowed suffix without hitting network', async () => {
    const { onboardingService } = await import('../OnboardingService');
    const result = await onboardingService.sendCode('user@gmail.com');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('@jcdz.cc');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sendCode accepts both whitelisted suffixes', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, data: { expiresInSec: 900, resendAfterSec: 30 } }),
    });

    const { onboardingService } = await import('../OnboardingService');
    const r1 = await onboardingService.sendCode('a@jcdz.cc');
    const r2 = await onboardingService.sendCode('b@wuhanjingce.com');

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('verifyAndRegister surfaces server error responses without writing files', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: false,
        error: 'CODE_INVALID',
        data: { attemptsLeft: 4 },
      }),
    });

    const { onboardingService } = await import('../OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '999999');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('CODE_INVALID');
    expect(result.data?.attemptsLeft).toBe(4);
    // No state should be persisted on failure.
    expect(onboardingService.checkRegistration().registered).toBe(false);
  });

  it('upserts base_url but preserves custom keys inside existing [model_providers.jyw] block', async () => {
    const codexDir = join(tempHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexConfigPath = join(codexDir, 'config.toml');
    writeFileSync(
      codexConfigPath,
      '[model_providers.jyw]\nname = "custom-name"\nbase_url = "https://other.example.com/v1"\ncustom_extra = "keep-me"\n'
    );

    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          user: { id: 1, name: 'Test User' },
          apiKey: 'unused-top-level-key',
          config: {
            claude: {
              baseUrl: 'https://cch-test.example.com/v1',
              authToken: 'claude-token',
            },
            codex: {
              baseUrl: 'https://cch-test.example.com/v1',
              apiKey: 'codex-key',
            },
          },
        },
      }),
    });

    const { onboardingService } = await import('../OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

    const updated = readFileSync(codexConfigPath, 'utf-8');
    expect(updated).toMatch(/name = "custom-name"/);
    expect(updated).toMatch(/base_url = "https:\/\/cch-test\.example\.com\/v1"/);
    expect(updated).not.toMatch(/base_url = "https:\/\/other\.example\.com/);
    expect(updated).toMatch(/custom_extra = "keep-me"/);
  });

  it('merges auth.json preserving unrelated keys', async () => {
    const codexDir = join(tempHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const codexAuthPath = join(codexDir, 'auth.json');
    writeFileSync(
      codexAuthPath,
      JSON.stringify({ OPENAI_API_KEY: 'old', OPENAI_ORG: 'org1', custom: true }, null, 2)
    );

    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          user: { id: 1, name: 'Test User' },
          apiKey: 'unused-top-level-key',
          config: {
            claude: {
              baseUrl: 'https://cch-test.example.com/v1',
              authToken: 'claude-token',
            },
            codex: {
              baseUrl: 'https://cch-test.example.com/v1',
              apiKey: 'codex-key',
            },
          },
        },
      }),
    });

    const { onboardingService } = await import('../OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

    expect(JSON.parse(readFileSync(codexAuthPath, 'utf-8'))).toEqual({
      OPENAI_API_KEY: 'codex-key',
      OPENAI_ORG: 'org1',
      custom: true,
    });
  });

  it('detectCli merges prerequisite status with CLI detection results', async () => {
    checkPrerequisitesMock.mockResolvedValue({
      gitInstalled: true,
      gitVersion: 'git version 2.43.0.windows.1',
      nodeInstalled: false,
      nodeVersion: 'v16.20.0',
      wingetAvailable: true,
    });

    const { cliDetector } = await import('../../cli/CliDetector');
    vi.mocked(cliDetector.detectOne)
      .mockResolvedValueOnce({
        id: 'claude',
        name: 'Claude',
        command: 'claude',
        installed: true,
        version: '1.0.0',
        isBuiltin: true,
        environment: 'native',
      })
      .mockResolvedValueOnce({
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        installed: false,
        isBuiltin: true,
      });

    const { onboardingService } = await import('../OnboardingService');
    const status = await onboardingService.detectCli();

    expect(status).toEqual({
      gitInstalled: true,
      gitVersion: 'git version 2.43.0.windows.1',
      nodeInstalled: false,
      nodeVersion: 'v16.20.0',
      wingetAvailable: true,
      claudeInstalled: true,
      claudeVersion: '1.0.0',
      codexInstalled: false,
      codexVersion: undefined,
    });
  });
});
