import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppStateRoot } from '@shared/appStateLayout';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
/** Stands in for `<userData>`'s basename — S2's profile segment. */
const MOCK_USER_DATA_NAME = 'jyw-ai-client-test';
const reportExternalLoginResponseMock = vi.fn();
const vaultReadMock = vi.fn(() => ({ status: 'absent' }) as const);
const authStateGetStateMock = vi.fn(() => ({ status: 'authenticated' }) as { status: string });
const authStateHasRefreshedMock = vi.fn(() => true);
const authStateRefreshMock = vi.fn();
// `vi.mock` factories are hoisted above every top-level statement, including
// plain `const` declarations — a `vi.mock('node:fs', ...)` factory is forced
// to run EAGERLY (before this file's own top-level code executes) because
// this file also has a static top-level `import ... from 'node:fs'` below,
// so a plain `const mockFsExistsSync = vi.fn()` referenced inside the factory
// throws "Cannot access before initialization". `vi.hoisted()` is the
// documented escape hatch: its return value is hoisted together with
// `vi.mock`, so it's guaranteed initialized before any factory runs.
const { mockFsExistsSync, mockFsReadFileSync } = vi.hoisted(() => ({
  mockFsExistsSync: vi.fn(),
  mockFsReadFileSync: vi.fn(),
}));

vi.mock('electron', () => ({
  net: {
    fetch: fetchMock,
  },
  // S2: `OnboardingService.checkRegistration()` resolves the app state root
  // through `app.getPath('userData')` — its basename is the profile segment.
  // Answered with a fixed name so the root this test seeds is the root the
  // production code reads.
  app: {
    getPath: vi.fn((name: string) =>
      name === 'userData' ? join(tmpdir(), MOCK_USER_DATA_NAME) : tmpdir()
    ),
  },
}));

// ESM module namespaces are not configurable, so `vi.spyOn(fsModule, 'existsSync')`
// cannot work directly. Unlike `CredentialVault.test.ts`'s `vi.fn(actual.chmodSync)`
// (that file never calls `vi.resetModules()`), THIS file resets the module
// registry in every `afterEach`, which would otherwise recreate a brand-new
// `vi.fn()` wrapper each time `'node:fs'` is re-evaluated — desyncing from this
// file's own static top-level `existsSync`/`readFileSync` imports (per Vitest's
// docs, static imports are never re-bound by `resetModules`). Delegating to the
// file-scope `mockFsExistsSync`/`mockFsReadFileSync` singletons keeps identity
// stable across resets, so `readCodexApiKeyLegacy()`'s call count stays
// independently assertable (D47 S6 §3 — "legacy reader 零参与，调用数断言 0").
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  mockFsExistsSync.mockImplementation(actual.existsSync);
  mockFsReadFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, existsSync: mockFsExistsSync, readFileSync: mockFsReadFileSync };
});

// Real `services/auth/index.ts` touches `electron.app`/`net` at call time,
// which this file's minimal `electron` mock does not provide — mocked here
// so `UsageService.ts`'s flag-on branches are independently controllable
// (`vaultReadMock`, `authState*Mock`) without needing a real vault/userData dir
// or a real `AuthStateService` singleton.
vi.mock('../../auth', () => ({
  getAuthProbeScheduler: () => ({ reportExternalLoginResponse: reportExternalLoginResponseMock }),
  getCredentialVault: () => ({ read: vaultReadMock }),
  getAuthStateService: () => ({
    hasRefreshed: authStateHasRefreshedMock,
    getState: authStateGetStateMock,
    refresh: authStateRefreshMock,
  }),
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
    authStateGetStateMock.mockReset();
    authStateGetStateMock.mockReturnValue({ status: 'authenticated' });
    authStateHasRefreshedMock.mockReset();
    authStateHasRefreshedMock.mockReturnValue(true);
    authStateRefreshMock.mockReset();
    mockFsExistsSync.mockClear();
    mockFsReadFileSync.mockClear();
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

  /** `~/.pilab/<profile>` — the app's own state root since S2. */
  function appStateRoot(): string {
    return buildAppStateRoot(tempHome, join(tmpdir(), MOCK_USER_DATA_NAME));
  }

  function writeOnboardingState(serverUrl = 'https://cch.example.com/'): void {
    mkdirSync(appStateRoot(), { recursive: true });
    writeFileSync(
      join(appStateRoot(), 'settings.json'),
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

  it('flag on + vault absent: key source is the vault, NOT the legacy ~/.codex file (D47 S5 §2 regression) — legacy reader is never called (D47 S6 §3)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    writeOnboardingState('https://cch.example.com');
    writeLegacyCodexKey(); // legacy file must be ignored once the flag is on

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    expect(result).toEqual({ error: 'Credentials not available' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockFsExistsSync).not.toHaveBeenCalled();
    expect(mockFsReadFileSync).not.toHaveBeenCalled();
  });

  it('flag on + AuthState is not authenticated: the admission gate uses AuthState, NOT legacy registered/serverUrl — the vault is never read (D47 S6 §3)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    writeOnboardingState('https://cch.example.com'); // legacy says registered=true; must be irrelevant now
    authStateGetStateMock.mockReturnValue({ status: 'signed_out' });

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    expect(result).toEqual({ error: 'Not registered' });
    expect(authStateHasRefreshedMock).toHaveBeenCalled();
    expect(vaultReadMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'cleared',
    'rejected',
    'locked',
    'unsupported',
    'invalid',
  ] as const)("flag on + vault status '%s': unavailable, and NEVER falls back to the legacy ~/.codex reader (D47 S6 §3 — stop-dual-write means a stale/rejected legacy key must not silently come back)", async (status) => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    writeLegacyCodexKey('legacy-key-should-never-be-used');
    vaultReadMock.mockReturnValue({ status } as never);

    const { usageService } = await import('../UsageService');
    const result = await usageService.getStats();

    expect(result).toEqual({ error: 'Credentials not available' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockFsExistsSync).not.toHaveBeenCalled();
    expect(mockFsReadFileSync).not.toHaveBeenCalled();
  });

  it('flag on + vault ok: key source AND server URL both come from the vault snapshot (cchBaseUrl/codex.apiKey), never legacy onboarding state — legacy reader is never called (D47 S6 §3)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    writeOnboardingState('https://legacy-should-be-ignored.example.com'); // must be ignored once flag is on
    writeLegacyCodexKey('legacy-key-should-be-ignored');
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: {
        payload: { cchBaseUrl: 'https://cch.example.com', codex: { apiKey: 'vault-api-key' } },
      },
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

    const directCall = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(directCall[0]).toBe('https://cch.example.com/api/actions/my-usage/getMyTodayStats');
    expect(directCall[1].headers.Authorization).toBe('Bearer vault-api-key');
    // Legacy reader (`readCodexApiKeyLegacy()`) never runs once the flag is on
    // — zero fs reads, even though a legacy key file was written above.
    expect(mockFsExistsSync).not.toHaveBeenCalled();
    expect(mockFsReadFileSync).not.toHaveBeenCalled();
  });

  it('flag off: never consults AuthStateService or the vault — vault read count 0 (D47 S6 §3)', async () => {
    writeOnboardingState('https://cch.example.com');
    writeLegacyCodexKey();

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

    expect(vaultReadMock).not.toHaveBeenCalled();
    expect(authStateHasRefreshedMock).not.toHaveBeenCalled();
    expect(authStateGetStateMock).not.toHaveBeenCalled();
  });

  it('D47 S5 §2 — a KEY_INVALID login response is reported to AuthProbeScheduler as an additional trigger source (flag on)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    writeOnboardingState('https://cch.example.com');
    vaultReadMock.mockReturnValue({
      status: 'ok',
      doc: {
        payload: { cchBaseUrl: 'https://cch.example.com', codex: { apiKey: 'vault-api-key' } },
      },
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
