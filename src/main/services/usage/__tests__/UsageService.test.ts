import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const reportExternalLoginResponseMock = vi.fn();
const vaultReadMock = vi.fn(() => ({ status: 'absent' }) as const);

vi.mock('electron', () => ({
  net: {
    fetch: fetchMock,
  },
}));

// Real `services/auth/index.ts` touches `electron.app`/`net` at call time,
// which this file's minimal `electron` mock does not provide — mocked here
// so `UsageService.ts`'s flag-on branches are independently controllable
// (`vaultReadMock`) without needing a real vault/userData dir.
vi.mock('../../auth', () => ({
  getAuthProbeScheduler: () => ({ reportExternalLoginResponse: reportExternalLoginResponseMock }),
  getCredentialVault: () => ({ read: vaultReadMock }),
}));

describe('UsageService', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalManagedFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;

  let tempHome: string;

  beforeEach(() => {
    tempHome = join(
      tmpdir(),
      `aiclient-usage-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    fetchMock.mockReset();
    reportExternalLoginResponseMock.mockReset();
    vaultReadMock.mockReset();
    vaultReadMock.mockReturnValue({ status: 'absent' });
  });

  afterEach(() => {
    vi.resetModules();
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
    if (originalManagedFlag === undefined) {
      delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    } else {
      process.env.AICLIENT_MANAGED_CREDENTIALS = originalManagedFlag;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  function writeOnboardingState(serverUrl = 'https://cch.example.com/'): void {
    mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
    writeFileSync(
      join(tempHome, '.aiclient', 'settings.json'),
      JSON.stringify(
        { onboarding: { registered: true, email: 'user@jcdz.cc', serverUrl } },
        null,
        2
      )
    );
  }

  function writeLegacyCodexKey(apiKey = 'api-key'): void {
    mkdirSync(join(tempHome, '.codex'), { recursive: true });
    writeFileSync(
      join(tempHome, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)
    );
  }

  it('returns { error } when not registered', async () => {
    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();
    expect(result).toEqual({ error: 'Not registered' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns { error } when credentials are not available', async () => {
    writeOnboardingState('https://cch.example.com');

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();
    expect(result).toEqual({ error: 'Credentials not available' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches usage stats from the actions API — direct calls use credentials:"omit" (D47 S5 §0-2 regression)', async () => {
    writeOnboardingState();
    writeLegacyCodexKey();

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 9, 10, 0, 0));

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { calls: 3, costUsd: 0.0696284 } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { totalRequests: 9, totalCost: 0.1324964 } }),
    });

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    vi.useRealTimers();

    expect(result).toEqual({
      todayCount: 3,
      todayCostUsd: 0.0696284,
      monthCount: 9,
      monthCostUsd: 0.1324964,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://cch.example.com/api/actions/my-usage/getMyTodayStats',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer api-key',
        },
        body: '{}',
        credentials: 'omit',
      }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cch.example.com/api/actions/my-usage/getMyStatsSummary',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Bearer api-key',
        },
        body: JSON.stringify({ startDate: '2026-04-01', endDate: '2026-04-09' }),
        credentials: 'omit',
      }
    );
  });

  it('returns { error } when actions API is unauthorized and login fails', async () => {
    writeOnboardingState('https://cch.example.com');
    writeLegacyCodexKey();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'Unauthorized' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
      text: async () => '{"error":"Unauthorized"}',
      headers: { get: () => null },
    });

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    expect(result).toEqual({ error: 'Unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('D47 S5 §0-1 regression — the retry sends a Cookie header, never Authorization: Bearer <cookie value>', async () => {
    writeOnboardingState('https://cch.example.com');
    writeLegacyCodexKey();

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 9, 10, 0, 0));

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'Unauthorized' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'set-cookie' ? 'auth-token=opaque-session-1; Path=/;' : null,
      },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { calls: 3, costUsd: 0.0696284 } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { totalRequests: 9, totalCost: 0.1324964 } }),
    });

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    vi.useRealTimers();

    expect(result).toEqual({
      todayCount: 3,
      todayCostUsd: 0.0696284,
      monthCount: 9,
      monthCostUsd: 0.1324964,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://cch.example.com/api/auth/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: 'api-key' }),
      credentials: 'omit',
    });
    const retryCall = fetchMock.mock.calls[2];
    expect(retryCall[0]).toBe('https://cch.example.com/api/actions/my-usage/getMyTodayStats');
    const retryInit = retryCall[1] as { headers: Record<string, string>; credentials: string };
    expect(retryInit.headers).not.toHaveProperty('Authorization');
    expect(retryInit.headers.Cookie).toBe('auth-token=opaque-session-1');
    expect(retryInit.credentials).toBe('omit');
  });

  it('a login success with no extractable session cookie errors out rather than silently retrying via the cookie jar', async () => {
    writeOnboardingState('https://cch.example.com');
    writeLegacyCodexKey();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'Unauthorized' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
      headers: { get: () => null },
    });

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    expect(result).toEqual({ error: 'Login succeeded but no session cookie was returned' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('flag on + vault absent: key source is the vault, NOT the legacy ~/.codex file (D47 S5 §2 regression)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    writeOnboardingState('https://cch.example.com');
    writeLegacyCodexKey(); // legacy file must be ignored once the flag is on

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    expect(result).toEqual({ error: 'Credentials not available' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flag on + vault ok: key source is the vault codex apiKey', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    writeOnboardingState('https://cch.example.com');
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'vault-api-key' } } },
    } as never);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { calls: 1, costUsd: 0.01 } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { totalRequests: 1, totalCost: 0.01 } }),
    });

    const { usageService } = await import('../UsageService');
    await usageService.getStats();

    const directCall = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(directCall.headers.Authorization).toBe('Bearer vault-api-key');
  });

  it('D47 S5 §2 — a KEY_INVALID login response is reported to AuthProbeScheduler as an additional trigger source (flag on)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    writeOnboardingState('https://cch.example.com');
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: { payload: { codex: { apiKey: 'vault-api-key' } } },
    } as never);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'Unauthorized' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'API Key 无效或已过期', errorCode: 'KEY_INVALID' }),
      text: async () => '{"error":"API Key 无效或已过期","errorCode":"KEY_INVALID"}',
      headers: { get: () => null },
    });

    const { usageService } = await import('../UsageService');
    await usageService.getStats();

    expect(reportExternalLoginResponseMock).toHaveBeenCalledWith(
      401,
      '{"error":"API Key 无效或已过期","errorCode":"KEY_INVALID"}'
    );
  });

  it('flag off: reportExternalLoginResponse is never called (probe wiring is managed-mode-only)', async () => {
    writeOnboardingState('https://cch.example.com');
    writeLegacyCodexKey();

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'Unauthorized' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
      text: async () => '{"error":"Unauthorized"}',
      headers: { get: () => null },
    });

    const { usageService } = await import('../UsageService');
    await usageService.getStats();

    expect(reportExternalLoginResponseMock).not.toHaveBeenCalled();
  });

  it('mutation target ⑨ — direct-attempt success at 200 never even reaches loginForActionsSession/reportExternalLoginResponse', async () => {
    writeOnboardingState();
    writeLegacyCodexKey();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 9, 10, 0, 0));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { calls: 1, costUsd: 0.01 } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { totalRequests: 1, totalCost: 0.01 } }),
    });

    const { usageService } = await import('../UsageService');
    await usageService.getStats();
    vi.useRealTimers();

    expect(reportExternalLoginResponseMock).not.toHaveBeenCalled();
  });
});
