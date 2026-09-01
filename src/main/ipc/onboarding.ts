import type { InstallAgentId, OnboardingSendCodeRequest } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, ipcMain, session } from 'electron';
import { getAuthStateService, getCredentialVault } from '../services/auth';
import { resolveManagedCredentialsEnabled } from '../services/auth/credentialMode';
import { AgentInstaller } from '../services/cli/AgentInstaller';
import { onboardingService } from '../services/onboarding/OnboardingService';
import { syncManagedPiModels } from '../services/piModelConfig';
import { sessionManager } from '../services/session/SessionManager';
import { createVerifyAndRegisterHandler } from './onboardingHandlers';

let activeInstaller: AgentInstaller | null = null;

async function terminateAllSessions(): Promise<void> {
  const remoteSessionIds = new Set<string>();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      continue;
    }

    for (const session of sessionManager.list(win)) {
      if (session.backend !== 'remote') {
        continue;
      }
      remoteSessionIds.add(session.sessionId);
    }
  }

  // Best-effort: kill remote sessions before tearing down local PTYs.
  await Promise.allSettled(
    [...remoteSessionIds].map((sessionId) => sessionManager.kill(sessionId))
  );

  // Local PTYs must be awaited to avoid native resource crashes on some platforms.
  await sessionManager.destroyAllLocalAndWait();
}

async function clearServerAuthCookie(serverUrl: string): Promise<void> {
  try {
    const origin = new URL(serverUrl).origin;
    await session.defaultSession.cookies.remove(origin, 'auth-token');
  } catch (error) {
    console.warn('[onboarding:logout] Failed to clear auth-token cookie:', error);
  }
}

/**
 * D47 S5 §3 — the I9 logout orchestration (rev.2 restructure; B-track B2
 * "handler 重排不可实现" is what forced this out of the fire-and-forget
 * `pendingLogoutRegeneratePromise` shape into an explicit, fully-awaited
 * sequence). `ONBOARDING_LOGOUT`'s handler is a thin `await` of this.
 *
 * Seven checkpoints, each an observable completion (A-track M5 口径):
 *  ① `beginLogout()` — synchronous, closes the spawn gate before ANY
 *     teardown starts (a `create`/`resume` call racing logout must see the
 *     gate already shut, not a stale `authenticated` snapshot).
 *  ② `terminateAllSessions()` — kill remote sessions, then await local PTYs.
 *  ③ `await workerManager.invalidateAll()` — flag-gated (matches the pre-S5
 *     "logout with managed credentials off never touches the runtime" contract,
 *     `OnboardingServiceManagedHome.test.ts`'s own assertion). MOVED OUT of
 *     `regenerateManagedHomesForLogout`'s tail (I9: "shutdown 从 regenerate
 *     链尾摘出") — this eliminates the codex swept-revive window
 *     (`agent-host/codexRuntime.ts`'s send-time silent reopen) by killing the
 *     whole Host process BEFORE the credential stores are wiped, not after.
 *  ④ `await vault.clear({keepLastEmail:true})` — NEVER flag-gated
 *     (`CredentialVault.clear()`'s own "no flag gate" contract); failure is
 *     caught and logged, never changes the return value.
 *  ⑤ `regenerateManagedHomesForLogout()` — flag-gated, construction-order-
 *     independent with ④ (logout's regenerate never reads the vault, S2-B2).
 *     Also where the legacy (`~/.claude`/`~/.codex`/`~/.aiclient/settings.json`)
 *     cleanup (`onboardingService.logout()`) runs — flag-agnostic, touches
 *     entirely different files than ④/⑤.
 *  ⑥ `clearServerAuthCookie(serverUrl)` — `serverUrl` captured BEFORE step's
 *     legacy cleanup wipes `onboarding.serverUrl` from settings.json.
 *  ⑦ `authStateService.refresh()` — the value-changed broadcast of
 *     `signed_out` (D47 S5 §1.2); the vault is already `cleared` (④), so this
 *     lands on `signed_out` and notifies exactly once (assuming the snapshot
 *     was previously `authenticated`).
 */
export async function performLogoutSequence(): Promise<boolean> {
  // Captured before ANY mutation — `onboardingService.logout()` (step ⑤)
  // wipes `onboarding.serverUrl` from settings.json.
  const onboarding = onboardingService.checkRegistration();
  const serverUrl = onboarding.registered ? onboarding.serverUrl : undefined;

  // ① — synchronous, before ②.
  getAuthStateService().beginLogout();

  // ②
  try {
    await terminateAllSessions();
  } catch (error) {
    console.warn('[onboarding:logout] Failed to terminate sessions:', error);
  }

  // ③ — flag-gated; strictly before ④/⑤ (I9 restructure).
  if (resolveManagedCredentialsEnabled()) {
    try {
      const { workerManager } = await import('../services/agent-host/WorkerManager');
      await workerManager.invalidateAll();
    } catch (error) {
      console.warn('[onboarding:logout] Failed to invalidate Pi workers:', error);
    }
  }

  // ④ — never flag-gated; failure captured, never changes the return value.
  try {
    await getCredentialVault().clear({ keepLastEmail: true });
  } catch (error) {
    console.warn('[onboarding:logout] vault.clear threw:', error);
  }

  // ⑤ + legacy cleanup — construction-order-independent with ④.
  if (resolveManagedCredentialsEnabled()) {
    await onboardingService.regenerateManagedHomesForLogout();
  }
  const ok = onboardingService.logout();
  if (!ok) {
    console.warn('[onboarding:logout] Failed to clear onboarding state');
  }

  // ⑥
  if (serverUrl) {
    await clearServerAuthCookie(serverUrl);
  }

  // ⑦ — payload/env already zeroed (④/⑤ landed above), so this is safe to
  // broadcast now: no renderer can observe a signed_out push before the
  // credential stores it implies are actually empty.
  getAuthStateService().refresh();

  return ok;
}

export function registerOnboardingHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_CHECK, async () => {
    return onboardingService.checkRegistration();
  });

  ipcMain.handle(
    IPC_CHANNELS.ONBOARDING_SEND_CODE,
    async (_, request: OnboardingSendCodeRequest) => {
      return onboardingService.sendCode(request.email);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.ONBOARDING_VERIFY_AND_REGISTER,
    createVerifyAndRegisterHandler(onboardingService, {
      // Login-success trigger (S5 §1.2), symmetric to logout step ⑦ below:
      // refresh recomputes from the freshly-saved vault, and the
      // value-changed broadcast kicks the probe scheduler once.
      onSuccess: async () => {
        getAuthStateService().refresh();
        const result = await syncManagedPiModels(undefined, { force: true });
        if (!result.ok) console.warn('[onboarding] Pi model sync skipped:', result.error);
      },
    })
  );

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_DETECT_CLI, async () => {
    return onboardingService.detectCli();
  });

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_CHECK_PREREQUISITES, async () => {
    const installer = new AgentInstaller();
    return await installer.checkPrerequisites();
  });

  ipcMain.handle(
    IPC_CHANNELS.ONBOARDING_INSTALL_AGENTS,
    async (event, agents: InstallAgentId[]) => {
      if (activeInstaller) {
        return {
          success: false,
          errors: ['Another onboarding installation is already in progress.'],
        };
      }

      const installer = new AgentInstaller();
      activeInstaller = installer;

      try {
        return await installer.installAll(agents, (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.ONBOARDING_INSTALL_PROGRESS, progress);
          }
        });
      } finally {
        if (activeInstaller === installer) {
          activeInstaller = null;
        }
      }
    }
  );

  /**
   * A3 (D65) — git only, deliberately narrow.
   *
   * `installAll` would have worked (an empty agent list skips both agents and
   * still runs the git prerequisite), and it is the wrong tool: it also
   * installs Node.js, which this app has BUNDLED since `resources/node-runtime`
   * — so reusing it would put a second Node on the user's machine to satisfy a
   * requirement we already satisfy ourselves. `installGit` carries its own
   * `ensureWindowsOnly` guard, so the platform rule is enforced in Main rather
   * than trusted from the renderer.
   *
   * Returns a result object instead of throwing: the caller is a non-blocking
   * notice, and an unhandled IPC rejection there would surface as an
   * unclassified error next to a message whose whole point is to stay calm.
   */
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_INSTALL_GIT, async () => {
    if (activeInstaller) {
      return { ok: false, error: 'Another onboarding installation is already in progress.' };
    }

    const installer = new AgentInstaller();
    activeInstaller = installer;

    try {
      await installer.installGit();
      const { gitInstalled } = await installer.checkPrerequisites();
      return gitInstalled
        ? { ok: true }
        : { ok: false, error: 'Git still could not be detected after installation.' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (activeInstaller === installer) {
        activeInstaller = null;
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_CANCEL_INSTALL, async () => {
    if (!activeInstaller) {
      return false;
    }

    activeInstaller.cancel();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_LOGOUT, async () => {
    return performLogoutSequence();
  });
}
