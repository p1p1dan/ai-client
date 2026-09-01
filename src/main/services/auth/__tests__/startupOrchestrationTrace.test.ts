import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultCrypto } from '../CredentialVault';
import { resetManagedFileWriterQueuesForTests } from '../managedFileWriter';

/**
 * D47 S6 §5 — orchestration trace: `adoption-read -> vault-save -> marker`,
 * with `regenerate` / `refresh` / `fetch` (the post-refresh
 * `AuthProbeScheduler` probe) each firing EXACTLY ONCE, driving the REAL
 * production functions `main/index.ts` calls at boot, in the REAL order
 * (see `main/index.ts` ~L154-155 and ~L757-775):
 *   registerAuthHandlers()            (attaches the onChange -> probe bridge)
 *   activateManagedClaudeHome()       (phase (1))
 *   ensureManagedHomeSkeleton()       (phase (1))
 *   ensureVaultAdoption(vault, dir)   (S6 (1).5 — adoption-read -> save -> marker)
 *   regenerateFromVault()             (phase (3) — "regenerate")
 *   authStateService.refresh()        ("refresh", fires the onChange bridge)
 *
 * `main/index.ts` itself is never imported here — it has module-load-time
 * `electron` side effects (protocol privilege registration,
 * `setAsDefaultProtocolClient`, etc.) that are unsafe under vitest's node
 * environment (see `managedClaudeHomeStartup.test.ts`'s module header for
 * the same reasoning already established in this codebase). This test
 * instead drives the exact same real, already-independently-unit-tested
 * service functions in the exact same real sequence, which is what "driving
 * a real startup orchestration" means at a testable seam.
 */

const fetchMock = vi.fn();
const state = { userDataPath: '' };

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '0.0.0-test'),
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
    setPath: vi.fn((name: string, value: string) => {
      if (name === 'userData') state.userDataPath = value;
    }),
  },
  net: { fetch: fetchMock },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

function fakeCrypto(): VaultCrypto {
  return {
    available: () => true,
    encrypt: (plainText) => plainText,
    decrypt: (cipherText) => cipherText,
  };
}

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;

let tempHome: string;
let userDataDir: string;

beforeEach(() => {
  vi.resetModules();
  resetManagedFileWriterQueuesForTests();
  fetchMock.mockReset();
  tempHome = mkdtempSync(join(tmpdir(), 'aiclient-startup-trace-home-'));
  userDataDir = mkdtempSync(join(tmpdir(), 'aiclient-startup-trace-userdata-'));
  state.userDataPath = userDataDir;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
});

function writeLegacyOnboardingState(serverUrl: string): void {
  mkdirSync(join(tempHome, '.aiclient'), { recursive: true });
  writeFileSync(
    join(tempHome, '.aiclient', 'settings.json'),
    JSON.stringify(
      { onboarding: { registered: true, email: 'legacy@jcdz.cc', serverUrl } },
      null,
      2
    )
  );
}

function writeLegacyClaudeSettings(baseUrl: string, authToken: string): void {
  mkdirSync(join(tempHome, '.claude'), { recursive: true });
  writeFileSync(
    join(tempHome, '.claude', 'settings.json'),
    JSON.stringify(
      { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: authToken } },
      null,
      2
    )
  );
}

describe('startup orchestration trace — adoption-read -> vault-save -> marker, regenerate/refresh/fetch each exactly once (D47 S6 §5)', () => {
  it('a legacy-registered machine gets adopted at boot, the managed home regenerates from the adopted vault, and the post-refresh probe fires exactly once off the adopted token', async () => {
    // A legacy `serverUrl` whose ORIGIN equals the legacy `claudeBaseUrl`'s
    // origin is a guaranteed guard `match` via the guard's second branch
    // (adoptionGatewayGuard, adoption.ts) regardless of the
    // `__ONBOARDING_SERVICE_URL__` gateway-family branch — no global stub
    // needed for this test to reach 'adopted'.
    const legacyServerUrl = 'https://cch-legacy.example.com';
    const legacyBaseUrl = 'https://cch-legacy.example.com/v1';
    const legacyToken = 'legacy-claude-token-abc123';
    writeLegacyOnboardingState(legacyServerUrl);
    writeLegacyClaudeSettings(legacyBaseUrl, legacyToken);

    // The probe fires a `POST {cchBaseUrl}/api/auth/login` right after
    // `authStateService.refresh()` transitions into `authenticated`. Give it
    // a definitively-'unknown' (non-rejecting) response so the probe this
    // test itself triggers never mutates the vault out from under the
    // assertions below.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/v1/models-config')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              version: 1,
              providers: {
                pilab: {
                  baseUrl: legacyBaseUrl,
                  api: 'openai-responses',
                  models: [{ id: 'gpt-5.6-sol' }],
                },
              },
            }),
        };
      }
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    });

    const authIndex = await import('../index');
    (await import('electron')).app.setPath('userData', userDataDir);
    authIndex.getCredentialVault().promoteCrypto(fakeCrypto());

    // Attach the onChange -> probe-scheduler bridge BEFORE refresh(), same
    // real ordering as `main/index.ts` (registerAuthHandlers runs inside
    // init(), strictly before the startup regenerate/refresh chain).
    const { registerAuthHandlers } = await import('../../../ipc/auth');
    registerAuthHandlers();

    const { ensureVaultAdoption } = await import('../adoption');
    const { activateManagedCredentials, ensureUserClaudeJsonOnboarded, regenerateFromVault } =
      await import('../managedCredentialsStartup');

    // Real production sequence (main/index.ts ~L154-155, ~L762-775).
    activateManagedCredentials();
    await ensureUserClaudeJsonOnboarded();

    const adoptionOutcome = await ensureVaultAdoption(authIndex.getCredentialVault(), userDataDir);
    expect(adoptionOutcome).toEqual({ kind: 'adopted' });

    // "adoption-read -> vault-save -> marker": vault now holds the adopted
    // payload (read), and the on-disk marker exists (marker) — the
    // intermediate `vault.save()` step is exactly what flipped the vault
    // from `absent` to `ok` between these two checks.
    const readAfterAdoption = authIndex.getCredentialVault().read();
    expect(readAfterAdoption.status).toBe('ok');
    if (readAfterAdoption.status !== 'ok') return;
    expect(readAfterAdoption.doc.payload.claude.authToken).toBe(legacyToken);
    expect(readAfterAdoption.doc.payload.claude.baseUrl).toBe(legacyBaseUrl);
    expect(existsSync(join(userDataDir, '.adopted-v1'))).toBe(true);

    await regenerateFromVault(); // "regenerate" — exactly once.
    authIndex.getAuthStateService().refresh(); // "refresh" — exactly once.

    // The post-refresh probe (`handleAuthStateChange` -> `void
    // this.probeOnce()`) is fire-and-forget from `refresh()`'s own call
    // stack. `probeOnce()` is singleflight (AuthProbeScheduler.ts): calling
    // it again here while the fire-and-forget call is still in flight
    // returns the SAME promise rather than firing a second fetch — the
    // production singleflight guard itself is what makes this a
    // deterministic (not timing-dependent) way to wait for "fetch" to land.
    await authIndex.getAuthProbeScheduler().probeOnce();

    // Two startup fetches now exist: Phase 5's metadata-only Pi model sync,
    // then the auth probe. Find the POST probe explicitly and assert it still
    // runs exactly once with the freshly adopted token.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const probeCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/auth/login')
    );
    expect(probeCalls).toHaveLength(1);
    const [probeUrl, probeInit] = probeCalls[0] as [string, { body: string }];
    expect(probeUrl).toBe(`${legacyServerUrl}/api/auth/login`);
    expect(JSON.parse(probeInit.body)).toEqual({ key: legacyToken });

    // "refresh" landed authenticated, off the SAME vault adoption wrote —
    // `remoteHealth` is `'valid'` here (not the freshly-computed `'unknown'`
    // refresh() itself would have produced) because the probe's 200 response
    // synchronously ran `reportRemoteHealthy()` before this assertion, via
    // the very `probeOnce()` await above — proof the fetch->classification
    // pipeline actually closes the loop back into AuthStateService.
    expect(authIndex.getAuthStateService().getState()).toEqual({
      status: 'authenticated',
      email: 'legacy@jcdz.cc',
      remoteHealth: 'valid',
    });
  });
});
