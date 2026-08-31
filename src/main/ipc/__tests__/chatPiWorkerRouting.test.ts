import { IPC_CHANNELS } from '@shared/types';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
type FakeWindow = {
  isDestroyed: () => boolean;
  webContents: { id: number; send: (...args: unknown[]) => void };
};

const handlers = new Map<string, Handler>();
const runtimeEventHandlers: Array<(event: RuntimeEvent) => void> = [];
let fakeWindows: FakeWindow[] = [];
const createSession = vi.fn(async () => 'create-1');
const send = vi.fn(async () => 'send-1');
const stop = vi.fn(async () => 'stop-1');
const closeSession = vi.fn(async () => 'close-1');
const respondExtensionUi = vi.fn(async () => 'extui-1');
const ensureReady = vi.fn(async () => undefined);
const recordCreated = vi.fn(async () => undefined);
const handleRuntimeEvent = vi.fn();

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getAppPath: vi.fn(() => '/app') },
  BrowserWindow: { getAllWindows: vi.fn(() => fakeWindows) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  },
}));

vi.mock('../../services/agent-host/PiSingleSlotRuntime', () => ({
  piSingleSlotRuntime: {
    onEvent: vi.fn((handler: (event: RuntimeEvent) => void) => {
      runtimeEventHandlers.push(handler);
      return () => undefined;
    }),
    ensureReady,
    getStatus: vi.fn(() => ({ state: 'ready', driver: 'agent-sdk' })),
    createSession,
    send,
    stop,
    closeSession,
    respondExtensionUi,
  },
}));

vi.mock('../../services/chat/SessionIndexService', () => ({
  sessionIndexService: {
    get: vi.fn(async (sessionId: string) => ({ sessionId, agent: 'pi' })),
    recordCreated,
    list: vi.fn(async () => []),
    rename: vi.fn(async () => true),
    setArchived: vi.fn(async () => true),
    handleRuntimeEvent,
  },
}));

vi.mock('../../services/auth/spawnGate', () => ({ assertAgentSpawnAllowed: vi.fn() }));

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  runtimeEventHandlers.length = 0;
  fakeWindows = [];
  vi.clearAllMocks();
  const { registerChatHandlers } = await import('../chat');
  registerChatHandlers();
});

function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`missing handler ${channel}`);
  return Promise.resolve(handler({ sender: { id: 7 } }, payload) as T);
}

describe('Pi WorkerSlot chat routing', () => {
  it('keeps ensureHost as a lightweight ready handshake', async () => {
    await expect(invoke('chat:ensureHost')).resolves.toEqual({
      state: 'ready',
      driver: 'agent-sdk',
    });
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('creates a Pi slot after recording the Pi session row', async () => {
    await expect(
      invoke('chat:createSession', {
        sessionId: 's1',
        workspacePath: '/repo',
        agent: 'claude-code',
        model: 'glm/glm-5',
        effort: 'high',
      })
    ).resolves.toEqual({ requestId: 'create-1' });

    expect(recordCreated).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', agent: 'pi', permissionPreference: undefined })
    );
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', agent: 'pi', model: 'glm/glm-5', effort: 'high' })
    );
  });

  it('routes send, stop, close, and Extension UI responses to the Pi authority', async () => {
    await expect(
      invoke('chat:send', { sessionId: 's1', text: 'hello', effort: 'xhigh' })
    ).resolves.toEqual({ requestId: 'send-1' });
    await expect(invoke('chat:stop', { sessionId: 's1' })).resolves.toEqual({
      requestId: 'stop-1',
    });
    await expect(invoke('chat:closeSession', { sessionId: 's1' })).resolves.toEqual({
      requestId: 'close-1',
    });
    await expect(
      invoke('chat:respondExtensionUi', {
        runtimeId: 'runtime-1',
        uiRequestId: 'ui-1',
        ok: false,
      })
    ).resolves.toEqual({ requestId: 'extui-1' });

    expect(send).toHaveBeenCalledWith({ sessionId: 's1', text: 'hello', effort: 'xhigh' });
    expect(stop).toHaveBeenCalledWith('s1');
    expect(closeSession).toHaveBeenCalledWith('s1');
    expect(respondExtensionUi).toHaveBeenCalledWith({
      runtimeId: 'runtime-1',
      uiRequestId: 'ui-1',
      ok: false,
    });
  });

  it('forwards one runtime stream to windows and SessionIndexService', () => {
    const sendToWindow = vi.fn();
    fakeWindows = [{ isDestroyed: () => false, webContents: { id: 7, send: sendToWindow } }];
    const event: RuntimeEvent = {
      type: 'session.stopped',
      sessionId: 's1',
      requestId: 'turn-1',
      seq: 1,
      timestamp: Date.now(),
      payload: {},
    };

    expect(runtimeEventHandlers).toHaveLength(2);
    for (const handler of runtimeEventHandlers) handler(event);

    expect(sendToWindow).toHaveBeenCalledWith(IPC_CHANNELS.CHAT_RUNTIME_EVENT, event);
    expect(handleRuntimeEvent).toHaveBeenCalledWith(event);
  });

  it('refuses resume and legacy permission/question routes instead of reviving a singleton host', async () => {
    await expect(
      invoke('chat:resumeSession', {
        sessionId: 's1',
        runtimeIdentity: '/session.jsonl',
        workspacePath: '/repo',
      })
    ).rejects.toThrow(/pi_resume_not_implemented/);
    await expect(
      invoke('chat:respondPermission', { sessionId: 's1', permissionId: 'p1', allow: false })
    ).rejects.toThrow(/Pi approvals use Extension UI/);
    await expect(
      invoke('chat:respondQuestion', { sessionId: 's1', questionId: 'q1', cancel: true })
    ).rejects.toThrow(/Pi questions use Extension UI/);
  });
});
