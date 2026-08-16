import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultCrypto, VaultPayload } from '../../services/auth/CredentialVault';

/**
 * D47 S5 §1.2/§2/§3 — `auth.getGateSnapshot` / `auth.stateChanged` /
 * `auth.devMarkInvalidated` + the migrated `auth.managedMode`. Drives the
 * REAL `registerAuthHandlers()` against a real `CredentialVault` in a temp
 * `userData` dir (same style as `vaultIntegration.test.ts`), with
 * `onboardingService` mocked for the flag-off legacy-folding cases.
 */

const checkRegistrationMock = vi.fn();
const checkCredentialsHealthMock = vi.fn();

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const sentWindows: Array<{ channel: string; payload: unknown }> = [];
const state = { userDataPath: '', isPackaged: false };

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged;
    },
    getPath: vi.fn((name: string) => (name === 'userData' ? state.userDataPath : tmpdir())),
  },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => sentWindows.push({ channel, payload }),
        },
      },
    ]),
  },
  net: { fetch: vi.fn() },
}));

vi.mock('../../services/onboarding', () => ({
  onboardingService: {
    checkRegistration: checkRegistrationMock,
    checkCredentialsHealth: checkCredentialsHealthMock,
  },
}));

// `AuthStateService.markRejected()` (via `services/auth/index.ts`'s real
// factory) dynamic-imports `AgentHostManager` — mocked so this test file
// never pulls in the real (heavy) dependency graph, same precedent as
// `OnboardingServiceManagedHome.test.ts`.
const agentHostShutdownMock = vi.fn(async () => {});
vi.mock('../../services/agent-host/AgentHostManager', () => ({
  agentHostManager: { shutdown: agentHostShutdownMock },
}));

function fakeCrypto(): VaultCrypto {
  return { available: () => true, encrypt: (s) => s, decrypt: (s) => s };
}

function makePayload(overrides?: Partial<VaultPayload>): VaultPayload {
  return {
    identity: { email: 'user@jcdz.cc', userId: 1 },
    cchBaseUrl: 'https://cch.example.com',
    claude: { baseUrl: 'https://cch.example.com/v1', authToken: 'claude-secret' },
    codex: { baseUrl: 'https://cch.example.com/v1', apiKey: 'codex-secret' },
    receivedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

let userDataDir: string;
const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;
const originalSkip = process.env.AICLIENT_SKIP_AUTH_GATE;

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  sentWindows.length = 0;
  checkRegistrationMock.mockReset();
  checkCredentialsHealthMock.mockReset();
  agentHostShutdownMock.mockClear();
  userDataDir = mkdtempSync(join(tmpdir(), 'aiclient-auth-ipc-'));
  state.userDataPath = userDataDir;
  state.isPackaged = false;
  delete process.env.AICLIENT_SKIP_AUTH_GATE;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(userDataDir, { recursive: true, force: true });
  if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
  if (originalSkip === undefined) delete process.env.AICLIENT_SKIP_AUTH_GATE;
  else process.env.AICLIENT_SKIP_AUTH_GATE = originalSkip;
});

async function registerAndGetHandlers() {
  const { registerAuthHandlers, resetAuthIpcStateForTests } = await import('../auth');
  resetAuthIpcStateForTests();
  registerAuthHandlers();
  return handlers;
}

describe('auth:managedMode (migrated from claudeRuntime.ts, D47 S5 §1.2)', () => {
  it('flag on: {managed:true, claudeHomeDir}', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const h = await registerAndGetHandlers();
    expect(h.get('auth:managedMode')?.()).toEqual({
      managed: true,
      claudeHomeDir: join(userDataDir, 'claude-home'),
    });
  });

  it('flag off: {managed:false, claudeHomeDir:null}', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    const h = await registerAndGetHandlers();
    expect(h.get('auth:managedMode')?.()).toEqual({ managed: false, claudeHomeDir: null });
  });
});

describe('auth:getGateSnapshot — flag off, legacy folding at the IPC-handler layer (D47 S5 §1.2)', () => {
  it('unregistered -> signed_out, lastEmail from the (absent) onboarding email', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    checkRegistrationMock.mockReturnValue({ registered: false });
    const h = await registerAndGetHandlers();

    const snapshot = await h.get('auth:getGateSnapshot')?.();

    expect(snapshot).toEqual({
      managed: false,
      legacyRegistered: false,
      state: { status: 'signed_out', lastEmail: null },
      skipAuthGate: false,
    });
    expect(checkCredentialsHealthMock).not.toHaveBeenCalled();
  });

  it('registered + unhealthy credentials -> credentials_invalid: corrupt, lastEmail pre-filled', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    checkRegistrationMock.mockReturnValue({ registered: true, email: 'user@jcdz.cc' });
    checkCredentialsHealthMock.mockReturnValue({ claudeEnvOk: false, codexAuthOk: true });
    const h = await registerAndGetHandlers();

    const snapshot = await h.get('auth:getGateSnapshot')?.();

    expect(snapshot).toEqual({
      managed: false,
      legacyRegistered: false,
      state: { status: 'credentials_invalid', reason: 'corrupt', lastEmail: 'user@jcdz.cc' },
      skipAuthGate: false,
    });
  });

  it('registered + healthy -> authenticated', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    checkRegistrationMock.mockReturnValue({ registered: true, email: 'user@jcdz.cc' });
    checkCredentialsHealthMock.mockReturnValue({ claudeEnvOk: true, codexAuthOk: true });
    const h = await registerAndGetHandlers();

    const snapshot = await h.get('auth:getGateSnapshot')?.();

    expect(snapshot).toEqual({
      managed: false,
      legacyRegistered: true,
      state: { status: 'authenticated', email: 'user@jcdz.cc', remoteHealth: 'unknown' },
      skipAuthGate: false,
    });
  });
});

describe('auth:getGateSnapshot — flag on, lazy-refresh latch (D47 S5 §1.3)', () => {
  it('the first call refreshes from the real vault even though nothing called refresh() yet', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const h = await registerAndGetHandlers();
    const authIndex = await import('../../services/auth');
    authIndex.getCredentialVault().promoteCrypto(fakeCrypto());
    await authIndex.getCredentialVault().save(makePayload());

    const snapshot = await h.get('auth:getGateSnapshot')?.();

    expect(snapshot).toEqual({
      managed: true,
      legacyRegistered: true,
      state: { status: 'authenticated', email: 'user@jcdz.cc', remoteHealth: 'unknown' },
      skipAuthGate: false,
    });
  });

  it('skipAuthGate reflects AICLIENT_SKIP_AUTH_GATE when unpackaged', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    process.env.AICLIENT_SKIP_AUTH_GATE = '1';
    const h = await registerAndGetHandlers();

    const snapshot = (await h.get('auth:getGateSnapshot')?.()) as { skipAuthGate: boolean };
    expect(snapshot.skipAuthGate).toBe(true);
  });

  it('skipAuthGate is forced false when packaged, regardless of the env var', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    process.env.AICLIENT_SKIP_AUTH_GATE = '1';
    state.isPackaged = true;
    const h = await registerAndGetHandlers();

    const snapshot = (await h.get('auth:getGateSnapshot')?.()) as { skipAuthGate: boolean };
    expect(snapshot.skipAuthGate).toBe(false);
  });
});

describe('auth:stateChanged broadcast (D47 S5 §1.2 — value-changed only)', () => {
  it('markRejected() broadcasts exactly once to every window', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const h = await registerAndGetHandlers();
    const authIndex = await import('../../services/auth');
    authIndex.getCredentialVault().promoteCrypto(fakeCrypto());
    await authIndex.getCredentialVault().save(makePayload());
    // Establish the initial authenticated snapshot (no broadcast expected —
    // covered by AuthStateService.test.ts's own "value changed only" table).
    await h.get('auth:getGateSnapshot')?.();
    sentWindows.length = 0;

    await authIndex.getAuthStateService().markRejected();

    expect(sentWindows).toHaveLength(1);
    expect(sentWindows[0]).toEqual({
      channel: 'auth:stateChanged',
      payload: { status: 'credentials_invalid', reason: 'rejected', lastEmail: 'user@jcdz.cc' },
    });
  });
});

describe('auth:devMarkInvalidated — dev-only registration (D47 S5 §5 GUI point-check ⑧)', () => {
  it('is registered when unpackaged', async () => {
    state.isPackaged = false;
    const h = await registerAndGetHandlers();
    expect(h.has('auth:devMarkInvalidated')).toBe(true);
  });

  it('is NOT registered when packaged', async () => {
    state.isPackaged = true;
    const h = await registerAndGetHandlers();
    expect(h.has('auth:devMarkInvalidated')).toBe(false);
  });

  it('forces markRejected() when invoked', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const h = await registerAndGetHandlers();
    const authIndex = await import('../../services/auth');
    authIndex.getCredentialVault().promoteCrypto(fakeCrypto());
    await authIndex.getCredentialVault().save(makePayload());
    await h.get('auth:getGateSnapshot')?.();

    const result = await h.get('auth:devMarkInvalidated')?.();

    expect(result).toBe(true);
    expect(authIndex.getAuthStateService().getState()).toEqual({
      status: 'credentials_invalid',
      reason: 'rejected',
      lastEmail: 'user@jcdz.cc',
    });
  });
});
