import type { OnboardingRegisterRequest } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { onboardingService } from '../services/onboarding/OnboardingService';

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
}
