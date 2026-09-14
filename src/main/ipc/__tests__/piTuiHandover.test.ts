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
const disposeSession = vi.fn(async (sessionFile: string) =>
  liveSessions.includes(sessionFile) ? ['terminal-1'] : []
);
const open = vi.fn(async (request: PiTuiOpenRequest) => ({
  terminalId: request.terminalId,
  generation: 1,
  resumed: false,
}));

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
    }
    open = open;
    disposeSession = disposeSession;
    disposeAll = vi.fn(async () => undefined);
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
  disposeSession.mockClear();
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
