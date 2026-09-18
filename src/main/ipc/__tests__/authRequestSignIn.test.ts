import { IPC_CHANNELS } from '@shared/types';
import type { AuthState } from '@shared/types/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `auth:requestSignIn` — the handler behind every in-app 登录/重新登录 button.
 *
 * ## The defect it was written for
 *
 * Those buttons only dispatched a renderer event, whose one listener re-queried
 * the gate. That can never route: `resolveGateDecision` answers `app` for as
 * long as Main's entry latch is set, and the latch is set for exactly as long
 * as the user is in the app. On a machine that entered on `Use my own setup`
 * there was not even a failure to see — `resolveSpawnGateDecision` short-
 * circuits `local` to "allowed", so nothing was rejected and nothing was
 * logged. The button did nothing at all, silently.
 *
 * So the two writes below are the fix, and neither is optional: leaving `local`
 * is what stops the spawn gate answering "there is nothing to sign in to", and
 * clearing the latch is what lets the gate route anywhere other than `app`.
 */

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
/** What the vault says once managed credentials are on. */
const authState: { current: AuthState } = { current: { status: 'signed_out', lastEmail: null } };
/** What `refresh()` returns while they are off — a placeholder, not a vault read. */
const LOCAL_PLACEHOLDER: AuthState = { status: 'signed_out', lastEmail: null };
const currentMode: { value: 'managed' | 'local' } = { value: 'local' };
const setCredentialMode = vi.fn();
const vaultReads = vi.fn();
/** Ordered trace of the two writes, so "which happened first" is assertable. */
const trace: string[] = [];

vi.mock('electron', () => ({
  // Packaged: keeps the dev-only `devMarkInvalidated` handler out of the map.
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../services/auth', () => ({
  getAuthStateService: () => ({
    getState: () => authState.current,
    hasRefreshed: () => true,
    // Stands in for the real short-circuit: `refresh()` reads the vault only
    // when managed credentials are on, so what it returns depends on the mode
    // the handler has just written.
    refresh: () => {
      trace.push(`refresh:${currentMode.value}`);
      return currentMode.value === 'managed' ? authState.current : LOCAL_PLACEHOLDER;
    },
    onChange: vi.fn(),
    // Present so a call would be visible rather than a missing-method throw:
    // this request must never sign anybody out.
    clear: vaultReads,
    markRejected: vaultReads,
  }),
  getAuthProbeScheduler: () => ({ handleAuthStateChange: vi.fn() }),
}));

vi.mock('../../services/auth/adoption', () => ({
  getAdoptionLatch: () => Promise.resolve(),
}));

vi.mock('../../services/auth/credentialMode', () => ({
  getCredentialMode: () => currentMode.value,
  setCredentialMode: (mode: 'managed' | 'local') => {
    setCredentialMode(mode);
    trace.push(`setCredentialMode:${mode}`);
    currentMode.value = mode;
  },
  resolveManagedCredentialsEnabled: () => currentMode.value === 'managed',
}));

vi.mock('../../services/onboarding', () => ({
  onboardingService: { checkRegistration: () => ({ registered: false, email: null }) },
}));

async function loadHandlers() {
  const auth = await import('../auth');
  auth.registerAuthHandlers();
  const appEntry = await import('../../services/auth/appEntry');
  const invoke = handlers.get(IPC_CHANNELS.AUTH_REQUEST_SIGN_IN);
  if (!invoke) throw new Error('auth:requestSignIn was never registered');
  return { appEntry, invoke: () => invoke({}) };
}

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  setCredentialMode.mockClear();
  vaultReads.mockClear();
  currentMode.value = 'local';
  trace.length = 0;
  authState.current = { status: 'signed_out', lastEmail: null };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auth:requestSignIn', () => {
  it('leaves the local credential mode and drops this run entry', async () => {
    const { appEntry, invoke } = await loadHandlers();
    appEntry.markAppEntered('local');
    expect(appEntry.hasEnteredApp()).toBe(true);

    await expect(invoke()).resolves.toEqual({ ok: true });

    // The half the user asked for by name: 「退出使用本机已有配置的模式」.
    expect(setCredentialMode).toHaveBeenCalledWith('managed');
    // The half that actually moves the screen — without it the gate keeps
    // answering `app` and the button is silent all over again.
    expect(appEntry.hasEnteredApp()).toBe(false);
    expect(appEntry.getAppEntryMode()).toBeNull();
  });

  it('behaves identically for a run that entered on the company account', async () => {
    // The user's two cases ("本地确实没登录" / "已经登录了") end in the same
    // place on purpose, and an already-signed-in vault is not a reason to skip
    // either write: the entry latch still has to go, or nothing moves.
    authState.current = { status: 'authenticated', email: 'user@jcdz.cc', remoteHealth: 'valid' };
    const { appEntry, invoke } = await loadHandlers();
    appEntry.markAppEntered('managed');

    await expect(invoke()).resolves.toEqual({ ok: true });
    expect(setCredentialMode).toHaveBeenCalledWith('managed');
    expect(appEntry.hasEnteredApp()).toBe(false);
  });

  it('re-reads the account AFTER leaving local mode, never before', async () => {
    // `AuthStateService.refresh()` short-circuits to a placeholder `signed_out`
    // whenever managed credentials are off — it never touches the vault in
    // `local` mode. Asking first would therefore answer a question about the
    // MODE we are leaving, and hand a fresh code form to someone whose vault is
    // still perfectly valid.
    authState.current = { status: 'authenticated', email: 'user@jcdz.cc', remoteHealth: 'valid' };
    const { appEntry, invoke } = await loadHandlers();
    appEntry.markAppEntered('local');

    await expect(invoke()).resolves.toEqual({ ok: true });
    expect(trace).toEqual(['setCredentialMode:managed', 'refresh:managed']);
  });

  it('never signs the user out — the vault is untouched', async () => {
    // `deriveWelcomeEntry` turns a still-valid account into `Continue as …`
    // rather than a fresh code form, which only works if nothing here clears
    // credentials. D64 keeps the choice and the credentials in separate files
    // exactly so this is possible.
    const { appEntry, invoke } = await loadHandlers();
    appEntry.markAppEntered('local');
    await invoke();
    expect(vaultReads).not.toHaveBeenCalled();
  });

  for (const status of ['locked', 'unknown'] as const) {
    it(`refuses while the account is ${status}, instead of stranding the user on a spinner`, async () => {
      // `deriveWelcomeEntry` returns null for both, which the gate renders as
      // LoadingShell. Un-latching here would replace a working app with a blank
      // screen and no way back, so the request is refused and the caller says
      // "try again in a moment".
      authState.current =
        status === 'locked' ? { status: 'locked', lastEmail: null } : { status: 'unknown' };
      const { appEntry, invoke } = await loadHandlers();
      appEntry.markAppEntered('local');

      await expect(invoke()).resolves.toEqual({ ok: false, reason: 'credentials-unresolved' });
      // The mode is put back, so a refused request leaves nothing behind.
      expect(setCredentialMode.mock.calls).toEqual([['managed'], ['local']]);
      expect(appEntry.hasEnteredApp()).toBe(true);
      expect(appEntry.getAppEntryMode()).toBe('local');
    });
  }
});
