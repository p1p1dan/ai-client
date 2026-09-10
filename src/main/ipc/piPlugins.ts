/**
 * H/19 U4 — IPC for user-installed pi extensions.
 *
 * The package source reaches a child process's argv, so it is validated on this
 * side of the boundary as well as in the service: the renderer is untrusted,
 * and a check that lives only past the boundary is a check an IPC caller can
 * step around.
 */

import {
  checkPluginSource,
  type PiPluginCommandResult,
  type PiPluginState,
} from '@shared/piPlugins';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain } from 'electron';
import {
  getPiPluginState,
  installPiPlugin,
  removePiPlugin,
  setPiPluginEnabled,
} from '../services/piPlugins';

function readSource(payload: unknown): string {
  const raw =
    typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
        ? (payload as { source?: unknown }).source
        : undefined;
  if (typeof raw !== 'string') throw new Error('Invalid plugin request: source');
  const issue = checkPluginSource(raw);
  if (issue) throw new Error(`Invalid plugin request: source ${issue}`);
  return raw.trim();
}

export function registerPiPluginHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PI_PLUGINS_LIST, (): Promise<PiPluginState> => getPiPluginState());

  ipcMain.handle(
    IPC_CHANNELS.PI_PLUGINS_INSTALL,
    (_event, payload: unknown): Promise<PiPluginCommandResult> =>
      installPiPlugin(readSource(payload))
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_PLUGINS_REMOVE,
    (_event, payload: unknown): Promise<PiPluginCommandResult> =>
      removePiPlugin(readSource(payload))
  );

  ipcMain.handle(IPC_CHANNELS.PI_PLUGINS_SET_ENABLED, (_event, payload: unknown): Promise<void> => {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid plugin request');
    const enabled = (payload as { enabled?: unknown }).enabled;
    if (typeof enabled !== 'boolean') throw new Error('Invalid plugin request: enabled');
    return setPiPluginEnabled(readSource(payload), enabled);
  });
}
