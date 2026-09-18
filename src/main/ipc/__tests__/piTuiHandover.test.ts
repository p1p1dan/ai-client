/**
 * session-01 / cutover-04 — handing a chat's JSONL back from the Pi TUI.
 *
 * The bug these pin: the GUI only re-read the file when the handover actually
 * killed a live terminal. A TUI the user quit from inside pi is already gone by
 * then, so the reload was skipped in exactly the case that needed it, and the
 * worker's next append carried the sequence it held BEFORE the terminal wrote —
 * which made the file throw `session_invalid` on every later open.
 *
 * The controller is faked: what is under test is the Main-side bookkeeping
 * around it, not node-pty.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zhTranslations } from '@shared/i18n';
import type { PiTuiOpenRequest } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

/** Terminals the fake controller still considers live, keyed by session file. */
let liveSessions: string[] = [];
/** terminal-01: sessions whose terminal was signalled but never seen to exit. */
let unconfirmedSessions: string[] = [];
/** concurrency-07: chats whose worker is mid-turn right now. */
let busySessionFiles: string[] = [];
const disposeSession = vi.fn(async (sessionFile: string) => ({
  terminalIds: liveSessions.includes(sessionFile) ? ['terminal-1'] : [],
  confirmed: !unconfirmedSessions.includes(sessionFile),
}));
const open = vi.fn(async (request: PiTuiOpenRequest) => ({
  terminalId: request.terminalId,
  generation: 1,
  resumed: false,
}));
const disposeAll = vi.fn(async () => undefined);
const dispose = vi.fn(async () => true);
/** The real controller announces every stop on the state channel; so does this. */
type StateCallback = (event: { terminalId: string; state: string }) => void;
let announceState: StateCallback = () => {};
/** terminal-10: every controller the registry has built, newest last. */
const controllerInstances: unknown[] = [];

/** TUI `/new`: the notices Main asked the OS to show, newest last. */
const shownNotices: Array<{ title: string; body?: string }> = [];
/** TUI `/new`: rows Main wrote into the session index, newest last. */
const importedRows: SessionIndexEntry[] = [];
/** TUI `/new`: an index that refuses the row (unwritable file, duplicate). */
let importRefusal: Error | null = null;
/** Everything Main pushed at a renderer, so a missing refresh fails a test. */
const sentToRenderer: Array<{ channel: string; payload: unknown }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    // D18: the sender says which window it is, so one test can drive two.
    fromWebContents: (sender: { windowId?: number }) => ({ id: sender?.windowId ?? 1 }),
    fromId: () => null,
    // One window, listening: the sidebar refresh is a broadcast, because one
    // session index backs every window's list.
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => sentToRenderer.push({ channel, payload }),
        },
      },
    ],
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  },
  Notification: class {
    static isSupported() {
      return true;
    }
    constructor(private readonly options: { title: string; body?: string }) {}
    show() {
      shownNotices.push(this.options);
    }
  },
}));

vi.mock('../../services/chat/SessionIndexService', () => ({
  sessionIndexService: {
    // The veto that keeps a chat created in another window out of the sweep.
    list: async () => [...importedRows],
    createImported: async (row: SessionIndexEntry) => {
      if (importRefusal) throw importRefusal;
      importedRows.push(row);
      return row;
    },
  },
}));

vi.mock('../../services/agent-host/piCliLayout', () => ({
  currentPiCliLayout: () => ({ platform: 'linux' }),
}));
vi.mock('../../services/auth/spawnGate', () => ({ assertAgentSpawnAllowed: vi.fn() }));
vi.mock('../../services/remote/RemotePath', () => ({ isRemoteVirtualPath: () => false }));
vi.mock('../../services/agent-host/WorkerManager', () => ({
  workerManager: {
    getSlotSnapshots: () => busySessionFiles.map((sessionFile) => ({ sessionFile, active: true })),
  },
}));
vi.mock('../../services/terminal/PiTuiPty', () => ({
  createNodePtySpawn: vi.fn(async () => vi.fn()),
  resolvePiCliLaunchPlan: vi.fn(async () => ({
    cliPath: 'pi',
    nodePath: 'node',
    args: [],
    env: {},
  })),
  PiTuiPtyController: class {
    readonly windowId: number;
    constructor(windowId: number, callbacks: { onState?: StateCallback }) {
      this.windowId = windowId;
      announceState = (event) => callbacks.onState?.(event);
      controllerInstances.push(this);
    }
    open = open;
    dispose = vi.fn(async (terminalId: string) => {
      // `#disposeAndConfirm` emits 'dead' before it waits for the exit, and
      // that event is what releases the D18 claim — a double that stayed
      // silent here would let a leak pass.
      announceState({ terminalId, state: 'dead' });
      return dispose();
    });
    disposeSession = disposeSession;
    disposeAll = disposeAll;
    disposeAllSync = vi.fn(() => undefined);
  },
}));

const { STRANDED_SESSION_BODY, STRANDED_SESSION_TITLE } = await import(
  '../../services/terminal/piTuiStrandedSessions'
);

const {
  registerPiTuiHandlers,
  releaseSessionForHostPrompt,
  assertHostPromptAllowed,
  disposeAllPiTuiControllers,
  PI_TUI_TURN_RUNNING_REASON,
} = await import('../piTui');

/** A path that does not exist, so the TUI-1 support probe lets it through. */
const CHAT = '/tmp/ai-client-handover-test/chat.jsonl';
const OTHER_CHAT = '/tmp/ai-client-handover-test/other.jsonl';

async function openTerminal(
  sessionFile: string,
  options: { windowId?: number; terminalId?: string } = {}
): Promise<void> {
  const handler = handlers.get(IPC_CHANNELS.PI_TUI_OPEN);
  if (!handler) throw new Error('PI_TUI_OPEN handler was not registered');
  await handler({ sender: { windowId: options.windowId ?? 1 } }, {
    terminalId: options.terminalId ?? 'terminal-1',
    cwd: '/repo',
    sessionFile,
  } satisfies PiTuiOpenRequest);
}

async function sessionSupport(sessionFile: string, windowId = 1): Promise<unknown> {
  const handler = handlers.get(IPC_CHANNELS.PI_TUI_SESSION_SUPPORT);
  if (!handler) throw new Error('PI_TUI_SESSION_SUPPORT handler was not registered');
  return handler({ sender: { windowId } }, sessionFile);
}

beforeEach(async () => {
  await disposeAllPiTuiControllers();
  handlers.clear();
  liveSessions = [];
  unconfirmedSessions = [];
  busySessionFiles = [];
  controllerInstances.length = 0;
  shownNotices.length = 0;
  importedRows.length = 0;
  importRefusal = null;
  sentToRenderer.length = 0;
  disposeSession.mockClear();
  disposeAll.mockClear();
  dispose.mockClear();
  open.mockClear();
  registerPiTuiHandlers();
});

describe('a GUI write reclaims the file from the Pi TUI', () => {
  it('reports the file as stale when the terminal is still live', async () => {
    await openTerminal(CHAT);
    liveSessions = [CHAT];

    await expect(releaseSessionForHostPrompt(CHAT)).resolves.toBe(true);
    expect(disposeSession).toHaveBeenCalledWith(CHAT);
  });

  it('reports it as stale when pi exited on its own and left nothing to kill', async () => {
    // The audited path: `onExit` has already dropped the terminal, so the
    // dispose finds nothing — which used to be read as "the file is untouched".
    await openTerminal(CHAT);
    liveSessions = [];

    await expect(releaseSessionForHostPrompt(CHAT)).resolves.toBe(true);
  });

  it('stops reporting it once the GUI has read the file back', async () => {
    await openTerminal(CHAT);
    await releaseSessionForHostPrompt(CHAT);

    // Every ordinary send goes through here; re-opening the session each time
    // would tear down and rebuild the runtime for nothing.
    await expect(releaseSessionForHostPrompt(CHAT)).resolves.toBe(false);
  });

  it('says nothing about a chat no terminal has opened', async () => {
    await openTerminal(CHAT);

    await expect(releaseSessionForHostPrompt(OTHER_CHAT)).resolves.toBe(false);
  });
});

describe('the gate before a GUI write', () => {
  it('throws while a terminal still owns the chat being written', async () => {
    await openTerminal(CHAT);

    expect(() => assertHostPromptAllowed(CHAT)).toThrow(/Terminal mode owns this session/);
  });

  it('allows a write to another chat while a terminal stays warm on this one', async () => {
    // Leaving terminal mode suspends rather than disposes, so ownership is held
    // across the switch. Refusing every other chat's sends would be wrong.
    await openTerminal(CHAT);

    expect(() => assertHostPromptAllowed(OTHER_CHAT)).not.toThrow();
  });

  it('allows the write once the handover has released the file', async () => {
    await openTerminal(CHAT);
    await releaseSessionForHostPrompt(CHAT);

    expect(() => assertHostPromptAllowed(CHAT)).not.toThrow();
  });
});

/**
 * terminal-01 — a disposal that could not confirm the process is gone must not
 * be read as "the file is mine again". The whole non-symmetric protection here
 * (kill the terminal, then re-read the JSONL) rests on the terminal actually
 * having stopped writing; releasing ownership on a signal that may not have
 * landed is how the GUI becomes the second writer.
 */
describe('an unconfirmed kill keeps the chat contested', () => {
  it('holds ownership so the GUI write is refused rather than racing the terminal', async () => {
    await openTerminal(CHAT);
    liveSessions = [CHAT];
    unconfirmedSessions = [CHAT];

    await expect(releaseSessionForHostPrompt(CHAT)).resolves.toBe(true);

    expect(() => assertHostPromptAllowed(CHAT)).toThrow(/Terminal mode owns this session/);
  });

  it('keeps the "must re-read" mark for the retry, instead of spending it on the failure', async () => {
    await openTerminal(CHAT);
    unconfirmedSessions = [CHAT];
    await releaseSessionForHostPrompt(CHAT);

    // Second attempt, this time the terminal is really gone: the reload still
    // has to happen, so the mark had to survive the first attempt.
    unconfirmedSessions = [];
    await expect(releaseSessionForHostPrompt(CHAT)).resolves.toBe(true);
    expect(() => assertHostPromptAllowed(CHAT)).not.toThrow();
  });
});

/**
 * concurrency-07 — "no turn may be running when the TUI takes a chat over" was
 * only enforced in the renderer. The CLI never takes the writer lock, so Main
 * has no other way to notice a second writer arriving; this puts the same
 * question in front of the handover itself.
 */
describe('the Pi TUI cannot take a chat that is mid-turn', () => {
  it('ships a Chinese entry for the refusal it sends the renderer', () => {
    // T065 回炉: same reasoning as the other reason guards — the renderer looks
    // this up as a variable, so the `t('literal')` coverage scan is blind to it.
    expect(zhTranslations[PI_TUI_TURN_RUNNING_REASON]).toBeTruthy();
  });

  it('refuses the open and never transfers ownership', async () => {
    busySessionFiles = [CHAT];

    await expect(openTerminal(CHAT)).rejects.toThrow(/turn/i);

    expect(open).not.toHaveBeenCalled();
    // Ownership stayed where it was, so the GUI half is still allowed to write.
    expect(() => assertHostPromptAllowed(CHAT)).not.toThrow();
  });

  it('lets the open through once that turn has ended', async () => {
    busySessionFiles = [OTHER_CHAT];

    await expect(openTerminal(CHAT)).resolves.toBeUndefined();
    expect(open).toHaveBeenCalled();
  });
});

/**
 * D18 — the DEV-16 point check opened one chat in two windows. Both windows
 * spawned `pi --session` on the same JSONL, both read the tree once at open,
 * and both hung their own turn off the same parent entry: the session forked
 * into two branches inside one file, with no prompt, no refusal and no
 * read-only fallback. The per-window PTY controllers cannot see each other, so
 * the refusal has to live here.
 */
describe('two windows cannot drive the same chat', () => {
  it('refuses the second window and never spawns its pi', async () => {
    await openTerminal(CHAT, { windowId: 1 });
    open.mockClear();

    await expect(openTerminal(CHAT, { windowId: 2, terminalId: 'terminal-2' })).rejects.toThrow(
      /another window/i
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('leaves the same window and a different chat alone', async () => {
    // Reverse check. Switching chats inside one window opens a second terminal
    // id, and the other window keeps every chat this one is not holding.
    await openTerminal(CHAT, { windowId: 1 });

    await expect(openTerminal(CHAT, { windowId: 1 })).resolves.toBeUndefined();
    await expect(
      openTerminal(OTHER_CHAT, { windowId: 2, terminalId: 'terminal-2' })
    ).resolves.toBeUndefined();
  });

  it('lets the other window in once the first window let the chat go', async () => {
    await openTerminal(CHAT, { windowId: 1 });
    const disposeHandler = handlers.get(IPC_CHANNELS.PI_TUI_DISPOSE);
    if (!disposeHandler) throw new Error('PI_TUI_DISPOSE handler was not registered');
    // Disposing unbooks the terminal before its PTY reports an exit, so the
    // controller's `onExit` never fires for it — this is the release path that
    // has to work, or the chat stays locked to window 1 for the rest of the run.
    await disposeHandler({ sender: { windowId: 1 } }, 'terminal-1');

    await expect(
      openTerminal(CHAT, { windowId: 2, terminalId: 'terminal-2' })
    ).resolves.toBeUndefined();
  });

  it('frees the chat when the GUI takes the file back', async () => {
    await openTerminal(CHAT, { windowId: 1 });
    await releaseSessionForHostPrompt(CHAT);

    await expect(
      openTerminal(CHAT, { windowId: 2, terminalId: 'terminal-2' })
    ).resolves.toBeUndefined();
  });

  /**
   * T065 回炉 — the rollback after a refused open must not disown a live pi.
   *
   * `controller.open` rejects for reasons that leave the previous terminal
   * running: terminal-03 refuses a warm PTY asked for a second chat, and a
   * chat's `runtimeIdentity` can change under a live terminal (a pi session file
   * is written lazily, and a fork or a continued chat renames it). The first
   * landing rolled the claim back with `releaseTerminal`, which drops every chat
   * that terminal id holds — including the one still being written.
   */
  it('keeps the live claim when the same terminal is refused a second chat', async () => {
    await openTerminal(CHAT, { windowId: 1 });
    open.mockRejectedValueOnce(new Error('This terminal is already running another chat'));

    await expect(openTerminal(OTHER_CHAT, { windowId: 1 })).rejects.toThrow(/another chat/i);

    // Window 1's pi is still on CHAT, so window 2 still must not get it. Under
    // the over-wide rollback this resolved, and two `pi --session` ran on one
    // JSONL — D18 itself.
    await expect(openTerminal(CHAT, { windowId: 2, terminalId: 'terminal-2' })).rejects.toThrow(
      /another window/i
    );
  });

  it('does release the chat the failed open asked for', async () => {
    // Reverse check: the rollback still has to happen, or a spawn that never
    // started would lock the chat out of terminal mode for the rest of the run.
    await openTerminal(CHAT, { windowId: 1 });
    open.mockRejectedValueOnce(new Error('This terminal is already running another chat'));
    await expect(openTerminal(OTHER_CHAT, { windowId: 1 })).rejects.toThrow();

    await expect(
      openTerminal(OTHER_CHAT, { windowId: 2, terminalId: 'terminal-2' })
    ).resolves.toBeUndefined();
  });

  it('says so in the pre-flight, so the surface never switches to a doomed terminal', async () => {
    await openTerminal(CHAT, { windowId: 1 });

    expect(await sessionSupport(CHAT, 2)).toMatchObject({ supported: false });
    // The window that holds it, and every other chat, stay openable.
    expect(await sessionSupport(CHAT, 1)).toEqual({ supported: true });
    expect(await sessionSupport(OTHER_CHAT, 2)).toEqual({ supported: true });
  });
});

/**
 * TUI `/new` — pi moves itself to a session file this app never hears about.
 *
 * `session-index.json` has no directory scan and no watcher, so that chat is
 * simply missing from the sidebar and the user reads it as lost. pi offers no
 * way to disable `/new` and no way to report the new path in TUI mode, so the
 * only evidence available is the file that appeared next to the one the app
 * handed over — and the terminal's own stop is where this looks for it.
 *
 * What happens to that file is the part these pin: it is INDEXED, because pi's
 * JSONL differs from this app's only in the header line and the runtime converts
 * it on the first open (see `piTuiStrandedSessions.ts`). The notification is
 * what is left when a file cannot be identified at all.
 */
describe('a chat created inside the terminal', () => {
  /** A `/new` session as pi writes it: v3 header, cwd, and a name row. */
  function writePiSession(file: string, cwd: string, name?: string): void {
    const rows: unknown[] = [
      {
        type: 'session',
        version: 3,
        id: 'pi-session-1',
        cwd,
        timestamp: '2026-09-18T10:00:00.000Z',
      },
    ];
    if (name) rows.push({ type: 'session_info', name });
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  }

  function openedTerminalDirectory(terminalId: string): Promise<string> {
    const directory = mkdtempSync(join(tmpdir(), 'ai-client-tui-new-'));
    const chat = join(directory, 'chat.jsonl');
    writePiSession(chat, '/repo');
    return openTerminal(chat, { terminalId }).then(() => directory);
  }

  it('puts the chat in the session list when the terminal stops', async () => {
    const directory = await openedTerminalDirectory('terminal-new');

    // What `/new` leaves behind: a fresh JSONL in the same directory, which
    // nothing in this app has a row for. Its header names the folder pi ran
    // in, which is NOT the cwd the terminal was opened with — pi lets the user
    // pick another one — and the row has to record pi's, or resuming the chat
    // fails with `session_cwd_mismatch`.
    const created = join(directory, '2026-09-18T10-00-00-000Z_new.jsonl');
    writePiSession(created, '/elsewhere/repo', 'named in pi');
    announceState({ terminalId: 'terminal-new', state: 'dead' });

    await vi.waitFor(() => expect(importedRows).toHaveLength(1));
    expect(importedRows[0]).toMatchObject({
      // pi's own file, not a copy: the runtime converts it on the first open
      // and Main re-binds the row to the v4 sibling then.
      runtimeIdentity: created,
      workspacePath: '/elsewhere/repo',
      title: 'named in pi',
      agent: 'pi',
      archived: false,
    });
    expect(importedRows[0].sessionId).toBeTruthy();
    // The list is pull-only, so a row nobody is told about stays invisible.
    expect(sentToRenderer).toContainEqual({
      channel: IPC_CHANNELS.PI_TUI_SESSIONS_INDEXED,
      payload: { sessionIds: [importedRows[0].sessionId] },
    });
    // Nothing to warn about: the chat is in the sidebar, which is the answer
    // the user wanted.
    expect(shownNotices).toEqual([]);
  });

  it('names the file instead when it cannot be identified', async () => {
    const directory = await openedTerminalDirectory('terminal-unreadable');

    // No pi header, so no workspace to resume in. A row pointing at it would
    // be a chat that fails the moment it is clicked.
    const created = join(directory, '2026-09-18T10-00-00-000Z_new.jsonl');
    writeFileSync(created, 'not a session file\n', 'utf8');
    announceState({ terminalId: 'terminal-unreadable', state: 'dead' });

    await vi.waitFor(() => expect(shownNotices).toHaveLength(1));
    expect(shownNotices[0].body).toContain(created);
    expect(importedRows).toEqual([]);
    expect(sentToRenderer).toEqual([]);
  });

  it('falls back to the notice when the index refuses the row', async () => {
    const directory = await openedTerminalDirectory('terminal-refused');
    importRefusal = new Error('Imported runtime identity is already indexed');

    const created = join(directory, '2026-09-18T10-00-00-000Z_new.jsonl');
    writePiSession(created, '/repo');
    announceState({ terminalId: 'terminal-refused', state: 'dead' });

    // A failed write must not swallow the chat: the user still gets the path.
    await vi.waitFor(() => expect(shownNotices).toHaveLength(1));
    expect(shownNotices[0].body).toContain(created);
  });

  it('ships a Chinese entry for the notice it shows', () => {
    // Main translates this itself (`translate(getCurrentLocale(), …)`), so the
    // renderer-side `t('literal')` coverage scan cannot see it.
    expect(zhTranslations[STRANDED_SESSION_BODY]).toBeTruthy();
    expect(zhTranslations[STRANDED_SESSION_TITLE]).toBeTruthy();
  });

  it('stays quiet when the terminal only wrote the chat it was given', async () => {
    await openedTerminalDirectory('terminal-quiet');

    announceState({ terminalId: 'terminal-quiet', state: 'dead' });

    // Give the sweep the same window the assertions above wait through, so a
    // notice or a row that arrives late still fails this test.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shownNotices).toEqual([]);
    expect(importedRows).toEqual([]);
    expect(sentToRenderer).toEqual([]);
  });
});

/**
 * terminal-10 — `disposeAll()` latches the controller as disposed forever. The
 * IPC path left that corpse in the registry, so every later open in the same
 * window threw "Pi TUI controller is disposed" and the user lost the embedded
 * terminal until the window was reopened.
 */
describe('disposing a whole window through IPC', () => {
  it('unbooks the controller so the next open builds a fresh one', async () => {
    await openTerminal(CHAT);
    expect(controllerInstances).toHaveLength(1);

    const disposeHandler = handlers.get(IPC_CHANNELS.PI_TUI_DISPOSE);
    if (!disposeHandler) throw new Error('PI_TUI_DISPOSE handler was not registered');
    await disposeHandler({ sender: {} });
    expect(disposeAll).toHaveBeenCalled();

    await openTerminal(CHAT);
    expect(controllerInstances).toHaveLength(2);
  });

  it('leaves the controller in place when a single terminal is disposed', async () => {
    await openTerminal(CHAT);

    const disposeHandler = handlers.get(IPC_CHANNELS.PI_TUI_DISPOSE);
    if (!disposeHandler) throw new Error('PI_TUI_DISPOSE handler was not registered');
    await disposeHandler({ sender: {} }, 'terminal-1');

    await openTerminal(CHAT);
    expect(controllerInstances).toHaveLength(1);
  });
});
