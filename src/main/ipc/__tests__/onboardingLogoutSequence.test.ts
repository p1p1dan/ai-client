import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D47 S5 §3 I9 — `performLogoutSequence()`'s seven checkpoints. Uses deferred
 * promises (not synchronous mocks + a call-order array alone) for the
 * long-running steps so the assertions prove a REAL cross-`await` barrier —
 * "gate closes before any kill starts" and "shutdown fully settles before
 * the next step starts" are exactly the shapes a synchronous-looking mock
 * could fake without actually enforcing an await (B-track B2 test form).
 * Fresh deferreds are (re)installed in `beforeEach` — a `Promise`, once
 * resolved, stays resolved, so reusing one across tests would silently stop
 * blocking anything from the second test onward.
 */

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let events: string[] = [];
let destroyAllLocalDeferred = createDeferred<void>();
let shutdownDeferred = createDeferred<void>();
let vaultClearDeferred = createDeferred<void>();
let regenerateDeferred = createDeferred<void>();

const beginLogoutMock = vi.fn(() => events.push('beginLogout'));
const refreshMock = vi.fn(() => events.push('refresh'));
const killMock = vi.fn(async () => {
  events.push('kill:remote');
});
const destroyAllLocalAndWaitMock = vi.fn(async () => {
  events.push('destroyAllLocalAndWait:start');
  await destroyAllLocalDeferred.promise;
  events.push('destroyAllLocalAndWait:end');
});
const listMock = vi.fn(() => []);
const shutdownMock = vi.fn(async () => {
  events.push('agentHost.shutdown:start');
  await shutdownDeferred.promise;
  events.push('agentHost.shutdown:end');
});
const vaultClearMock = vi.fn(async () => {
  events.push('vault.clear:start');
  await vaultClearDeferred.promise;
  events.push('vault.clear:end');
});
const regenerateManagedHomesForLogoutMock = vi.fn(async () => {
  events.push('regenerateManagedHomesForLogout:start');
  await regenerateDeferred.promise;
  events.push('regenerateManagedHomesForLogout:end');
});
const checkRegistrationMock = vi.fn(() => ({
  registered: true,
  email: 'user@jcdz.cc',
  serverUrl: 'https://cch.example.com',
}));
const logoutMock = vi.fn(() => {
  events.push('onboardingService.logout');
  return true;
});
const cookiesRemoveMock = vi.fn(async () => {
  events.push('clearServerAuthCookie');
});

vi.mock('electron', () => ({
  // D64/S3 — the mode resolver falls through to the settings file when the
  // dev-only override is not set, and reading it needs `<userData>`.
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) =>
      name === 'userData' ? '/tmp/aiclient-test-userdata' : '/tmp'
    ),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() },
  session: { defaultSession: { cookies: { remove: cookiesRemoveMock } } },
}));

vi.mock('../../services/session/SessionManager', () => ({
  sessionManager: {
    list: listMock,
    kill: killMock,
    destroyAllLocalAndWait: destroyAllLocalAndWaitMock,
  },
}));

vi.mock('../../services/agent-host/WorkerManager', () => ({
  workerManager: { invalidateAll: shutdownMock },
}));

vi.mock('../../services/auth', () => ({
  getAuthStateService: () => ({ beginLogout: beginLogoutMock, refresh: refreshMock }),
  getCredentialVault: () => ({ clear: vaultClearMock }),
}));

vi.mock('../../services/auth/AuthStateService', () => ({
  resolveManagedCredentialsEnabled: () => true,
}));

vi.mock('../../services/onboarding/OnboardingService', () => ({
  onboardingService: {
    checkRegistration: checkRegistrationMock,
    logout: logoutMock,
    regenerateManagedHomesForLogout: regenerateManagedHomesForLogoutMock,
  },
}));

vi.mock('../../services/cli/AgentInstaller', () => ({ AgentInstaller: vi.fn() }));
vi.mock('../onboardingHandlers', () => ({ createVerifyAndRegisterHandler: vi.fn() }));

beforeEach(() => {
  events = [];
  destroyAllLocalDeferred = createDeferred<void>();
  shutdownDeferred = createDeferred<void>();
  vaultClearDeferred = createDeferred<void>();
  regenerateDeferred = createDeferred<void>();
  for (const mock of [
    beginLogoutMock,
    refreshMock,
    killMock,
    destroyAllLocalAndWaitMock,
    listMock,
    shutdownMock,
    vaultClearMock,
    regenerateManagedHomesForLogoutMock,
    checkRegistrationMock,
    logoutMock,
    cookiesRemoveMock,
  ]) {
    mock.mockClear();
  }
});

/** Polls (bounded) until `predicate()` is true, flushing one microtask per attempt — robust against however many `await` levels separate the resolved deferred from the next mock's body actually running. */
async function flushUntil(predicate: () => boolean, maxAttempts = 200): Promise<void> {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('flushUntil: predicate never became true');
}

describe('performLogoutSequence — I9 checkpoint order (D47 S5 §3)', () => {
  it('① beginLogout fires synchronously before ② kill/destroy even starts', async () => {
    const { performLogoutSequence } = await import('../onboarding');

    const sequencePromise = performLogoutSequence();
    // beginLogout is synchronous — it must already be recorded before we
    // even await anything.
    expect(events).toEqual(['beginLogout']);

    destroyAllLocalDeferred.resolve();
    shutdownDeferred.resolve();
    vaultClearDeferred.resolve();
    regenerateDeferred.resolve();
    await sequencePromise;
  });

  it('② fully settles (destroyAllLocalAndWait resolves) before ③ shutdown starts', async () => {
    const { performLogoutSequence } = await import('../onboarding');

    const sequencePromise = performLogoutSequence();
    await flushUntil(() => events.includes('destroyAllLocalAndWait:start'));
    expect(events).not.toContain('agentHost.shutdown:start');

    destroyAllLocalDeferred.resolve();
    await flushUntil(() => events.includes('agentHost.shutdown:start'));

    shutdownDeferred.resolve();
    vaultClearDeferred.resolve();
    regenerateDeferred.resolve();
    await sequencePromise;

    const destroyEndIdx = events.indexOf('destroyAllLocalAndWait:end');
    const shutdownStartIdx = events.indexOf('agentHost.shutdown:start');
    expect(destroyEndIdx).toBeGreaterThanOrEqual(0);
    expect(shutdownStartIdx).toBeGreaterThan(destroyEndIdx);
  });

  it('③ shutdown fully settles before ④ vault.clear starts', async () => {
    const { performLogoutSequence } = await import('../onboarding');

    const sequencePromise = performLogoutSequence();
    destroyAllLocalDeferred.resolve();
    await flushUntil(() => events.includes('agentHost.shutdown:start'));
    expect(events).not.toContain('vault.clear:start');

    shutdownDeferred.resolve();
    await flushUntil(() => events.includes('vault.clear:start'));

    vaultClearDeferred.resolve();
    regenerateDeferred.resolve();
    await sequencePromise;

    const shutdownEndIdx = events.indexOf('agentHost.shutdown:end');
    const vaultStartIdx = events.indexOf('vault.clear:start');
    expect(vaultStartIdx).toBeGreaterThan(shutdownEndIdx);
  });

  it('⑦ refresh() (the broadcast) fires only AFTER vault.clear/regenerate/onboardingService.logout have all landed, and the whole sequence resolves only once refresh has run', async () => {
    const { performLogoutSequence } = await import('../onboarding');

    const sequencePromise = performLogoutSequence();
    destroyAllLocalDeferred.resolve();
    shutdownDeferred.resolve();
    await flushUntil(() => events.includes('vault.clear:start'));
    expect(events).not.toContain('refresh');

    vaultClearDeferred.resolve();
    regenerateDeferred.resolve();
    const ok = await sequencePromise;

    expect(ok).toBe(true);
    expect(events).toContain('refresh');
    const refreshIdx = events.indexOf('refresh');
    expect(events.indexOf('vault.clear:end')).toBeLessThan(refreshIdx);
    expect(events.indexOf('regenerateManagedHomesForLogout:end')).toBeLessThan(refreshIdx);
    expect(events.indexOf('onboardingService.logout')).toBeLessThan(refreshIdx);
    // Last event overall — nothing runs after the broadcast.
    expect(events[events.length - 1]).toBe('refresh');
  });

  it('clearServerAuthCookie uses the serverUrl captured BEFORE onboardingService.logout() (which would otherwise have wiped it)', async () => {
    const { performLogoutSequence } = await import('../onboarding');

    const sequencePromise = performLogoutSequence();
    destroyAllLocalDeferred.resolve();
    shutdownDeferred.resolve();
    vaultClearDeferred.resolve();
    regenerateDeferred.resolve();
    await sequencePromise;

    expect(cookiesRemoveMock).toHaveBeenCalledWith('https://cch.example.com', 'auth-token');
  });
});
