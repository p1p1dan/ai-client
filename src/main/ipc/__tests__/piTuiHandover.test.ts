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

import type { PiTuiOpenRequest } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
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
/** terminal-10: every controller the registry has built, newest last. */
const controllerInstances: unknown[] = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: () => ({ id: 1 }),
    fromId: () => null,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
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
    constructor(windowId: number) {
      this.windowId = windowId;
      controllerInstances.push(this);
    }
    open = open;
    dispose = dispose;
    disposeSession = disposeSession;
    disposeAll = disposeAll;
    disposeAllSync = vi.fn(() => undefined);
  },
}));

const {
  registerPiTuiHandlers,
  releaseSessionForHostPrompt,
  assertHostPromptAllowed,
  disposeAllPiTuiControllers,
} = await import('../piTui');

/** A path that does not exist, so the TUI-1 support probe lets it through. */
const CHAT = '/tmp/ai-client-handover-test/chat.jsonl';
const OTHER_CHAT = '/tmp/ai-client-handover-test/other.jsonl';

async function openTerminal(sessionFile: string): Promise<void> {
  const handler = handlers.get(IPC_CHANNELS.PI_TUI_OPEN);
  if (!handler) throw new Error('PI_TUI_OPEN handler was not registered');
  await handler({ sender: {} }, {
    terminalId: 'terminal-1',
    cwd: '/repo',
    sessionFile,
  } satisfies PiTuiOpenRequest);
}

beforeEach(async () => {
  await disposeAllPiTuiControllers();
  handlers.clear();
  liveSessions = [];
  unconfirmedSessions = [];
  busySessionFiles = [];
  controllerInstances.length = 0;
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
