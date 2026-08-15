import { describe, expect, it, vi } from 'vitest';
import type { OnboardingRegisterResponse } from '../../services/onboarding/types';
import {
  createVerifyAndRegisterHandler,
  toRendererRegisterResponse,
  type VerifyAndRegisterService,
} from '../onboardingHandlers';

/**
 * D47 S1 §3 test group 3 — drives the REAL `createVerifyAndRegisterHandler`
 * production seam (not a rule copy), so a mutation that turns the sanitizer
 * into a passthrough is caught through the exact function `onboarding.ts`
 * hands to `ipcMain.handle` (B-track 1.2). Fixture shape mirrors
 * `OnboardingService.test.ts:338`.
 */

function fakeService(response: OnboardingRegisterResponse): VerifyAndRegisterService {
  return { verifyAndRegister: vi.fn(async () => response) };
}

describe('createVerifyAndRegisterHandler — success arm', () => {
  it('deep-scans clean: no apiKey/config/secret substrings, keeps only user.{id,name}', async () => {
    const full: OnboardingRegisterResponse = {
      ok: true,
      data: {
        user: { id: 1, name: 'Test User' },
        apiKey: 'unused-top-level-key',
        config: {
          claude: { baseUrl: 'https://cch-test.example.com/v1', authToken: 'claude-secret-token' },
          codex: { baseUrl: 'https://cch-test.example.com/v1', apiKey: 'codex-secret-key' },
        },
      },
    };
    const handler = createVerifyAndRegisterHandler(fakeService(full));

    const result = await handler(undefined, { email: 'user@jcdz.cc', code: '123456' });

    expect(result).toEqual({ ok: true, data: { user: { id: 1, name: 'Test User' } } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('config');
    expect(serialized).not.toContain('claude-secret-token');
    expect(serialized).not.toContain('codex-secret-key');
  });

  it('drops an unknown field the server adds tomorrow — whitelist construction, not a delete-style trim', async () => {
    const full = {
      ok: true,
      data: {
        user: { id: 2, name: 'Someone' },
        apiKey: 'x',
        config: {
          claude: { baseUrl: 'https://a.example.com', authToken: 'b' },
          codex: { baseUrl: 'https://c.example.com', apiKey: 'd' },
        },
        futureField: 'should-not-leak',
      },
    } as unknown as OnboardingRegisterResponse;
    const handler = createVerifyAndRegisterHandler(fakeService(full));

    const result = await handler(undefined, { email: 'user@jcdz.cc', code: '123456' });

    expect(result).toEqual({ ok: true, data: { user: { id: 2, name: 'Someone' } } });
    expect(JSON.stringify(result)).not.toContain('futureField');
  });
});

describe('createVerifyAndRegisterHandler — failure arm', () => {
  it('keeps attemptsLeft, drops user, matches the real server failure shape', async () => {
    const full = {
      ok: false,
      error: 'CODE_INVALID',
      data: { attemptsLeft: 4 },
    } as OnboardingRegisterResponse;
    const handler = createVerifyAndRegisterHandler(fakeService(full));

    const result = await handler(undefined, { email: 'user@jcdz.cc', code: '999999' });

    expect(result).toEqual({ ok: false, error: 'CODE_INVALID', data: { attemptsLeft: 4 } });
    expect(result).not.toHaveProperty('data.user');
  });

  it('a bare error with no data omits the data field entirely', async () => {
    const full: OnboardingRegisterResponse = { ok: false, error: 'INTERNAL_ERROR' };
    const handler = createVerifyAndRegisterHandler(fakeService(full));

    const result = await handler(undefined, { email: 'user@jcdz.cc', code: '000000' });

    expect(result).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
    expect(result).not.toHaveProperty('data');
  });
});

describe('toRendererRegisterResponse — direct unit coverage', () => {
  it('falls back to the failure shape when ok=true but data.user is missing (defensive)', () => {
    const malformed = { ok: true } as unknown as OnboardingRegisterResponse;
    expect(toRendererRegisterResponse(malformed)).toEqual({ ok: false });
  });
});
