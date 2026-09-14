import { IPC_CHANNELS, type PiTuiOpenRequest } from '@shared/types';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { currentPiCliLayout } from '../services/agent-host/piCliLayout';
import { assertAgentSpawnAllowed } from '../services/auth/spawnGate';
import { isRemoteVirtualPath } from '../services/remote/RemotePath';
import {
  createNodePtySpawn,
  PiTuiPtyController,
  resolvePiCliLaunchPlan,
} from '../services/terminal/PiTuiPty';
import {
  inspectPiTuiSessionSupport,
  normalizeSessionKey,
  PiTuiExclusiveGuard,
} from '../services/terminal/piTuiSession';

/**
 * Q17: which chat session (if any) currently has a Pi terminal writing its
 * JSONL. Process-wide and single-owner — GUI and TUI are mutually exclusive
 * (`presentationMode` is one app-wide setting), and the GUI worker that would
 * be the second writer is process-wide too.
 */
const sessionGuard = new PiTuiExclusiveGuard();

/**
 * session-01: chats a Pi terminal has been handed, and that the GUI has not
 * re-read since.
 *
 * Ownership above is released the moment the terminal dies, which is too early
 * to answer the question the send path actually asks — "is my worker's cached
 * tree behind this file". A TUI the user quit from inside pi is already gone by
 * then (`onExit` drops its record and releases the guard), so `disposeSession`
 * reports nothing to kill and the reload was skipped in exactly the case that
 * needed it: the worker then appended with the sequence it held BEFORE the
 * terminal wrote, which made the file unopenable from that point on.
 *
 * Remembered until a GUI write claims the file back, because that is when the
 * reload happens. Keyed like everything else here, so `/private/var` drift
 * cannot make an entry unfindable.
 */
const tuiWrittenSessions = new Set<string>();

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
        // The TUI died (user typed /exit, crash, dispose). Ownership must go
        // back before the GUI's next send, or the session stays locked out of
        // chat for the rest of the run.
        if (event.sessionFile) sessionGuard.release(event.sessionFile);
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
    async () => resolvePiCliLaunchPlan(currentPiCliLayout())
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
    // A remote virtual path is not a local directory; node-pty would fail with
    // an opaque spawn error instead of naming the actual limitation.
    if (isRemoteVirtualPath(request?.cwd ?? '')) {
      throw new Error('Pi TUI is not available for remote repositories');
    }
    const controller = await controllerFor(event.sender);
    assertOwner(event.sender, controller);
    if (request.sessionFile) {
      // TUI-1: refuse a session the CLI cannot parse before taking ownership of
      // it. Reaching the spawn would hand the user the CLI's own
      // "not a valid pi session" error and leave the guard holding a file no
      // terminal ever opened.
      const support = await inspectPiTuiSessionSupport(request.sessionFile);
      if (!support.supported) throw new Error(support.reason);
      // Always transfer, never test-and-set: see PiTuiExclusiveGuard.transferTo
      // for the desync failure pix hit with tryAcquire-only.
      const acquired = sessionGuard.transferTo(request.sessionFile);
      if (!acquired.ok) throw new Error(acquired.reason);
      // Marked on the way in, not on the way out: however this terminal ends —
      // disposed, crashed, or quit from inside pi — the GUI has to re-read the
      // file before it writes it again.
      tuiWrittenSessions.add(normalizeSessionKey(request.sessionFile));
    }
    return controller.open(request);
  });
  ipcMain.handle(IPC_CHANNELS.PI_TUI_SESSION_SUPPORT, async (_event, sessionFile: string | null) =>
    inspectPiTuiSessionSupport(sessionFile)
  );
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

/**
 * Q17 — the GUI is about to write this session's JSONL, so any terminal on it
 * must stop first. Called by the chat send path before it starts a turn.
 *
 * Reports whether the worker's cached view of this session may now be behind
 * the file. That is true when a terminal was still holding it AND when one held
 * it earlier in this run (see `tuiWrittenSessions`) — killing a writer does not
 * tell the worker what the writer wrote, and neither does a writer that left on
 * its own before anyone asked it to.
 */
export async function releaseSessionForHostPrompt(sessionFile: string): Promise<boolean> {
  if (!sessionFile.trim()) return false;
  const written = tuiWrittenSessions.delete(normalizeSessionKey(sessionFile));
  const results = await Promise.allSettled(
    [...controllers.values()].map((controller) => controller.disposeSession(sessionFile))
  );
  sessionGuard.release(sessionFile);
  return (
    written ||
    results.some((result) => result.status === 'fulfilled' && (result.value?.length ?? 0) > 0)
  );
}

/**
 * Throws while a Pi terminal still owns this chat's JSONL (defence in depth).
 *
 * cutover-04 — called by every GUI path that writes the file, after it has asked
 * for the handover. Reaching here with the terminal still holding the file means
 * the release did not happen (an index read that failed, a caller that skipped
 * it), and failing the write is better than becoming its second writer.
 */
export function assertHostPromptAllowed(sessionFile?: string): void {
  sessionGuard.assertHostPromptAllowed(sessionFile);
}

export async function disposeAllPiTuiControllers(): Promise<void> {
  const windowIds = new Set([...controllers.keys(), ...controllerPromises.keys()]);
  for (const windowId of windowIds) disposedWindowIds.add(windowId);
  const pending = [...controllerPromises.values()];
  controllerPromises.clear();
  await Promise.allSettled(pending);
  await Promise.allSettled([...controllers.values()].map((controller) => controller.disposeAll()));
  controllers.clear();
  sessionGuard.release();
  disposedWindowIds.clear();
}

export function disposeAllPiTuiControllersSync(): void {
  for (const windowId of [...controllers.keys(), ...controllerPromises.keys()]) {
    disposedWindowIds.add(windowId);
  }
  controllerPromises.clear();
  for (const controller of controllers.values()) controller.disposeAllSync();
  controllers.clear();
  sessionGuard.release();
}

export function disposePiTuiWindow(windowId: number): void {
  disposedWindowIds.add(windowId);
  controllerPromises.delete(windowId);
  const controller = controllers.get(windowId);
  if (!controller) return;
  controller.disposeAllSync();
  controllers.delete(windowId);
}
