import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type AuthProbeFetchResponse,
  AuthProbeScheduler,
  classifyAuthLoginResponse,
} from '../AuthProbeScheduler';
import type { VaultReadResult } from '../CredentialVault';

/** D47 S5 §2/§5 — E5 fixture-driven classify tests + orchestration checkpoints. */

const FIXTURES_DIR = join(__dirname, 'fixtures');

interface E5Fixture {
  request: { endpoint: string; authMode: string };
  response: { status: number; headers: Record<string, string>; bodyText: string };
}

function readFixture(name: string): E5Fixture {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf-8');
  const parsed = JSON.parse(raw) as E5Fixture;
  expect(parsed.response.bodyText.length).toBeGreaterThan(0); // non-empty assertion (A-track M10 style)
  return parsed;
}

describe('classifyAuthLoginResponse — E5 fixture-driven (D47 S5 §2)', () => {
  it('login-valid (200) classifies as unknown (never a rejection signal)', () => {
    const fixture = readFixture('e5-login-valid.json');
    expect(classifyAuthLoginResponse(fixture.response.status, fixture.response.bodyText)).toBe(
      'unknown'
    );
  });

  it('login-key-invalid (401 + errorCode KEY_INVALID) classifies as rejected — the only positive case', () => {
    const fixture = readFixture('e5-login-key-invalid.json');
    expect(classifyAuthLoginResponse(fixture.response.status, fixture.response.bodyText)).toBe(
      'rejected'
    );
  });

  it('actions-401-no-cookie (401 + ok:false, no errorCode) classifies as unknown — the E5 "ok:false" negative control', () => {
    const fixture = readFixture('e5-actions-401-no-cookie.json');
    expect(classifyAuthLoginResponse(fixture.response.status, fixture.response.bodyText)).toBe(
      'unknown'
    );
  });

  it("actions-cookie-200 classifies as unknown (200, not the login endpoint's rejection shape)", () => {
    const fixture = readFixture('e5-actions-cookie-200.json');
    expect(classifyAuthLoginResponse(fixture.response.status, fixture.response.bodyText)).toBe(
      'unknown'
    );
  });

  it('non-JSON body (network/HTML 404 shape) classifies as unknown, never throws', () => {
    expect(classifyAuthLoginResponse(404, '<!DOCTYPE html><title>404</title>')).toBe('unknown');
  });

  it('307 redirect classifies as unknown', () => {
    expect(classifyAuthLoginResponse(307, '')).toBe('unknown');
  });

  it('5xx classifies as unknown', () => {
    expect(classifyAuthLoginResponse(500, '{"error":"internal"}')).toBe('unknown');
  });

  it('401 with an unrecognized JSON shape (no errorCode) classifies as unknown', () => {
    expect(classifyAuthLoginResponse(401, '{"message":"nope"}')).toBe('unknown');
  });
});

function okVaultResult(): VaultReadResult {
  return {
    status: 'ok',
    doc: {
      version: 1,
      enc: 'none',
      lastEmail: 'user@jcdz.cc',
      invalidatedAt: null,
      encReason: 'unavailable',
      payload: {
        identity: { email: 'user@jcdz.cc', userId: 1 },
        cchBaseUrl: 'https://cch.example.com',
        claude: { baseUrl: 'https://cch.example.com/v1', authToken: 'claude-token' },
        codex: { baseUrl: 'https://cch.example.com/v1', apiKey: 'codex-key' },
        receivedAt: '2026-08-15T00:00:00.000Z',
      },
    },
  };
}

function fetchResponse(status: number, bodyText: string): AuthProbeFetchResponse {
  return { status, text: async () => bodyText };
}

describe('AuthProbeScheduler — orchestration (D47 S5 §2/§5)', () => {
  it('handleAuthStateChange("authenticated") fires exactly one immediate probe and starts the timer', async () => {
    const fetchFn = vi.fn(async () => fetchResponse(200, '{"ok":true}'));
    const authStateService = { markRejected: vi.fn(async () => {}), reportRemoteHealthy: vi.fn() };
    const setIntervalFn = vi.fn(() => 'timer-handle');
    const clearIntervalFn = vi.fn();
    const scheduler = new AuthProbeScheduler({
      authStateService,
      vault: { read: () => okVaultResult() },
      fetchFn,
      setIntervalFn,
      clearIntervalFn,
    });

    scheduler.handleAuthStateChange('authenticated');
    await scheduler.probeOnce(); // await the in-flight probe kicked off by handleAuthStateChange

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://cch.example.com/api/auth/login',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ key: 'codex-key' }) })
    );
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(authStateService.reportRemoteHealthy).toHaveBeenCalledTimes(1);
  });

  it('leaving authenticated stops the timer', () => {
    const setIntervalFn = vi.fn(() => 'timer-handle');
    const clearIntervalFn = vi.fn();
    const scheduler = new AuthProbeScheduler({
      authStateService: { markRejected: vi.fn(async () => {}), reportRemoteHealthy: vi.fn() },
      vault: { read: () => okVaultResult() },
      fetchFn: vi.fn(async () => fetchResponse(200, '{}')),
      setIntervalFn,
      clearIntervalFn,
    });

    scheduler.handleAuthStateChange('authenticated');
    scheduler.handleAuthStateChange('signed_out');

    expect(clearIntervalFn).toHaveBeenCalledWith('timer-handle');
  });

  it('a rejected classification calls markRejected exactly once, no vault mutation done by the scheduler itself', async () => {
    const authStateService = { markRejected: vi.fn(async () => {}), reportRemoteHealthy: vi.fn() };
    const scheduler = new AuthProbeScheduler({
      authStateService,
      vault: { read: () => okVaultResult() },
      fetchFn: vi.fn(async () =>
        fetchResponse(401, '{"error":"API Key 无效或已过期","errorCode":"KEY_INVALID"}')
      ),
    });

    await scheduler.probeOnce();

    expect(authStateService.markRejected).toHaveBeenCalledTimes(1);
    expect(authStateService.reportRemoteHealthy).not.toHaveBeenCalled();
  });

  it('mutation target ① — a network error classifies unknown: authenticated/reportRemoteHealthy untouched, markRejected 0 times', async () => {
    const authStateService = { markRejected: vi.fn(async () => {}), reportRemoteHealthy: vi.fn() };
    const scheduler = new AuthProbeScheduler({
      authStateService,
      vault: { read: () => okVaultResult() },
      fetchFn: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    });

    await scheduler.probeOnce();

    expect(authStateService.markRejected).not.toHaveBeenCalled();
    expect(authStateService.reportRemoteHealthy).not.toHaveBeenCalled();
  });

  it('mutation target ② — fixture-driven business-401 (actions shape) never reaches markRejected via reportExternalLoginResponse', () => {
    const fixture = readFixture('e5-actions-401-no-cookie.json');
    const authStateService = { markRejected: vi.fn(async () => {}), reportRemoteHealthy: vi.fn() };
    const scheduler = new AuthProbeScheduler({
      authStateService,
      vault: { read: () => okVaultResult() },
      fetchFn: vi.fn(),
    });

    scheduler.reportExternalLoginResponse(fixture.response.status, fixture.response.bodyText);

    expect(authStateService.markRejected).not.toHaveBeenCalled();
  });

  it('reportExternalLoginResponse routes a rejected login-key-invalid fixture into markRejected — the additional trigger source', () => {
    const fixture = readFixture('e5-login-key-invalid.json');
    const authStateService = { markRejected: vi.fn(async () => {}), reportRemoteHealthy: vi.fn() };
    const scheduler = new AuthProbeScheduler({
      authStateService,
      vault: { read: () => okVaultResult() },
      fetchFn: vi.fn(),
    });

    scheduler.reportExternalLoginResponse(fixture.response.status, fixture.response.bodyText);

    expect(authStateService.markRejected).toHaveBeenCalledTimes(1);
  });

  it('singleflight — a second probeOnce() call while one is in flight does not fetch twice', async () => {
    let resolveFetch: (value: AuthProbeFetchResponse) => void = () => {};
    const fetchFn = vi.fn(
      () =>
        new Promise<AuthProbeFetchResponse>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const scheduler = new AuthProbeScheduler({
      authStateService: { markRejected: vi.fn(async () => {}), reportRemoteHealthy: vi.fn() },
      vault: { read: () => okVaultResult() },
      fetchFn,
    });

    const first = scheduler.probeOnce();
    const second = scheduler.probeOnce();
    resolveFetch(fetchResponse(200, '{}'));
    await Promise.all([first, second]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('backoff — after an unknown classification, a scheduled probeOnce() within backoffMs is skipped', async () => {
    let now = 1_000_000;
    const fetchFn = vi.fn(async () => fetchResponse(404, '<html></html>'));
    const scheduler = new AuthProbeScheduler({
      authStateService: { markRejected: vi.fn(async () => {}), reportRemoteHealthy: vi.fn() },
      vault: { read: () => okVaultResult() },
      fetchFn,
      backoffMs: 10 * 60 * 1000,
      now: () => now,
    });

    await scheduler.probeOnce();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now += 5 * 60 * 1000; // still inside the backoff window
    await scheduler.probeOnce();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now += 6 * 60 * 1000; // now past the 10-minute backoff
    await scheduler.probeOnce();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('no vault target (flag-off shaped read) is a silent no-op — never calls fetch', async () => {
    const fetchFn = vi.fn();
    const scheduler = new AuthProbeScheduler({
      authStateService: { markRejected: vi.fn(async () => {}), reportRemoteHealthy: vi.fn() },
      vault: { read: () => ({ status: 'absent' }) },
      fetchFn,
    });

    await scheduler.probeOnce();

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
