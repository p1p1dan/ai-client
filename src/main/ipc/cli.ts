import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import { cliInstaller } from '../services/cli/CliInstaller';

export function registerCliHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CLI_INSTALL_STATUS, async () => {
    return await cliInstaller.checkInstalled();
  });

  ipcMain.handle(IPC_CHANNELS.CLI_INSTALL, async () => {
    return await cliInstaller.install();
  });

  ipcMain.handle(IPC_CHANNELS.CLI_UNINSTALL, async () => {
    return await cliInstaller.uninstall();
  });
}
