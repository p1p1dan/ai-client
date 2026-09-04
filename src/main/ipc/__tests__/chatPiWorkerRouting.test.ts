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
const createSession = vi.fn(async (_payload: Record<string, unknown>) => 'create-1');
const resumeSession = vi.fn(async (_payload: Record<string, unknown>) => 'resume-1');
const loadHistoryPage = vi.fn(async () => 'history-1');
const getSessionTree = vi.fn(async () => ({
  sessionKey: 's1:session:/session.jsonl',
  requestSequence: 3,
  branchRevision: 0,
  snapshot: {
    logicalSessionId: 's1',
    sessionFile: '/session.jsonl',
    workspacePath: '/repo',
    leaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
    nodes: [],
    totalNodes: 0,
    returnedNodes: 0,
    truncated: false,
  },
}));
const rewindSession = vi.fn(async () => ({
  requestId: 'rewind-1',
  sessionKey: 's1:session:/session.jsonl',
  leaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
  tree: {
    logicalSessionId: 's1',
    sessionFile: '/session.jsonl',
    workspacePath: '/repo',
    leaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
    nodes: [],
    totalNodes: 0,
    returnedNodes: 0,
    truncated: false,
  },
}));
const forkSession = vi.fn(async () => ({
  requestId: 'fork-1',
  session: {
    sessionId: 'forked',
    runtimeIdentity: '/forked.jsonl',
    agent: 'pi',
    workspacePath: '/repo',
    title: 'Source (fork)',
    updatedAt: 1,
    archived: false,
  },
}));
const reloadSession = vi.fn(async () => ({ requestId: 'reload-1', reloaded: true }));
/** Whether a Pi terminal was holding the session file when the send arrived. */
let terminalWasReleased = false;
const releaseSessionForHostPrompt = vi.fn(async () => terminalWasReleased);
const send = vi.fn(async () => 'send-1');
const stop = vi.fn(async () => 'stop-1');
const closeSession = vi.fn(async () => 'close-1');
const respondExtensionUi = vi.fn(async () => 'extui-1');
const ensureReady = vi.fn(async () => undefined);
const recordCreated = vi.fn(async () => undefined);
const clearUnwrittenRuntimeIdentity = vi.fn(async () => true);
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
    getSessionTree,
    rewindSession,
    forkSession,
    reloadSession,
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
      title: 'Source',
      updatedAt: 1,
      archived: false,
      runtimeIdentity: '/session.jsonl',
      // A row that can be resumed has run at least one turn, so it carries a
      // leaf checkpoint. Its absence is how the handler recognises a session
      // whose JSONL Pi never actually wrote.
      piLeaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
    })),
    clearUnwrittenRuntimeIdentity,
    recordCreated,
    list: vi.fn(async () => []),
    rename: vi.fn(async () => true),
    setArchived: vi.fn(async () => true),
    handleRuntimeEvent,
  },
}));

vi.mock('../../services/auth/spawnGate', () => ({ assertAgentSpawnAllowed: vi.fn() }));

vi.mock('../piTui', () => ({
  releaseSessionForHostPrompt,
  assertHostPromptAllowed: vi.fn(),
}));

/**
 * U05-a — Main owns the scratch directories, so the handlers must ask it what
 * counts as one rather than pattern-matching a path themselves. `SCRATCH_DIR`
 * is the only path this fake recognises.
 */
const SCRATCH_DIR = '/tmp/base/unbound-sessions/abc';
const ensureScratch = vi.fn(async (_sessionId: string) => SCRATCH_DIR);
const adoptScratch = vi.fn(async (_sessionId: string, target: string) => target);
const releaseScratch = vi.fn(async (_sessionId: string) => undefined);

vi.mock('../../services/agent-host/ScratchWorkspaceService', () => ({
  scratchWorkspaceService: {
    ensure: (sessionId: string) => ensureScratch(sessionId),
    adopt: (sessionId: string, target: string) => adoptScratch(sessionId, target),
    release: (sessionId: string) => releaseScratch(sessionId),
    isScratchPath: (candidate: string) => candidate === SCRATCH_DIR,
  },
}));

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  runtimeEventHandlers.length = 0;
  fakeWindows = [];
  terminalWasReleased = false;
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

  // U05 — an unbound chat's directory and its trust posture are both Main's
  // call. The renderer supplies a path it was given; it never gets to say
  // whether that path is trusted.
  describe('unbound chats', () => {
    it('allocates the isolated directory on request and returns it', async () => {
      await expect(invoke('chat:ensureScratchWorkspace', { sessionId: 's1' })).resolves.toEqual({
        path: SCRATCH_DIR,
      });
      expect(ensureScratch).toHaveBeenCalledWith('s1');
    });

    it('marks a session created in a scratch directory as unbound', async () => {
      await invoke('chat:createSession', { sessionId: 's1', workspacePath: SCRATCH_DIR });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: SCRATCH_DIR, unbound: true })
      );
    });

    it('leaves a session created in a real folder unmarked', async () => {
      await invoke('chat:createSession', { sessionId: 's1', workspacePath: '/repo' });
      expect(createSession.mock.calls[0][0]).not.toHaveProperty('unbound');
    });

    it('[release-blocker] ignores an unbound flag the renderer tries to send', async () => {
      // The posture is derived from Main's own record of what it allocated.
      // A compromised or buggy renderer must not be able to declare a real
      // project folder "unbound", nor a scratch folder trusted.
      await invoke('chat:createSession', {
        sessionId: 's1',
        workspacePath: SCRATCH_DIR,
        unbound: false,
      });
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ unbound: true }));
    });

    it('recreates the directory before resuming, and keeps the session untrusted', async () => {
      // Last run's directory was wiped at exit; the index row still names it.
      const { sessionIndexService } = await import('../../services/chat/SessionIndexService');
      vi.mocked(sessionIndexService.get).mockResolvedValueOnce({
        sessionId: 's1',
        agent: 'pi',
        workspacePath: SCRATCH_DIR,
        title: 'Source',
        updatedAt: 1,
        archived: false,
        runtimeIdentity: '/session.jsonl',
        piLeaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
      });
      await invoke('chat:resumeSession', {
        sessionId: 's1',
        runtimeIdentity: '/session.jsonl',
        workspacePath: SCRATCH_DIR,
      });
      expect(adoptScratch).toHaveBeenCalledWith('s1', SCRATCH_DIR);
      expect(resumeSession).toHaveBeenCalledWith(expect.objectContaining({ unbound: true }));
    });

    it('does not touch scratch state when resuming a real folder', async () => {
      // The upgrade path: once a chat is bound to a folder it goes through the
      // normal trust gate, with nothing left over from its unbound life.
      await invoke('chat:resumeSession', {
        sessionId: 's1',
        runtimeIdentity: '/session.jsonl',
        workspacePath: '/repo',
      });
      expect(adoptScratch).not.toHaveBeenCalled();
      expect(resumeSession.mock.calls[0][0]).not.toHaveProperty('unbound');
    });

    it('releases the directory when the chat is archived', async () => {
      await invoke('chat:archiveSession', { sessionId: 's1', archived: true });
      expect(releaseScratch).toHaveBeenCalledWith('s1');
    });

    it('keeps the directory when a chat is un-archived', async () => {
      await invoke('chat:archiveSession', { sessionId: 's1', archived: false });
      expect(releaseScratch).not.toHaveBeenCalled();
    });
  });

  // U12 fix — the tier a worker STARTS on. `chat:setPermissionTier` only
  // reaches a worker that already exists, so a tier picked before the first
  // send had nowhere to go; it now rides along with the spawn instead.
  describe('spawn permission tier', () => {
    it('carries a valid tier into createSession and resumeSession', async () => {
      await invoke('chat:createSession', {
        sessionId: 's1',
        workspacePath: '/repo',
        tier: 'readonly',
      });
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ tier: 'readonly' }));

      await invoke('chat:resumeSession', {
        sessionId: 's1',
        runtimeIdentity: '/session.jsonl',
        workspacePath: '/repo',
        tier: 'readonly',
      });
      expect(resumeSession).toHaveBeenCalledWith(expect.objectContaining({ tier: 'readonly' }));
    });

    it('omits the tier when the renderer sends none', async () => {
      await invoke('chat:createSession', { sessionId: 's1', workspacePath: '/repo' });
      expect(createSession.mock.calls[0][0]).not.toHaveProperty('tier');
    });

    it('drops a corrupt tier instead of refusing to start the session', async () => {
      // The value comes from a per-session preference in the renderer's own
      // storage. A corrupted entry there must not make the chat unusable — and
      // dropping is the safe direction, since the worker then comes up on the
      // default tier, which asks about everything.
      await expect(
        invoke('chat:createSession', {
          sessionId: 's1',
          workspacePath: '/repo',
          tier: 'root',
        })
      ).resolves.toEqual({ requestId: 'create-1' });
      expect(createSession.mock.calls[0][0]).not.toHaveProperty('tier');
    });
  });

  describe('handing the session file back from the Pi TUI', () => {
    it('re-reads the file after killing a terminal, before the turn starts', async () => {
      terminalWasReleased = true;

      await expect(
        invoke('chat:send', { sessionId: 's1', attemptId: 'attempt-1', text: 'continue' })
      ).resolves.toEqual({ requestId: 'send-1' });

      // Killing the other writer is only half a handover: the worker still
      // holds the tree it read before the terminal appended. Sending first
      // would branch off the pre-terminal leaf and strand the TUI's messages.
      expect(reloadSession).toHaveBeenCalledWith({
        sessionId: 's1',
        sessionFile: '/session.jsonl',
        ownerWebContentsId: 7,
      });
      expect(reloadSession.mock.invocationCallOrder[0]).toBeLessThan(
        send.mock.invocationCallOrder[0]
      );
    });

    it('does not reload when no terminal was holding the file', async () => {
      terminalWasReleased = false;

      await expect(
        invoke('chat:send', { sessionId: 's1', attemptId: 'attempt-1', text: 'hello' })
      ).resolves.toEqual({ requestId: 'send-1' });

      // Every ordinary GUI send goes through this path. Re-opening the Pi
      // session on each one would tear down and rebuild the runtime for
      // nothing.
      expect(reloadSession).not.toHaveBeenCalled();
    });

    it('resolves the file to reload from the index, not from the renderer', async () => {
      await expect(invoke('chat:reloadSession', { sessionId: 's1' })).resolves.toEqual({
        reloaded: true,
      });
      expect(reloadSession).toHaveBeenCalledWith({
        sessionId: 's1',
        sessionFile: '/session.jsonl',
        ownerWebContentsId: 7,
      });
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

  /**
   * Pi reserves a session's JSONL name at creation and writes it only when the
   * first assistant message lands, so older builds could index a path that
   * never became a file. Resume can only ever fail on such a row, which left
   * the chat permanently unopenable even though it had lost nothing.
   */
  it('repairs a row whose Pi session file was never written instead of resuming it', async () => {
    const { sessionIndexService } = await import('../../services/chat/SessionIndexService');
    vi.mocked(sessionIndexService.get).mockResolvedValueOnce({
      sessionId: 's1',
      agent: 'pi',
      workspacePath: '/repo',
      title: 'Never ran a turn',
      updatedAt: 1,
      archived: false,
      // No piLeaf: no turn ever ended, so nothing was ever persisted.
      runtimeIdentity: '/never-written.jsonl',
    });

    await expect(
      invoke('chat:resumeSession', {
        sessionId: 's1',
        runtimeIdentity: '/never-written.jsonl',
        workspacePath: '/repo',
      })
    ).resolves.toEqual({ requestId: 'create-1' });

    expect(clearUnwrittenRuntimeIdentity).toHaveBeenCalledWith('s1', '/never-written.jsonl');
    expect(resumeSession).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith({
      sessionId: 's1',
      workspacePath: '/repo',
      ownerWebContentsId: 7,
    });
  });

  it('still resumes a row that ran a turn, even when its file is now gone', async () => {
    const { sessionIndexService } = await import('../../services/chat/SessionIndexService');
    vi.mocked(sessionIndexService.get).mockResolvedValueOnce({
      sessionId: 's1',
      agent: 'pi',
      workspacePath: '/repo',
      title: 'Deleted transcript',
      updatedAt: 1,
      archived: false,
      runtimeIdentity: '/deleted-by-user.jsonl',
      // A committed leaf proves the file existed, so its absence is real data
      // loss and must surface as such rather than as a silent empty session.
      piLeaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
    });

    await expect(
      invoke('chat:resumeSession', {
        sessionId: 's1',
        runtimeIdentity: '/deleted-by-user.jsonl',
        workspacePath: '/repo',
      })
    ).resolves.toEqual({ requestId: 'resume-1' });

    expect(clearUnwrittenRuntimeIdentity).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
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

  it('routes tree, confirmed rewind, and fork by indexed session identity', async () => {
    await expect(
      invoke('chat:getSessionTree', { sessionId: 's1', requestSequence: 3 })
    ).resolves.toMatchObject({ requestSequence: 3 });
    expect(getSessionTree).toHaveBeenCalledWith({
      sessionId: 's1',
      requestSequence: 3,
      ownerWebContentsId: 7,
    });

    await expect(
      invoke('chat:rewindSession', { sessionId: 's1', entryId: 'a', confirmed: false })
    ).rejects.toThrow(/rewind_confirmation_required/);
    await expect(
      invoke('chat:rewindSession', { sessionId: 's1', entryId: 'a', confirmed: true })
    ).resolves.toMatchObject({ requestId: 'rewind-1' });
    expect(rewindSession).toHaveBeenCalledWith({
      sessionId: 's1',
      entryId: 'a',
      confirmed: true,
      ownerWebContentsId: 7,
    });

    await expect(
      invoke('chat:forkSession', { sessionId: 's1', entryId: 'a' })
    ).resolves.toMatchObject({
      requestId: 'fork-1',
      session: { sessionId: 'forked' },
    });
    expect(forkSession).toHaveBeenCalledWith({
      sourceSessionId: 's1',
      entryId: 'a',
      sourceTitle: 'Source',
      ownerWebContentsId: 7,
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
      leafCheckpoint: { activeEntryId: 'a', fileTailEntryId: 'c' },
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
