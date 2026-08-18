import { IPC_CHANNELS } from '@shared/types';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F2 S5 (2026-08-18 watchdog redesign, spec §6.2) — `AgentHostManager`'s
 * Host-exit broadcast is deliberately ZERO new code in `chat.ts`: it reuses
 * `agentHostManager.onEvent(broadcastRuntimeEvent)`, the SAME forwarding
 * point every real Host RuntimeEvent already goes through. This file pins
 * that the EXISTING wiring actually holds for a Main-synthesized
 * `session.failed` event the way it holds for a real one — the §12.1
 * collection criterion for S5's chat.ts half: "合成事件送达所有未销毁窗口；
 * 窗口在 guard 后销毁时 catch 不影响其它窗口".
 *
 * Harness follows `chatSpawnGate.test.ts`'s pattern: `electron` mocked so
 * `ipcMain.handle` calls can be captured, and `agentHostManager.onEvent` is
 * mocked to capture the registered handler instead of calling it — the test
 * then invokes that captured handler directly with a fabricated Host-exit
 * event, exactly as `AgentHostManager` would after S5's broadcast.
 */

type FakeWindow = {
  isDestroyed: () => boolean;
  webContents: { send: (...args: unknown[]) => void };
};

const handlers = new Map<string, (...args: unknown[]) => unknown>();
let capturedEventHandlers: Array<(event: RuntimeEvent) => void> = [];
let fakeWindows: FakeWindow[] = [];

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => fakeWindows) },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock('../../services/agent-host/AgentHostManager', () => ({
  agentHostManager: {
    onEvent: vi.fn((handler: (event: RuntimeEvent) => void) => {
      capturedEventHandlers.push(handler);
      return () => {};
    }),
    getStatus: vi.fn(),
  },
}));

vi.mock('../../services/chat/SessionIndexService', () => ({
  sessionIndexService: {
    handleRuntimeEvent: vi.fn(),
  },
}));

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  capturedEventHandlers = [];
  fakeWindows = [];
});

function hostExitFailedEvent(sessionId: string): RuntimeEvent {
  return {
    type: 'session.failed',
    sessionId,
    seq: 1,
    timestamp: Date.now(),
    payload: { error: 'Agent Host exited (code=1 signal=null)' },
  };
}

/**
 * `ensureEventBridge()` registers `broadcastRuntimeEvent` FIRST, then
 * `sessionIndexService.handleRuntimeEvent` (see `chat.ts`) — the first
 * captured handler is always the broadcast one.
 */
async function registerAndCaptureBroadcast(): Promise<(event: RuntimeEvent) => void> {
  const { registerChatHandlers } = await import('../chat');
  registerChatHandlers();
  const broadcast = capturedEventHandlers[0];
  if (!broadcast) throw new Error('broadcastRuntimeEvent was never registered via onEvent()');
  return broadcast;
}

describe('chat.ts Host-exit broadcast wiring (F2 S5 §6.2 — zero new pipeline)', () => {
  it('[S5-C1] a Main-synthesized session.failed event reaches every non-destroyed window', async () => {
    const win1Send = vi.fn();
    const win2Send = vi.fn();
    fakeWindows = [
      { isDestroyed: () => false, webContents: { send: win1Send } },
      { isDestroyed: () => false, webContents: { send: win2Send } },
    ];
    const broadcast = await registerAndCaptureBroadcast();

    broadcast(hostExitFailedEvent('s1'));

    expect(win1Send).toHaveBeenCalledWith(
      IPC_CHANNELS.CHAT_RUNTIME_EVENT,
      expect.objectContaining({ type: 'session.failed', sessionId: 's1' })
    );
    expect(win2Send).toHaveBeenCalledWith(
      IPC_CHANNELS.CHAT_RUNTIME_EVENT,
      expect.objectContaining({ type: 'session.failed', sessionId: 's1' })
    );
  });

  it('[S5-C2] a destroyed window is skipped without throwing and without blocking the others', async () => {
    const destroyedSend = vi.fn();
    const liveSend = vi.fn();
    fakeWindows = [
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
      { isDestroyed: () => false, webContents: { send: liveSend } },
    ];
    const broadcast = await registerAndCaptureBroadcast();

    expect(() => broadcast(hostExitFailedEvent('s1'))).not.toThrow();

    expect(destroyedSend).not.toHaveBeenCalled();
    expect(liveSend).toHaveBeenCalled();
  });

  it('[S5-C3] a window whose send() throws mid-guard (closing race) does not block delivery to the rest', async () => {
    const throwingSend = vi.fn(() => {
      throw new Error('window is being destroyed');
    });
    const liveSend = vi.fn();
    fakeWindows = [
      { isDestroyed: () => false, webContents: { send: throwingSend } },
      { isDestroyed: () => false, webContents: { send: liveSend } },
    ];
    const broadcast = await registerAndCaptureBroadcast();

    expect(() => broadcast(hostExitFailedEvent('s1'))).not.toThrow();

    expect(liveSend).toHaveBeenCalled();
  });
});
