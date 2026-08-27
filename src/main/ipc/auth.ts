/**
 * D47 S5 §1.2/§2/§3 — the login-state IPC surface. Two live channels
 * (`auth.getGateSnapshot` / `auth.stateChanged`) plus the S2a-era
 * `AUTH_MANAGED_MODE` probe, migrated here verbatim (S5 §1.2: "顺迁 S2b
 * 寄生在 claudeRuntime 的 AUTH_MANAGED_MODE"). Also owns wiring
 * `AuthStateService.onChange` to BOTH the multi-window broadcast and the
 * `AuthProbeScheduler` — the single place that turns "the state changed"
 * into everything downstream needs to know about it.
 */

import { resolveSkipAuthGate } from '@shared/devFlags';
import { IPC_CHANNELS } from '@shared/types';
import type { AuthState } from '@shared/types/auth';
import { app, BrowserWindow, ipcMain } from 'electron';
import { getAuthProbeScheduler, getAuthStateService } from '../services/auth';
import { resolveManagedCredentialsEnabled } from '../services/auth/AuthStateService';
import { getAdoptionLatch } from '../services/auth/adoption';
import { onboardingService } from '../services/onboarding';

/**
 * D47 S5 §1.2 — flag-off folding, IPC-handler-layer only (never changes
 * `OnboardingService`'s own method bodies): `checkRegistration()` +
 * `checkCredentialsHealth()` collapse into the SAME `AuthState` shape
 * `auth.getGateSnapshot` returns for the managed path, so a single `state`
 * field is meaningful regardless of the flag.
 */
function deriveLegacyAuthState(): AuthState {
  const onboarding = onboardingService.checkRegistration();
  if (!onboarding.registered || !onboarding.email) {
    return { status: 'signed_out', lastEmail: onboarding.email ?? null };
  }
  const health = onboardingService.checkCredentialsHealth();
  if (!health.claudeEnvOk || !health.codexAuthOk) {
    return { status: 'credentials_invalid', reason: 'corrupt', lastEmail: onboarding.email };
  }
  return { status: 'authenticated', email: onboarding.email, remoteHealth: 'unknown' };
}

function broadcastAuthStateChanged(state: AuthState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC_CHANNELS.AUTH_STATE_CHANGED, state);
    } catch {
      // Window may be closing mid-send.
    }
  }
}

let changeBridgeAttached = false;

/** Idempotent — matches `chat.ts`'s `ensureEventBridge` pattern. */
function ensureAuthChangeBridge(): void {
  if (changeBridgeAttached) return;
  changeBridgeAttached = true;
  getAuthStateService().onChange((state) => {
    broadcastAuthStateChanged(state);
    getAuthProbeScheduler().handleAuthStateChange(state.status);
  });
}

export function registerAuthHandlers(): void {
  ensureAuthChangeBridge();

  // `claudeHomeDir` is ALWAYS `null` since D60 — there is no managed
  // claude-home any more. The field is kept rather than removed so the IPC
  // shape and its renderer consumers (`useManagedMode`, `App.tsx`'s session
  // path candidates) stay unchanged; `App.tsx` already treats `null` as "just
  // use the user config dir", which is now the only correct answer. Removing
  // the field is a separate, renderer-side cleanup.
  ipcMain.handle(IPC_CHANNELS.AUTH_MANAGED_MODE, () => ({
    managed: resolveManagedCredentialsEnabled(),
    claudeHomeDir: null,
  }));

  ipcMain.handle(IPC_CHANNELS.AUTH_GET_GATE_SNAPSHOT, async () => {
    // D47 S6 §1.5 — front-loaded: a caller that races the boot sequence
    // (renderer mounts before `ensureVaultAdoption()` has resolved) must
    // never observe a pre-adoption snapshot and flash `first_run`/
    // `cli-check` before flipping to `authenticated` a moment later. A
    // no-op (already-resolved promise) once adoption has settled, and on
    // flag-off (adoption never even calls `vault.read()` there).
    await getAdoptionLatch();

    const managed = resolveManagedCredentialsEnabled();
    const skipAuthGate = resolveSkipAuthGate({ env: process.env, isPackaged: app.isPackaged });
    if (!managed) {
      const state = deriveLegacyAuthState();
      // `legacyRegistered` (consumed by `resolveGateDecision`'s renderer/
      // MainWindow call sites) is derived FROM the same folded `state` —
      // one fact, never two independently-computed booleans that could
      // drift apart.
      return { managed, legacyRegistered: state.status === 'authenticated', state, skipAuthGate };
    }
    const authStateService = getAuthStateService();
    // Lazy latch (D47 S5 §1.3): the very first caller (normally the
    // renderer, once mounted) forces a refresh if the startup sequence
    // hasn't computed one yet — the argv snapshot allows a stale/`locked`
    // read, but this live query must never hand back a snapshot from before
    // `regenerateFromVault()` even ran.
    if (!authStateService.hasRefreshed()) {
      authStateService.refresh();
    }
    const state = authStateService.getState();
    return { managed, legacyRegistered: state.status === 'authenticated', state, skipAuthGate };
  });

  // Dev-only injection (D47 S5 §5 GUI point-check ⑧) — registered ONLY when
  // unpackaged, so a real distribution build never exposes a way to force
  // credential invalidation from the renderer.
  if (!app.isPackaged) {
    ipcMain.handle(IPC_CHANNELS.AUTH_DEV_MARK_INVALIDATED, async () => {
      await getAuthStateService().markRejected();
      return true;
    });
  }
}

/**
 * D47 S5 §2 "启动 refresh 后一次" — `registerAuthHandlers()` (called from
 * `init()`, before `main/index.ts`'s startup `regenerateFromVault()` +
 * `authStateService.refresh()` run) already attaches the `onChange` bridge
 * ahead of that first refresh, so entering `authenticated` at startup and
 * entering it via a later login both flow through the SAME
 * `handleAuthStateChange` transition-detection — no separate "prime" step
 * needed. This ordering dependency is exactly why `ensureAuthChangeBridge()`
 * is called unconditionally at the top of `registerAuthHandlers()`, not
 * lazily on first `auth.getGateSnapshot` call.
 */

/** Test-only: reset module state between test cases. The `AuthProbeScheduler` singleton itself now lives in `services/auth/index.ts` — see `resetAuthSingletonsForTests`. */
export function resetAuthIpcStateForTests(): void {
  changeBridgeAttached = false;
}
