import { IPC_CHANNELS, type PiTuiOpenRequest } from '@shared/types';
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import { assertAgentSpawnAllowed } from '../services/auth/spawnGate';
import {
  createNodePtySpawn,
  PiTuiPtyController,
  resolvePiTuiLaunchPlan,
} from '../services/terminal/PiTuiPty';

const controllers = new Map<number, PiTuiPtyController>();
const controllerPromises = new Map<number, Promise<PiTuiPtyController>>();
const disposedWindowIds = new Set<number>();

function ownerId(sender: WebContents): number {
  const owner = BrowserWindow.fromWebContents(sender);
  if (!owner) throw new Error('Pi TUI owner window not found');
  return owner.id;
}

async function createController(windowId: number): Promise<PiTuiPtyController> {
  const spawn = await createNodePtySpawn();
  return new PiTuiPtyController(
    windowId,
    {
      onData: (event) => {
        const window = BrowserWindow.fromId(windowId);
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.PI_TUI_DATA, event);
        }
      },
      onExit: (event) => {
        const window = BrowserWindow.fromId(windowId);
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.PI_TUI_EXIT, event);
        }
      },
      onState: (event) => {
        const window = BrowserWindow.fromId(windowId);
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.PI_TUI_STATE, event);
        }
      },
    },
    spawn,
    async () =>
      resolvePiTuiLaunchPlan({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        platform: process.platform,
        electronExecPath: process.execPath,
      })
  );
}

async function controllerFor(sender: WebContents): Promise<PiTuiPtyController> {
  const windowId = ownerId(sender);
  if (disposedWindowIds.has(windowId)) throw new Error('Pi TUI owner window is closing');
  const existing = controllers.get(windowId);
  if (existing) return existing;

  let pending = controllerPromises.get(windowId);
  if (!pending) {
    pending = createController(windowId).then((controller) => {
      if (disposedWindowIds.has(windowId)) {
        controller.disposeAllSync();
        throw new Error('Pi TUI owner window closed during controller creation');
      }
      controllers.set(windowId, controller);
      return controller;
    });
    controllerPromises.set(windowId, pending);
    const cleanup = () => controllerPromises.delete(windowId);
    void pending.then(cleanup, cleanup);
  }
  return pending;
}

function assertOwner(sender: WebContents, controller: PiTuiPtyController): void {
  if (ownerId(sender) !== controller.windowId) throw new Error('Pi TUI owner mismatch');
}

export function registerPiTuiHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.PI_TUI_OPEN, async (event, request: PiTuiOpenRequest) => {
    assertAgentSpawnAllowed();
    const controller = await controllerFor(event.sender);
    assertOwner(event.sender, controller);
    return controller.open(request);
  });
  ipcMain.handle(IPC_CHANNELS.PI_TUI_WRITE, async (event, terminalId: string, data: string) => {
    const controller = await controllerFor(event.sender);
    assertOwner(event.sender, controller);
    await controller.write(terminalId, data);
  });
  ipcMain.handle(
    IPC_CHANNELS.PI_TUI_RESIZE,
    async (event, terminalId: string, cols: number, rows: number) => {
      const controller = await controllerFor(event.sender);
      assertOwner(event.sender, controller);
      await controller.resize(terminalId, cols, rows);
    }
  );
  ipcMain.handle(IPC_CHANNELS.PI_TUI_SUSPEND, async (event, terminalId: string) => {
    const controller = await controllerFor(event.sender);
    assertOwner(event.sender, controller);
    await controller.suspend(terminalId);
  });
  ipcMain.handle(IPC_CHANNELS.PI_TUI_DISPOSE, async (event, terminalId?: string) => {
    const controller = await controllerFor(event.sender);
    assertOwner(event.sender, controller);
    if (terminalId) await controller.dispose(terminalId);
    else await controller.disposeAll();
  });
  ipcMain.handle(IPC_CHANNELS.PI_TUI_STATUS, async (event) => {
    const controller = await controllerFor(event.sender);
    assertOwner(event.sender, controller);
    return controller.status();
  });
}

export async function disposeAllPiTuiControllers(): Promise<void> {
  const windowIds = new Set([...controllers.keys(), ...controllerPromises.keys()]);
  for (const windowId of windowIds) disposedWindowIds.add(windowId);
  const pending = [...controllerPromises.values()];
  controllerPromises.clear();
  await Promise.allSettled(pending);
  await Promise.allSettled([...controllers.values()].map((controller) => controller.disposeAll()));
  controllers.clear();
  disposedWindowIds.clear();
}

export function disposeAllPiTuiControllersSync(): void {
  for (const windowId of [...controllers.keys(), ...controllerPromises.keys()]) {
    disposedWindowIds.add(windowId);
  }
  controllerPromises.clear();
  for (const controller of controllers.values()) controller.disposeAllSync();
  controllers.clear();
}

export function disposePiTuiWindow(windowId: number): void {
  disposedWindowIds.add(windowId);
  controllerPromises.delete(windowId);
  const controller = controllers.get(windowId);
  if (!controller) return;
  controller.disposeAllSync();
  controllers.delete(windowId);
}
