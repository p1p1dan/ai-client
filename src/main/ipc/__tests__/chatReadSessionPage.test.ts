import { IPC_CHANNELS } from '@shared/types';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionHistoryPage } from '@shared/types/sessionHistory';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T102 (decision 030) — `chat:readSessionPage`, the history channel that starts
 * nothing.
 *
 * Two contracts are pinned here, and they pull in opposite directions:
 *
 *  - **It must refuse a session that HAS a worker.** That worker holds the
 *    writer lock and the authoritative in-memory branch; its file is allowed to
 *    lag. Answering from the file anyway would show the user a transcript that
 *    is a turn behind the one being written. `worker_active` is the refusal,
 *    and it is a routing instruction: ask `chat:loadHistoryPage` instead.
 *  - **It must not bind a session to a host.** The renderer marks a session
 *    host-bound on `session.resumed`, and the next send reads that flag to
 *    choose between starting a worker and talking to one. A preview that
 *    published `session.resumed` would leave the composer addressing a worker
 *    that was never started, so this handler publishes the history event ALONE.
 */

type Handler = (...args: unknown[]) => unknown;
type FakeWindow = {
  isDestroyed: () => boolean;
  webContents: { id: number; send: (channel: string, event: RuntimeEvent) => void };
};

const handlers = new Map<string, Handler>();
let published: RuntimeEvent[] = [];
let fakeWindows: FakeWindow[] = [];
/** Slots the WorkerManager reports; empty means "no worker for any session". */
let slots: Array<{ logicalSessionId: string; state: string }> = [];
const claimSession = vi.fn();
const readSessionReplayPage = vi.fn(
  async (_request: unknown): Promise<SessionHistoryPage> => ({
    messages: [
      {
        id: 'h:u1',
        entryId: 'u1',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', id: 'h:u1:text:0', text: 'hello' }],
      },
    ],
    offset: 0,
    limit: 80,
    totalCount: 3,
    hasMore: true,
  })
);

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getAppPath: vi.fn(() => '/app') },
  BrowserWindow: { getAllWindows: vi.fn(() => fakeWindows) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  },
}));

vi.mock('../../services/agent-host/WorkerManager', () => ({
  WorkerManagerError: class WorkerManagerError extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message);
      this.name = 'WorkerManagerError';
    }
  },
  workerManager: {
    onEvent: vi.fn(() => () => undefined),
    getSlotSnapshots: vi.fn(() => slots),
    claimSession,
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
      runtimeIdentity: '/repo/.sessions/s1.jsonl',
      title: 'Yesterday',
      updatedAt: 1,
      archived: false,
      piLeaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
    })),
    handleRuntimeEvent: vi.fn(),
  },
}));

vi.mock('../../services/chat/SessionReplayReader', () => ({
  SESSION_REPLAY_UNAVAILABLE: 'session_replay_unavailable',
  readSessionReplayPage: (request: unknown) => readSessionReplayPage(request),
}));

vi.mock('../../services/auth/spawnGate', () => ({ assertAgentSpawnAllowed: vi.fn() }));
vi.mock('../piTui', () => ({
  releaseSessionForHostPrompt: vi.fn(async () => false),
  assertHostPromptAllowed: vi.fn(),
}));
vi.mock('../../services/agent-host/TempWorkspaceService', () => ({
  isTempWorkspacePath: () => false,
  adoptTempWorkspace: vi.fn(async () => undefined),
}));
vi.mock('../../services/agent-host/ScratchWorkspaceService', () => ({
  scratchWorkspaceService: {
    ensure: vi.fn(async () => '/tmp/scratch'),
    adopt: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    pathFor: () => null,
    isScratchPath: () => false,
  },
}));

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  published = [];
  slots = [];
  vi.clearAllMocks();
  fakeWindows = [
    {
      isDestroyed: () => false,
      webContents: {
        id: 7,
        send: (channel: string, event: RuntimeEvent) => {
          if (channel === IPC_CHANNELS.CHAT_RUNTIME_EVENT) published.push(event);
        },
      },
    },
  ];
  const { registerChatHandlers } = await import('../chat');
  registerChatHandlers();
});

function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`missing handler ${channel}`);
  return Promise.resolve(handler({ sender: { id: 7 } }, payload) as T);
}

describe('chat:readSessionPage — read-only history (T102)', () => {
  it('refuses with worker_active when the session has a live worker', async () => {
    slots = [{ logicalSessionId: 's1', state: 'ready' }];

    await expect(invoke(IPC_CHANNELS.CHAT_READ_SESSION_PAGE, { sessionId: 's1' })).rejects.toThrow(
      /worker_active/
    );
    // Refused before anything read the file, and without claiming a slot: a
    // history read must never be the reason a session looks held by a window.
    expect(readSessionReplayPage).not.toHaveBeenCalled();
    expect(claimSession).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('refuses a session whose worker is still starting', async () => {
    // Not only `ready`: a worker that is starting, restarting or crashed still
    // owns the file, so every slot state refuses.
    slots = [{ logicalSessionId: 's1', state: 'starting' }];
    await expect(invoke(IPC_CHANNELS.CHAT_READ_SESSION_PAGE, { sessionId: 's1' })).rejects.toThrow(
      /worker_active/
    );
  });

  it('publishes the page as session.history in branch mode and nothing else', async () => {
    const { requestId } = await invoke<{ requestId: string }>(IPC_CHANNELS.CHAT_READ_SESSION_PAGE, {
      sessionId: 's1',
    });

    expect(readSessionReplayPage).toHaveBeenCalledWith({
      sessionFile: '/repo/.sessions/s1.jsonl',
      workspacePath: '/repo',
    });
    expect(published).toHaveLength(1);
    const [event] = published;
    expect(event).toMatchObject({
      type: 'session.history',
      sessionId: 's1',
      requestId,
      payload: {
        runtimeIdentity: '/repo/.sessions/s1.jsonl',
        workspacePath: '/repo',
        agent: 'pi',
        // `initial`/`refresh` are the resume modes and the store rejects them
        // without a matching resume snapshot; `branch` means "the file is the
        // authority", which is exactly what a replay is.
        mode: 'branch',
        totalCount: 3,
        hasMore: true,
        truncated: true,
        omittedCount: 2,
      },
    });
    // The host binding is what this must never create.
    expect(published.map((item) => item.type)).not.toContain('session.resumed');
    expect(published.map((item) => item.type)).not.toContain('session.status');
    expect(claimSession).not.toHaveBeenCalled();
  });

  it('pages an older window in older mode', async () => {
    await invoke(IPC_CHANNELS.CHAT_READ_SESSION_PAGE, { sessionId: 's1', offset: 80, limit: 40 });

    expect(readSessionReplayPage).toHaveBeenCalledWith({
      sessionFile: '/repo/.sessions/s1.jsonl',
      offset: 80,
      limit: 40,
      workspacePath: '/repo',
    });
    expect(published[0]).toMatchObject({ payload: { mode: 'older' } });
  });

  it('lets a replay refusal through with its code', async () => {
    readSessionReplayPage.mockRejectedValueOnce(
      new Error('session_replay_unavailable: cannot decode /repo/.sessions/s1.jsonl')
    );
    await expect(invoke(IPC_CHANNELS.CHAT_READ_SESSION_PAGE, { sessionId: 's1' })).rejects.toThrow(
      /session_replay_unavailable/
    );
    expect(published).toEqual([]);
  });
});
