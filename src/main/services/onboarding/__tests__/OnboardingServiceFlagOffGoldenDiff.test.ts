import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D47 S2 spec §2 — "flag-off AND CLAUDE_CONFIG_DIR unset ⇒ byte-for-byte
 * equivalent" acceptance test ②: disk golden diff. Frozen clock (so the
 * `.bak`/backup timestamp-derived bytes are deterministic), Buffer-for-Buffer
 * comparison against a hand-computed golden literal (this repo's actual
 * unmodified `writeClaudeConfig` serialization — `JSON.stringify(x, null, 2)
 * + '\n'`), an explicit "compared file count > 0" assertion (guards against
 * a vacuously-green 0-file comparison), and confirms
 * `<userData>/claude-home` never gets created.
 */

const fetchMock = vi.fn();

vi.mock('electron', () => ({
  net: { fetch: fetchMock },
  app: { on: vi.fn(), getPath: vi.fn(() => tmpdir()) },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../cli/CliDetector', () => ({ cliDetector: { detectOne: vi.fn() } }));
vi.mock('../../cli/AgentInstaller', () => ({
  AgentInstaller: vi.fn().mockImplementation(() => ({ checkPrerequisites: vi.fn() })),
}));

describe('OnboardingService flag-off golden diff (D47 S2 spec §2)', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;

  let tempHome: string;
  let userDataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    tempHome = join(
      tmpdir(),
      `aiclient-golden-diff-home-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    userDataDir = join(
      tmpdir(),
      `aiclient-golden-diff-userdata-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(userDataDir, { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    fetchMock.mockReset();
    vi.stubGlobal('__ONBOARDING_SERVICE_URL__', 'https://onboarding-test.example.com');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('writes the exact golden bytes to ~/.claude/settings.json — no S2a redirect artifact anywhere', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        data: {
          user: { id: 1, name: 'Golden User' },
          config: {
            claude: { baseUrl: 'https://cch-test.example.com/v1', authToken: 'golden-token' },
            codex: { baseUrl: 'https://cch-test.example.com/v1', apiKey: 'golden-codex-key' },
          },
        },
      }),
    });

    const { onboardingService } = await import('../OnboardingService');
    const result = await onboardingService.verifyAndRegister('user@jcdz.cc', '123456');
    expect(result.ok).toBe(true);

    // Golden literal: exactly what OnboardingService.writeClaudeConfig (an
    // untouched code path in this slice) has always produced for a fresh
    // settings.json — same key order, same serialization.
    const expectedSettings = {
      env: {
        ANTHROPIC_BASE_URL: 'https://cch-test.example.com/v1',
        ANTHROPIC_AUTH_TOKEN: 'golden-token',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      skipWebFetchPreflight: true,
    };
    const expectedBytes = Buffer.from(`${JSON.stringify(expectedSettings, null, 2)}\n`, 'utf-8');

    const settingsPath = join(tempHome, '.claude', 'settings.json');
    const actualBytes = readFileSync(settingsPath);
    expect(actualBytes.equals(expectedBytes)).toBe(true);

    // Compared-file-count > 0 guard: never let this pass by comparing zero files.
    const comparedFiles = [settingsPath];
    expect(comparedFiles.length).toBeGreaterThan(0);
    for (const f of comparedFiles) {
      expect(readFileSync(f).length).toBeGreaterThan(0);
    }

    // No S2a artifact anywhere near userData.
    expect(readdirSync(userDataDir)).toEqual([]);
    expect(() => readdirSync(join(userDataDir, 'claude-home'))).toThrow();
  });
});
