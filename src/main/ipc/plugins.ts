import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PLUGIN_PACKAGE_EXTENSION } from '@shared/plugins/manifest';
import { PLUGIN_IPC, type PluginInstallResult, type PluginView } from '@shared/plugins/view';
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { getAppStateRoot } from '../services/appStatePaths';
import { allocateRemoteOwnerId } from '../services/chat/chatCaller';
import { sessionControl } from '../services/chat/sessionControl';
import { PluginManager } from '../services/plugins/pluginManager';
import { resolvePluginLaunch } from '../services/plugins/pluginProcess';
import { PluginStore } from '../services/plugins/pluginStore';
import { invokeChatHandler, onChatRuntimeEvent } from './chat';

/**
 * Plugins (plugin-system README §3): the Plugins page's IPC, and the manager
 * that runs the enabled plugins from app start to quit. With nothing
 * installed, nothing here starts a process or records anything.
 */

let manager: PluginManager | undefined;

function broadcast(views: PluginView[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(PLUGIN_IPC.changed, views);
    } catch {
      // Window may be closing mid-send
    }
  }
}

function createManager(): PluginManager {
  const store = new PluginStore(path.join(getAppStateRoot(), 'plugins'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plainText) => safeStorage.encryptString(plainText).toString('base64'),
    decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText, 'base64')),
  });
  return new PluginManager({
    store,
    launch: (plugin) =>
      resolvePluginLaunch({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        pluginId: plugin.manifest.id,
        dataDir: plugin.dataDir,
      }),
    invokeChat: (channel, caller, args) => invokeChatHandler(channel, caller, args),
    onChatRuntimeEvent,
    sessionControl,
    allocateOwnerId: allocateRemoteOwnerId,
    appendAudit: (entry) => {
      mkdirSync(path.dirname(store.auditFile), { recursive: true });
      appendFileSync(store.auditFile, `${JSON.stringify(entry)}\n`);
    },
    log: (pluginId, level, message) => console[level](`[plugin:${pluginId}] ${message}`),
    notify: broadcast,
  });
}

export function registerPluginHandlers(): void {
  manager = createManager();
  const plugins = manager;

  ipcMain.handle(PLUGIN_IPC.list, () => plugins.list());

  ipcMain.handle(PLUGIN_IPC.pickAndInstall, async (event): Promise<PluginInstallResult | null> => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options = {
      properties: ['openFile' as const],
      filters: [{ name: 'PiLab plugin', extensions: [PLUGIN_PACKAGE_EXTENSION.slice(1)] }],
    };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return null;
    return plugins.install(file);
  });

  ipcMain.handle(
    PLUGIN_IPC.setEnabled,
    (_event, payload: { id: string; enabled: boolean }): Promise<void> => {
      if (typeof payload?.id !== 'string' || typeof payload.enabled !== 'boolean') {
        throw new Error('Invalid plugin enable request');
      }
      return plugins.setEnabled(payload.id, payload.enabled);
    }
  );

  ipcMain.handle(PLUGIN_IPC.uninstall, (_event, payload: { id: string }): Promise<void> => {
    if (typeof payload?.id !== 'string') throw new Error('Invalid plugin id');
    return plugins.uninstall(payload.id);
  });

  ipcMain.handle(
    PLUGIN_IPC.setSetting,
    (_event, payload: { id: string; key: string; value: unknown }): void => {
      if (typeof payload?.id !== 'string' || typeof payload.key !== 'string') {
        throw new Error('Invalid plugin setting');
      }
      plugins.setSetting(payload.id, payload.key, payload.value);
    }
  );

  // Off the startup path: a slow or broken plugin never delays the window.
  setImmediate(() => {
    plugins.startAll().catch((error) => console.warn('[plugins] start failed:', error));
  });
}

export async function stopAllPlugins(): Promise<void> {
  await manager?.stopAll();
}

export function killAllPluginsSync(): void {
  manager?.killAllSync();
}
