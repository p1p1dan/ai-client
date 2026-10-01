import { mkdir } from 'node:fs/promises';
import type { PiResourceSettings } from '@shared/piModelConfig';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain, shell } from 'electron';
import { getPiResourceSettings } from '../services/piModelConfig';

/**
 * Settings → Extensions → Skills (dsh-rebase P1-16e): read the two skill
 * folders and open either. Nothing here writes a setting: the delegation
 * switch (decision 105) and the prompt-template folder (decision 103) went,
 * with their `updateSettings` / `openPromptTemplates` channels, in P1-12
 * step 1 (decision 147).
 */
export function registerPiResourceHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PI_RESOURCES_GET_SETTINGS,
    async (): Promise<PiResourceSettings> => getPiResourceSettings()
  );

  ipcMain.handle(IPC_CHANNELS.PI_RESOURCES_OPEN_SKILLS, async (): Promise<void> => {
    const skillsDir = getPiResourceSettings().paths.sharedSkills;
    await mkdir(skillsDir, { recursive: true });
    const error = await shell.openPath(skillsDir);
    if (error) throw new Error(`Failed to open skills folder: ${error}`);
  });

  // dsh-rebase P1-16e: the Resources page's second skill root, `<agentDir>/skills`,
  // which the DSH host scans as `customSkillDirs` (decision 101).
  ipcMain.handle(IPC_CHANNELS.PI_RESOURCES_OPEN_APP_SKILLS, async (): Promise<void> => {
    const skillsDir = getPiResourceSettings().paths.appSkills;
    await mkdir(skillsDir, { recursive: true });
    const error = await shell.openPath(skillsDir);
    if (error) throw new Error(`Failed to open skills folder: ${error}`);
  });
}
