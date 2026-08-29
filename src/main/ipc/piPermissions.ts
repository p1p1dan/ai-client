/**
 * T08-c slice 2 — IPC for the permission-policy panel.
 *
 * Three verbs and one affordance. `update` and `reset` throw on the local
 * route rather than returning a "nothing happened" snapshot: an
 * `ipcRenderer.invoke` rejection reaches the panel as an error the user can
 * read, whereas a silently unchanged snapshot reads as a save that worked.
 *
 * `reveal` exists for the read-only case. Telling someone their policy lives in
 * `~/.pi` and then making them find it by hand is most of the way to not telling
 * them.
 */

import type {
  PermissionPolicyRequest,
  PermissionPolicySnapshot,
  UpdatePermissionPolicyRequest,
} from '@shared/piPermissionPolicy';
import { IPC_CHANNELS } from '@shared/types';
import { ipcMain, shell } from 'electron';
import {
  readPermissionPolicy,
  resetPermissionPolicy,
  updatePermissionPolicy,
} from '../services/piPermissionPolicy';

export function registerPiPermissionHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.PI_PERMISSIONS_GET,
    async (_event, payload: PermissionPolicyRequest = {}): Promise<PermissionPolicySnapshot> =>
      readPermissionPolicy(payload.repoPath)
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_PERMISSIONS_UPDATE,
    async (_event, payload: UpdatePermissionPolicyRequest): Promise<PermissionPolicySnapshot> =>
      updatePermissionPolicy(payload.patch, payload.repoPath)
  );

  ipcMain.handle(
    IPC_CHANNELS.PI_PERMISSIONS_RESET,
    async (_event, payload: PermissionPolicyRequest = {}): Promise<PermissionPolicySnapshot> =>
      resetPermissionPolicy(payload.repoPath)
  );

  /**
   * Show a scope file in the OS file manager.
   *
   * `showItemInFolder` on the file, which opens the parent and selects it when
   * the file exists and opens nothing when it does not — so the fallback is the
   * containing directory, which is where someone would create it.
   */
  ipcMain.handle(IPC_CHANNELS.PI_PERMISSIONS_REVEAL, async (_event, path: string) => {
    if (typeof path !== 'string' || !path.trim()) return;
    shell.showItemInFolder(path);
  });
}
