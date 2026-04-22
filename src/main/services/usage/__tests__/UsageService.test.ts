import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('electron', () => ({
  net: {
    fetch: fetchMock,
  },
}));

describe('UsageService', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  let tempHome: string;

  beforeEach(() => {
    tempHome = join(tmpdir(), `aiclient-usage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempHome, { recursive: true });
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    fetchMock.mockReset();
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
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns { error } when not registered', async () => {
    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();
    expect(result).toEqual({ error: 'Not registered' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns { error } when credentials are not available', async () => {
    mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
    writeFileSync(
      join(tempHome, '.aiclient', 'settings.json'),
      JSON.stringify(
        {
          onboarding: {
            registered: true,
            email: 'user@jcdz.cc',
            serverUrl: 'https://cch.example.com',
          },
        },
        null,
        2
      )
    );

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();
    expect(result).toEqual({ error: 'Credentials not available' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers /api/usage/stats when available', async () => {
    mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
    writeFileSync(
      join(tempHome, '.aiclient', 'settings.json'),
      JSON.stringify(
        {
          onboarding: {
            registered: true,
            email: 'user@jcdz.cc',
            serverUrl: 'https://cch.example.com/',
          },
        },
        null,
        2
      )
    );

    mkdirSync(join(tempHome, '.codex'), { recursive: true });
    writeFileSync(join(tempHome, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'api-key' }, null, 2));

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ todayCount: 3, todayCostUsd: 0.069, monthCount: 9, monthCostUsd: 0.132 }),
    });

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    expect(result).toEqual({ todayCount: 3, todayCostUsd: 0.069, monthCount: 9, monthCostUsd: 0.132 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://cch.example.com/api/usage/stats', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer api-key',
      },
      credentials: 'include',
    });
  });

  it('falls back to actions API when /api/usage/stats is not implemented', async () => {
    mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
    writeFileSync(
      join(tempHome, '.aiclient', 'settings.json'),
      JSON.stringify(
        {
          onboarding: {
            registered: true,
            email: 'user@jcdz.cc',
            serverUrl: 'https://cch.example.com/',
          },
        },
        null,
        2
      )
    );

    mkdirSync(join(tempHome, '.codex'), { recursive: true });
    writeFileSync(join(tempHome, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'api-key' }, null, 2));

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 9, 10, 0, 0));

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not Found' }),
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

    expect(result).toEqual({ todayCount: 3, todayCostUsd: 0.0696284, monthCount: 9, monthCostUsd: 0.1324964 });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://cch.example.com/api/usage/stats', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer api-key',
      },
      credentials: 'include',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://cch.example.com/api/actions/my-usage/getMyTodayStats', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer api-key',
      },
      body: '{}',
      credentials: 'include',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://cch.example.com/api/actions/my-usage/getMyStatsSummary', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer api-key',
      },
      body: JSON.stringify({ startDate: '2026-04-01', endDate: '2026-04-09' }),
      credentials: 'include',
    });
  });

  it('returns { error } when actions API is unauthorized and login fails', async () => {
    mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
    writeFileSync(
      join(tempHome, '.aiclient', 'settings.json'),
      JSON.stringify(
        {
          onboarding: {
            registered: true,
            email: 'user@jcdz.cc',
            serverUrl: 'https://cch.example.com',
          },
        },
        null,
        2
      )
    );

    mkdirSync(join(tempHome, '.codex'), { recursive: true });
    writeFileSync(join(tempHome, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'api-key' }, null, 2));

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not Found' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'Unauthorized' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
      headers: { get: () => null },
    });

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    expect(result).toEqual({ error: 'Unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('logs in and retries actions API when session token mode is opaque', async () => {
    mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
    writeFileSync(
      join(tempHome, '.aiclient', 'settings.json'),
      JSON.stringify(
        {
          onboarding: {
            registered: true,
            email: 'user@jcdz.cc',
            serverUrl: 'https://cch.example.com/',
          },
        },
        null,
        2
      )
    );

    mkdirSync(join(tempHome, '.codex'), { recursive: true });
    writeFileSync(join(tempHome, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'api-key' }, null, 2));

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 9, 10, 0, 0));

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not Found' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'Unauthorized' }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
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

    expect(result).toEqual({ todayCount: 3, todayCostUsd: 0.0696284, monthCount: 9, monthCostUsd: 0.1324964 });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://cch.example.com/api/auth/login', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: 'api-key' }),
      credentials: 'include',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'https://cch.example.com/api/actions/my-usage/getMyTodayStats', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer opaque-session-1',
      },
      body: '{}',
      credentials: 'include',
    });
  });
});
