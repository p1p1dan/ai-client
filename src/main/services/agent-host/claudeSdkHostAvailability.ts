/**
 * Route B: whether this build can start the Claude Agent SDK host, asked in one
 * place. The engine choice for a new chat (`dshHostModelSource.ts`) and the
 * model menu the renderer predicts it from (S-2, `piModelConfig`) read the same
 * answer, so a build without the host never shows a chat Claude's modes.
 */

import { app } from 'electron';
import { createClaudeSdkHostAvailability } from './claudeSdkEngine';

export const claudeSdkHostAvailable = createClaudeSdkHostAvailability({
  appPath: () => app.getAppPath(),
  isPackaged: () => app.isPackaged,
  resourcesPath: () => process.resourcesPath,
  log: (message) => console.info(message),
});
