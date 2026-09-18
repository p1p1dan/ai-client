import { translate } from '@shared/i18n';
import { IPC_CHANNELS, type PiTuiOpenRequest } from '@shared/types';
import { BrowserWindow, ipcMain, Notification, type WebContents } from 'electron';
import { redactStderrLine } from '../../agent-host/stderrRedaction';
import { currentPiCliLayout } from '../services/agent-host/piCliLayout';
import { assertAgentSpawnAllowed } from '../services/auth/spawnGate';
import { getCurrentLocale } from '../services/i18n';
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
  PiTuiWindowSessionGuard,
} from '../services/terminal/piTuiSession';
import {
  STRANDED_SESSION_BODY,
  STRANDED_SESSION_TITLE,
  type StrandedSessionSnapshot,
  snapshotSessionDirectory,
  sweepStrandedSessions,
} from '../services/terminal/piTuiStrandedSessions';

/**
 * Q17: which chat session (if any) currently has a Pi terminal writing its
 * JSONL. Process-wide and single-owner — GUI and TUI are mutually exclusive
 * (`presentationMode` is one app-wide setting), and the GUI worker that would
 * be the second writer is process-wide too.
 */
const sessionGuard = new PiTuiExclusiveGuard();

/**
 * D18: which WINDOW has a Pi terminal on each chat's JSONL.
 *
 * `sessionGuard` above cannot answer this. It holds one owner key for the whole
 * process and transfers it unconditionally, which is correct for the GUI-vs-TUI
 * question it exists for and blind to the one the DEV-16 point check exposed:
 * two windows opened the same chat, both spawned `pi --session` on that file,
 * and each appended its own turn under the same parent entry — one session tree
 * silently forked in two, with nothing on screen to say so. The PTY controllers
 * are per-window, so no controller could see the other window's terminal; this
 * registry is the one place that can.
 */
const windowSessionGuard = new PiTuiWindowSessionGuard();

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

/**
 * What each terminal's session directory held when it opened, keyed by
 * window+terminal.
 *
 * `/new` inside the TUI silently moves pi to a session file this app never
 * hears about (see `piTuiStrandedSessions.ts`), so the only way to notice is to
 * compare the directory afterwards. Recorded on open, spent when the terminal
 * stops.
 */
const sessionDirectorySnapshots = new Map<string, StrandedSessionSnapshot>();

function snapshotKey(windowId: number, terminalId: string): string {
  return `${windowId}:${terminalId}`;
}

/**
 * Remember the chat's session directory before pi can write to it.
 *
 * Never overwrites an existing record: leaving and re-entering terminal mode
 * SUSPENDS and re-opens the same PTY, and a second snapshot would adopt a
 * session created since the first one as "already there" — which is exactly the
 * file the user needs to be told about.
 */
async function rememberSessionDirectory(
  windowId: number,
  terminalId: string,
  sessionFile: string
): Promise<boolean> {
  const key = snapshotKey(windowId, terminalId);
  if (sessionDirectorySnapshots.has(key)) return false;
  try {
    sessionDirectorySnapshots.set(key, await snapshotSessionDirectory(sessionFile));
    return true;
  } catch (error) {
    console.warn('[pi-tui] Could not read the session directory before opening a terminal:', error);
    return false;
  }
}

/**
 * Does the session index already know this file?
 *
 * The app writes its own chats into the same directory, so a chat created in
 * another window while the terminal was open would otherwise be announced as
 * lost while it sits in the sidebar. Read through a lazy import, like
 * `hasRunningTurn`: an index this process cannot reach answers "unknown", and
 * an extra notice naming a real file beats silence about a missing chat.
 */
async function isIndexedSession(sessionFile: string): Promise<boolean> {
  const key = normalizeSessionKey(sessionFile);
  try {
    const { sessionIndexService } = await import('../services/chat/SessionIndexService');
    const entries = await sessionIndexService.list();
    return entries.some((entry) => normalizeSessionKey(entry.runtimeIdentity ?? '') === key);
  } catch {
    return false;
  }
}

/**
 * Tell the user where the chat they started in the terminal actually went.
 *
 * A system notification rather than an in-app toast: the app has no Main→
 * renderer channel for an unsolicited message, and this one arrives exactly
 * when the terminal closes and the user turns back to a sidebar that does not
 * list their conversation. Best effort throughout — a notification that cannot
 * be shown must not take a terminal teardown down with it.
 */
function showStrandedSessionNotice(sessionFile: string): void {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(getCurrentLocale(), key, params);
  try {
    if (!Notification.isSupported()) return;
    new Notification({
      title: t(STRANDED_SESSION_TITLE),
      body: t(STRANDED_SESSION_BODY, { path: sessionFile }),
    }).show();
  } catch (error) {
    console.warn('[pi-tui] Could not show the notice about a terminal-created chat:', error);
  }
}

/**
 * The terminal stopped — anything that appeared in its session directory since
 * it opened is a chat this app has no row for.
 *
 * Paths are redacted in the log (T042) and spelled out in the notification: the
 * log is diagnostics, and the notification is the one place the user can read
 * the filename they now need.
 */
async function reportStrandedSessions(windowId: number, terminalId: string): Promise<void> {
  const key = snapshotKey(windowId, terminalId);
  const snapshot = sessionDirectorySnapshots.get(key);
  if (!snapshot) return;
  sessionDirectorySnapshots.delete(key);
  const stranded = await sweepStrandedSessions(snapshot, { isIndexed: isIndexedSession });
  for (const sessionFile of stranded) {
    console.warn(
      `[pi-tui] A chat created inside the terminal is not in the session list: ${redactStderrLine(sessionFile)}`
    );
    showStrandedSessionNotice(sessionFile);
  }
}

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
        // D18: the one seam every way a terminal can stop passes through —
        // its own exit, a dispose (which unbooks the entry BEFORE the PTY
        // reports an exit, so `onExit` above never fires for it) and a
        // capacity eviction (which never produces an exit event at all). A
        // claim that outlives its PTY would refuse the chat to every other
        // window for the rest of the run.
        if (event.state === 'dead') {
          windowSessionGuard.releaseTerminal(windowId, event.terminalId);
          // Same seam, same reason: whichever way this terminal stopped, its
          // `/new` chats are stranded from here on and nothing else will look.
          void reportStrandedSessions(windowId, event.terminalId).catch((error) => {
            console.warn('[pi-tui] Could not check the session directory after a terminal:', error);
          });
        }
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

/** concurrency-07 — refused when a worker is mid-turn on the chat being handed over. */
export const PI_TUI_TURN_RUNNING_REASON =
  'This chat is still running a turn; wait for it to finish before opening the Pi terminal';

/**
 * concurrency-07 — is a GUI worker writing this chat's JSONL right now?
 *
 * The rule "no turn may be running when the terminal takes a chat over" only
 * existed in the renderer, and the pi CLI never takes the worker's writer lock,
 * so nothing on this side would have noticed the second writer arriving. Asking
 * the worker manager here makes the renderer's check a matter of UX again
 * rather than the only thing standing between one JSONL and two live writers.
 *
 * Read through a lazy import so this module keeps no load-order dependency on
 * the worker manager; a probe that cannot answer lets the open through (the
 * renderer's gate is still in front of it) and says so in the log.
 */
async function hasRunningTurn(sessionFile: string): Promise<boolean> {
  const key = normalizeSessionKey(sessionFile);
  if (!key) return false;
  try {
    const { workerManager } = await import('../services/agent-host/WorkerManager');
    return workerManager
      .getSlotSnapshots()
      .some((slot) => slot.active && normalizeSessionKey(slot.sessionFile ?? '') === key);
  } catch (error) {
    console.warn('[pi-tui] Could not check for a running turn before the handover:', error);
    return false;
  }
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
    /** True when THIS call took the session-directory snapshot below. */
    let recorded = false;
    if (request.sessionFile) {
      // TUI-1: refuse a session the CLI cannot parse before taking ownership of
      // it. Reaching the spawn would hand the user the CLI's own
      // "not a valid pi session" error and leave the guard holding a file no
      // terminal ever opened.
      const support = await inspectPiTuiSessionSupport(request.sessionFile);
      if (!support.supported) throw new Error(support.reason);
      // concurrency-07: asked before the transfer, because the transfer is
      // unconditional by design and cannot itself refuse anything.
      if (await hasRunningTurn(request.sessionFile)) {
        throw new Error(PI_TUI_TURN_RUNNING_REASON);
      }
      // Always transfer, never test-and-set: see PiTuiExclusiveGuard.transferTo
      // for the desync failure pix hit with tryAcquire-only.
      const acquired = sessionGuard.transferTo(request.sessionFile);
      if (!acquired.ok) throw new Error(acquired.reason);
      // D18: the cross-window half, and the only refusal that is a real
      // test-and-set. It sits AFTER the transfer above deliberately — the
      // transfer is this window's own bookkeeping and stays unconditional
      // (see `PiTuiExclusiveGuard.transferTo`), while the claim is what
      // stops a second `pi --session` on a file another window is already
      // driving.
      const claimed = windowSessionGuard.claim(
        request.sessionFile,
        controller.windowId,
        request.terminalId
      );
      if (!claimed.ok) throw new Error(claimed.reason);
      // Marked on the way in, not on the way out: however this terminal ends —
      // disposed, crashed, or quit from inside pi — the GUI has to re-read the
      // file before it writes it again.
      tuiWrittenSessions.add(normalizeSessionKey(request.sessionFile));
      // Before the spawn, so a `/new` session written by this pi cannot be
      // mistaken for a file that was already there.
      recorded = await rememberSessionDirectory(
        controller.windowId,
        request.terminalId,
        request.sessionFile
      );
    }
    try {
      return await controller.open(request);
    } catch (error) {
      // A spawn that never happened must not leave the chat claimed: the next
      // attempt, in this window or another, would be refused for a terminal
      // that does not exist.
      //
      // Scoped to the chat this open asked for, never `releaseTerminal`: that
      // one means "this PTY died" and drops every chat the terminal id holds.
      // A warm terminal refused a SECOND chat (terminal-03) would then have had
      // its FIRST chat un-claimed with its pi still running on it — and the
      // next window asking for that chat would have been let straight in, which
      // is the D18 fork this guard exists to stop.
      if (request.sessionFile) {
        windowSessionGuard.releaseClaim(
          request.sessionFile,
          controller.windowId,
          request.terminalId
        );
      }
      // Only the snapshot this call took: a warm terminal refused a SECOND chat
      // (terminal-03) is still running on its first one, and dropping ITS
      // snapshot would lose the `/new` chats that terminal is about to make.
      if (recorded) {
        sessionDirectorySnapshots.delete(snapshotKey(controller.windowId, request.terminalId));
      }
      throw error;
    }
  });
  ipcMain.handle(IPC_CHANNELS.PI_TUI_SESSION_SUPPORT, async (event, sessionFile: string | null) => {
    const support = await inspectPiTuiSessionSupport(sessionFile);
    if (!support.supported || !sessionFile) return support;
    // D18 pre-flight. Advisory, not the guard: the open handler above refuses
    // for real. This exists so the renderer can say why BEFORE it switches the
    // whole chat surface to a terminal that is about to fail.
    let windowId: number;
    try {
      windowId = ownerId(event.sender);
    } catch {
      return support;
    }
    const available = windowSessionGuard.check(sessionFile, windowId);
    return available.ok ? support : { supported: false, reason: available.reason };
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
    if (terminalId) {
      await controller.dispose(terminalId);
      return;
    }
    // terminal-10: `disposeAll` latches the controller as disposed for good, so
    // leaving it in the registry would make every later open in this window
    // throw "Pi TUI controller is disposed" — the window would lose its
    // embedded terminal until it was reopened. Unbook it the way the app-exit
    // and logout paths already do.
    const { windowId } = controller;
    try {
      await controller.disposeAll();
    } finally {
      windowSessionGuard.releaseWindow(windowId);
      if (controllers.get(windowId) === controller) controllers.delete(windowId);
    }
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
 *
 * terminal-01 — ownership is released only when every terminal on the file was
 * SEEN to exit. A disposal that could not confirm that leaves the guard held,
 * which makes `assertHostPromptAllowed` fail this write: refusing one send is
 * the cheap outcome, and becoming the second writer on a JSONL a live pi CLI is
 * still appending to is the expensive one.
 */
export async function releaseSessionForHostPrompt(sessionFile: string): Promise<boolean> {
  if (!sessionFile.trim()) return false;
  const key = normalizeSessionKey(sessionFile);
  const results = await Promise.allSettled(
    [...controllers.values()].map((controller) => controller.disposeSession(sessionFile))
  );
  const killed = results.some(
    (result) => result.status === 'fulfilled' && result.value.terminalIds.length > 0
  );
  const unconfirmed = results.some(
    (result) => result.status === 'rejected' || !result.value.confirmed
  );
  if (unconfirmed) {
    console.warn(
      `[pi-tui] A terminal on ${sessionFile} was not confirmed dead; keeping the chat locked to terminal mode`
    );
    // The mark stays: the retry still has to re-read the file, so spending it
    // on a handover that did not happen would skip the reload that matters.
    return killed || tuiWrittenSessions.has(key);
  }
  const written = tuiWrittenSessions.delete(key);
  sessionGuard.release(sessionFile);
  // D18: every terminal on this file is confirmed gone, so no window holds it.
  windowSessionGuard.releaseSession(sessionFile);
  return written || killed;
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
  windowSessionGuard.releaseAll();
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
  windowSessionGuard.releaseAll();
}

export function disposePiTuiWindow(windowId: number): void {
  disposedWindowIds.add(windowId);
  controllerPromises.delete(windowId);
  // D18: before the early return, because claims are keyed by window rather
  // than by controller — a window whose controller was already unbooked is
  // still the recorded owner of every chat its terminals held.
  windowSessionGuard.releaseWindow(windowId);
  const controller = controllers.get(windowId);
  if (!controller) return;
  controller.disposeAllSync();
  controllers.delete(windowId);
}
