import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it("logout removes local CLI credentials surgically — config.toml/auth.json are REWRITTEN, never deleted, and a user's own unrelated provider/keys/comments/files survive (D47 S6 §2, re-anchored)", async () => {
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
    const codexConfigPath = join(tempHome, '.codex', 'config.toml');
    const codexAuthPath = join(tempHome, '.codex', 'auth.json');
    const sentinelPath = join(tempHome, '.codex', 'sentinel-user-file');
    // Fixture deliberately mixes: a comment, this app's own root line + jyw
    // table, and a user's own unrelated provider table — all of which must
    // survive except the jyw root line and the jyw table itself.
    writeFileSync(
      codexConfigPath,
      [
        '# user comment above their own settings',
        'model_provider = "jyw"',
        '',
        '[model_providers.my-own-provider]',
        'name = "My Own Provider"',
        'base_url = "https://my-own.example.com/v1"',
        '',
        '[model_providers.jyw]',
        'name = "jyw"',
        'base_url = "https://cch.example.com/v1"',
        'wire_api = "responses"',
        '',
      ].join('\n')
    );
    writeFileSync(
      codexAuthPath,
      JSON.stringify({ OPENAI_API_KEY: 'k', OPENAI_ORG: 'user-own-org' }, null, 2)
    );
    writeFileSync(sentinelPath, 'user-owned file untouched by logout\n');

    expect(onboardingService.logout()).toBe(true);

    const updatedClaudeSettings = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8')) as {
      env?: Record<string, unknown>;
    };
    expect(updatedClaudeSettings.env).toEqual({ KEEP: 'x' });

    // Surgical, not rmSync: both files still exist.
    expect(existsSync(codexConfigPath)).toBe(true);
    expect(existsSync(codexAuthPath)).toBe(true);

    const updatedCodexConfig = readFileSync(codexConfigPath, 'utf-8');
    expect(updatedCodexConfig).not.toMatch(/^model_provider = "jyw"$/m);
    expect(updatedCodexConfig).not.toMatch(/\[model_providers\.jyw\]/);
    expect(updatedCodexConfig).not.toContain('base_url = "https://cch.example.com/v1"');
    // User's own comment, root-order, and unrelated provider table survive byte-for-byte.
    expect(updatedCodexConfig).toContain('# user comment above their own settings');
    expect(updatedCodexConfig).toContain('[model_providers.my-own-provider]');
    expect(updatedCodexConfig).toContain('base_url = "https://my-own.example.com/v1"');

    expect(JSON.parse(readFileSync(codexAuthPath, 'utf-8'))).toEqual({
      OPENAI_ORG: 'user-own-org',
    });

    // A file logout never touches at all must survive verbatim.
    expect(readFileSync(sentinelPath, 'utf-8')).toBe('user-owned file untouched by logout\n');
  });

  it('D47 S5 §0-3 regression — logout re-pastes email instead of letting the shallow settings merge silently drop it', async () => {
    const { onboardingService } = await import('../OnboardingService');

    mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
    writeFileSync(
      join(tempHome, '.aiclient', 'settings.json'),
      JSON.stringify({
        onboarding: {
          registered: true,
          email: 'user@jcdz.cc',
          serverUrl: 'https://cch.example.com',
          registeredAt: '2026-08-01T00:00:00.000Z',
        },
      })
    );

    expect(onboardingService.logout()).toBe(true);

    const settings = JSON.parse(
      readFileSync(join(tempHome, '.aiclient', 'settings.json'), 'utf-8')
    ) as { onboarding: { registered: boolean; email?: string } };
    expect(settings.onboarding.registered).toBe(false);
    // The bug (pre-fix): a bare `{onboarding:{registered:false}}` patch is a
    // SHALLOW merge (`{...base, ...patch}`) that replaces the whole
    // `onboarding` object, silently dropping `email` — breaking the
    // flag-off re-login pre-fill that reads `onboarding.email`.
    expect(settings.onboarding.email).toBe('user@jcdz.cc');
  });

  it('logout with no prior registration merges email:undefined, never throws (checkRegistration returns registered:false)', async () => {
    const { onboardingService } = await import('../OnboardingService');

    expect(onboardingService.logout()).toBe(true);
    expect(onboardingService.checkRegistration().registered).toBe(false);
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

  it('clears existing ANTHROPIC_API_KEY when registering so it does not shadow ANTHROPIC_AUTH_TOKEN', async () => {
    const claudeDir = join(tempHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const claudeSettingsPath = join(claudeDir, 'settings.json');
    writeFileSync(
      claudeSettingsPath,
      JSON.stringify(
        {
          env: {
            ANTHROPIC_API_KEY: 'sk-ant-old-xxx',
            ANTHROPIC_BASE_URL: 'https://old.example.com/v1',
            ANTHROPIC_AUTH_TOKEN: 'old-token',
            SOME_EXISTING_ENV: 'keep-me',
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

    const updated = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8')) as {
      env?: Record<string, unknown>;
    };
    expect(updated.env).toBeDefined();
    expect(updated.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(updated.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://cch-test.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'claude-token',
      SOME_EXISTING_ENV: 'keep-me',
    });
  });

  it('removes top-level apiKeyHelper when registering so it does not override env credentials', async () => {
    const claudeDir = join(tempHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const claudeSettingsPath = join(claudeDir, 'settings.json');
    writeFileSync(
      claudeSettingsPath,
      JSON.stringify(
        {
          apiKeyHelper: '/bin/echo old-key',
          permissions: { allow: ['Read'], deny: [] },
          hooks: { Stop: [{ command: 'echo stop' }] },
          env: {
            SOME_EXISTING_ENV: 'keep-me',
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

    const updated = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(updated).not.toHaveProperty('apiKeyHelper');
    expect(updated.permissions).toEqual({ allow: ['Read'], deny: [] });
    expect(updated.hooks).toEqual({ Stop: [{ command: 'echo stop' }] });
  });

  it('rejects registration when server returns ok=true but data.config is missing required credentials', async () => {
    const claudeDir = join(tempHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const claudeSettingsPath = join(claudeDir, 'settings.json');
    const originalClaudeSettings = JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: 'https://old.example.com/v1',
          ANTHROPIC_AUTH_TOKEN: 'old-token',
        },
      },
      null,
      2
    );
    writeFileSync(claudeSettingsPath, originalClaudeSettings);

    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          user: { id: 1, name: 'Test User' },
          config: {
            claude: { baseUrl: 'x' },
            codex: { baseUrl: 'x' },
          },
        },
      }),
    });

    const { onboardingService } = await import('../OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/incomplete|credentials/i);
    expect(onboardingService.checkRegistration().registered).toBe(false);
    expect(readFileSync(claudeSettingsPath, 'utf-8')).toBe(originalClaudeSettings);
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

/**
 * D47 S6 §2 (A-M5) — dedicated pure-function coverage for the two surgical
 * removal helpers backing `removeCodexConfig()`. Zero filesystem, zero
 * `OnboardingService` instance: string/object in, string/object out.
 *
 * Dynamic-imported once in `beforeAll` (not a static top-level import):
 * `../OnboardingService` pulls in `electron`, which this file's top-level
 * `vi.mock('electron', ...)` factory satisfies with `fetchMock` — a static
 * import here would hoist above that `const fetchMock = vi.fn()`
 * declaration and throw "Cannot access 'fetchMock' before initialization".
 */
let removeOpenAiApiKey: (authObj: Record<string, unknown>) => Record<string, unknown>;
let removeJywProviderFromToml: (toml: string) => string;

beforeAll(async () => {
  const mod = await import('../OnboardingService');
  removeOpenAiApiKey = mod.removeOpenAiApiKey;
  removeJywProviderFromToml = mod.removeJywProviderFromToml;
});

describe('removeOpenAiApiKey (pure, D47 S6 §2)', () => {
  it("removes only OPENAI_API_KEY, preserving a user's own unrelated keys", () => {
    const input = { OPENAI_API_KEY: 'secret', OPENAI_ORG: 'user-own-org', CUSTOM_FLAG: true };
    expect(removeOpenAiApiKey(input)).toEqual({ OPENAI_ORG: 'user-own-org', CUSTOM_FLAG: true });
  });

  it('is a no-op (returns an equal, distinct object) when the key is already absent', () => {
    const input = { OPENAI_ORG: 'user-own-org' };
    const result = removeOpenAiApiKey(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  it('handles an empty object', () => {
    expect(removeOpenAiApiKey({})).toEqual({});
  });

  it('never mutates the input object', () => {
    const input = { OPENAI_API_KEY: 'secret', KEEP: 1 };
    const snapshot = { ...input };
    removeOpenAiApiKey(input);
    expect(input).toEqual(snapshot);
  });
});

describe('removeJywProviderFromToml (pure, D47 S6 §2)', () => {
  it('strips the [model_providers.jyw] table and the root model_provider = "jyw" line, preserving a user\'s own comment, blank lines, and unrelated provider table', () => {
    const toml = [
      '# user comment above their own settings',
      'model_provider = "jyw"',
      '',
      '[model_providers.my-own-provider]',
      'name = "My Own Provider"',
      'base_url = "https://my-own.example.com/v1"',
      '',
      '[model_providers.jyw]',
      'name = "jyw"',
      'base_url = "https://cch.example.com/v1"',
      'wire_api = "responses"',
      '',
    ].join('\n');

    const result = removeJywProviderFromToml(toml);

    expect(result).not.toMatch(/^model_provider = "jyw"$/m);
    expect(result).not.toContain('[model_providers.jyw]');
    expect(result).not.toContain('base_url = "https://cch.example.com/v1"');
    expect(result).toContain('# user comment above their own settings');
    expect(result).toContain('[model_providers.my-own-provider]');
    expect(result).toContain('name = "My Own Provider"');
    expect(result).toContain('base_url = "https://my-own.example.com/v1"');
  });

  it('leaves a root model_provider line pointing at a DIFFERENT value completely untouched', () => {
    const toml = [
      'model_provider = "my-own-provider"',
      '',
      '[model_providers.jyw]',
      'name = "jyw"',
      '',
    ].join('\n');

    const result = removeJywProviderFromToml(toml);

    expect(result).toContain('model_provider = "my-own-provider"');
    expect(result).not.toContain('[model_providers.jyw]');
  });

  it('is a complete no-op when there is no [model_providers.jyw] table at all (real-machine shape: [model_providers.OpenAI])', () => {
    const toml = [
      '[model_providers.OpenAI]',
      'name = "OpenAI"',
      'base_url = "https://api.openai.com/v1"',
      '',
    ].join('\n');

    expect(removeJywProviderFromToml(toml)).toBe(toml);
  });

  it('handles an empty string', () => {
    expect(removeJywProviderFromToml('')).toBe('');
  });

  it('handles a file that is ONLY the jyw table, collapsing to an empty string', () => {
    const toml = [
      '[model_providers.jyw]',
      'name = "jyw"',
      'base_url = "https://cch.example.com/v1"',
      '',
    ].join('\n');

    expect(removeJywProviderFromToml(toml)).toBe('');
  });

  it('preserves a comment/blank-line-only sentinel file untouched', () => {
    const toml = ['# just a comment', '', '# and another', ''].join('\n');
    expect(removeJywProviderFromToml(toml)).toBe(toml);
  });
});
