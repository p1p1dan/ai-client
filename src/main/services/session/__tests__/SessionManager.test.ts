import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  // D64/S3 — `credentialMode.ts` reads `app.isPackaged` (the dev-only override
  // is forced off in a packaged build) and, when it consults the settings file,
  // `app.getPath('userData')`. `isPackaged:false` keeps the env override live,
  // which is how this suite still controls the mode.
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) =>
      name === 'userData' ? '/tmp/aiclient-test-userdata' : '/tmp'
    ),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(),
    fromId: vi.fn(() => null),
  },
}));

vi.mock('../../remote/RemoteConnectionManager', () => ({
  remoteConnectionManager: {
    getStatus: vi.fn(),
    call: vi.fn(),
    addEventListener: vi.fn(),
    onDidDisconnect: vi.fn(),
    onDidStatusChange: vi.fn(),
  },
}));

describe('SessionManager', () => {
  const originalMode = process.env.AICLIENT_MANAGED_CREDENTIALS;

  beforeEach(() => {
    // D64/S3 — with nothing recorded the mode is MANAGED, and the spawn gate
    // then refuses a session on an unauthenticated machine. These cases are
    // about detach/persist behaviour, not about auth, so they run in local
    // mode — the dev-only override's explicit `'0'`.
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalMode;
    vi.restoreAllMocks();
  });

  it('keeps a local session alive after detach when persistOnDisconnect is enabled', async () => {
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();

    const allocateIdSpy = vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    const createSpy = vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');
    const destroySpy = vi.spyOn(manager.localPtyManager, 'destroy').mockImplementation(() => {});

    // T36 moved agent PTYs out of SessionManager, P1-11 removed the pi TUI
    // they moved to, and `SessionKind` is `'terminal'` alone since (decision
    // 128; stamping pinned below). This case is about persistOnDisconnect.
    const created = await manager.create(1, {
      cwd: 'C:/repo',
      kind: 'terminal',
      persistOnDisconnect: true,
    });

    await manager.attach(1, {
      sessionId: created.session.sessionId,
      cwd: 'C:/repo',
    });

    await manager.detach(1, created.session.sessionId);

    await expect(
      manager.attach(1, {
        sessionId: created.session.sessionId,
        cwd: 'C:/repo',
      })
    ).resolves.toMatchObject({
      session: expect.objectContaining({
        sessionId: 's1',
        persistOnDisconnect: true,
      }),
    });

    expect(allocateIdSpy).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledOnce();
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('destroys a local session after detach when persistOnDisconnect is disabled', async () => {
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();

    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s2');
    vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's2');
    const destroySpy = vi.spyOn(manager.localPtyManager, 'destroy').mockImplementation(() => {});

    const created = await manager.create(1, {
      cwd: 'C:/repo',
      kind: 'terminal',
      persistOnDisconnect: false,
    });

    await manager.attach(1, {
      sessionId: created.session.sessionId,
      cwd: 'C:/repo',
    });

    await manager.detach(1, created.session.sessionId);

    expect(destroySpy).toHaveBeenCalledWith('s2');
    await expect(
      manager.attach(1, {
        sessionId: created.session.sessionId,
        cwd: 'C:/repo',
      })
    ).rejects.toThrow('Session not found: s2');
  });
});

/**
 * dsh-rebase P1-11 (decision 128): the right-column terminal is a local shell
 * created with `persistOnDisconnect: false`, one per folder. Its renderer view
 * detaches on unmount; these are the Main-side ends that must not leave a pty
 * behind when the renderer never gets to say goodbye. No real pty is spawned:
 * `PtyManager` is stubbed at its seams, so nothing here signals a process.
 */
describe('SessionManager cleanup of right-column shells', () => {
  const originalMode = process.env.AICLIENT_MANAGED_CREDENTIALS;

  beforeEach(() => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalMode;
    vi.restoreAllMocks();
  });

  async function managerWithStubbedPtys(ids: string[]) {
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();
    const allocate = vi.spyOn(manager.localPtyManager, 'allocateId');
    for (const id of ids) allocate.mockReturnValueOnce(id);
    const create = vi
      .spyOn(manager.localPtyManager, 'create')
      .mockImplementation((_options, _onData, _onExit, id) => id ?? '');
    const destroy = vi.spyOn(manager.localPtyManager, 'destroy').mockImplementation(() => {});
    return { manager, create, destroy };
  }

  it('a closing window ends its own shells, and only the ones that do not persist', async () => {
    const { manager, destroy } = await managerWithStubbedPtys(['alpha', 'kept', 'other']);
    // Window 1: two column shells (alpha, and one that asked to persist);
    // window 2: a shell of its own.
    for (const [windowId, cwd, persistOnDisconnect] of [
      [1, '/repo/alpha', false],
      [1, '/repo/kept', true],
      [2, '/repo/other', false],
    ] as const) {
      const created = await manager.create(windowId, { cwd, persistOnDisconnect });
      await manager.attach(windowId, { sessionId: created.session.sessionId, cwd });
    }

    // `MainWindow`'s close handler.
    await manager.detachWindowSessions(1);

    expect(destroy.mock.calls).toEqual([['alpha']]);
    expect(manager.list(1)).toEqual([]);
    expect(manager.list(2).map((session) => session.sessionId)).toEqual(['other']);
  });

  it('a removed worktree ends its shells even while a window still shows them', async () => {
    const { manager, destroy } = await managerWithStubbedPtys(['alpha']);
    const created = await manager.create(1, { cwd: '/repo/alpha' });
    await manager.attach(1, { sessionId: 'alpha', cwd: '/repo/alpha' });
    await manager.attach(2, { sessionId: 'alpha', cwd: '/repo/alpha' });

    // A detach from one of two windows keeps it…
    await manager.detach(1, created.session.sessionId);
    expect(destroy).not.toHaveBeenCalled();
    // …a kill (a deleted worktree's `killByWorkdir`) does not ask.
    await manager.killByWorkdir('/repo');
    expect(destroy.mock.calls).toEqual([['alpha']]);
    expect(manager.list(2)).toEqual([]);
  });

  it('quitting destroys every local shell through the IPC module’s teardown', async () => {
    const ipc = await import('../../../ipc/session');
    const { sessionManager } = await import('../SessionManager');
    const destroyAll = vi
      .spyOn(sessionManager.localPtyManager, 'destroyAll')
      .mockImplementation(() => {});
    const destroyAllAndWait = vi
      .spyOn(sessionManager.localPtyManager, 'destroyAllAndWait')
      .mockResolvedValue(undefined);

    ipc.destroyAllTerminals();
    await ipc.destroyAllTerminalsAndWait();

    expect(destroyAll).toHaveBeenCalledOnce();
    expect(destroyAllAndWait).toHaveBeenCalledOnce();
  });

  it('stamps every session a shell, whatever an untyped payload asks for', async () => {
    const { manager, create } = await managerWithStubbedPtys(['alpha']);
    const created = await manager.create(1, {
      cwd: '/repo/alpha',
      kind: 'agent' as never,
    });
    expect(created.session.kind).toBe('terminal');
    expect(create.mock.calls[0]?.[0]).toMatchObject({ cwd: '/repo/alpha', kind: 'terminal' });

    // The remote helper still branches on `'agent'` (it runs `initialCommand`
    // without its shell wrapper), so the stamp has to reach it too.
    const { remoteConnectionManager } = await import('../../remote/RemoteConnectionManager');
    const { toRemoteVirtualPath } = await import('../../remote/RemotePath');
    vi.mocked(remoteConnectionManager.getStatus).mockReturnValue({ connected: true } as never);
    vi.mocked(remoteConnectionManager.addEventListener).mockResolvedValue((() => {}) as never);
    vi.mocked(remoteConnectionManager.call).mockResolvedValue({
      session: {
        sessionId: 'remote-1',
        backend: 'remote',
        kind: 'terminal',
        cwd: '/srv/app',
        persistOnDisconnect: true,
        createdAt: 0,
      },
      replay: '',
    } as never);
    await manager.create(1, {
      cwd: toRemoteVirtualPath('conn-1', '/srv/app'),
      kind: 'agent' as never,
      initialCommand: 'ls',
    });
    const createAndAttach = vi
      .mocked(remoteConnectionManager.call)
      .mock.calls.find(([, method]) => method === 'session:createAndAttach');
    expect(createAndAttach?.[2]).toMatchObject({
      options: { cwd: '/srv/app', kind: 'terminal', initialCommand: 'ls' },
    });
  });
});
