import type { OnboardingRegisterRequest } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { BrowserWindow, ipcMain, session } from 'electron';
import { onboardingService } from '../services/onboarding/OnboardingService';
import { sessionManager } from '../services/session/SessionManager';

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
  await Promise.allSettled([...remoteSessionIds].map((sessionId) => sessionManager.kill(sessionId)));

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

export function registerOnboardingHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ONBOARDING_CHECK, async () => {
    return onboardingService.checkRegistration();
  });

  ipcMain.handle(
    IPC_CHANNELS.ONBOARDING_REGISTER,
    async (_, request: OnboardingRegisterRequest) => {
      return onboardingService.register(
        request.email,
        request.serverUrl,
        request.onboardingSecret
      );
    }
  );

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_DETECT_CLI, async () => {
    return onboardingService.detectCli();
  });

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_LOGOUT, async () => {
    const onboarding = onboardingService.checkRegistration();
    const serverUrl = onboarding.registered ? onboarding.serverUrl : undefined;

    try {
      await terminateAllSessions();
    } catch (error) {
      console.warn('[onboarding:logout] Failed to terminate sessions:', error);
    }

    const ok = onboardingService.logout();
    if (!ok) {
      console.warn('[onboarding:logout] Failed to clear onboarding state');
    }

    if (serverUrl) {
      await clearServerAuthCookie(serverUrl);
    }

    return ok;
  });
}
