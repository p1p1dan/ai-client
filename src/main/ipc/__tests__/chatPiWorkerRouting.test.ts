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
const resumeSession = vi.fn(async () => 'resume-1');
const loadHistoryPage = vi.fn(async () => 'history-1');
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

vi.mock('../../services/agent-host/WorkerManager', () => ({
  workerManager: {
    onEvent: vi.fn((handler: (event: RuntimeEvent) => void) => {
      runtimeEventHandlers.push(handler);
      return () => undefined;
    }),
    ensureReady,
    getStatus: vi.fn(() => ({ state: 'ready', driver: 'agent-sdk' })),
    createSession,
    resumeSession,
    loadHistoryPage,
    send,
    stop,
    closeSession,
    respondExtensionUi,
    claimSession: vi.fn(),
    releaseSession: vi.fn(),
    releaseWindow: vi.fn(),
  },
}));

vi.mock('../../services/chat/SessionIndexService', () => ({
  sessionIndexService: {
    get: vi.fn(async (sessionId: string) => ({
      sessionId,
      agent: 'pi',
      workspacePath: '/repo',
      runtimeIdentity: '/session.jsonl',
    })),
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
      expect.objectContaining({ sessionId: 's1', agent: 'pi' })
    );
    expect(createSession).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/repo',
      model: 'glm/glm-5',
      effort: 'high',
      ownerWebContentsId: 7,
    });
  });

  it('routes send, stop, close, and Extension UI responses to the Pi authority', async () => {
    await expect(
      invoke('chat:send', {
        sessionId: 's1',
        attemptId: 'attempt-s1',
        text: 'hello',
        effort: 'xhigh',
      })
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

    expect(send).toHaveBeenCalledWith({
      sessionId: 's1',
      attemptId: 'attempt-s1',
      text: 'hello',
      effort: 'xhigh',
      ownerWebContentsId: 7,
    });
    expect(stop).toHaveBeenCalledWith('s1');
    expect(closeSession).toHaveBeenCalledWith('s1');
    expect(respondExtensionUi).toHaveBeenCalledWith(
      {
        runtimeId: 'runtime-1',
        uiRequestId: 'ui-1',
        ok: false,
      },
      7
    );
  });

  it('refuses a renderer workspace that disagrees with the indexed Pi row', async () => {
    await expect(
      invoke('chat:resumeSession', {
        sessionId: 's1',
        runtimeIdentity: '/session.jsonl',
        workspacePath: '/other-repo',
      })
    ).rejects.toThrow(/pi_session_workspace_mismatch/);
    expect(resumeSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/other-repo' })
    );
  });

  it('refuses a non-Pi index row before WorkerManager can interpret its opaque identity', async () => {
    const { sessionIndexService } = await import('../../services/chat/SessionIndexService');
    vi.mocked(sessionIndexService.get).mockResolvedValueOnce({
      sessionId: 'legacy',
      workspacePath: '/repo',
      title: 'Legacy',
      updatedAt: 1,
      archived: false,
      agent: 'codex',
      runtimeIdentity: 'legacy-thread',
    });
    await expect(
      invoke('chat:resumeSession', {
        sessionId: 'legacy',
        runtimeIdentity: 'legacy-thread',
        workspacePath: '/repo',
      })
    ).rejects.toThrow(/pi_session_agent_mismatch/);
    expect(resumeSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'legacy' })
    );
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

  it('routes exact-file resume and history pagination without legacy permission/question handlers', async () => {
    await expect(
      invoke('chat:resumeSession', {
        sessionId: 's1',
        runtimeIdentity: '/session.jsonl',
        workspacePath: '/repo',
        model: 'glm/glm-5',
        effort: 'high',
      })
    ).resolves.toEqual({ requestId: 'resume-1' });
    expect(resumeSession).toHaveBeenCalledWith({
      sessionId: 's1',
      sessionFile: '/session.jsonl',
      workspacePath: '/repo',
      model: 'glm/glm-5',
      effort: 'high',
      ownerWebContentsId: 7,
    });
    await expect(
      invoke('chat:loadHistoryPage', { sessionId: 's1', offset: 80, limit: 40 })
    ).resolves.toEqual({ requestId: 'history-1' });
    expect(loadHistoryPage).toHaveBeenCalledWith({
      sessionId: 's1',
      offset: 80,
      limit: 40,
      ownerWebContentsId: 7,
    });
    expect(handlers.has('chat:listHistory')).toBe(false);
    expect(handlers.has('chat:updatePermission')).toBe(false);
    expect(handlers.has('chat:respondPermission')).toBe(false);
    expect(handlers.has('chat:respondQuestion')).toBe(false);
  });
});
